/* ==========================================================================
   LOLU PIPER TTS — Text-to-Speech client-side (Piper, WebAssembly/ONNX Runtime
   Web) untuk suara balasan Lolu di halaman Chat AI.

   Kenapa file terpisah dari lolu-voice.js?
   - lolu-voice.js sudah menangani SpeechInput (STT), IntentParser, Player,
     UIState, dsb. Modul ini HANYA bertanggung jawab atas satu hal: mengubah
     teks balasan Lolu menjadi audio lewat Piper lalu memutarnya.
   - Dengan dipisah, lolu-voice.js cukup memanggil `window.LoluPiperTTS.speakDJ(text)`
     tanpa perlu tahu detail model/WASM/OPFS caching sama sekali.

   Library yang dipakai: @mintplex-labs/piper-tts-web
   - 100% berjalan di browser (WebAssembly + ONNX Runtime Web), TIDAK butuh
     server/VPS sama sekali.
   - Diimpor sebagai ES module langsung dari CDN jsDelivr (dynamic import()),
     karena project ini adalah static site TANPA build tool/bundler (tidak
     ada package.json/webpack/vite — index.html memuat semua script lewat
     tag <script> biasa). Dynamic import() valid dipanggil dari script biasa
     (bukan hanya dari <script type="module">), jadi TIDAK perlu mengubah
     tag <script> yang sudah ada di vibexa.html.
   - Alternatif (opsional, lihat catatan di bawah file ini / chat) kalau suatu
     saat CDN ini bermasalah: unduh paketnya lewat `npm i @mintplex-labs/piper-tts-web`
     di komputer lokal, lalu copy folder dist/ (isinya cuma kode JS + wasm
     loader, BUKAN model suara) ke folder static site ini, dan ganti PIPER_CDN_URL
     di bawah ke path lokal tsb. Model suara (.onnx) TETAP di-fetch dari
     Hugging Face saat runtime seperti biasa — jadi tetap tidak menambah
     ukuran repo.

   Model voice: en_GB-semaine-medium (~63 MB .onnx + .onnx.json kecil)
   - Model TIDAK disertakan di source code. Library ini otomatis mengunduh
     model dari Hugging Face (repo publik rhasspy/piper-voices — file:
     en/en_GB/semaine/medium/en_GB-semaine-medium.onnx dan .onnx.json) pada
     pemakaian pertama, lalu menyimpannya di Origin Private File System (OPFS)
     milik browser. Pemakaian berikutnya membaca dari OPFS, TIDAK unduh ulang.
   - Kalau suatu saat ingin self-host model sendiri (mis. supaya tidak
     bergantung ke Hugging Face), unduh manual kedua file itu dari:
       https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/semaine/medium
     lalu host di server/CDN sendiri — tapi ini butuh menyesuaikan opsi
     custom base URL pada library (cek dokumentasi/README versi library yang
     dipakai untuk nama opsi persisnya sebelum mengubah kode ini).

   PENTING — dependency 'onnxruntime-web':
   - piper-tts-web.js melakukan `import ... from 'onnxruntime-web'` di dalam
     kodenya sendiri (bare specifier). Browser TIDAK bisa resolve bare
     specifier semacam ini tanpa import map (beda dengan bundler seperti
     webpack/vite yang otomatis resolve dari node_modules). Karena itu
     vibexa.html WAJIB punya <script type="importmap"> yang memetakan
     "onnxruntime-web" ke build ESM-nya di CDN — sudah ditambahkan di <head>
     vibexa.html. Kalau import map itu dihapus/hilang, Piper akan gagal
     dengan error "Failed to resolve module specifier 'onnxruntime-web'".
   ========================================================================== */
