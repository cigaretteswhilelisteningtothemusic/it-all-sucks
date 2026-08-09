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

  // ── Profil suara PER BAHASA — Lolu sekarang punya suara Piper terpisah
  // untuk Indonesia (bukan lagi cuma satu suara Inggris dipakai untuk semua
  // bahasa). Kunci di sini SAMA PERSIS dengan kode bahasa yang dipakai
  // lolu-voice.js (`currentLang`: 'id-ID' / 'en-US'), jadi tinggal disambung
  // lewat setLanguage() (dipanggil dari toggleLanguage() di lolu-voice.js)
  // untuk otomatis pakai suara yang tepat sesuai bahasa yang lagi aktif.
  //
  //  - EN tetap pakai en_GB-semaine-medium speaker "poppy" seperti sebelumnya.
  //  - ID pakai id_ID-news_tts-medium — SATU-SATUNYA suara Bahasa Indonesia
  //    yang tersedia gratis & open-source untuk Piper saat ini (dari
  //    rhasspy/piper-voices di Hugging Face, lisensi bebas dipakai, model
  //    ~63MB, jalan 100% di browser lewat WASM+ONNX Runtime — sama seperti
  //    suara EN, TIDAK butuh API berbayar/server sama sekali). Modelnya
  //    sendiri direkam gaya pembaca berita (netral/formal), jadi supaya
  //    kedengaran lebih "imut & interaktif" sesuai request, parameternya
  //    di-tuning di bawah (bukan ganti model, karena memang tidak ada
  //    pilihan model ID lain yang gratis) — lihat noiseScale/noiseW yang
  //    dinaikkan (lebih ekspresif/tidak monoton kayak berita), lengthScale
  //    yang dipercepat sedikit (lebih semangat), dan pitchBoost (lihat
  //    _applyCutePitch di bawah — trik playbackRate+preservesPitch=false
  //    yang menaikkan nada suara sedikit, kesannya jadi lebih muda/imut,
  //    mirip teknik "chipmunk voice" yang umum dipakai buat karakter lucu).
  var VOICE_PROFILES = {
    'id-ID': {
      voiceId: 'id_ID-news_tts-medium',
      speakerId: 0,       // model ini single-speaker (cuma speaker_0)
      noiseScale: 0.75,   // dinaikkan dari bawaan (~0.667) -> intonasi lebih hidup/ceria, tidak datar kayak berita
      noiseW: 0.85,       // dinaikkan dari bawaan (~0.8) -> variasi tempo antar-suku kata lebih "ngobrol", tidak kaku
      lengthScale: 0.92,  // sedikit lebih cepat dari normal (1.0) -> kesan lebih semangat & interaktif
      pitchBoost: 1.12    // naikkan nada+tempo bareng ~12% (lihat _applyCutePitch) -> suara lebih imut/muda
    },
    'en-US': {
      voiceId: 'en_GB-semaine-medium',
      speakerId: 3,       // poppy — lihat speaker map di komentar atas file
      noiseScale: 0.35,
      noiseW: 0.4,
      lengthScale: null,  // pakai default model (tidak diubah)
      pitchBoost: 1.0     // tidak diubah — suara EN sudah oke apa adanya
    }
  };
  var DEFAULT_LANG = 'id-ID';
  var _activeLang = DEFAULT_LANG;
  // File ini dimuat SEBELUM lolu-voice.js (lihat urutan <script> di
  // vibexa.html), jadi preload() di ujung file ini akan jalan DULUAN
  // sebelum lolu-voice.js sempat memanggil setLanguage(). Supaya voice yang
  // di-preload dari awal tetap sesuai pilihan bahasa terakhir user (bukan
  // selalu default), baca langsung localStorage key YANG SAMA dipakai
  // lolu-voice.js di sini juga.
  try {
    var _storedLang = localStorage.getItem('vibexa_lolu_voice_lang');
    if (_storedLang && VOICE_PROFILES[_storedLang]) _activeLang = _storedLang;
  } catch (e) {}

  // Dipanggil dari lolu-voice.js (toggleLanguage() & saat load awal) supaya
  // suara Piper yang dipakai otomatis mengikuti bahasa voice command yang
  // lagi aktif — TIDAK perlu pemanggil tahu apa pun soal daftar voice/model
  // di atas, cukup kirim kode bahasa yang sudah ada ('id-ID'/'en-US').
  function setLanguage(lang) {
    if (VOICE_PROFILES[lang]) _activeLang = lang;
  }
  function _activeProfile() {
    return VOICE_PROFILES[_activeLang] || VOICE_PROFILES[DEFAULT_LANG];
  }

  // Suara hasil Piper (model en_GB-semaine-medium) secara natural terdengar
  // cukup pelan dibanding audio lain di halaman. Elemen <audio> biasa cuma
  // bisa diset volume MAKSIMAL 1.0 (100%, sudah dipakai bawaan/default) —
  // tidak bisa dibuat lebih kencang dari itu lewat `audio.volume` saja.
  // Untuk benar-benar MENAIKKAN kekencangan di atas 100%, audio Piper
  // dialirkan lewat Web Audio API (GainNode) — lihat _boostVoiceGain() di
  // bawah. Naikkan/turunkan angka ini kalau masih kurang/kelewat kencang
  // (1.0 = tidak ada boost sama sekali, sama seperti sebelumnya). Berlaku
  // untuk SEMUA bahasa/suara.
  var VOICE_GAIN = 1.8;

  var piperModulePromise = null;   // cache hasil import() library
  var modelReadyPromises = {};     // voiceId -> Promise "model ini sudah siap dipakai"
                                    // (per-voice, karena sekarang ada >1 model/bahasa)
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

  // ── Cache "prepared" — hasil predict() yang disiapkan LEBIH AWAL lewat
  // prepare(text), SEBELUM speakDJ(text) beneran dipanggil untuk teks yang
  // sama. Dipakai LoluDJ (lolu-dj.js) untuk menyiapkan suara komentar lagu
  // BERIKUTNYA selagi lagu SEKARANG masih diputar, supaya begitu lagu
  // beneran berganti, speakDJ() tidak perlu nunggu ensureModel()+predict()
  // lagi dari nol — tinggal pakai wav yang sudah jadi, suara langsung
  // muncul. Hanya menyimpan SATU slot (teks terakhir yang disiapkan) karena
  // DJ cuma perlu menyiapkan SATU lagu berikutnya di satu waktu. Kuncinya
  // menyertakan bahasa aktif (bukan cuma teks) supaya kalau user kebetulan
  // ganti bahasa PAS lagi di-prepare, slot lama otomatis dianggap tidak
  // cocok lagi (tidak salah pakai suara). ─────────────────────────────────
  var preparedKey = null;   // format: `${lang}::${text}`
  var preparedWavPromise = null;

  function _keyFor(text) { return _activeLang + '::' + text; }

  // Siapkan (sintesis) audio Piper untuk `text` LEBIH AWAL, tanpa
  // memutarnya. Aman dipanggil kapan saja (mis. beberapa detik sebelum lagu
  // berikutnya mulai) — hasilnya disimpan sampai speakDJ() dipanggil dengan
  // teks yang SAMA PERSIS (& bahasa aktif yang sama), atau sampai prepare()
  // dipanggil lagi dengan teks lain (menggantikan slot lama). Tidak
  // melempar error ke pemanggil kalau gagal — speakDJ() akan tetap fallback
  // ke jalur biasa (generate saat itu juga) kalau prepare() ini gagal/tidak
  // dipanggil sama sekali.
  function prepare(text) {
    if (!text) return Promise.resolve();
    var key = _keyFor(text);
    if (preparedKey === key && preparedWavPromise) return preparedWavPromise; // sudah disiapkan/lagi disiapkan
    var profile = _activeProfile();
    preparedKey = key;
    preparedWavPromise = ensureModel(profile.voiceId)
      .then(function (tts) {
        _applyVoiceParams(tts, profile);
        return tts.predict({ text: text, voiceId: profile.voiceId });
      })
      .catch(function (err) {
        console.warn('[LoluPiperTTS] prepare() gagal:', err);
        // Biar tidak nyangkut sebagai cache basi — slot dikosongkan lagi
        // supaya speakDJ() nanti fallback generate biasa.
        if (preparedKey === key) { preparedKey = null; preparedWavPromise = null; }
        throw err;
      });
    return preparedWavPromise;
  }

  // ── Speaking start/end hooks — dipakai UI lain (lihat lolu-voice.js:
  // animasi "voice recognition" yang menggantikan foto burung Lolu di
  // halaman Lolu Voice selagi Piper BENERAN sedang bersuara) supaya tahu
  // kapan tepatnya audio Piper mulai & selesai diputar, TANPA modul ini
  // perlu tahu apa pun soal DOM/UI pemanggilnya. Dipanggil lewat
  // setSpeakingHandlers() di window.LoluPiperTTS (lihat bawah file). ──
  var onSpeakStart = null;
  var onSpeakEnd = null;
  function setSpeakingHandlers(onStart, onEnd) {
    onSpeakStart = typeof onStart === 'function' ? onStart : null;
    onSpeakEnd = typeof onEnd === 'function' ? onEnd : null;
  }

  // Terapkan speakerId/noiseScale/noiseW/lengthScale dari sebuah profil
  // suara (lihat VOICE_PROFILES) ke TtsSession (singleton milik library —
  // nilainya dibaca ulang tiap kali predict() dipanggil, jadi aman diubah
  // tepat sebelum tiap predict() untuk pakai profil suara yang berbeda-beda
  // gantian, mis. ID lalu EN lalu ID lagi tanpa perlu reload modul).
  function _applyVoiceParams(tts, profile) {
    if (!tts || !tts.TtsSession) return;
    tts.TtsSession.speakerId = profile.speakerId || 0;
    if (profile.noiseScale != null) tts.TtsSession.noiseScale = profile.noiseScale;
    if (profile.noiseW != null) tts.TtsSession.noiseW = profile.noiseW;
    if (profile.lengthScale != null) tts.TtsSession.lengthScale = profile.lengthScale;
  }

  // ── Load library Piper (sekali saja, lazy) ────────────────────────────
  function loadPiperModule() {
    if (!piperModulePromise) {
      piperModulePromise = import(PIPER_MODULE_URL).catch(function (err) {
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

  // ── Naikkan volume audio Piper lewat Web Audio API (GainNode) — dipanggil
  // sekali per elemen <audio> baru yang dibuat di speakDJ(), SEBELUM
  // audio.play() dipanggil. Aman/tidak melempar error kalau gagal (mis.
  // browser sangat lama yang tidak dukung Web Audio API sama sekali) —
  // audio tetap diputar normal lewat elemen <audio>-nya apa adanya, cuma
  // tanpa boost volume tambahan.
  function _boostVoiceGain(audioEl) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
      if (sharedAudioCtx.state === 'suspended') { sharedAudioCtx.resume().catch(function () {}); }
      var src = sharedAudioCtx.createMediaElementSource(audioEl);
      var gain = sharedAudioCtx.createGain();
      gain.gain.value = VOICE_GAIN;
      // Compressor kecil setelah gain supaya boost volume tidak gampang
      // clipping/pecah suara di kalimat yang kebetulan sudah cukup keras.
      var comp = sharedAudioCtx.createDynamicsCompressor();
      src.connect(gain);
      gain.connect(comp);
      comp.connect(sharedAudioCtx.destination);
    } catch (e) {
      // Aman diabaikan — fallback ke volume normal (tanpa boost).
    }
  }

  // ── Naikkan nada+tempo audio bareng ("chipmunk trick") lewat
  // playbackRate + preservesPitch=false — dipakai supaya suara Piper
  // Indonesia (model "news_tts" yang aslinya bernada pembaca berita) bisa
  // kedengaran lebih imut/muda/interaktif TANPA perlu model suara baru
  // (yang memang tidak tersedia gratis untuk Bahasa Indonesia saat ini —
  // lihat catatan panjang di VOICE_PROFILES di atas). rate>1 menaikkan
  // nada & sedikit mempercepat tempo bicara BERSAMAAN (itu sebabnya efeknya
  // suka disebut "chipmunk voice") — untuk profile.pitchBoost=1.0 (mis.
  // suara EN yang sudah oke), fungsi ini otomatis tidak melakukan apa-apa.
  function _applyCutePitch(audioEl, profile) {
    if (!profile || !profile.pitchBoost || profile.pitchBoost === 1.0) return;
    try {
      audioEl.preservesPitch = false;
      audioEl.mozPreservesPitch = false;
      audioEl.webkitPreservesPitch = false;
      audioEl.playbackRate = profile.pitchBoost;
    } catch (e) { /* aman diabaikan — audio tetap diputar dg nada asli */ }
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

  // ── Pastikan model voice `voiceId` sudah terunduh & tersimpan di OPFS.
  //    Kalau sudah pernah (dicek lewat tts.stored()), TIDAK unduh ulang —
  //    langsung pakai cache. Kalau belum, unduh sekali sambil menampilkan
  //    progress. Di-cache PER voiceId (bukan lagi satu variabel global)
  //    supaya suara ID & EN bisa dipakai gantian tanpa unduh ulang tiap
  //    pindah bahasa. ─────────────────────────────────────────────────────
  function ensureModel(voiceId) {
    if (modelReadyPromises[voiceId]) return modelReadyPromises[voiceId];

    modelReadyPromises[voiceId] = loadPiperModule().then(function (tts) {
      return tts.stored().catch(function () { return []; }).then(function (stored) {
        if (stored && stored.indexOf(voiceId) !== -1) {
          return tts; // sudah ada di cache OPFS, langsung pakai
        }
        var label = (voiceId.indexOf('id_ID') === 0)
          ? 'Menyiapkan suara Lolu (ID)… 0%'
          : 'Menyiapkan suara Lolu… 0%';
        _setStatusUI(label);
        return tts.download(voiceId, function (progress) {
          if (progress && progress.total) {
            var pct = Math.round((progress.loaded * 100) / progress.total);
            _setStatusUI(label.replace('0%', pct + '%'));
          }
        }).then(function () {
          _clearStatusUI();
          return tts;
        });
      });
    }).catch(function (err) {
      delete modelReadyPromises[voiceId]; // biar bisa dicoba lagi (mis. koneksi sempat putus)
      _clearStatusUI();
      throw err;
    });

    return modelReadyPromises[voiceId];
  }

  // Panggil ini lebih awal (mis. begitu user pencet tombol mic pertama kali,
  // atau begitu file ini sendiri selesai di-parse — lihat preload() di
  // bagian paling bawah file) supaya model SUARA YANG SEDANG AKTIF sudah
  // ter-download di background SEBELUM Lolu benar-benar perlu bicara, jadi
  // balasan pertama tidak nunggu lama. Sengaja HANYA menyiapkan suara bahasa
  // yang aktif sekarang (bukan ID+EN sekaligus) — tiap model ~63MB, jadi
  // menyiapkan keduanya di awal cuma buang-buang kuota kalau user ternyata
  // tidak pernah pindah bahasa. Begitu user ganti bahasa (toggleLanguage()
  // di lolu-voice.js -> setLanguage() di sini), model suara yang BARU akan
  // otomatis diunduh sendiri saat dibutuhkan (lewat ensureModel() di
  // speakDJ()/prepare()) — aman dipanggil berkali-kali, unduhan tidak dobel.
  function preload() {
    ensureModel(_activeProfile().voiceId).catch(function (err) {
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
    var profile = _activeProfile(); // suara bahasa yang aktif SEKARANG dikunci di awal panggilan
                                     // ini, supaya konsisten dari sini sampai audio selesai diputar
                                     // walau user sempat ganti bahasa lagi di tengah proses.
    unlockAudio();

    // Kalau teks ini SUDAH disiapkan lebih awal lewat prepare() (mis. oleh
    // LoluDJ selagi lagu sebelumnya masih jalan) DENGAN BAHASA YANG SAMA,
    // langsung pakai wav yang sudah/lagi disintesis itu — SKIP
    // ensureModel()+predict() dari nol di sini, supaya suara Lolu bisa
    // langsung muncul begitu dipanggil, tanpa loading tambahan. Kalau tidak
    // ada yang cocok (mis. prepare() belum sempat dipanggil, gagal, teksnya
    // beda, atau bahasa sempat berubah), fallback ke jalur lama:
    // ensureModel()+predict() seperti biasa untuk voiceId bahasa aktif.
    var wavPromise;
    var key = _keyFor(text);
    if (preparedKey === key && preparedWavPromise) {
      wavPromise = preparedWavPromise;
      preparedKey = null;
      preparedWavPromise = null; // slot sudah "dipakai", kosongkan
    } else {
      wavPromise = ensureModel(profile.voiceId).then(function (tts) {
        if (myToken !== speakToken) return null; // sudah ada speakDJ lebih baru
        _applyVoiceParams(tts, profile);
        return tts.predict({ text: text, voiceId: profile.voiceId });
      });
    }

    return wavPromise
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
        _boostVoiceGain(audio);       // naikkan volume di atas 100% bawaan (lihat VOICE_GAIN)
        _applyCutePitch(audio, profile); // naikkan nada biar imut, khusus suara yang punya pitchBoost (lihat VOICE_PROFILES)
        currentAudio = audio;
        // Audio Piper BENERAN mulai diputar dari sini — panggil hook "mulai
        // bicara" sekarang (bukan di 'ended'/'error' seperti onSpeakEnd),
        // supaya UI (mis. animasi voice recognition) muncul tepat saat
        // suaranya mau bunyi, bukan nunggu playback event lebih lanjut.
        if (onSpeakStart) { try { onSpeakStart(); } catch (e) {} }

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
            // Audio ini BENERAN selesai (baik sukses 'ended', error, atau
            // di-interrupt oleh speakDJ() baru) — panggil hook "selesai
            // bicara" persis sekali di sini, cocok dengan resolve() promise
            // ini juga (lihat catatan besar di atas fungsi speakDJ soal
            // promise baru resolve setelah BENERAN selesai).
            if (onSpeakEnd) { try { onSpeakEnd(); } catch (e) {} }
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
    prepare: prepare,
    preload: preload,
    unlockAudio: unlockAudio,
    setSpeakingHandlers: setSpeakingHandlers,
    // Dipanggil dari lolu-voice.js (toggleLanguage() + saat load awal)
    // supaya suara Piper otomatis mengikuti bahasa voice command yang aktif
    // ('id-ID' -> suara Indonesia, 'en-US' -> suara Inggris "poppy").
    setLanguage: setLanguage,
    get VOICE_ID() { return _activeProfile().voiceId; } // voice yang SEDANG aktif (bukan lagi tetap satu)
  };

  // ── PERCEPAT KEMUNCULAN SUARA LOLU ──────────────────────────────────────
  // Sebelumnya preload() cuma dipanggil dari lolu-voice.js, dan itu pun
  // masih menunggu event (DOMContentLoaded + requestIdleCallback timeout
  // 4 detik, atau baru saat user buka halaman Voice/Chat AI/pencet mic).
  // Jadi ada jeda "nganggur" sebelum unduhan model (~63 MB) mulai sama
  // sekali, padahal fetch/download TIDAK butuh user-gesture & TIDAK
  // memblokir render halaman.
  //
  // Sekarang preload() langsung dipanggil DI SINI, begitu file
  // lolu-piper-tts.js ini sendiri selesai di-parse browser — paling awal
  // yang mungkin, tanpa nunggu event/timeout apa pun lagi. ensureModel()
  // sudah cache Promise-nya (lihat di atas), jadi aman/idempotent walau
  // lolu-voice.js & halaman lain masih ikut memanggil preload() lagi
  // nanti (tidak akan dobel unduh, cuma reuse Promise yang sama).
  preload();
})();
