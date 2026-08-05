// ════════════════════════════════════════════════════════════════════
// VOICE AI DJ — "Lolu" bisa dikendalikan pakai suara.
//
// User menekan tombol mic di #voice-dj-page → browser mendengarkan lewat
// Web Speech API (SpeechRecognition) → ucapan diubah jadi teks → teks
// dianalisis jadi perintah terstruktur ({intent, ...}) → perintah itu
// dieksekusi ke player yang SUDAH ADA di vibexa.js (loadPlay, playNext,
// dst) → Lolu membalas lewat teks di layar + suara (TTS).
//
// Tidak ada wake word ("Hey Lolu") — mic HANYA aktif setelah tombol mic
// ditekan, dan otomatis berhenti setelah satu ucapan selesai (continuous
// = false) atau setelah timeout. Semua berjalan 100% di browser, tanpa
// server pengenalan suara sendiri.
//
// Modul-modul di file ini (dipisah biar gampang ditambah perintah baru):
//   1. SpeechController   → wrapper SpeechRecognition (STT) + TTS
//   2. IntentParser       → ubah teks jadi {intent, ...} terstruktur
//   3. MusicSearch        → cari lagu/artis lewat iTunes (reuse vibexa.js)
//   4. PlaylistSearch     → cari playlist milik user (object `playlists`)
//   5. PlaybackController → bungkus kontrol player yang sudah ada
//   6. UIStateManager     → update tampilan #voice-dj-page
//   7. VoiceDJ            → orkestrator, di-expose ke window.VoiceDJ
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Konfigurasi bahasa ────────────────────────────────────────────
  // Dua bahasa didukung: Indonesia (id-ID) & Inggris (en-US). Tombol
  // bahasa di header halaman DJ men-toggle di antara keduanya, dan
  // pilihannya disimpan supaya tetap sama walau halaman dibuka ulang.
  var SUPPORTED_LANGS = ['id-ID', 'en-US'];
  var _vdjLang = localStorage.getItem('vdjLang') || 'id-ID';

  function _vdjIsID() { return _vdjLang === 'id-ID'; }

  // ════════════════════════════════════════════════════════════════
  // 1. SPEECH CONTROLLER — Speech-to-Text (STT) & Text-to-Speech (TTS)
  // ════════════════════════════════════════════════════════════════
  var SpeechController = (function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var recognition = null;
    var listening = false;
    var manualTimeoutId = null;
    var MAX_LISTEN_MS = 9000; // jaga-jaga kalau browser tidak auto-stop

    function isSupported() { return !!SR; }

    function _buildRecognition() {
      var r = new SR();
      // Sesuai spesifikasi: sekali ucap → langsung diproses, tanpa hasil
      // sementara, dan hanya alternatif terbaik yang diambil.
      r.continuous = false;
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.lang = _vdjLang;
      return r;
    }

    // start(onFinalText, onStart, onError, onEnd)
    function start(onFinalText, onStart, onError, onEnd) {
      if (!isSupported()) {
        if (onError) onError('unsupported');
        return;
      }
      if (listening) return;

      recognition = _buildRecognition();
      listening = true;

      recognition.onstart = function () {
        if (onStart) onStart();
        clearTimeout(manualTimeoutId);
        manualTimeoutId = setTimeout(function () {
          try { recognition && recognition.stop(); } catch (e) {}
        }, MAX_LISTEN_MS);
      };

      recognition.onresult = function (ev) {
        var text = '';
        try {
          text = ev.results[0][0].transcript || '';
        } catch (e) {}
        if (onFinalText) onFinalText(text.trim());
      };

      recognition.onerror = function (ev) {
        if (onError) onError((ev && ev.error) || 'unknown');
      };

      recognition.onend = function () {
        listening = false;
        clearTimeout(manualTimeoutId);
        if (onEnd) onEnd();
      };

      try {
        recognition.start();
      } catch (e) {
        listening = false;
        if (onError) onError('start-failed');
      }
    }

    function stop() {
      clearTimeout(manualTimeoutId);
      if (recognition && listening) {
        try { recognition.stop(); } catch (e) {}
      }
      listening = false;
    }

    function isListening() { return listening; }

    // ── Text-to-Speech ─────────────────────────────────────────────
    var synth = window.speechSynthesis || null;

    function speak(text, onDone) {
      if (!synth || !text) { if (onDone) onDone(); return; }
      try { synth.cancel(); } catch (e) {}
      var utt = new SpeechSynthesisUtterance(text);
      utt.lang = _vdjLang;
      utt.rate = 1.02;
      utt.pitch = 1.05;
      // Coba pilih voice yang cocok dengan bahasa aktif kalau tersedia.
      try {
        var voices = synth.getVoices() || [];
        var match = voices.find(function (v) { return v.lang === _vdjLang; }) ||
                    voices.find(function (v) { return v.lang && v.lang.indexOf(_vdjLang.slice(0, 2)) === 0; });
        if (match) utt.voice = match;
      } catch (e) {}
      utt.onend = function () { if (onDone) onDone(); };
      utt.onerror = function () { if (onDone) onDone(); };
      try { synth.speak(utt); } catch (e) { if (onDone) onDone(); }
    }

    function cancelSpeak() { if (synth) { try { synth.cancel(); } catch (e) {} } }

    return {
      isSupported: isSupported,
      start: start,
      stop: stop,
      isListening: isListening,
      speak: speak,
      cancelSpeak: cancelSpeak
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // 2. INTENT PARSER — teks ucapan → command terstruktur
  // ════════════════════════════════════════════════════════════════
  // Mengembalikan objek seperti:
  //   { intent: "play_song", title: "Baby", artist: "Justin Bieber" }
  //   { intent: "pause" }
  //   { intent: "play_playlist", playlist: "Workout" }
  //   { intent: "next_track" }
  // Parser berjalan 100% lokal (regex, cepat & tidak butuh jaringan).
  var IntentParser = (function () {
    function norm(s) { return (s || '').trim().toLowerCase(); }

    // Perintah playback satu-kata/frasa tetap, EN + ID sekaligus.
    var EXACT_PATTERNS = [
      { re: /^(pause|jeda|berhenti(kan)?( musik| lagu)?)$/i, intent: 'pause' },
      { re: /^(stop|stop( musik| lagu)?)$/i, intent: 'stop' },
      { re: /^(resume|play|lanjutkan|lanjut(in)?|terusin|mainkan)$/i, intent: 'resume' },
      { re: /^(next( song| track)?|skip( lagu| song)?|lagu (selanjutnya|berikutnya)|next lagu)$/i, intent: 'next_track' },
      { re: /^(previous( song| track)?|lagu sebelumnya|balik(in)? lagu|kembali(kan)? ke lagu sebelumnya)$/i, intent: 'previous_track' },
      { re: /^(repeat this song|ulangi lagu ini|putar ulang lagu ini|repeat song ini)$/i, intent: 'repeat_one' },
      { re: /^(repeat|ulangi|ulang)$/i, intent: 'repeat_all' },
      { re: /^(shuffle|acak(kan)?( lagu| antrian)?)$/i, intent: 'shuffle' },
      { re: /^(mute|bisukan( suara)?|senyapkan( suara)?)$/i, intent: 'mute' },
      { re: /^(unmute|suarakan( lagi)?|batal(kan)? bisu)$/i, intent: 'unmute' },
      { re: /^(volume up|naikkan volume|volume naik|kencangkan (suara|volume))$/i, intent: 'volume_up' },
      { re: /^(volume down|turunkan volume|volume turun|pelankan (suara|volume)|kecilkan (suara|volume))$/i, intent: 'volume_down' }
    ];

    // Kata-kata pembuka/pengganggu yang dibuang saat mengekstrak nama
    // playlist dari kalimat.
    var PLAYLIST_STOPWORDS = ['play', 'putar', 'muterin', 'muter', 'my', 'the',
      'playlist', 'daftar putar', 'punya saya', 'punya ku', 'punyaku', 'aku',
      'saya', 'ku'];

    function stripStopwords(text, words) {
      var out = ' ' + text + ' ';
      words.forEach(function (w) {
        var re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
        out = out.replace(re, ' ');
      });
      return out.replace(/\s+/g, ' ').trim();
    }

    function parse(rawText) {
      var text = norm(rawText);
      if (!text) return { intent: 'unknown', raw: rawText };

      // 1) Perintah playback tetap (paling spesifik & tidak ambigu)
      for (var i = 0; i < EXACT_PATTERNS.length; i++) {
        if (EXACT_PATTERNS[i].re.test(text)) {
          return { intent: EXACT_PATTERNS[i].intent, raw: rawText };
        }
      }

      // 2) "Set volume to 50%" / "atur volume ke 50" / "volume 50%"
      var volMatch = text.match(/(?:set\s+)?(?:volume|suara)\s*(?:ke|to)?\s*(\d{1,3})\s*(%|persen)?/i);
      if (volMatch) {
        var v = Math.max(0, Math.min(100, parseInt(volMatch[1], 10)));
        return { intent: 'volume_set', value: v, raw: rawText };
      }

      // 3) Playlist: kalau kata "playlist"/"daftar putar" muncul, atau
      //    user minta lagu favorit/kesukaan.
      if (/playlist|daftar putar/i.test(text)) {
        var plName = stripStopwords(text, PLAYLIST_STOPWORDS);
        return { intent: 'play_playlist', playlist: plName, raw: rawText };
      }
      if (/favorit(e|ku)?s?|kesukaan|liked songs|lagu (yang )?disukai/i.test(text) &&
          /^(play|putar|muterin|muter)\b/i.test(text)) {
        return { intent: 'play_playlist', playlist: 'favorites', raw: rawText };
      }

      // 4) Pencarian eksplisit: "find songs by X" / "search for X" / "cari X"
      var searchMatch = text.match(/^(?:find( songs)? by|search for|cari(kan)?( lagu)?( dari| oleh)?)\s+(.+)$/i);
      if (searchMatch) {
        return { intent: 'search_music', query: searchMatch[searchMatch.length - 1].trim(), raw: rawText };
      }

      // 5) "Play X" / "Putar X" / "Muterin X" generik — bisa lagu, bisa
      //    artis. Kalau ada " by "/" oleh "/" dari " pisahkan judul & artis.
      var playMatch = text.match(/^(?:play|putar|muterin|muter)\s+(.+)$/i);
      if (playMatch) {
        var body = playMatch[1].trim();
        var byMatch = body.match(/^(.+?)\s+(?:by|oleh|dari)\s+(.+)$/i);
        if (byMatch) {
          return { intent: 'play_song', title: byMatch[1].trim(), artist: byMatch[2].trim(), raw: rawText };
        }
        // Tidak ada "by" → biarkan executor yang memutuskan lagu vs artis.
        return { intent: 'play_query', query: body, raw: rawText };
      }

      return { intent: 'unknown', raw: rawText };
    }

    return { parse: parse };
  })();

  // ════════════════════════════════════════════════════════════════
  // 3. MUSIC SEARCH — cari lagu/artis via katalog iTunes
  //    (reuse fetchItunesResults & lookupArtistSongs dari vibexa.js)
  // ════════════════════════════════════════════════════════════════
  var MusicSearch = (function () {
    function buildTrack(it) {
      var thumb = (it.artworkUrl100 || '').replace('100x100bb', '600x600bb');
      return {
        title: it.trackName || 'Unknown',
        artist: it.artistName || 'Unknown',
        thumb: thumb,
        album: it.collectionName || '',
        preview: it.previewUrl || null,
        videoId: null,
        photo: null,
        duration: it.trackTimeMillis ? Math.round(it.trackTimeMillis / 1000) : 0,
        _query: (it.artistName || '') + '|||' + (it.trackName || '') + '|||' + (it.trackId || Math.random())
      };
    }

    // Cari lagu terbaik yang cocok dengan query (judul, atau "judul artis").
    async function findBestSong(query) {
      if (typeof fetchItunesResults !== 'function') return null;
      try {
        var results = await Promise.all([
          fetchItunesResults(query, 'ID').catch(function () { return []; }),
          fetchItunesResults(query, 'US').catch(function () { return []; })
        ]);
        var items = results[0].concat(results[1]);
        if (!items.length) return null;
        var qNorm = query.toLowerCase().replace(/[^a-z0-9 ]/g, '');
        // Prioritaskan judul yang benar-benar mengandung kata kunci.
        items.sort(function (a, b) {
          var aHit = (a.trackName || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').indexOf(qNorm) !== -1 ? 0 : 1;
          var bHit = (b.trackName || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').indexOf(qNorm) !== -1 ? 0 : 1;
          return aHit - bHit;
        });
        return buildTrack(items[0]);
      } catch (e) {
        return null;
      }
    }

    // Cek apakah `name` adalah nama artis yang dikenali; kalau ya kembalikan
    // beberapa lagu top-nya (pakai lookupArtistSongs yang sudah ada).
    async function findArtistTracks(name) {
      if (typeof fetchItunesResults !== 'function' || typeof lookupArtistSongs !== 'function') return null;
      try {
        var found = await fetchItunesResults(name, 'US', 'musicArtist', 5);
        if (!found || !found.length) return null;
        var norm = function (s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
        var target = norm(name);
        var best = found.find(function (a) { return norm(a.artistName) === target; }) ||
                   found.find(function (a) { return norm(a.artistName).indexOf(target) !== -1 || target.indexOf(norm(a.artistName)) !== -1; });
        if (!best) return null;
        var songs = await lookupArtistSongs(best.artistId, 'US');
        if (!songs || !songs.length) return null;
        var tracks = songs.slice(0, 30).map(buildTrack);
        return { artistName: best.artistName, tracks: tracks };
      } catch (e) {
        return null;
      }
    }

    return { findBestSong: findBestSong, findArtistTracks: findArtistTracks };
  })();

  // ════════════════════════════════════════════════════════════════
  // 4. PLAYLIST SEARCH — cocokkan ucapan dengan playlist user
  // ════════════════════════════════════════════════════════════════
  var PlaylistSearch = (function () {
    function find(rawName) {
      if (typeof playlists === 'undefined') return null;
      if (typeof ensureLikedPlaylist === 'function') ensureLikedPlaylist();
      var q = (rawName || '').trim().toLowerCase();
      if (!q || /favorit|favorite|liked|disukai|kesukaan/.test(q)) {
        return playlists[LIKED_PLAYLIST_ID] || null;
      }
      var entries = Object.keys(playlists).map(function (id) { return playlists[id]; });
      var exact = entries.find(function (p) { return p.name && p.name.toLowerCase() === q; });
      if (exact) return exact;
      var partial = entries.find(function (p) {
        if (!p.name) return false;
        var n = p.name.toLowerCase();
        return n.indexOf(q) !== -1 || q.indexOf(n) !== -1;
      });
      return partial || null;
    }
    return { find: find };
  })();

  // ════════════════════════════════════════════════════════════════
  // 5. PLAYBACK CONTROLLER — bungkus kontrol player vibexa.js
  // ════════════════════════════════════════════════════════════════
  var PlaybackController = (function () {
    function getVolume() {
      var el = document.getElementById('vol');
      return el ? (parseInt(el.value, 10) || 0) : 80;
    }

    function setVolume(percent) {
      percent = Math.max(0, Math.min(100, Math.round(percent)));
      var el = document.getElementById('vol');
      if (el) el.value = percent;
      try { if (typeof YTP !== 'undefined' && YTP) YTP.setVolume(percent); } catch (e) {}
      try { if (typeof spAudio !== 'undefined' && spAudio) spAudio.volume = percent / 100; } catch (e) {}
      return percent;
    }

    function isPlaying() { return typeof playing !== 'undefined' && !!playing; }
    function hasTrack() { return typeof curTrack !== 'undefined' && !!curTrack; }

    function pause() {
      if (isPlaying() && typeof _togglePlayPause === 'function') _togglePlayPause();
    }
    function resume() {
      if (!isPlaying() && hasTrack() && typeof _togglePlayPause === 'function') _togglePlayPause();
    }
    function next() { if (typeof playNext === 'function') playNext(); }
    function previous() { if (typeof playPrev === 'function') playPrev(); }

    function repeatOne() {
      if (typeof _repeatMode !== 'undefined') {
        _repeatMode = 'one';
        if (typeof _updateRepeatBtnUI === 'function') _updateRepeatBtnUI();
      }
    }
    function repeatAll() {
      if (typeof _repeatMode !== 'undefined') {
        _repeatMode = _repeatMode === 'all' ? 'off' : 'all';
        if (typeof _updateRepeatBtnUI === 'function') _updateRepeatBtnUI();
      }
    }

    function shuffleQueue() {
      if (typeof curQueue === 'undefined' || curQueue.length < 3) return false;
      var head = curQueue[0];
      var rest = curQueue.slice(1);
      for (var i = rest.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
      }
      curQueue = [head].concat(rest);
      return true;
    }

    function playTrack(track, plId) {
      if (typeof loadPlay === 'function') {
        curQueue = [track];
        loadPlay(track, plId || null);
      }
    }

    function playQueue(tracks, plId) {
      if (!tracks || !tracks.length) return false;
      if (typeof curQueue !== 'undefined') curQueue = tracks.slice();
      if (typeof loadPlay === 'function') loadPlay(tracks[0], plId || null);
      return true;
    }

    function playPlaylist(pl) {
      if (!pl || !pl.tracks || !pl.tracks.length) return false;
      return playQueue(pl.tracks, pl.id);
    }

    return {
      getVolume: getVolume, setVolume: setVolume,
      isPlaying: isPlaying, hasTrack: hasTrack,
      pause: pause, resume: resume, next: next, previous: previous,
      repeatOne: repeatOne, repeatAll: repeatAll, shuffleQueue: shuffleQueue,
      playTrack: playTrack, playQueue: playQueue, playPlaylist: playPlaylist
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // 6. UI STATE MANAGER — update tampilan #voice-dj-page
  // ════════════════════════════════════════════════════════════════
  var UIStateManager = (function () {
    function els() {
      return {
        orb: document.getElementById('vdj-page-orb'),
        micBtn: document.getElementById('vdj-page-mic-btn'),
        icoMic: document.getElementById('vdj-page-ico-mic'),
        icoStop: document.getElementById('vdj-page-ico-stop'),
        status: document.getElementById('vdj-page-status'),
        sub: document.getElementById('vdj-page-sub'),
        transcript: document.getElementById('vdj-page-transcript'),
        langBtn: document.getElementById('vdj-page-lang-btn')
      };
    }

    // state: 'idle' | 'listening' | 'processing' | 'speaking'
    function setState(state) {
      var e = els();
      if (!e.orb || !e.micBtn) return;
      ['listening', 'processing', 'speaking'].forEach(function (c) {
        e.orb.classList.remove(c);
        e.micBtn.classList.remove(c);
      });
      if (state !== 'idle') {
        e.orb.classList.add(state);
        e.micBtn.classList.add(state);
      }
      if (e.icoMic && e.icoStop) {
        var showStop = state === 'listening' || state === 'processing';
        e.icoMic.style.display = showStop ? 'none' : 'block';
        e.icoStop.style.display = showStop ? 'block' : 'none';
      }
    }

    function setStatus(text) { var e = els(); if (e.status) e.status.textContent = text; }
    function setSub(text) { var e = els(); if (e.sub) e.sub.textContent = text; }
    function setTranscript(text) { var e = els(); if (e.transcript) e.transcript.textContent = text || ''; }
    function setLangLabel(lang) {
      var e = els();
      if (e.langBtn) e.langBtn.textContent = lang === 'id-ID' ? 'ID' : 'EN';
    }

    return {
      setState: setState, setStatus: setStatus, setSub: setSub,
      setTranscript: setTranscript, setLangLabel: setLangLabel
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // 7. VOICEDJ ORCHESTRATOR — hubungkan semua modul di atas
  // ════════════════════════════════════════════════════════════════
  var _preDuckVolume = null; // volume sebelum di-duck saat mulai mendengarkan
  var _mutedPrevVolume = null; // volume sebelum di-mute, untuk unmute

  function T(id, en) { return _vdjIsID() ? id : en; }

  function duckVolumeIfPlaying() {
    _preDuckVolume = PlaybackController.getVolume();
    if (PlaybackController.isPlaying()) {
      PlaybackController.setVolume(Math.round(_preDuckVolume * 0.18));
    }
  }

  function restoreVolume() {
    if (_preDuckVolume !== null && PlaybackController.isPlaying()) {
      PlaybackController.setVolume(_preDuckVolume);
    }
    _preDuckVolume = null;
  }

  // Bangun pesan balasan Lolu berdasarkan intent yang dieksekusi.
  async function executeIntent(cmd) {
    switch (cmd.intent) {
      case 'pause':
      case 'stop':
        PlaybackController.pause();
        return T('Oke, musik dijeda.', 'Pausing your music.');

      case 'resume':
        if (!PlaybackController.hasTrack()) {
          return T('Belum ada lagu yang diputar sebelumnya.', "There's no song to resume yet.");
        }
        PlaybackController.resume();
        return T('Oke, lanjut muter.', 'Resuming playback.');

      case 'next_track':
        PlaybackController.next();
        return T('Skip ke lagu berikutnya.', 'Skipping to the next song.');

      case 'previous_track':
        PlaybackController.previous();
        return T('Balik ke lagu sebelumnya.', 'Playing the previous song.');

      case 'repeat_one':
        PlaybackController.repeatOne();
        return T('Oke, lagu ini bakal diulang terus.', "Okay, I'll repeat this song.");

      case 'repeat_all':
        PlaybackController.repeatAll();
        return T('Repeat diatur.', 'Repeat updated.');

      case 'shuffle':
        var shuffled = PlaybackController.shuffleQueue();
        return shuffled
          ? T('Antrian lagu udah diacak.', 'Shuffled your queue.')
          : T('Antriannya kependekan buat diacak.', 'Not enough songs in the queue to shuffle.');

      case 'mute':
        _mutedPrevVolume = PlaybackController.getVolume();
        PlaybackController.setVolume(0);
        return T('Suara dimatikan.', 'Muted.');

      case 'unmute':
        PlaybackController.setVolume(_mutedPrevVolume != null ? _mutedPrevVolume : 80);
        _mutedPrevVolume = null;
        return T('Suara dinyalakan lagi.', 'Unmuted.');

      case 'volume_up':
        _preDuckVolume = PlaybackController.setVolume(PlaybackController.getVolume() + 15);
        return T('Volume dinaikkan.', 'Volume increased.');

      case 'volume_down':
        _preDuckVolume = PlaybackController.setVolume(PlaybackController.getVolume() - 15);
        return T('Volume diturunkan.', 'Volume decreased.');

      case 'volume_set':
        _preDuckVolume = PlaybackController.setVolume(cmd.value);
        return T('Volume diatur ke ' + cmd.value + ' persen.', 'Volume set to ' + cmd.value + ' percent.');

      case 'play_playlist': {
        var pl = PlaylistSearch.find(cmd.playlist);
        if (!pl) {
          return T('Aku nggak nemu playlist "' + cmd.playlist + '".', 'I couldn\u2019t find a playlist called "' + cmd.playlist + '".');
        }
        var ok = PlaybackController.playPlaylist(pl);
        return ok
          ? T('Muterin playlist ' + pl.name + '.', 'Playing your ' + pl.name + ' playlist.')
          : T('Playlist ' + pl.name + ' masih kosong.', 'That playlist is empty.');
      }

      case 'search_music':
      case 'play_query': {
        var query = cmd.query || cmd.query === '' ? cmd.query : cmd.query;
        query = (cmd.intent === 'play_query') ? cmd.query : cmd.query;
        // Coba dulu sebagai nama artis.
        var artistResult = await MusicSearch.findArtistTracks(query);
        if (artistResult && artistResult.tracks.length) {
          PlaybackController.playQueue(artistResult.tracks, null);
          return T('Muterin lagu-lagu dari ' + artistResult.artistName + '.', 'Playing songs by ' + artistResult.artistName + '.');
        }
        // Kalau bukan nama artis, cari sebagai judul lagu.
        var song = await MusicSearch.findBestSong(query);
        if (song) {
          PlaybackController.playTrack(song, null);
          return T('Muterin ' + song.title + ' dari ' + song.artist + '.', 'Playing ' + song.title + ' by ' + song.artist + '.');
        }
        return T('Aku nggak nemu lagu buat "' + query + '".', 'I couldn\u2019t find anything for "' + query + '".');
      }

      case 'play_song': {
        var q = cmd.artist ? (cmd.artist + ' ' + cmd.title) : cmd.title;
        var songResult = await MusicSearch.findBestSong(q);
        if (songResult) {
          PlaybackController.playTrack(songResult, null);
          return T('Muterin ' + songResult.title + ' dari ' + songResult.artist + '.', 'Playing ' + songResult.title + ' by ' + songResult.artist + '.');
        }
        return T('Aku nggak nemu lagunya.', "I couldn't find that song.");
      }

      default:
        return T('Maaf, aku belum ngerti maksudnya. Coba bilang lagi ya.', "Sorry, I didn't catch that. Could you try again?");
    }
  }

  function onMicError(err) {
    UIStateManager.setState('idle');
    if (err === 'unsupported') {
      UIStateManager.setStatus(T('Browser ini belum mendukung input suara', 'Voice input isn\u2019t supported in this browser'));
      if (typeof toast === 'function') toast(T(' Browser kamu belum mendukung Voice DJ', ' Your browser doesn\u2019t support Voice DJ'));
    } else if (err === 'not-allowed' || err === 'service-not-allowed') {
      UIStateManager.setStatus(T('Izin mikrofon ditolak', 'Microphone access denied'));
      if (typeof toast === 'function') toast(T(' Izinkan akses mikrofon dulu ya', ' Please allow microphone access'));
    } else if (err === 'no-speech') {
      UIStateManager.setStatus(T('Nggak kedengeran apa-apa', "I didn't hear anything"));
    } else {
      UIStateManager.setStatus(T('Ada gangguan, coba lagi ya', 'Something went wrong, try again'));
    }
    restoreVolume();
    UIStateManager.setSub('Lolu');
  }

  function toggle() {
    if (SpeechController.isListening()) {
      SpeechController.stop();
      return;
    }
    if (!SpeechController.isSupported()) {
      onMicError('unsupported');
      return;
    }
    SpeechController.cancelSpeak();
    UIStateManager.setTranscript('');
    duckVolumeIfPlaying();

    SpeechController.start(
      // onFinalText
      async function (text) {
        UIStateManager.setState('processing');
        UIStateManager.setStatus(T('Memproses...', 'Processing...'));
        UIStateManager.setTranscript('\u201c' + text + '\u201d');

        if (!text) {
          var msg = T('Aku nggak nangkep ucapannya.', "I didn't catch that.");
          UIStateManager.setStatus(msg);
          restoreVolume();
          UIStateManager.setState('speaking');
          SpeechController.speak(msg, function () {
            UIStateManager.setState('idle');
            UIStateManager.setSub('Lolu');
          });
          return;
        }

        var cmd = IntentParser.parse(text);
        var reply = await executeIntent(cmd);

        UIStateManager.setStatus(reply);
        UIStateManager.setState('speaking');
        SpeechController.speak(reply, function () {
          UIStateManager.setState('idle');
          UIStateManager.setSub('Lolu');
          restoreVolume();
        });
      },
      // onStart
      function () {
        UIStateManager.setState('listening');
        UIStateManager.setStatus(T('Mendengarkan...', 'Listening...'));
        UIStateManager.setSub(T('Ngomong aja, aku dengerin', "I'm listening"));
      },
      // onError
      onMicError,
      // onEnd
      function () {
        // onresult sudah menangani transisi state selanjutnya; kalau
        // recognition berhenti TANPA hasil (mis. no-speech), pastikan
        // tetap kembali ke idle supaya mic tidak nyangkut di state listening.
        var e = UIStateManager;
        setTimeout(function () {
          var micBtn = document.getElementById('vdj-page-mic-btn');
          if (micBtn && micBtn.classList.contains('listening')) {
            e.setState('idle');
            restoreVolume();
          }
        }, 50);
      }
    );
  }

  function stop() {
    SpeechController.stop();
    SpeechController.cancelSpeak();
    UIStateManager.setState('idle');
    restoreVolume();
  }

  function toggleLanguage() {
    var idx = SUPPORTED_LANGS.indexOf(_vdjLang);
    _vdjLang = SUPPORTED_LANGS[(idx + 1) % SUPPORTED_LANGS.length];
    localStorage.setItem('vdjLang', _vdjLang);
    UIStateManager.setLangLabel(_vdjLang);
    UIStateManager.setStatus(_vdjIsID() ? 'Halo!' : 'Hello!');
    UIStateManager.setSub('Lolu');
  }

  // Inisialisasi tampilan awal begitu script dimuat.
  document.addEventListener('DOMContentLoaded', function () {
    UIStateManager.setLangLabel(_vdjLang);
    UIStateManager.setStatus(_vdjIsID() ? 'Halo!' : 'Hello!');
    UIStateManager.setSub('Lolu');
  });

  window.VoiceDJ = {
    toggle: toggle,
    stop: stop,
    toggleLanguage: toggleLanguage
  };
})();
