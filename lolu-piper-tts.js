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

   PENTING — kenapa file library di-vendor (host sendiri), bukan dari CDN:
   - Library resminya TIDAK punya opsi publik untuk memilih "speaker" pada
     model multi-speaker seperti en_GB-semaine-medium (speakerId di-hardcode
     ke 0 di dalam kodenya). Karena Anda minta suara "poppy" secara spesifik
     (speaker index 3 pada model ini — urutan resminya: prudence=0, spike=1,
     obadiah=2, poppy=3), saya tempel (patch) 4 baris kecil di salinan
     dist/piper-tts-web.js supaya speakerId, noiseScale, noiseW, dan
     lengthScale bisa diatur dari luar lewat TtsSession.speakerId dst — TANPA
     mengubah logic inti/algoritma library sama sekali, cuma membuka 1 nilai
     yang tadinya hardcode jadi bisa dikonfigurasi.
   - File yang di-vendor (folder ./piper/) HANYA kode JS kecil (~320 KB total:
     piper-tts-web.js yang sudah dipatch + phonemizer wasm loader + daftar
     voice statis) — BUKAN model suara. Model .onnx (~63 MB) tetap diunduh
     otomatis dari Hugging Face saat runtime seperti sebelumnya, TIDAK ikut
     di-vendor/disertakan di source code.
   - "Suara berubah-ubah" pada model VITS/Piper seperti semaine itu wajar:
     model ini punya noise_scale/noise_w yang dipakai untuk memberi variasi
     intonasi & tempo bicara secara acak di tiap generate (supaya tidak
     terdengar monoton) — bukan bug, tapi juga bukan speaker yang berpindah
     (speakerId memang selalu 0/prudence sebelum dipatch, TIDAK pernah acak).
     Karena semaine dilatih dari rekaman akting emosional (proyek SEMAINE),
     variasi ini terasa lebih kentara dibanding model lain. Saya turunkan
     noiseScale & noiseW di bawah supaya hasil bicara Lolu lebih konsisten
     antar-kalimat; kalau masih terasa kurang stabil, kecilkan lagi angkanya
     (0 = paling datar/monoton, mendekati nilai asli model = paling ekspresif
     tapi paling bervariasi).

   Model voice: en_GB-semaine-medium — speaker "poppy" (~63 MB .onnx + .onnx.json kecil)
   - Model TIDAK disertakan di source code. Library ini otomatis mengunduh
     model dari Hugging Face (repo publik rhasspy/piper-voices — file:
     en/en_GB/semaine/medium/en_GB-semaine-medium.onnx dan .onnx.json) pada
     pemakaian pertama, lalu menyimpannya di Origin Private File System (OPFS)
     milik browser. Pemakaian berikutnya membaca dari OPFS, TIDAK unduh ulang.

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

  // File lokal (di-vendor, hasil patch kecil — lihat komentar di atas).
  // Path relatif terhadap lolu-piper-tts.js sendiri TIDAK dipakai di sini;
  // ini path relatif terhadap vibexa.html (folder ./piper/ ada di sebelah
  // vibexa.html). Sesuaikan kalau struktur folder Anda berbeda.
  var PIPER_MODULE_URL = './piper/piper-tts-web.js';
  var VOICE_ID = 'en_GB-semaine-medium';

  // Speaker map resmi untuk en_GB-semaine-medium: prudence=0, spike=1,
  // obadiah=2, poppy=3. Ganti angka ini kalau suatu saat ingin speaker lain
  // dari model yang sama.
  var SPEAKER_ID = 3; // poppy

  // Redam variasi intonasi/tempo VITS supaya suara Lolu lebih konsisten
  // antar-kalimat (lihat catatan panjang di atas). Set ke null kalau ingin
  // pakai nilai bawaan model (lebih ekspresif, tapi lebih bervariasi).
  var NOISE_SCALE = 0.35;   // bawaan model medium biasanya ~0.667
  var NOISE_W = 0.4;        // bawaan model medium biasanya ~0.8

  var piperModulePromise = null;   // cache hasil import() library
  var modelReadyPromise = null;    // cache hasil "model sudah siap dipakai"
  var audioUnlocked = false;       // sudah ada user-gesture yang unlock audio?
  var sharedAudioCtx = null;
  var currentAudio = null;
  var currentAudioFinish = null; // fungsi "selesai" utk promise speakDJ yang
                                  // lagi berjalan saat ini — dipanggil kalau
                                  // audio itu di-interrupt oleh speakDJ()
                                  // baru sebelum sempat 'ended', supaya
                                  // promise LAMA tidak nge-hang selamanya
  var speakToken = 0;              // dipakai supaya speakDJ terbaru "menang"
                                    // kalau ada pemanggilan bertumpuk

  // ── Load library Piper (sekali saja, lazy) ────────────────────────────
  function loadPiperModule() {
    if (!piperModulePromise) {
      piperModulePromise = import(PIPER_MODULE_URL).then(function (tts) {
        // Set sekali di sini — TtsSession pakai pola singleton, dan nilai
        // ini dibaca ulang tiap kali predict() dipanggil, jadi cukup di-set
        // sekali saat modul pertama kali dimuat.
        if (tts.TtsSession) {
          tts.TtsSession.speakerId = SPEAKER_ID;
          if (NOISE_SCALE !== null) tts.TtsSession.noiseScale = NOISE_SCALE;
          if (NOISE_W !== null) tts.TtsSession.noiseW = NOISE_W;
        }
        return tts;
      }).catch(function (err) {
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
  // PENTING: Promise yang dikembalikan fungsi ini BARU resolve setelah
  // audio-nya BENERAN selesai diputar (event 'ended'), BUKAN cuma setelah
  // audio.play() dipanggil. Sebelumnya fungsi ini resolve nyaris seketika
  // begitu playback dimulai, jadi pemanggil yang perlu "menunggu Lolu
  // selesai ngomong" (mis. LoluDJ._speakAwait, dipakai buat menahan lagu
  // supaya tidak langsung bunyi bareng suara Lolu) diam-diam cuma menunggu
  // estimasi kasar dari jumlah kata, bukan durasi asli — makanya lagu bisa
  // kedengeran mulai duluan padahal Lolu masih ngomong. Sekarang pemanggil
  // benar-benar menunggu sampai audio Piper selesai.
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
          // Audio LAMA di-interrupt sebelum sempat 'ended' -> selesaikan
          // promise-nya sekarang juga supaya pemanggil sebelumnya (yang
          // masih menunggu) tidak nge-hang selamanya.
          if (typeof currentAudioFinish === 'function') {
            try { currentAudioFinish(); } catch (e) {}
          }
        }
        var url = URL.createObjectURL(wav);
        var audio = new Audio(url);
        currentAudio = audio;

        return new Promise(function (resolve) {
          var settled = false;
          var safetyTimer = null;

          function finish() {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            audio.removeEventListener('ended', finish);
            audio.removeEventListener('error', finish);
            try { URL.revokeObjectURL(url); } catch (e) {}
            if (currentAudioFinish === finish) currentAudioFinish = null;
            resolve();
          }
          currentAudioFinish = finish;

          audio.addEventListener('ended', finish);
          audio.addEventListener('error', finish);

          // Jaring pengaman: kalau 'ended' entah kenapa tidak pernah
          // ter-trigger (mis. autoplay diblokir & user TIDAK PERNAH nge-tap
          // layar buat resume, atau decode gagal diam-diam), JANGAN tahan
          // lagu selamanya. Begitu metadata audio kebaca, batasi maksimum
          // tunggu = durasi asli + sedikit buffer; sebelum itu kebaca,
          // pakai fallback flat 20 detik.
          function armSafetyTimer() {
            var estMs = (audio.duration && isFinite(audio.duration) && audio.duration > 0)
              ? (audio.duration * 1000) + 2500
              : 20000;
            clearTimeout(safetyTimer);
            safetyTimer = setTimeout(finish, estMs);
          }
          audio.addEventListener('loadedmetadata', armSafetyTimer);
          armSafetyTimer();

          var playPromise = audio.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(function () {
              // Autoplay masih diblokir (belum ada gesture yang "nyantol").
              // Tunggu satu klik/tap berikutnya untuk memutar ulang. Promise
              // speakDJ tetap menunggu (lewat safetyTimer di atas kalau user
              // tidak pernah tap, atau lewat 'ended' begitu berhasil diputar).
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
        });
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
