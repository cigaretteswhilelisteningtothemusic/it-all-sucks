/* ==========================================================================
   LOLU DJ — mode "AI DJ" ala Spotify AI DJ, dibangun di atas fitur Lolu
   Voice yang sudah ada (lolu-voice.js, lolu-piper-tts.js) TANPA mengganti
   logikanya. File ini berdiri sendiri (namespace `LoluDJ`) dan HANYA
   memakai ulang state/fungsi yang SUDAH ADA di vibexa.js & lolu-voice.js
   (loadPlay, curTrack, curQueue, favoriteArtists, fetchItunesResults,
   fetchArtistTopTracks, fetchRecommendedSongs, _aiCallGemini,
   LoluVoiceDJ.parseIntent, LoluPiperTTS) — bukan sumber data/AI baru.

   Dimuat SETELAH vibexa.js & lolu-voice.js (lihat urutan <script> di
   vibexa.html) supaya semua deklarasi top-level punya nama di atas sudah
   ada di scope chain saat file ini dievaluasi.

   Fitur (checklist "AI DJ ala Spotify"):
     1. DJ berbicara pakai suara natural       -> reuse LoluPiperTTS (Piper)
     2. Komentar singkat lagu/artis/genre       -> _djGenerateIntro() lewat
        sebelum/di antara lagu                     Gemini (_aiCallGemini),
                                                     dipicu tiap kali track
                                                     baru mulai (hook loadPlay)
     3. DJ Request (voice/teks): "play something -> DJ_MOOD_DEFS di
        chill", "workout music", "similar to my      lolu-voice.js + chip
        favorites"                                   mood di UI
     4. Mood/Vibe switching tanpa playlist baru -> setMood()
     5. Personalized suggestions dari histori    -> _djBuildDefaultQueue()/
        dengar                                       _djBuildFavoritesQueue()
     6. Implicit feedback (skip vs selesai)      -> _djRecordFeedback() lewat
                                                      hook loadPlay
     7. Ask DJ soal lagu/artis yang lagi diputar -> askAboutCurrentSong()
     8. Voice & Text input                       -> voice: lewat
                                                      lolu-voice.js intents;
                                                      teks: wrap
                                                      sendAIChatMessage()
     9. DJ Personality per bahasa/budaya         -> _djSystemPrompt() beda
                                                      nada ID (gaul santai)
                                                      vs EN, suara Piper yang
                                                      sama dgn Lolu chat AI
   ========================================================================== */
