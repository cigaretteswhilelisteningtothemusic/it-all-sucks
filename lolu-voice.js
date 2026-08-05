/* ==========================================================================
   LOLU VOICE DJ
   ==========================================================================
   Fitur voice command untuk halaman Chat AI (Lolu). User cukup pencet tombol
   mic — TANPA wake word — ngomong satu perintah ATAU langsung ngobrol biasa,
   dan Lolu langsung merespons: kalau itu printah player (putar lagu, pause,
   next, atur volume, dst) langsung dieksekusi; kalau bukan printah yang
   dikenali, otomatis disambungkan ke AI Lolu (Gemini, lewat _aiCallGemini
   milik vibexa.js — AI YANG SAMA dipakai Chat AI berbasis teks) supaya user
   beneran bisa ngobrol pakai suara. Semua balasan Lolu keluar lewat teks +
   suara (Text-to-Speech).

   Modul ini sengaja dipisah dari vibexa.js dan berdiri sendiri
   (namespace `LoluVoiceDJ`) supaya gampang dikembangkan lebih lanjut tanpa
   mengubah logic chat AI (Gemini) yang sudah ada — modul ini hanya MEMAKAI
   ULANG fungsi & state milik vibexa.js (aiChatDisplay, aiApiHistory,
   _aiCallGemini, dkk), bukan bikin koneksi AI baru. Terdiri dari beberapa
   sub-modul independen:

     1. SpeechInput        -> Speech-to-Text (Web Speech API)
     2. IntentParser       -> ubah teks jadi { intent, ...params } terstruktur
     3. MusicFinder        -> cari lagu (iTunes) / artist (Deezer) terbaik
     4. PlaylistFinder      -> cocokkan nama playlist milik user yang login
     5. PlaybackController -> eksekusi command ke player utama Vibexa
     6. UIState             -> tombol mic, bubble "Listening.../Processing...",
                               animasi Lolu
     7. VoiceOutput         -> balasan suara (SpeechSynthesis / TTS)
     8. AIChatBridge        -> sambungkan ucapan yang BUKAN printah player ke
                               obrolan AI (Gemini) yang sama dipakai Chat AI
                               teks di vibexa.js, biar user bisa ngobrol
                               beneran pakai suara, satu konteks sama chat teks

   Semua sub-modul TIDAK saling tahu detail satu sama lain secara langsung —
   mereka hanya dipanggil berurutan oleh `LoluVoiceDJ.toggleListening()`,
   sehingga command baru gampang ditambah cukup dengan menambah 1 pola regex
   di IntentParser + 1 case di PlaybackController.
   ========================================================================== */