(function () {
  'use strict';

  // Versi dipin supaya perilaku konsisten. Naikkan manual kalau perlu update.
  var PIPER_CDN_URL = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.4/dist/piper-tts-web.js';
  var VOICE_ID = 'en_GB-semaine-medium';

  var piperModulePromise = null;   // cache hasil import() library
  var modelReadyPromise = null;    // cache hasil "model sudah siap dipakai"
  var audioUnlocked = false;       // sudah ada user-gesture yang unlock audio?
  var sharedAudioCtx = null;
  var currentAudio = null;
  var speakToken = 0;              // dipakai supaya speakDJ terbaru "menang"
                                    // kalau ada pemanggilan bertumpuk

  // ── Load library Piper (sekali saja, lazy) ────────────────────────────
  function loadPiperModule() {
    if (!piperModulePromise) {
      piperModulePromise = import(PIPER_CDN_URL).catch(function (err) {
        piperModulePromise = null; // biar bisa dicoba lagi lain waktu
        throw err;
      });
    }
    return piperModulePromise;
  }

  // ── Autoplay / AudioContext unlock ─────────────────────────────────────
  // Banyak browser (terutama Safari/iOS, Chrome mobile) memblokir audio yang
  // diputar tanpa didahului interaksi user. Panggil ini di dalam event
  // handler klik/tap pertama user (mis. saat user pencet tombol mic) supaya
  // pemutaran audio Piper berikutnya tidak diblokir.
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
        if (sharedAudioCtx.state === 'suspended') {
          sharedAudioCtx.resume().catch(function () {});
        }
        // Mainkan buffer nyaris hening — trik standar untuk "membuka kunci"
        // audio di Safari/iOS supaya elemen <audio> berikutnya boleh autoplay.
        var buffer = sharedAudioCtx.createBuffer(1, 1, 22050);
        var src = sharedAudioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(sharedAudioCtx.destination);
        if (src.start) src.start(0); else src.noteOn(0);
      }
    } catch (e) { /* aman diabaikan */ }
    audioUnlocked = true;
  }

  // ── Loading state kecil — numpang di bubble "lolu-voice-bubble" yang
  //    sudah ada di UI (elemen sama yang dipakai lolu-voice.js untuk
  //    "Listening.../Processing..."), supaya TIDAK perlu menambah elemen UI
  //    baru. Kalau elemen tidak ada (mis. dipanggil dari tempat lain), fungsi
  //    ini aman diabaikan. ─────────────────────────────────────────────────
  function _setStatusUI(text) {
    try {
      var bub = document.getElementById('lolu-voice-bubble');
      var txt = document.getElementById('lolu-voice-bubble-text');
      if (bub && txt) { txt.textContent = text; bub.classList.add('show'); }
    } catch (e) {}
  }
  function _clearStatusUI() {
    try {
      var bub = document.getElementById('lolu-voice-bubble');
      if (bub) bub.classList.remove('show');
    } catch (e) {}
  }

  // ── Pastikan model voice sudah terunduh & tersimpan di OPFS. Kalau sudah
  //    pernah (dicek lewat tts.stored()), TIDAK unduh ulang — langsung pakai
  //    cache. Kalau belum, unduh sekali sambil menampilkan progress. ───────
  function ensureModel() {
    if (modelReadyPromise) return modelReadyPromise;

    modelReadyPromise = loadPiperModule().then(function (tts) {
      return tts.stored().catch(function () { return []; }).then(function (stored) {
        if (stored && stored.indexOf(VOICE_ID) !== -1) {
          return tts; // sudah ada di cache OPFS, langsung pakai
        }
        _setStatusUI('Menyiapkan suara Lolu… 0%');
        return tts.download(VOICE_ID, function (progress) {
          if (progress && progress.total) {
            var pct = Math.round((progress.loaded * 100) / progress.total);
            _setStatusUI('Menyiapkan suara Lolu… ' + pct + '%');
          }
        }).then(function () {
          _clearStatusUI();
          return tts;
        });
      });
    }).catch(function (err) {
      modelReadyPromise = null; // biar bisa dicoba lagi (mis. koneksi sempat putus)
      _clearStatusUI();
      throw err;
    });

    return modelReadyPromise;
  }

  // Panggil ini lebih awal (mis. begitu user pencet tombol mic pertama kali)
  // supaya model sudah ter-download di background SEBELUM Lolu benar-benar
  // perlu bicara — jadi balasan pertama tidak nunggu lama. Aman dipanggil
  // berkali-kali; unduhan tidak akan dobel.
  function preload() {
    ensureModel().catch(function (err) {
      console.warn('[LoluPiperTTS] Gagal preload model:', err);
    });
  }

  // ── Fungsi utama: teks -> suara Piper -> diputar otomatis ──────────────
  function speakDJ(text) {
    if (!text) return Promise.resolve();
    var myToken = ++speakToken;
    unlockAudio();

    return ensureModel()
      .then(function (tts) {
        if (myToken !== speakToken) return null; // sudah ada speakDJ lebih baru
        return tts.predict({ text: text, voiceId: VOICE_ID });
      })
      .then(function (wav) {
        if (!wav || myToken !== speakToken) return;

        if (currentAudio) {
          try { currentAudio.pause(); } catch (e) {}
        }
        var url = URL.createObjectURL(wav);
        var audio = new Audio(url);
        currentAudio = audio;
        audio.addEventListener('ended', function () { URL.revokeObjectURL(url); });
        audio.addEventListener('error', function () { URL.revokeObjectURL(url); });

        var playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function () {
            // Autoplay masih diblokir (belum ada gesture yang "nyantol").
            // Tunggu satu klik/tap berikutnya untuk memutar ulang.
            _setStatusUI('Ketuk layar untuk dengar balasan Lolu');
            var resumeOnGesture = function () {
              audio.play().catch(function () {});
              _clearStatusUI();
              document.removeEventListener('click', resumeOnGesture);
              document.removeEventListener('touchend', resumeOnGesture);
            };
            document.addEventListener('click', resumeOnGesture, { once: true });
            document.addEventListener('touchend', resumeOnGesture, { once: true });
          });
        }
      })
      .catch(function (err) {
        console.error('[LoluPiperTTS] speakDJ gagal:', err);
        _clearStatusUI();
        throw err; // biar pemanggil bisa fallback kalau perlu
      });
  }

  window.LoluPiperTTS = {
    speakDJ: speakDJ,
    preload: preload,
    unlockAudio: unlockAudio,
    VOICE_ID: VOICE_ID
  };
})();