(function () {
  'use strict';

  // ── Bahasa aktif — mengikuti bahasa voice command Lolu (lolu-voice.js),
  // disinkronkan lewat LoluVoiceDJ.toggleLanguage() -> LoluDJ._setLang(). ──
  const LANG_STORAGE_KEY = 'vibexa_lolu_voice_lang';
  let _djLang = localStorage.getItem(LANG_STORAGE_KEY) || 'id-ID';
  function _setLang(lang) { _djLang = lang; }
  function _t(idText, enText) { return _djLang === 'en-US' ? enText : idText; }

  // ── State sesi DJ ──────────────────────────────────────────────────────
  let _djActive = false;
  let _djMood = null; // null = "personalized"/default, atau salah satu key MOOD_QUERIES
  let _djSuppressNextAutoCommentary = false;
  let _djLastCommentaryAt = 0;
  const DJ_COMMENTARY_COOLDOWN_MS = 20000; // jangan komentar tiap lagu kalau user lompat2 cepat
  const DJ_REFILL_THRESHOLD = 3; // isi ulang queue kalau tinggal N lagu lagi

  // ── "Tahan" pemutaran sampai Lolu selesai ngomong — dipakai tiap kali sesi
  // DJ baru dimulai/lagu baru diminta LANGSUNG oleh user (start(), setMood(),
  // playRequestedSong()), supaya lagunya TIDAK langsung bunyi bareng suara
  // Lolu. TIDAK dipakai untuk komentar ambient di tengah sesi (lihat
  // _djOnNewTrackStarted) karena di situ lagunya memang sudah jalan duluan
  // seperti siaran radio beneran. ──
  let _djHoldPlaybackForSpeech = false;
  let _djHoldWatchTimer = null;
  function _djWatchAndHoldPlayback() {
    clearInterval(_djHoldWatchTimer);
    _djHoldWatchTimer = setInterval(() => {
      if (!_djHoldPlaybackForSpeech) { clearInterval(_djHoldWatchTimer); return; }
      try {
        if (window.playing && window.LoluVoiceDJ && typeof window.LoluVoiceDJ.pause === 'function') {
          window.LoluVoiceDJ.pause();
        }
      } catch (e) {}
    }, 70);
  }
  function _djBeginHeldTrack(track) {
    _djHoldPlaybackForSpeech = true;
    if (typeof loadPlay === 'function') loadPlay(track, null); // loadPlay milik vibexa.js otomatis buka halaman Now Playing
    _djWatchAndHoldPlayback();
  }
  function _djReleaseHeldTrack() {
    _djHoldPlaybackForSpeech = false;
    clearInterval(_djHoldWatchTimer);
    try {
      // Halaman Now Playing sebenarnya SUDAH dibuka di baliknya sejak
      // _djBeginHeldTrack() (lewat loadPlay -> openNP() milik vibexa.js) —
      // cuma masih ketutup #lolu-voice-page yang z-index-nya lebih tinggi.
      // Begitu Lolu selesai ngomong, tutup halaman Lolu DJ supaya user
      // otomatis "pindah" melihat Now Playing dari lagu yang baru diputar.
      if (window.LoluVoiceDJ && typeof window.LoluVoiceDJ.closeVoicePage === 'function') {
        window.LoluVoiceDJ.closeVoicePage();
      }
    } catch (e) {}
    try {
      if (window.LoluVoiceDJ && typeof window.LoluVoiceDJ.resume === 'function') window.LoluVoiceDJ.resume();
      else if (window.YTP && typeof window.YTP.playVideo === 'function') window.YTP.playVideo();
    } catch (e) {}
  }

  // ==========================================================================
  // LABEL MOOD (dwibahasa, dipakai di komentar DJ & bubble UI)
  // ==========================================================================
  const MOOD_LABELS = {
    chill: { id: 'santai/chill', en: 'chill' },
    workout: { id: 'workout', en: 'workout' },
    party: { id: 'party', en: 'party' },
    focus: { id: 'fokus', en: 'focus' },
    romantic: { id: 'romantis', en: 'romantic' },
    throwback: { id: 'throwback/nostalgia', en: 'throwback' },
    favorites: { id: 'mirip favoritmu', en: 'similar to your favorites' },
    surprise: { id: 'kejutan', en: 'surprise' },
    happy: { id: 'ceria', en: 'happy' },
    sad: { id: 'galau', en: 'sad' }
  };
  function _moodLabel(mood) {
    const def = MOOD_LABELS[mood];
    if (!def) return mood || '';
    return _djLang === 'en-US' ? def.en : def.id;
  }

  // Query pencarian iTunes per mood — dipilih acak 1 dari beberapa supaya
  // hasil tetap bervariasi tiap kali mood yang sama diminta lagi.
  const MOOD_QUERIES = {
    chill: ['chill lofi vibes', 'acoustic chill songs', 'calm relaxing music'],
    workout: ['workout gym hype', 'pump up workout songs', 'high energy running music'],
    party: ['party dance hits', 'club dance anthems', 'party bangers'],
    focus: ['focus study instrumental', 'deep focus concentration music', 'lo-fi study beats'],
    romantic: ['romantic love songs', 'slow romantic ballads', 'love songs playlist'],
    throwback: ['2000s throwback hits', '90s throwback classics', 'old school throwback songs'],
    happy: ['feel good happy songs', 'upbeat feel good hits', 'sunshine pop happy songs'],
    sad: ['sad emotional songs', 'heartbreak ballads', 'melancholy songs'],
    surprise: ['viral trending songs', 'top hits mix', 'popular songs right now']
  };

  // ==========================================================================
  // IMPLICIT FEEDBACK — skor preferensi per artis, dari perilaku user
  // (skip cepat = sinyal negatif, dengerin sampai cukup lama = sinyal
  // positif) TANPA perlu user kasih rating eksplisit apa pun.
  // ==========================================================================
  const DJ_PREF_KEY = 'vibexa_dj_pref';
  function _djGetPrefStore() {
    try { return JSON.parse(localStorage.getItem(DJ_PREF_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function _djSetPrefStore(store) {
    try { localStorage.setItem(DJ_PREF_KEY, JSON.stringify(store)); } catch (e) {}
  }
  function _djPrefScore(artist) {
    if (!artist) return 0;
    const store = _djGetPrefStore();
    return store[artist.toLowerCase()] || 0;
  }
  function _djRecordFeedback(track, delta) {
    if (!track || !track.artist) return;
    const store = _djGetPrefStore();
    const key = track.artist.toLowerCase();
    store[key] = Math.max(-3, Math.min(3, (store[key] || 0) + delta));
    _djSetPrefStore(store);
  }
  // Saring artis yang sering banget di-skip (skor <= -2), lalu urutkan
  // sisanya (setelah diacak) supaya artis yang lebih disukai lebih sering
  // muncul di depan queue. Kalau hasil saringan kelewat sedikit, jangan
  // dibuang beneran (biar queue tidak kosong).
  function _djApplyPreference(tracks) {
    const withPref = tracks.filter((t) => _djPrefScore(t.artist) > -2);
    const base = withPref.length >= 5 ? withPref : tracks;
    const shuffled = (typeof window._shuffleArray === 'function') ? window._shuffleArray(base.slice()) : base.slice();
    return shuffled.sort((a, b) => _djPrefScore(b.artist) - _djPrefScore(a.artist));
  }

  // ==========================================================================
  // BUILDER QUEUE — semua fungsi ini mengembalikan array track siap-pakai
  // (format sama dengan yang dipakai curQueue di vibexa.js, WAJIB punya
  // `_query` unik supaya next/prev/prefetch di vibexa.js tetap jalan).
  // ==========================================================================
  function _toTrackFromItunes(it) {
    if (!it || !it.trackName) return null;
    const thumb = (it.artworkUrl100 || '').replace('100x100bb', '600x600bb');
    return {
      title: it.trackName,
      artist: it.artistName || 'Unknown',
      thumb,
      album: it.collectionName || '',
      preview: it.previewUrl || null,
      videoId: null, photo: null,
      duration: it.trackTimeMillis ? Math.round(it.trackTimeMillis / 1000) : 0,
      _query: `${it.artistName || ''}|||${it.trackName || ''}|||${it.trackId || Math.random()}`
    };
  }
  function _ensureQuery(t) {
    if (t._query) return t;
    return { ...t, _query: `${t.artist || ''}|||${t.title || ''}|||${t.id || Math.random()}` };
  }

  async function _djSearchQuery(query) {
    let items = [];
    try {
      const [us, id] = await Promise.all([
        (typeof fetchItunesResults === 'function') ? fetchItunesResults(query, 'US').catch(() => []) : [],
        (typeof fetchItunesResults === 'function') ? fetchItunesResults(query, 'ID').catch(() => []) : []
      ]);
      const seen = new Set();
      [...(us || []), ...(id || [])].forEach((it) => {
        if (it && it.trackId != null && !seen.has(it.trackId)) { seen.add(it.trackId); items.push(it); }
      });
    } catch (e) { items = []; }
    return items.map(_toTrackFromItunes).filter(Boolean);
  }

  async function _djBuildMoodQueue(mood) {
    if (mood === 'favorites') return await _djBuildFavoritesQueue();
    const queries = MOOD_QUERIES[mood] || MOOD_QUERIES.surprise;
    const pick = queries[Math.floor(Math.random() * queries.length)];
    let tracks = await _djSearchQuery(pick);
    tracks = _djApplyPreference(tracks);
    return tracks.slice(0, 20);
  }

  async function _djBuildFavoritesQueue() {
    let names = [];
    try { names = Object.values((typeof favoriteArtists !== 'undefined' && favoriteArtists) || {}).map((a) => a && a.name).filter(Boolean); } catch (e) {}
    if (!names.length) {
      try {
        const recent = (typeof _getRecentlyPlayed === 'function') ? _getRecentlyPlayed() : [];
        names = [...new Set((recent || []).map((t) => t.artist).filter(Boolean))];
      } catch (e) {}
    }
    if (!names.length) return await _djBuildMoodQueue('surprise');

    const shuffled = (typeof window._shuffleArray === 'function') ? window._shuffleArray(names.slice()) : names.slice();
    const pickNames = shuffled.slice(0, 6);
    let results = [];
    try {
      results = await Promise.all(
        pickNames.map((n) => (typeof fetchArtistTopTracks === 'function') ? fetchArtistTopTracks(n, 8).catch(() => []) : [])
      );
    } catch (e) { results = []; }

    const seen = new Set();
    let tracks = [];
    results.forEach((arr) => (arr || []).forEach((t) => {
      const q = `${t.artist}|||${t.title}|||${t.id}`;
      if (!seen.has(q)) { seen.add(q); tracks.push({ ...t, _query: q }); }
    }));
    if (!tracks.length) return await _djBuildMoodQueue('surprise');
    tracks = _djApplyPreference(tracks);
    return tracks.slice(0, 20);
  }

  // Queue "personalized" default (dipakai saat DJ dinyalain TANPA nyebut
  // mood spesifik) — pakai rekomendasi harian yang SUDAH ADA di vibexa.js
  // (fetchRecommendedSongs, berbasis artis yang di-follow user), baru
  // fallback ke favorites/surprise kalau kosong.
  async function _djBuildDefaultQueue() {
    try {
      if (typeof fetchRecommendedSongs === 'function') {
        const reco = await fetchRecommendedSongs(false);
        if (reco && reco.length) {
          let tracks = reco.map(_ensureQuery);
          tracks = _djApplyPreference(tracks);
          if (tracks.length) return tracks.slice(0, 20);
        }
      }
    } catch (e) {}
    return await _djBuildFavoritesQueue();
  }

  // Isi ulang queue di belakang layar begitu user mendekati lagu terakhir,
  // supaya sesi DJ jalan terus tanpa henti kayak siaran radio beneran.
  async function _djMaybeRefillQueue() {
    try {
      if (!_djActive) return;
      const q = curQueue;
      if (!Array.isArray(q) || !q.length || !curTrack) return;
      const idx = q.findIndex((t) => t._query === curTrack._query);
      if (idx === -1 || idx < q.length - DJ_REFILL_THRESHOLD) return;
      const more = _djMood ? await _djBuildMoodQueue(_djMood) : await _djBuildDefaultQueue();
      const existing = new Set(q.map((t) => t._query));
      const fresh = (more || []).filter((t) => !existing.has(t._query));
      if (fresh.length && curQueue === q) curQueue = [...q, ...fresh.slice(0, 15)];
    } catch (e) {}
  }

  // ==========================================================================
  // PERSONA & KOMENTAR AI DJ — pakai Gemini yang SAMA dipakai Chat AI Lolu
  // (_aiCallGemini), tapi dengan system prompt khusus DJ (fokus komentar
  // singkat, bukan chat panjang) supaya cepat & pas didengar lewat TTS.
  // ==========================================================================
  function _djSystemPrompt() {
    const langNote = _djLang === 'en-US'
      ? 'Balas dalam Bahasa Inggris, gaya radio DJ yang santai & energik.'
      : 'Balas dalam Bahasa Indonesia gaul sehari-hari (bukan bahasa baku/formal), gaya radio DJ anak muda yang santai & energik.';
    return `Kamu adalah "Lolu" — persona yang sama seperti asisten chat AI Vibexa, tapi sekarang lagi "on air" sebagai AI DJ yang muterin lagu buat user di aplikasi musik Vibexa. ${langNote}
ATURAN WAJIB:
- Balasan HARUS berupa JSON murni: {"message": "..."} — tanpa markdown, tanpa backtick, tanpa teks apa pun di luar JSON itu.
- "message" singkat, maksimal sekitar 1-3 kalimat pendek — ini akan DIUCAPKAN lewat text-to-speech, bukan dibaca sebagai artikel.
- Jangan pernah bilang kamu AI/model bahasa, jangan minta maaf berlebihan, jangan tulis daftar lagu di dalam teks.
- Boleh sebut judul lagu/nama artis/genre secara natural kalau relevan dengan tugas yang diberikan.
- WAJIB variasikan gaya kalimat tiap kali dipanggil — jangan pernah pakai kalimat yang itu-itu terus/template.`;
  }

  async function _djAskGemini(taskPrompt, fallbackText) {
    if (typeof _aiCallGemini !== 'function') return fallbackText;
    try {
      const parsed = await _aiCallGemini([{ role: 'user', parts: [{ text: taskPrompt }] }], _djSystemPrompt(), 1);
      const msg = parsed && typeof parsed.message === 'string' && parsed.message.trim();
      return msg || fallbackText;
    } catch (e) {
      return fallbackText;
    }
  }

  function _trackDesc(track) {
    if (!track) return '';
    return `"${track.title}" oleh ${track.artist}${track.album ? ' (album: ' + track.album + ')' : ''}`;
  }

  async function _djGenerateIntro(track, isFirstOfSession) {
    const fallback = _t(`Sekarang muter ${_trackDesc(track)}. Selamat menikmati!`, `Now playing ${_trackDesc(track)}. Enjoy!`);
    const prompt = `TUGAS: Lagu baru mulai diputar di radio DJ kamu: ${_trackDesc(track)}. Kasih komentar singkat DJ sebelum/menemani lagu ini, boleh soal lagunya, artisnya, atau vibe/genrenya.`
      + (isFirstOfSession ? ' Ini lagu PERTAMA di sesi DJ kali ini, sapa usernya singkat juga sebelum masuk ke lagunya.' : '');
    return _djAskGemini(prompt, fallback);
  }

  async function _djGenerateMoodSwitch(track, mood) {
    const label = _moodLabel(mood);
    const fallback = _t(`Oke, ganti vibe ke ${label}! Sekarang muter ${_trackDesc(track)}.`, `Alright, switching the vibe to ${label}! Now playing ${_trackDesc(track)}.`);
    const prompt = `TUGAS: User baru minta kamu ganti mood/vibe musik ke "${label}". Kamu udah mulai muterin lagu pertama buat vibe ini: ${_trackDesc(track)}. Kasih komentar DJ singkat yang narasiin pergantian vibe ini sambil nyebut lagu pertamanya.`;
    return _djAskGemini(prompt, fallback);
  }

  // Komentar DJ buat lagu yang DIMINTA LANGSUNG oleh user (judul/artis
  // spesifik, lewat suara/teks) selagi di halaman Lolu DJ — beda dari
  // _djGenerateIntro (dipakai buat lagu pilihan DJ sendiri) karena di sini
  // Lolu WAJIB konfirmasi kalau ini lagu request-an user.
  async function _djGenerateRequestIntro(track) {
    const fallback = _t(`Oke, ini dia ${_trackDesc(track)} yang kamu minta. Tunggu bentar, langsung diputer!`, `Alright, here's ${_trackDesc(track)} you asked for. Coming right up!`);
    const prompt = `TUGAS: User baru saja MEMINTA LANGSUNG lagu ini diputar sambil dengerin radio DJ kamu: ${_trackDesc(track)}. Kasih komentar DJ singkat yang mengonfirmasi permintaan ini sebelum lagunya mulai (boleh sebut sedikit soal lagu/artisnya).`;
    return _djAskGemini(prompt, fallback);
  }

  // ==========================================================================
  // OUTPUT — suara (Piper TTS, reuse lolu-piper-tts.js) + teks singkat di
  // bubble status Lolu Voice kalau elemen-elemennya lagi ada di halaman.
  // Sengaja duplikat kecil dari UIState.setReply milik lolu-voice.js (yang
  // tidak diekspos publik) supaya modul ini tetap berdiri sendiri.
  // ==========================================================================
  function _showBubble(text) {
    try {
      document.querySelectorAll('#lolu-voice-bubble-text, #lv-status-text').forEach((el) => { el.textContent = text; });
      document.querySelectorAll('#lolu-voice-bubble, #lv-status-bubble').forEach((el) => el.classList.add('show'));
      const w = document.getElementById('lv-below-mic'); if (w) w.classList.add('lv-active');
      clearTimeout(_showBubble._t);
      _showBubble._t = setTimeout(() => {
        document.querySelectorAll('#lolu-voice-bubble, #lv-status-bubble').forEach((el) => el.classList.remove('show'));
        if (w) w.classList.remove('lv-active');
      }, 4200);
    } catch (e) {}
  }

  function _speak(text) {
    if (!text) return;
    _showBubble(text);
    if (window.LoluPiperTTS && typeof window.LoluPiperTTS.speakDJ === 'function') {
      window.LoluPiperTTS.speakDJ(text).catch(() => {
        try {
          if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.lang = _djLang; u.rate = 1.02; u.pitch = 1.05;
            window.speechSynthesis.speak(u);
          }
        } catch (e) {}
      });
    } else if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = _djLang; u.rate = 1.02; u.pitch = 1.05;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    }
  }

  // Versi _speak() yang mengembalikan Promise, baru resolve setelah Lolu
  // BENERAN selesai ngomong — dipakai buat "menahan" lagu (lihat
  // _djBeginHeldTrack/_djReleaseHeldTrack di atas) supaya musik baru mulai
  // bunyi SETELAH komentar DJ selesai, bukan bebarengan. Dikombinasikan
  // dengan estimasi durasi dari jumlah kata sebagai jaring pengaman kalau
  // Promise dari LoluPiperTTS.speakDJ ternyata resolve lebih cepat dari
  // audionya beneran selesai.
  function _speakAwait(text) {
    if (!text) return Promise.resolve();
    _showBubble(text);
    const wordCount = text.trim().split(/\s+/).length;
    const estMs = Math.min(15000, Math.max(1600, wordCount * 380));
    const minWait = new Promise((resolve) => setTimeout(resolve, estMs));

    let ttsPromise;
    if (window.LoluPiperTTS && typeof window.LoluPiperTTS.speakDJ === 'function') {
      ttsPromise = window.LoluPiperTTS.speakDJ(text).catch(() => _speakBrowserTTSAwait(text));
    } else {
      ttsPromise = _speakBrowserTTSAwait(text);
    }
    return Promise.all([ttsPromise, minWait]);
  }

  function _speakBrowserTTSAwait(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) { resolve(); return; }
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = _djLang; u.rate = 1.02; u.pitch = 1.05;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      } catch (e) { resolve(); }
    });
  }

  // ==========================================================================
  // UI SYNC — toggle DJ (topbar & input bar), badge "ON AIR", chip mood.
  // ==========================================================================
  function _refreshUI() {
    document.querySelectorAll('.lv-dj-toggle-btn').forEach((b) => {
      b.classList.toggle('active', _djActive);
      b.title = _djActive ? _t('Matikan mode DJ', 'Turn off DJ mode') : _t('Nyalakan mode DJ', 'Turn on DJ mode');
    });
    const badge = document.getElementById('lv-onair-badge');
    if (badge) badge.classList.toggle('show', _djActive);
    const badgeText = document.getElementById('lv-onair-badge-text');
    if (badgeText) badgeText.textContent = _djActive ? _t('ON AIR', 'ON AIR') : '';
    const wrap = document.getElementById('lv-below-mic');
    if (wrap) wrap.classList.toggle('lv-dj-active', _djActive);
    document.querySelectorAll('.lv-mood-chip').forEach((c) => {
      c.classList.toggle('active', !!_djMood && c.dataset.mood === _djMood);
    });
    const npGif = document.getElementById('np-dj-gif');
    if (npGif) { npGif.classList.toggle('show', _djActive); if (_djActive) _djSyncGifSize(); }
  }

  // Samakan ukuran #np-dj-gif (halaman Now Playing) dengan ukuran
  // #ai-fab-sleep-gif (burung tidur di tombol FAB) yang SUDAH ADA, supaya
  // tidak perlu duplikasi angka px secara manual di sini — otomatis ikut
  // kalau ukuran sleepbird.gif di CSS utama (vibexa.css) berubah suatu saat.
  function _djSyncGifSize() {
    try {
      const ref = document.getElementById('ai-fab-sleep-gif');
      const gif = document.getElementById('np-dj-gif');
      if (!ref || !gif) return;
      const cs = window.getComputedStyle(ref);
      if (cs && cs.width && cs.width !== 'auto' && parseFloat(cs.width) > 0) gif.style.width = cs.width;
      if (cs && cs.height && cs.height !== 'auto' && parseFloat(cs.height) > 0) gif.style.height = cs.height;
    } catch (e) {}
  }

  // ==========================================================================
  // HOOK PLAYBACK — bungkus loadPlay() milik vibexa.js (dipanggil setiap kali
  // lagu berganti, dari mana pun: next/prev/klik lagu/DJ sendiri) supaya bisa
  // (1) catat implicit feedback lagu SEBELUMNYA (skip vs selesai), dan
  // (2) picu komentar DJ + auto-refill queue untuk lagu BARU, TANPA mengubah
  // satu baris pun kode asli loadPlay di vibexa.js.
  // ==========================================================================
  let _djPrevTrack = null;
  let _djPrevStartedAt = 0;

  function _djBeforeTrackChange(nextTrack) {
    try {
      if (_djPrevTrack && _djPrevStartedAt) {
        const elapsedSec = (Date.now() - _djPrevStartedAt) / 1000;
        const dur = _djPrevTrack.duration || 0;
        const frac = dur > 0 ? elapsedSec / dur : 1;
        // Skip cepat (belum sampai 40% lagu) -> sinyal negatif ringan.
        // Kedengeran cukup lama -> sinyal positif ringan. Ini SEMUA implisit,
        // user tidak perlu kasih rating apa pun secara eksplisit.
        _djRecordFeedback(_djPrevTrack, frac < 0.4 ? -1 : 1);
      }
    } catch (e) {}
    _djPrevTrack = nextTrack;
    _djPrevStartedAt = Date.now();
    if (_djActive) _djOnNewTrackStarted(nextTrack);
  }

  async function _djOnNewTrackStarted(track) {
    _djMaybeRefillQueue();
    if (_djSuppressNextAutoCommentary) { _djSuppressNextAutoCommentary = false; return; }
    const now = Date.now();
    if (now - _djLastCommentaryAt < DJ_COMMENTARY_COOLDOWN_MS) return; // hindari spam pas skip beruntun
    _djLastCommentaryAt = now;
    const commentary = await _djGenerateIntro(track, false);
    if (_djActive) _speak(commentary); // batal ngomong kalau user keburu matiin DJ
  }

  const _origLoadPlay = window.loadPlay;
  if (typeof _origLoadPlay === 'function') {
    window.loadPlay = function (track, fromPlId) {
      _djBeforeTrackChange(track);
      return _origLoadPlay.apply(this, arguments);
    };
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  function isActive() { return _djActive; }

  async function start(mood) {
    if (_djActive && !mood) {
      const t = _t('Mode DJ udah nyala nih, tinggal dengerin aja!', 'DJ mode is already on, just sit back and enjoy!');
      _showBubble(t);
      return t;
    }
    _djActive = true;
    _refreshUI();

    let queue, isMoodStart = !!mood;
    queue = mood ? await _djBuildMoodQueue(mood) : await _djBuildDefaultQueue();

    if (!queue || !queue.length) {
      _djActive = false; _refreshUI();
      const t = _t('Aduh, Lolu belum nemu lagu buat mode DJ sekarang. Coba lagi bentar ya.', "Hmm, I couldn't find songs for DJ mode right now. Try again in a bit.");
      _showBubble(t);
      return t;
    }

    _djMood = mood || null;
    curQueue = queue;
    _djSuppressNextAutoCommentary = true;
    _djLastCommentaryAt = Date.now();
    _djBeginHeldTrack(queue[0]); // buka Now Playing + tahan audio sampai Lolu selesai ngomong

    const commentary = isMoodStart
      ? await _djGenerateMoodSwitch(queue[0], mood)
      : await _djGenerateIntro(queue[0], true);
    _refreshUI();
    await _speakAwait(commentary);
    _djReleaseHeldTrack();
    return commentary;
  }

  async function setMood(mood) {
    _showBubble(_t('Menyesuaikan vibe...', 'Switching up the vibe...'));
    _djActive = true;
    _refreshUI();

    const queue = await _djBuildMoodQueue(mood);
    if (!queue || !queue.length) {
      const t = _t(`Belum nemu lagu buat vibe "${_moodLabel(mood)}" sekarang, coba vibe lain ya.`, `Couldn't find songs for "${_moodLabel(mood)}" right now, try another vibe.`);
      _showBubble(t);
      return t;
    }

    _djMood = mood;
    curQueue = queue;
    _djSuppressNextAutoCommentary = true;
    _djLastCommentaryAt = Date.now();
    _djBeginHeldTrack(queue[0]); // buka Now Playing + tahan audio sampai Lolu selesai ngomong

    const commentary = await _djGenerateMoodSwitch(queue[0], mood);
    _refreshUI();
    await _speakAwait(commentary);
    _djReleaseHeldTrack();
    return commentary;
  }

  // Dipanggil dari lolu-voice.js ketika user MEMINTA LANGSUNG suatu lagu
  // (judul/artis, playlist, atau hasil pencarian) selagi berada di halaman
  // Lolu DJ (#lolu-voice-page) — beda dari start()/setMood() yang isi
  // queue-nya dipilihkan sendiri oleh DJ. Di sini queue-nya sudah
  // ditentukan dari luar (`track` = lagu yang diminta, `queueList` = daftar
  // terkait yang sudah ditemukan MusicFinder di lolu-voice.js, dipakai buat
  // next/prev). Otomatis: (1) nyalain mode DJ kalau belum aktif, (2) buka
  // halaman Now Playing lagu tsb, (3) TAHAN audio sampai Lolu selesai
  // ngomong duluan, baru lagunya bunyi.
  async function playRequestedSong(track, queueList) {
    if (!track) {
      const t = _t('Maaf, Lolu nggak nemu lagunya.', "Sorry, I couldn't find that song.");
      _showBubble(t);
      return t;
    }
    _djActive = true;
    _djMood = null;
    _refreshUI();

    curQueue = (Array.isArray(queueList) && queueList.length) ? queueList.map(_ensureQuery) : [_ensureQuery(track)];
    _djSuppressNextAutoCommentary = true;
    _djLastCommentaryAt = Date.now();
    _djBeginHeldTrack(_ensureQuery(track)); // buka Now Playing + tahan audio sampai Lolu selesai ngomong

    const commentary = await _djGenerateRequestIntro(track);
    _refreshUI();
    await _speakAwait(commentary);
    _djReleaseHeldTrack();
    return commentary;
  }

  function stop() {
    if (!_djActive) {
      const t = _t('Mode DJ memang lagi mati.', 'DJ mode is already off.');
      _showBubble(t);
      return t;
    }
    _djActive = false;
    _djMood = null;
    if (_djHoldPlaybackForSpeech) { _djHoldPlaybackForSpeech = false; clearInterval(_djHoldWatchTimer); }
    _refreshUI();
    const t = _t('Oke, mode DJ Lolu matiin dulu ya. Panggil lagi kapan aja kalau mau nyala lagi!', 'Alright, turning DJ mode off for now. Call me back anytime!');
    _showBubble(t);
    return t;
  }

  function toggle() { return _djActive ? stop() : start(); }

  // Ngobrol soal lagu yang lagi diputar / minta rekomendasi / gali info
  // artis — TIDAK harus dalam mode DJ aktif (bisa dipakai kapan saja selagi
  // ada lagu yang lagi diputar), dan TIDAK ikut nyampur ke riwayat Chat AI
  // utama (ini obrolan ambient DJ, bukan chat biasa).
  async function askAboutCurrentSong(question) {
    const track = curTrack;
    const ctx = track
      ? `User lagi dengerin ${_trackDesc(track)}.`
      : 'Tidak ada lagu yang sedang diputar saat ini — kalau pertanyaannya soal lagu yang sedang diputar, bilang belum ada lagu yang nyala.';
    const prompt = `TUGAS: User nanya ke kamu sambil lagi dengerin radio DJ kamu: "${question}". ${ctx} Jawab singkat & natural gaya radio DJ (1-3 kalimat, boleh sedikit lebih panjang kalau memang perlu jelasin).`;
    const fallback = _t('Hmm, koneksi ke Lolu lagi gangguan dikit. Coba tanya lagi ya.', "Hmm, I'm having connection trouble. Try asking again.");
    const answer = await _djAskGemini(prompt, fallback);
    _speak(answer);
    return answer;
  }

  window.LoluDJ = {
    start, stop, toggle, setMood, isActive,
    askAboutCurrentSong, playRequestedSong,
    _setLang: _setLang
  };

  // ── Init UI begitu DOM siap (badge/tombol mulai dalam kondisi nonaktif) ──
  document.addEventListener('DOMContentLoaded', _refreshUI);

  // ==========================================================================
  // TEXT INPUT — bungkus sendAIChatMessage() milik vibexa.js supaya
  // permintaan DJ yang DIKETIK ("play something chill", "jadi dj", dst) di
  // kotak Chat AI juga dikenali & dieksekusi lewat LoluDJ, pakai pola yang
  // SAMA dengan voice command (LoluVoiceDJ.parseIntent) — bukan parser
  // terpisah. Permintaan yang BUKAN soal DJ tetap diteruskan apa adanya ke
  // sendAIChatMessage() asli (ngobrol biasa / cari lagu manual dst).
  // ==========================================================================
  const _origSendAIChatMessage = window.sendAIChatMessage;
  if (typeof _origSendAIChatMessage === 'function') {
    window.sendAIChatMessage = function () {
      try {
        const inp = document.getElementById('ai-chat-input');
        const text = inp ? inp.value.trim() : '';
        if (text && window.LoluVoiceDJ && typeof window.LoluVoiceDJ.parseIntent === 'function') {
          const intent = window.LoluVoiceDJ.parseIntent(text);
          if (intent && typeof intent.intent === 'string' && intent.intent.indexOf('dj_') === 0) {
            inp.value = '';
            try { inp.style.height = ''; } catch (e) {}
            _handleTypedDJIntent(intent, text);
            return;
          }
        }
      } catch (e) { /* aman jatuh ke chat biasa kalau ada error tak terduga */ }
      return _origSendAIChatMessage.apply(this, arguments);
    };
  }

  // Jalankan intent DJ hasil ketikan, lalu catat sebagai satu giliran chat
  // (tampilan doang, sama seperti voice command) supaya user tetap punya
  // jejak percakapan di Chat AI seperti biasa.
  async function _handleTypedDJIntent(intent, originalText) {
    let replyText = '';
    switch (intent.intent) {
      case 'dj_start': replyText = await start(); break;
      case 'dj_stop': replyText = stop(); break;
      case 'dj_mood': replyText = await setMood(intent.mood); break;
      case 'dj_ask': replyText = await askAboutCurrentSong(originalText); break;
      default: replyText = _t('Oke!', 'Okay!');
    }
    try {
      if (typeof aiChatDisplay !== 'undefined' && Array.isArray(aiChatDisplay) && typeof renderAIChatMessages === 'function') {
        aiChatDisplay.push({ role: 'user', text: originalText, viaVoice: false });
        aiChatDisplay.push({ role: 'assistant', text: replyText, songs: [], playlistName: null, viaDJ: true });
        renderAIChatMessages();
        if (typeof _aiSaveChatState === 'function') _aiSaveChatState();
      }
    } catch (e) {}
  }

})();