(function () {
  'use strict';

  // ── State bahasa aktif untuk voice command. Bisa di-toggle user lewat
  // tombol "ID/EN" di sebelah mic (lihat toggleLanguage). Disimpan di
  // localStorage supaya tetap ingat pilihan user antar sesi. ──────────────
  const LANG_STORAGE_KEY = 'vibexa_lolu_voice_lang';
  const SUPPORTED_LANGS = { 'id-ID': 'ID', 'en-US': 'EN' };
  let currentLang = localStorage.getItem(LANG_STORAGE_KEY) || 'id-ID';
  if (!SUPPORTED_LANGS[currentLang]) currentLang = 'id-ID';

  // ==========================================================================
  // 1) SPEECH INPUT — Speech-to-Text lewat Web Speech API browser (tidak
  //    butuh server sama sekali). Sengaja continuous=false + interimResults
  //    =false: user ngomong SATU perintah, otomatis berhenti sendiri begitu
  //    selesai bicara (atau timeout), tanpa perlu wake word apa pun.
  // ==========================================================================
  const SpeechInput = (function () {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognizer = null;
    let listening = false;
    let safetyTimer = null;

    function isSupported() { return !!SR; }

    function _build() {
      const r = new SR();
      r.continuous = false;
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.lang = currentLang;
      return r;
    }

    // start(onResult, onError, onEnd) — mulai dengarkan sekali. onResult
    // dipanggil dengan teks hasil transkrip; onEnd selalu dipanggil di akhir
    // (baik sukses, gagal, atau timeout) supaya UI bisa reset.
    function start(onResult, onError, onEnd) {
      if (!isSupported()) { onError && onError('unsupported'); onEnd && onEnd(); return; }
      if (listening) return;
      recognizer = _build();
      listening = true;

      recognizer.onresult = (e) => {
        const text = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
        onResult && onResult((text || '').trim());
      };
      recognizer.onerror = (e) => { onError && onError(e.error || 'error'); };
      recognizer.onend = () => {
        listening = false;
        clearTimeout(safetyTimer);
        onEnd && onEnd();
      };

      try { recognizer.start(); }
      catch (e) { listening = false; onError && onError('start_failed'); onEnd && onEnd(); return; }

      // Timeout jaga-jaga: kalau browser tidak pernah fire onresult/onend
      // (mis. user diam saja / mic bermasalah), paksa berhenti setelah 8 detik.
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => { stop(); }, 8000);
    }

    function stop() {
      if (recognizer && listening) { try { recognizer.stop(); } catch (e) {} }
    }

    function setLang(lang) { currentLang = lang; }
    function isListening() { return listening; }

    return { isSupported, start, stop, setLang, isListening };
  })();

  // ==========================================================================
  // 2) INTENT PARSER — "AI intent parser" lokal berbasis pola bahasa alami
  //    (ID + EN) yang mengubah teks bebas jadi objek command terstruktur.
  //    Berjalan 100% di browser (tanpa API/server) supaya responsif &
  //    tetap jalan walau koneksi lambat. Bisa dengan mudah disambungkan ke
  //    LLM (mis. _aiCallGemini yang sudah ada di vibexa.js) sebagai fallback
  //    untuk ucapan yang lebih rumit/ambigu — lihat fallback di bagian bawah.
  // ==========================================================================
  const IntentParser = (function () {

    function _clean(t) { return (t || '').trim().replace(/\s+/g, ' '); }

    // "Play Baby by Justin Bieber" / "Putar Baby dari Justin Bieber" -> title+artist
    const BY_PATTERNS = [
      /\bby\b/i, /\bdari\b/i, /\boleh\b/i
    ];

    function parse(rawText) {
      const text = _clean(rawText);
      if (!text) return { intent: 'unknown', raw: rawText };
      const t = text.toLowerCase();

      // ── Playback controls (dicek duluan karena paling pendek/spesifik) ──
      if (/^(pause|jeda|berhenti sebentar)$/i.test(t)) return { intent: 'pause', raw: text };
      if (/^(resume|lanjutkan|lanjut|play|putar)$/i.test(t)) return { intent: 'resume', raw: text };
      if (/^(stop|berhenti|hentikan)( musik(nya)?)?$/i.test(t)) return { intent: 'stop', raw: text };
      if (/(next|skip|lagu (selanjutnya|berikutnya)|selanjutnya|berikutnya)/i.test(t) && !/playlist/i.test(t)) return { intent: 'next_track', raw: text };
      if (/(previous|sebelumnya|lagu (tadi|kemarin)|kembali ke lagu)/i.test(t)) return { intent: 'previous_track', raw: text };
      if (/shuffle|acak/i.test(t)) return { intent: 'shuffle', raw: text };
      if (/repeat (this )?song|ulangi lagu ini|putar ulang lagu ini/i.test(t)) return { intent: 'repeat_one', raw: text };
      if (/^repeat$|^ulangi$|^putar ulang$/i.test(t)) return { intent: 'repeat_toggle', raw: text };
      if (/mute|bisukan/i.test(t) && !/unmute|jangan bisukan/i.test(t)) return { intent: 'mute', raw: text };
      if (/unmute|jangan bisukan|suarakan lagi/i.test(t)) return { intent: 'unmute', raw: text };

      // "set volume to 50%" / "atur volume ke 50" / "volume 50"
      let m = t.match(/(?:set\s+)?volume\s*(?:to|ke|jadi)?\s*(\d{1,3})\s*%?/i);
      if (m) return { intent: 'set_volume', value: Math.max(0, Math.min(100, parseInt(m[1], 10))), raw: text };

      if (/volume up|naikkan volume|volume naik|kencangkan|kenceng(in)?/i.test(t)) return { intent: 'volume_up', raw: text };
      if (/volume down|turunkan volume|volume turun|kecilkan|pelankan/i.test(t)) return { intent: 'volume_down', raw: text };

      // ── Search: "find songs by X" / "search for X" / "cari lagu X" ──
      m = text.match(/^(?:find songs by|cari lagu(?:nya)? dari|search for|cari)\s+(.+)$/i);
      if (m) return { intent: 'search', query: _clean(m[1]), raw: text };

      // ── Play playlist: "play my workout playlist" / "putar playlist workout ku" ──
      m = text.match(/^(?:play|putar)\s+my\s+(.+?)\s+playlist$/i)
        || text.match(/^(?:play|putar)\s+playlist\s+(?:saya\s+|ku\s+)?(.+)$/i)
        || text.match(/^(?:play|putar)\s+(.+?)\s+playlist(?:\s+(?:saya|ku))?$/i)
        || text.match(/^(?:play|putar)\s+playlist\s+(.+?)(?:\s+(?:saya|ku))?$/i);
      if (m) return { intent: 'play_playlist', playlist: _clean(m[1]), raw: text };

      // ── Play favorites / liked songs khusus ──
      if (/(play|putar)\s+(my\s+)?(favorites?|favorit(ku)?|liked songs|lagu (yang )?disukai)/i.test(t)) {
        return { intent: 'play_playlist', playlist: 'Liked Songs', raw: text };
      }

      // ── Play song: "play X by Y" / "putar X dari Y" ──
      m = text.match(/^(?:play|putar)\s+(.+)$/i);
      if (m) {
        const rest = _clean(m[1]);
        // pisahkan "title by/dari artist" kalau ada
        for (const pat of BY_PATTERNS) {
          const parts = rest.split(pat);
          if (parts.length >= 2) {
            const title = _clean(parts[0]);
            const artist = _clean(parts.slice(1).join(' '));
            if (title && artist) return { intent: 'play_song', title, artist, raw: text };
          }
        }
        // Tidak ada pemisah "by/dari" -> bisa jadi judul lagu SAJA, atau
        // nama artis saja ("Play Justin Bieber", "Play Taylor Swift").
        // Kita tandai sebagai 'play_query' — MusicFinder akan mencoba
        // mencocokkan ke lagu dulu, lalu fallback ke top track artist.
        return { intent: 'play_query', query: rest, raw: text };
      }

      return { intent: 'unknown', raw: text };
    }

    return { parse };
  })();

  // ==========================================================================
  // 3) MUSIC FINDER — bungkus fungsi pencarian lagu/artis yang SUDAH ADA di
  //    vibexa.js (fetchItunesResults, fetchArtistTopTracks) supaya hasil
  //    pencarian voice command konsisten dengan hasil pencarian teks biasa.
  // ==========================================================================
  const MusicFinder = (function () {

    function _toTrack(it) {
      const thumb = (it.artworkUrl100 || '').replace('100x100bb', '600x600bb');
      return {
        title: it.trackName || 'Unknown',
        artist: it.artistName || 'Unknown',
        thumb,
        album: it.collectionName || '',
        preview: it.previewUrl || null,
        videoId: null, photo: null,
        duration: it.trackTimeMillis ? Math.round(it.trackTimeMillis / 1000) : 0,
        _query: `${it.artistName || ''}|||${it.trackName || ''}|||${it.trackId || Math.random()}`
      };
    }

    // Cari lagu spesifik (judul [+ artis opsional]), kembalikan track terbaik + daftar lengkap
    async function findSong(title, artist) {
      const q = artist ? `${title} ${artist}` : title;
      let items = [];
      try {
        const [idItems, usItems] = await Promise.all([
          window.fetchItunesResults ? fetchItunesResults(q, 'ID').catch(() => []) : [],
          window.fetchItunesResults ? fetchItunesResults(q, 'US').catch(() => []) : []
        ]);
        const seen = new Set();
        [...idItems, ...usItems].forEach(it => { if (!seen.has(it.trackId)) { items.push(it); seen.add(it.trackId); } });
      } catch (e) { items = []; }
      if (!items.length) return { track: null, all: [] };

      // Prioritaskan hasil yang judulnya paling cocok, dan kalau ada nama
      // artis, prioritaskan yang artist-nya juga cocok.
      const tl = title.toLowerCase();
      const al = (artist || '').toLowerCase();
      items.sort((a, b) => {
        const aScore = ((a.trackName || '').toLowerCase().includes(tl) ? 2 : 0) + (al && (a.artistName || '').toLowerCase().includes(al) ? 2 : 0);
        const bScore = ((b.trackName || '').toLowerCase().includes(tl) ? 2 : 0) + (al && (b.artistName || '').toLowerCase().includes(al) ? 2 : 0);
        return bScore - aScore;
      });
      return { track: _toTrack(items[0]), all: items.map(_toTrack) };
    }

    // Cari lagu-lagu teratas dari seorang artis (pakai Deezer via fungsi yang
    // sudah ada di vibexa.js: fetchArtistTopTracks)
    async function findArtistTracks(artistName) {
      try {
        if (typeof window.fetchArtistTopTracks !== 'function') return [];
        const tracks = await fetchArtistTopTracks(artistName, 15);
        return (tracks || []).map(t => ({
          title: t.title, artist: t.artist, thumb: t.thumb, album: '',
          preview: t.preview || null, videoId: null, photo: null,
          duration: t.duration, _query: `${t.artist}|||${t.title}|||${t.id}`
        }));
      } catch (e) { return []; }
    }

    return { findSong, findArtistTracks };
  })();

  // ==========================================================================
  // 4) PLAYLIST FINDER — cocokkan nama playlist yang diucapkan user dengan
  //    playlist yang dia punya (object global `playlists` di vibexa.js).
  // ==========================================================================
  const PlaylistFinder = (function () {
    function findByName(spokenName) {
      const pls = window.playlists || {};
      const target = (spokenName || '').toLowerCase().trim();
      if (!target) return null;
      let best = null, bestScore = -1;
      Object.keys(pls).forEach(id => {
        const pl = pls[id];
        if (!pl || !pl.name) return;
        const name = pl.name.toLowerCase();
        let score = -1;
        if (name === target) score = 3;
        else if (name.includes(target) || target.includes(name)) score = 2;
        else if (target.split(' ').some(w => w.length > 2 && name.includes(w))) score = 1;
        if (score > bestScore) { bestScore = score; best = pl; }
      });
      return bestScore >= 1 ? best : null;
    }
    return { findByName };
  })();

  // ==========================================================================
  // 5) PLAYBACK CONTROLLER — satu-satunya sub-modul yang benar-benar
  //    menyentuh player (fungsi-fungsi global milik vibexa.js). Menerima
  //    objek intent terstruktur dari IntentParser, TIDAK PERNAH mem-parsing
  //    teks mentah sendiri.
  // ==========================================================================
  const PlaybackController = (function () {

    function _hasCurTrack() { return !!window.curTrack; }

    function _playTrackAsQueue(track, queue) {
      if (queue && queue.length) window.curQueue = queue;
      if (typeof window.loadPlay === 'function') window.loadPlay(track, null);
    }

    function pause() {
      if (window.YTP && window.playing) { try { window.YTP.pauseVideo(); } catch (e) {} return true; }
      return false;
    }
    function resume() {
      if (!_hasCurTrack()) return false;
      if (window.YTP && !window.playing) { try { window.YTP.playVideo(); } catch (e) {} return true; }
      if (!window.YTP && typeof window._togglePlayPause === 'function') { window._togglePlayPause(); return true; }
      return false;
    }
    function stop() {
      if (window.YTP) { try { window.YTP.pauseVideo(); window.YTP.seekTo(0); } catch (e) {} return true; }
      return false;
    }
    function next() { if (typeof window.playNext === 'function') { window.playNext(); return true; } return false; }
    function prev() { if (typeof window.playPrev === 'function') { window.playPrev(); return true; } return false; }
    function repeatToggle() { if (typeof window.toggleRepeatMode === 'function') { window.toggleRepeatMode(); return window._repeatMode; } return null; }
    function repeatOne() {
      // Paksa mode ke 'one' langsung (bukan cuma toggle bergilir)
      if (typeof window.toggleRepeatMode !== 'function') return null;
      let guard = 0;
      while (window._repeatMode !== 'one' && guard < 3) { window.toggleRepeatMode(); guard++; }
      return window._repeatMode;
    }
    function shuffle() {
      // Acak antrian (curQueue) yang sedang berjalan, kalau ada, lalu lanjut
      // dari lagu yang sedang diputar. Ini best-effort karena Vibexa belum
      // punya toggle "shuffle mode" permanen di player utama.
      if (Array.isArray(window.curQueue) && window.curQueue.length > 1 && typeof window._shuffleArray === 'function') {
        const rest = window.curQueue.filter(t => !window.curTrack || t.title !== window.curTrack.title || t.artist !== window.curTrack.artist);
        window.curQueue = [window.curTrack, ...window._shuffleArray(rest)].filter(Boolean);
        return true;
      }
      return false;
    }

    function _volEl() { return document.getElementById('vol'); }
    function _applyVolume(v) {
      v = Math.max(0, Math.min(100, Math.round(v)));
      const el = _volEl();
      if (el) { el.value = v; el.dispatchEvent(new Event('input')); }
      else {
        if (window.YTP) { try { window.YTP.setVolume(v); } catch (e) {} }
        if (window.spAudio) { try { window.spAudio.volume = v / 100; } catch (e) {} }
      }
      return v;
    }
    function setVolume(v) { return _applyVolume(v); }
    function volumeUp() { const el = _volEl(); const cur = el ? parseInt(el.value) || 0 : 50; return _applyVolume(cur + 15); }
    function volumeDown() { const el = _volEl(); const cur = el ? parseInt(el.value) || 0 : 50; return _applyVolume(cur - 15); }

    let _preMuteVolume = null;
    function mute() {
      const el = _volEl();
      _preMuteVolume = el ? (parseInt(el.value) || 0) : 50;
      _applyVolume(0);
    }
    function unmute() { _applyVolume(_preMuteVolume != null && _preMuteVolume > 0 ? _preMuteVolume : 50); _preMuteVolume = null; }

    function duckVolume() {
      const el = _volEl();
      const cur = el ? (parseInt(el.value) || 0) : 0;
      if (cur > 20) { _lastVolumeBeforeDuck = cur; _applyVolume(Math.round(cur * 0.18)); return true; }
      _lastVolumeBeforeDuck = null;
      return false;
    }
    let _lastVolumeBeforeDuck = null;
    function restoreVolumeAfterDuck() {
      if (_lastVolumeBeforeDuck != null) { _applyVolume(_lastVolumeBeforeDuck); _lastVolumeBeforeDuck = null; }
    }

    function playSongTrack(track, queue) { _playTrackAsQueue(track, queue); }
    function playPlaylist(pl) {
      if (!pl || !pl.tracks || !pl.tracks.length) return false;
      window.curQueue = [...pl.tracks];
      if (typeof window.loadPlay === 'function') window.loadPlay(pl.tracks[0], pl.id);
      return true;
    }

    return {
      pause, resume, stop, next, prev, repeatToggle, repeatOne, shuffle,
      setVolume, volumeUp, volumeDown, mute, unmute,
      duckVolume, restoreVolumeAfterDuck,
      playSongTrack, playPlaylist,
      hasCurTrack: _hasCurTrack
    };
  })();

  // ==========================================================================
  // 6) UI STATE MANAGER — tombol mic, bubble status, animasi Lolu. Tidak
  //    tahu apa-apa soal player atau parsing — cuma render state.
  // ==========================================================================
  const UIState = (function () {
    function micBtn() { return document.getElementById('lolu-mic-btn'); }
    function bubble() { return document.getElementById('lolu-voice-bubble'); }
    function bubbleText() { return document.getElementById('lolu-voice-bubble-text'); }
    function headIcon() { return document.querySelector('#ai-chat-overlay .ai-chat-head-icon img'); }

    function setIdle() {
      const b = micBtn(); if (b) b.classList.remove('listening', 'processing');
      const bub = bubble(); if (bub) bub.classList.remove('show');
      const hi = headIcon(); if (hi) hi.classList.remove('lolu-voice-pulsing');
    }
    function setListening() {
      const b = micBtn(); if (b) { b.classList.add('listening'); b.classList.remove('processing'); }
      const bub = bubble(); const txt = bubbleText();
      if (bub && txt) { txt.textContent = currentLang === 'id-ID' ? 'Mendengarkan...' : 'Listening...'; bub.classList.add('show'); }
      const hi = headIcon(); if (hi) hi.classList.add('lolu-voice-pulsing');
    }
    function setProcessing(heardText) {
      const b = micBtn(); if (b) { b.classList.remove('listening'); b.classList.add('processing'); }
      const bub = bubble(); const txt = bubbleText();
      if (bub && txt) {
        txt.textContent = (currentLang === 'id-ID' ? 'Memproses: ' : 'Processing: ') + '“' + (heardText || '') + '”';
        bub.classList.add('show');
      }
    }
    function setReply(text) {
      const bub = bubble(); const txt = bubbleText();
      if (bub && txt) { txt.textContent = text; bub.classList.add('show'); }
      setTimeout(() => { const bub2 = bubble(); if (bub2) bub2.classList.remove('show'); }, 3200);
      const b = micBtn(); if (b) b.classList.remove('listening', 'processing');
      const hi = headIcon(); if (hi) hi.classList.remove('lolu-voice-pulsing');
    }
    function setError(text) { setReply(text); }
    function setLangBtnLabel(lang) {
      const b = document.getElementById('lolu-mic-lang-btn');
      if (b) b.textContent = SUPPORTED_LANGS[lang] || 'ID';
    }
    return { setIdle, setListening, setProcessing, setReply, setError, setLangBtnLabel };
  })();

  // ==========================================================================
  // 7) VOICE OUTPUT — Text-to-Speech pakai SpeechSynthesis bawaan browser,
  //    supaya Lolu benar-benar "berbicara" balik ke user (opsional, otomatis
  //    dimatikan kalau browser tidak mendukung).
  // ==========================================================================
  const VoiceOutput = (function () {
    const synth = window.speechSynthesis;
    function isSupported() { return !!synth; }
    function speak(text) {
      if (!isSupported() || !text) return;
      try {
        synth.cancel(); // hentikan ucapan sebelumnya kalau masih jalan
        const u = new SpeechSynthesisUtterance(text);
        u.lang = currentLang;
        u.rate = 1.02;
        u.pitch = 1.05;
        synth.speak(u);
      } catch (e) {}
    }
    return { isSupported, speak };
  })();

  // ==========================================================================
  // 8) AI CHAT BRIDGE — kalau ucapan user TIDAK dikenali IntentParser sebagai
  //    printah player (intent 'unknown'), itu artinya user lagi BENERAN
  //    ngobrol sama Lolu (curhat, nanya, basa-basi, dll), bukan minta puter
  //    lagu. Di sinilah suara disambungkan ke "otak" AI Lolu yang sama
  //    persis dipakai Chat AI berbasis teks di vibexa.js (Gemini, lewat
  //    _aiCallGemini + GEMINI_PROXY_URLS) — bukan AI/model terpisah.
  //
  //    vibexa.js & lolu-voice.js sama-sama <script> classic (bukan module)
  //    yang dimuat di halaman yang sama, jadi semua deklarasi top-level di
  //    vibexa.js (aiChatDisplay, aiApiHistory, _aiCallGemini,
  //    _aiBuildSystemPrompt, dst — lihat AI_SYSTEM_PROMPT & sendAIChatMessage
  //    di vibexa.js) otomatis "kelihatan" dari sini lewat scope chain,
  //    TANPA perlu window.* ataupun mengubah vibexa.js sama sekali.
  //
  //    Riwayat obrolan (aiChatDisplay/aiApiHistory) dipakai bareng2 sama
  //    Chat AI teks, supaya Lolu punya SATU konteks obrolan yang nyambung
  //    baik user ngetik maupun ngomong lewat mic.
  // ==========================================================================
  const AIChatBridge = (function () {

    function isReady() {
      return typeof _aiCallGemini === 'function'
        && typeof aiChatDisplay !== 'undefined'
        && typeof aiApiHistory !== 'undefined';
    }

    // Kirim `text` ke AI Lolu (Gemini) persis seperti sendAIChatMessage() di
    // vibexa.js, lalu balikin teks balasannya (buat ditampilkan di bubble
    // voice + diucapkan lewat TTS). Riwayat API, render bubble teks+lagu di
    // overlay Chat AI, penyimpanan state, follow-up otomatis, dsb, semuanya
    // sudah ditangani lewat fungsi2 vibexa.js yang sama dipakai chat teks —
    // jadi hasil & perilakunya konsisten 100% dengan ngobrol lewat keyboard.
    async function chat(text) {
      if (!isReady()) {
        return reply(
          'Fitur ngobrolnya lagi belum siap, coba lagi bentar ya.',
          "Chat isn't ready yet, please try again in a bit."
        );
      }

      aiChatDisplay.push({ role: 'user', text, viaVoice: true });
      aiApiHistory.push({ role: 'user', parts: [{ text }] });
      if (typeof renderAIChatMessages === 'function') renderAIChatMessages();
      if (typeof _aiSaveChatState === 'function') _aiSaveChatState();
      if (typeof _aiUpdateHeaderTitle === 'function') _aiUpdateHeaderTitle();

      aiChatLoading = true;
      if (typeof _aiSetTyping === 'function') _aiSetTyping(true);

      try {
        const systemPrompt = typeof _aiBuildSystemPrompt === 'function' ? _aiBuildSystemPrompt() : undefined;
        const parsed = await _aiCallGemini(aiApiHistory, systemPrompt);
        const rawMessage = (parsed && typeof parsed.message === 'string' && parsed.message.trim()) || 'Oke!';
        const extracted = typeof _aiExtractStickerTag === 'function'
          ? _aiExtractStickerTag(rawMessage)
          : { text: rawMessage, tag: null };

        const msg = {
          role: 'assistant',
          text: extracted.text || 'Oke!',
          songs: (parsed && Array.isArray(parsed.songs)) ? parsed.songs.filter(s => s && s.title).slice(0, 20) : [],
          playlistName: (parsed && parsed.playlist_name) || null,
          stickerTag: extracted.tag,
          viaVoice: true
        };

        if (typeof _aiRemember === 'function') _aiRemember(parsed && parsed.remember);
        if (typeof _aiUpdateAffection === 'function') _aiUpdateAffection(parsed && parsed.user_tone, parsed && parsed.apology_sincere);
        if (typeof _aiHandleFollowUp === 'function') _aiHandleFollowUp(parsed);

        aiApiHistory.push({ role: 'model', parts: [{ text: JSON.stringify(parsed) }] });
        aiChatDisplay.push(msg);
        if (typeof _aiSaveChatState === 'function') _aiSaveChatState();

        return msg.text;
      } catch (e) {
        console.error('LoluVoiceDJ -> AI chat error:', e);
        const friendlyText = (e && e.message) ? e.message
          : reply('Waduh, ada gangguan dikit pas nyambung ke AI-nya. Coba ngomong lagi ya.', 'Oops, something went wrong connecting to the AI. Try again.');
        aiChatDisplay.push({ role: 'assistant', text: friendlyText, songs: [], playlistName: null, isError: true, viaVoice: true });
        if (typeof _aiSaveChatState === 'function') _aiSaveChatState();
        return friendlyText;
      } finally {
        aiChatLoading = false;
        if (typeof _aiSetTyping === 'function') _aiSetTyping(false);
        if (typeof renderAIChatMessages === 'function') renderAIChatMessages();
      }
    }

    return { chat, isReady };
  })();

  // ==========================================================================
  // Balasan teks Lolu untuk tiap intent — dwibahasa mengikuti bahasa aktif.
  // ==========================================================================
  function reply(idText, enText) { return currentLang === 'id-ID' ? idText : enText; }

  // ==========================================================================
  // ORKESTRATOR UTAMA — menjalankan 1 siklus penuh voice command sesuai flow
  // yang diminta: tekan mic -> dengarkan -> kecilkan volume -> ubah ke teks ->
  // parse intent -> eksekusi -> balas teks+suara -> kembalikan volume.
  // ==========================================================================
  async function handleRecognizedText(text) {
    UIState.setProcessing(text);

    const intent = IntentParser.parse(text);
    let replyText = '';
    // true kalau balasannya sudah ditulis langsung ke riwayat Chat AI asli
    // (aiChatDisplay/aiApiHistory lewat AIChatBridge) supaya
    // _pushVoiceTurnToChatLog di bawah (yang cuma nulis versi "tampilan
    // doang", tanpa songs/sticker) TIDAK dobel-nambahin turn yang sama.
    let loggedViaAIChat = false;

    try {
      switch (intent.intent) {

        case 'play_song': {
          replyText = reply(`Mencari “${intent.title}”...`, `Looking for “${intent.title}”...`);
          UIState.setProcessing(text);
          const { track, all } = await MusicFinder.findSong(intent.title, intent.artist);
          if (track) {
            PlaybackController.playSongTrack(track, all);
            replyText = reply(`Memutar ${track.title} dari ${track.artist}.`, `Playing ${track.title} by ${track.artist}.`);
          } else {
            replyText = reply(`Maaf, aku tidak menemukan lagu itu.`, `Sorry, I couldn't find that song.`);
          }
          break;
        }

        case 'play_query': {
          // Coba sebagai judul lagu dulu
          const { track, all } = await MusicFinder.findSong(intent.query, '');
          if (track) {
            PlaybackController.playSongTrack(track, all);
            replyText = reply(`Memutar ${track.title} dari ${track.artist}.`, `Playing ${track.title} by ${track.artist}.`);
            break;
          }
          // Fallback: anggap sebagai nama artis
          const artistTracks = await MusicFinder.findArtistTracks(intent.query);
          if (artistTracks.length) {
            PlaybackController.playSongTrack(artistTracks[0], artistTracks);
            replyText = reply(`Memutar lagu-lagu dari ${intent.query}.`, `Playing songs by ${intent.query}.`);
          } else {
            replyText = reply(`Maaf, aku tidak menemukan “${intent.query}”.`, `Sorry, I couldn't find “${intent.query}”.`);
          }
          break;
        }

        case 'play_playlist': {
          const pl = PlaylistFinder.findByName(intent.playlist);
          if (pl && PlaybackController.playPlaylist(pl)) {
            replyText = reply(`Memutar playlist ${pl.name}.`, `Playing your ${pl.name} playlist.`);
          } else {
            replyText = reply(`Aku tidak menemukan playlist “${intent.playlist}”.`, `I couldn't find a playlist called “${intent.playlist}”.`);
          }
          break;
        }

        case 'search': {
          const { all } = await MusicFinder.findSong(intent.query, '');
          if (all && all.length) {
            PlaybackController.playSongTrack(all[0], all);
            replyText = reply(`Ini hasil terbaik untuk “${intent.query}”: ${all[0].title}.`, `Here's the best match for “${intent.query}”: ${all[0].title}.`);
          } else {
            replyText = reply(`Tidak ada hasil untuk “${intent.query}”.`, `No results for “${intent.query}”.`);
          }
          break;
        }

        case 'pause':
          replyText = PlaybackController.pause() ? reply('Musik dijeda.', 'Pausing your music.') : reply('Tidak ada musik yang sedang diputar.', 'Nothing is playing right now.');
          break;

        case 'resume':
          replyText = PlaybackController.resume() ? reply('Melanjutkan musik.', 'Resuming your music.') : reply('Tidak ada musik untuk dilanjutkan.', 'Nothing to resume.');
          break;

        case 'stop':
          replyText = PlaybackController.stop() ? reply('Musik dihentikan.', 'Stopping your music.') : reply('Tidak ada musik yang diputar.', 'Nothing is playing right now.');
          break;

        case 'next_track':
          replyText = PlaybackController.next() ? reply('Lanjut ke lagu berikutnya.', 'Skipping to the next song.') : reply('Tidak bisa lanjut, antrian kosong.', 'Nothing to skip to.');
          break;

        case 'previous_track':
          replyText = PlaybackController.prev() ? reply('Kembali ke lagu sebelumnya.', 'Going back to the previous song.') : reply('Tidak ada lagu sebelumnya.', 'No previous song.');
          break;

        case 'shuffle':
          replyText = PlaybackController.shuffle() ? reply('Antrian diacak.', 'Shuffling your queue.') : reply('Shuffle belum tersedia untuk sumber musik ini.', 'Shuffle isn\'t available for this playback source.');
          break;

        case 'repeat_one':
          PlaybackController.repeatOne();
          replyText = reply('Mengulang lagu ini.', 'Repeating this song.');
          break;

        case 'repeat_toggle': {
          const mode = PlaybackController.repeatToggle();
          replyText = mode === 'off' ? reply('Repeat dimatikan.', 'Repeat turned off.') : (mode === 'one' ? reply('Mengulang lagu ini.', 'Repeating this song.') : reply('Mengulang semua lagu.', 'Repeating all songs.'));
          break;
        }

        case 'set_volume':
          PlaybackController.setVolume(intent.value);
          replyText = reply(`Volume diatur ke ${intent.value} persen.`, `Volume set to ${intent.value} percent.`);
          break;

        case 'volume_up':
          PlaybackController.volumeUp();
          replyText = reply('Volume dinaikkan.', 'Volume up.');
          break;

        case 'volume_down':
          PlaybackController.volumeDown();
          replyText = reply('Volume diturunkan.', 'Volume down.');
          break;

        case 'mute':
          PlaybackController.mute();
          replyText = reply('Suara dibisukan.', 'Muted.');
          break;

        case 'unmute':
          PlaybackController.unmute();
          replyText = reply('Suara dinyalakan kembali.', 'Unmuted.');
          break;

        // 'unknown' -> IntentParser nggak nemuin pola printah player yang
        // cocok, artinya ini kemungkinan besar OBROLAN BENERAN, bukan
        // command. Sambungkan ke AI Lolu (Gemini) yang sama dipakai Chat AI
        // teks, biar user bisa beneran ngobrol pakai suara (lihat
        // AIChatBridge di bagian 8 di atas).
        case 'unknown':
        default: {
          UIState.setProcessing(reply('Lolu lagi mikir...', 'Lolu is thinking...'));
          replyText = await AIChatBridge.chat(text);
          loggedViaAIChat = true;
          break;
        }
      }
    } catch (e) {
      console.error('LoluVoiceDJ error:', e);
      replyText = reply('Waduh, ada gangguan. Coba lagi ya.', 'Oops, something went wrong. Try again.');
    }

    UIState.setReply(replyText);
    // Balasan suara Lolu memakai Piper TTS client-side (lihat lolu-piper-tts.js).
    // VoiceOutput (Web Speech API) HANYA dipakai sebagai fallback darurat kalau
    // modul Piper gagal dimuat sama sekali (mis. browser tidak mendukung
    // dynamic import / OPFS), supaya Lolu tetap "bersuara" walau kualitasnya
    // turun — bukan pengganti Piper dalam kondisi normal.
    if (window.LoluPiperTTS && typeof window.LoluPiperTTS.speakDJ === 'function') {
      window.LoluPiperTTS.speakDJ(replyText).catch(function () {
        VoiceOutput.speak(replyText);
      });
    } else {
      VoiceOutput.speak(replyText);
    }

    // Kirim juga sebagai bubble chat di dalam obrolan Lolu (kalau overlay
    // sedang terbuka) supaya user tetap punya jejak percakapan seperti chat
    // biasa, tanpa perlu menekan tombol Send. DILEWATI kalau turn ini sudah
    // ditulis ke riwayat Chat AI ASLI oleh AIChatBridge (intent 'unknown'),
    // supaya obrolannya nggak dobel-muncul.
    if (!loggedViaAIChat) _pushVoiceTurnToChatLog(text, replyText);

    PlaybackController.restoreVolumeAfterDuck();
  }

  // Menambahkan giliran voice user + balasan Lolu ke tampilan chat (kalau
  // struktur data chat AI dari vibexa.js tersedia), murni tampilan — tidak
  // ikut campur ke riwayat yang dikirim ke Gemini.
  function _pushVoiceTurnToChatLog(userText, loluText) {
    try {
      // CATATAN: aiChatDisplay/renderAIChatMessages dideklarasikan sebagai
      // top-level `let`/`function` di vibexa.js (bukan `window.aiChatDisplay`
      // dkk — let/const top-level TIDAK jadi properti window), tapi tetap
      // bisa diakses langsung di sini lewat scope chain karena vibexa.js dan
      // lolu-voice.js sama-sama <script> classic di halaman yang sama.
      if (typeof aiChatDisplay === 'undefined' || !Array.isArray(aiChatDisplay)) return;
      if (typeof renderAIChatMessages !== 'function') return;
      aiChatDisplay.push({ role: 'user', text: userText, viaVoice: true });
      aiChatDisplay.push({ role: 'assistant', text: loluText, songs: [], playlistName: null, viaVoice: true });
      renderAIChatMessages();
      if (typeof _aiSaveChatState === 'function') _aiSaveChatState();
    } catch (e) { /* aman diabaikan — cuma UI tambahan */ }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  function toggleListening() {
    if (SpeechInput.isListening()) { SpeechInput.stop(); return; }
    startListening();
  }

  function startListening() {
    if (!SpeechInput.isSupported()) {
      UIState.setError(reply('Browser ini tidak mendukung voice command.', 'This browser doesn\'t support voice commands.'));
      return;
    }
    SpeechInput.setLang(currentLang);
    UIState.setListening();
    PlaybackController.duckVolume();

    // Klik tombol mic = user-gesture pertama yang tersedia di alur ini.
    // Manfaatkan untuk (1) "membuka kunci" autoplay audio Piper, dan
    // (2) mulai unduh/siapkan model Piper di background supaya balasan
    // pertama Lolu tidak menunggu lama. Lihat lolu-piper-tts.js.
    if (window.LoluPiperTTS) {
      window.LoluPiperTTS.unlockAudio();
      window.LoluPiperTTS.preload();
    }

    SpeechInput.start(
      (text) => {
        if (!text) {
          UIState.setReply(reply('Aku tidak dengar apa-apa, coba lagi.', 'I didn\'t catch that, try again.'));
          PlaybackController.restoreVolumeAfterDuck();
          return;
        }
        handleRecognizedText(text);
      },
      (err) => {
        if (err === 'no-speech') {
          UIState.setReply(reply('Aku tidak dengar apa-apa, coba lagi.', 'I didn\'t catch that, try again.'));
        } else if (err === 'not-allowed' || err === 'service-not-allowed') {
          UIState.setError(reply('Izin mikrofon ditolak.', 'Microphone permission denied.'));
        } else if (err !== 'unsupported') {
          UIState.setError(reply('Gagal mendengarkan, coba lagi.', 'Couldn\'t listen, try again.'));
        }
        PlaybackController.restoreVolumeAfterDuck();
      },
      () => { /* onEnd: tidak perlu apa-apa, UI sudah di-set di onresult/onerror */ }
    );
  }

  function toggleLanguage(e) {
    if (e) e.stopPropagation();
    const langs = Object.keys(SUPPORTED_LANGS);
    const idx = langs.indexOf(currentLang);
    currentLang = langs[(idx + 1) % langs.length];
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
    UIState.setLangBtnLabel(currentLang);
  }

  window.LoluVoiceDJ = {
    toggleListening,
    startListening,
    stopListening: SpeechInput.stop,
    toggleLanguage,
    isSupported: SpeechInput.isSupported
  };

  // ── Init: label tombol bahasa sesuai preferensi tersimpan, dan hentikan
  // voice recognition otomatis kalau overlay Chat AI ditutup. ──────────────
  document.addEventListener('DOMContentLoaded', () => {
    UIState.setLangBtnLabel(currentLang);
    if (!SpeechInput.isSupported()) {
      const b = document.getElementById('lolu-mic-btn');
      if (b) { b.disabled = true; b.title = 'Voice command tidak didukung browser ini'; b.classList.add('unsupported'); }
    }
  });

  // Bungkus closeAIChatOverlay yang sudah ada supaya voice recognition ikut
  // berhenti begitu halaman Chat AI ditutup (tanpa mengubah file vibexa.js).
  const _origCloseAIChatOverlay = window.closeAIChatOverlay;
  if (typeof _origCloseAIChatOverlay === 'function') {
    window.closeAIChatOverlay = function () {
      try { SpeechInput.stop(); } catch (e) {}
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
      return _origCloseAIChatOverlay.apply(this, arguments);
    };
  }

})();
