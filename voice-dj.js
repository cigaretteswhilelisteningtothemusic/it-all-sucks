/* ==========================================================================
   VOICE-CONTROLLED AI DJ — Lolu
   ==========================================================================
   Press the mic button -> speak a command -> Lolu executes it. No wake word,
   no server: Speech-to-Text runs on the browser's Web Speech API and intent
   parsing + music/playlist lookup all run client-side against the same
   catalog Vibexa already uses (iTunes search + the user's own playlists).

   This file is intentionally split into small, independent modules so new
   commands/languages can be added without touching the others:

     SpeechRecognitionModule  – wraps SpeechRecognition/webkitSpeechRecognition
     IntentParser             – text -> structured { intent, ...slots }
     MusicSearch               – finds songs/artists in the catalog
     PlaylistSearch            – finds the user's playlists by spoken name
     PlaybackController        – the only module allowed to touch the player
     UIStateManager            – mic button + speech-bubble UI state
     TTS                       – optional spoken confirmation

   It relies on globals already defined in vibexa.js (loaded before this
   file): YTP, playing, curTrack, curQueue, playlists, LIKED_PLAYLIST_ID,
   loadPlay(), playNext(), playPrev(), toggleRepeatMode(), _repeatMode,
   fetchItunesResults(), toast(), esc(). None of those are modified here —
   they're only called, exactly like every other part of the app calls them.
   ========================================================================== */
(function(){
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. Feature detection
   * ------------------------------------------------------------------ */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const fabEl   = document.getElementById('voice-dj-fab');
  const langBtn = document.getElementById('voice-dj-lang-btn');

  if (!SR) {
    // Browser doesn't support the Web Speech API — hide the entry point
    // entirely instead of showing a button that can never work.
    if (fabEl) fabEl.classList.add('hide');
    if (langBtn) langBtn.classList.add('hide');
    // Halaman penuh DJ juga disesuaikan: sembunyikan tombol mic & tampilkan
    // pesan bahwa fitur suara tidak didukung, daripada tombol yang diam saja.
    const pageMic = document.getElementById('vdj-page-mic-btn');
    if (pageMic) pageMic.style.display = 'none';
    const pageStat = document.getElementById('vdj-page-status');
    if (pageStat) pageStat.textContent = 'Not supported';
    const pageSubEl = document.getElementById('vdj-page-sub');
    if (pageSubEl) pageSubEl.textContent = 'This browser can\'t use voice control';
    console.warn('Voice AI DJ: SpeechRecognition API not supported in this browser.');
    return;
  }

  /* ------------------------------------------------------------------ *
   * 1. Small shared helpers
   * ------------------------------------------------------------------ */
  function norm(s){
    return (s || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function wordOverlapScore(a, b){
    const wa = norm(a).split(' ').filter(Boolean);
    const wb = new Set(norm(b).split(' ').filter(Boolean));
    if (!wa.length || !wb.size) return 0;
    let hit = 0;
    wa.forEach(w => { if (wb.has(w)) hit++; });
    return hit / wa.length;
  }

  /* ------------------------------------------------------------------ *
   * 2. UI STATE MANAGER — mic button + speech bubble + Lolu animation
   * ------------------------------------------------------------------ */
  const UIStateManager = (function(){
    const bubble   = document.getElementById('voice-dj-bubble');
    const bubbleTx = document.getElementById('voice-dj-bubble-text');
    const transcriptEl = document.getElementById('voice-dj-transcript');
    const icoMic   = document.getElementById('voice-dj-ico-mic');
    const icoStop  = document.getElementById('voice-dj-ico-stop');
    const loluFab  = document.getElementById('ai-fab-lottie');

    // Elemen halaman penuh "DJ" (lihat #voice-dj-page di vibexa.html).
    // Bisa saja tidak ada di DOM (mis. versi lama file), makanya semua
    // pemakaian di bawah selalu dicek null-nya dulu — mic FAB kecil tetap
    // berfungsi normal walau halaman ini belum ada.
    const pageOrb    = document.getElementById('vdj-page-orb');
    const pageMicBtn = document.getElementById('vdj-page-mic-btn');
    const pageIcoMic  = document.getElementById('vdj-page-ico-mic');
    const pageIcoStop = document.getElementById('vdj-page-ico-stop');
    const pageStatus     = document.getElementById('vdj-page-status');
    const pageSub         = document.getElementById('vdj-page-sub');
    const pageTranscript = document.getElementById('vdj-page-transcript');

    const DEFAULT_STATUS = { text: 'Welcome', sub: 'DJ' };

    let hideTimer = null;

    function setFabState(state){
      // state: 'idle' | 'listening' | 'processing' | 'speaking'
      if (fabEl){
        fabEl.classList.remove('listening', 'processing', 'speaking');
        if (state !== 'idle') fabEl.classList.add(state);
      }
      if (icoMic && icoStop){
        icoMic.style.display  = (state === 'listening') ? 'none' : 'block';
        icoStop.style.display = (state === 'listening') ? 'block' : 'none';
      }
      // Give Lolu's own floating icon a little life while we're working.
      if (loluFab) loluFab.style.animation = (state === 'idle') ? '' : 'voiceDjMicBob 1s ease-in-out infinite';

      // Cerminkan state yang sama ke orb + tombol mic di halaman penuh DJ.
      if (pageOrb){
        pageOrb.classList.remove('listening', 'processing', 'speaking');
        if (state !== 'idle') pageOrb.classList.add(state);
      }
      if (pageMicBtn){
        pageMicBtn.classList.remove('listening', 'processing', 'speaking');
        if (state !== 'idle') pageMicBtn.classList.add(state);
      }
      if (pageIcoMic && pageIcoStop){
        pageIcoMic.style.display  = (state === 'listening') ? 'none' : 'block';
        pageIcoStop.style.display = (state === 'listening') ? 'block' : 'none';
      }
    }

    function showBubble(state, text, transcript){
      if (bubble){
        clearTimeout(hideTimer);
        bubble.classList.remove('state-listening', 'state-processing', 'state-speaking', 'state-error');
        bubble.classList.add('state-' + state);
        bubble.classList.remove('hide');
        bubble.classList.add('show');
        if (bubbleTx) bubbleTx.textContent = text;
        if (transcriptEl) transcriptEl.textContent = transcript || '';
      }
      // Sinkronkan teks status/transcript ke halaman penuh DJ juga, terlepas
      // dari mic mana (FAB kecil atau tombol besar di halaman) yang dipakai.
      if (pageStatus) pageStatus.textContent = text;
      if (pageSub) pageSub.textContent = transcript ? 'DJ' : (state === 'error' ? 'DJ' : '');
      if (pageTranscript) pageTranscript.textContent = transcript || '';
    }

    function hideBubble(delay){
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (bubble) bubble.classList.remove('show');
        // Kembalikan halaman penuh DJ ke sapaan default begitu percakapan
        // selesai, supaya tidak menampilkan balasan lama selamanya.
        if (pageStatus) pageStatus.textContent = DEFAULT_STATUS.text;
        if (pageSub) pageSub.textContent = DEFAULT_STATUS.sub;
        if (pageTranscript) pageTranscript.textContent = '';
      }, delay || 0);
    }

    return { setFabState, showBubble, hideBubble };
  })();

  /* ------------------------------------------------------------------ *
   * 3. TTS (optional) — spoken confirmation of what Lolu is doing
   * ------------------------------------------------------------------ */
  const TTS = (function(){
    const synth = window.speechSynthesis;
    let enabled = true;

    function speak(text, lang, onend){
      if (!enabled || !synth || !text){ if (onend) onend(); return; }
      try{
        synth.cancel(); // don't stack utterances
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang || 'en-US';
        u.rate = 1.02;
        u.onend = () => { if (onend) onend(); };
        u.onerror = () => { if (onend) onend(); };
        synth.speak(u);
      }catch(e){ if (onend) onend(); }
    }

    return {
      speak,
      setEnabled(v){ enabled = !!v; },
      isEnabled(){ return enabled; }
    };
  })();

  /* ------------------------------------------------------------------ *
   * 4. SPEECH RECOGNITION MODULE
   * ------------------------------------------------------------------ */
  const SpeechRecognitionModule = (function(){
    const LANGS = ['en-US', 'id-ID'];
    let langIdx = (localStorage.getItem('voiceDjLang') === 'id-ID') ? 1 : 0;
    let recognition = null;
    let listening = false;
    let safetyTimer = null;

    function currentLang(){ return LANGS[langIdx]; }

    function updateLangBtn(){
      const label = currentLang() === 'id-ID' ? 'ID' : 'EN';
      if (langBtn) langBtn.textContent = label;
      const pageLangBtn = document.getElementById('vdj-page-lang-btn');
      if (pageLangBtn) pageLangBtn.textContent = label;
    }
    updateLangBtn();

    function toggleLanguage(){
      langIdx = (langIdx + 1) % LANGS.length;
      localStorage.setItem('voiceDjLang', currentLang());
      updateLangBtn();
      toast(currentLang() === 'id-ID' ? ' Voice language: Indonesian' : ' Voice language: English');
    }

    function buildRecognizer(){
      const r = new SR();
      r.lang = currentLang();
      r.continuous = false;      // stop automatically once a result comes in
      r.interimResults = false;  // only final results
      r.maxAlternatives = 1;
      return r;
    }

    // callbacks: { onStart, onResult(text), onError(err), onEnd }
    function start(callbacks){
      if (listening) return;
      callbacks = callbacks || {};
      recognition = buildRecognizer();
      listening = true;

      recognition.onstart = () => { if (callbacks.onStart) callbacks.onStart(); };

      recognition.onresult = (e) => {
        clearTimeout(safetyTimer);
        const text = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || '';
        if (callbacks.onResult) callbacks.onResult(text.trim());
      };

      recognition.onerror = (e) => {
        clearTimeout(safetyTimer);
        listening = false;
        if (callbacks.onError) callbacks.onError(e.error || 'unknown');
      };

      recognition.onend = () => {
        clearTimeout(safetyTimer);
        listening = false;
        if (callbacks.onEnd) callbacks.onEnd();
      };

      try{
        recognition.start();
        // Safety timeout: if the browser never fires a result/error/end
        // (rare, but happens on some mobile WebViews), force a stop after
        // a timeout so the mic doesn't get stuck in "listening" forever.
        safetyTimer = setTimeout(() => { try{ recognition.stop(); }catch(e){} }, 9000);
      }catch(e){
        listening = false;
        if (callbacks.onError) callbacks.onError('start-failed');
      }
    }

    function stop(){
      if (recognition && listening){ try{ recognition.stop(); }catch(e){} }
    }

    function abort(){
      if (recognition){ try{ recognition.abort(); }catch(e){} }
      listening = false;
    }

    return { start, stop, abort, toggleLanguage, currentLang, isListening: () => listening };
  })();

  /* ------------------------------------------------------------------ *
   * 5. MUSIC SEARCH — song & artist lookup (reuses vibexa's iTunes calls)
   * ------------------------------------------------------------------ */
  const MusicSearch = (function(){

    function trackFromItunesItem(it){
      const thumb = (it.artworkUrl100 || '').replace('100x100bb', '600x600bb');
      return {
        title: it.trackName || 'Unknown',
        artist: it.artistName || 'Unknown',
        thumb,
        album: it.collectionName || '',
        preview: it.previewUrl || null,
        videoId: null,
        photo: null,
        duration: it.trackTimeMillis ? Math.round(it.trackTimeMillis / 1000) : 0,
        _query: `${it.artistName}|||${it.trackName}|||${it.trackId || Math.random()}`
      };
    }

    // Search a specific "title [by artist]" and return the best-matching track
    // plus a small queue of related results (so Next/Previous keep working).
    async function findBestSong(title, artist){
      const term = artist ? `${title} ${artist}` : title;
      let items = [];
      try{
        items = await fetchItunesResults(term, 'US', 'song', 25);
      }catch(e){ items = []; }
      if (!items.length) return null;

      items.sort((a, b) => {
        const scoreA = wordOverlapScore(title, a.trackName) + (artist ? wordOverlapScore(artist, a.artistName) : 0);
        const scoreB = wordOverlapScore(title, b.trackName) + (artist ? wordOverlapScore(artist, b.artistName) : 0);
        return scoreB - scoreA;
      });

      const best = items[0];
      const queue = items.slice(0, 15).map(trackFromItunesItem);
      return { track: trackFromItunesItem(best), queue };
    }

    // Search all songs by a given artist name.
    async function findArtistTracks(artistName){
      let items = [];
      try{
        items = await fetchItunesResults(artistName, 'US', 'song', 50);
      }catch(e){ items = []; }
      const nArtist = norm(artistName);
      const matched = items.filter(it => {
        const a = norm(it.artistName || '');
        return a === nArtist || a.includes(nArtist) || nArtist.includes(a);
      });
      const pool = matched.length ? matched : items;
      if (!pool.length) return null;
      return pool.slice(0, 25).map(trackFromItunesItem);
    }

    // Decide whether a bare "play X" phrase (no "by <artist>") means an
    // artist or a specific song, then resolve it fully. This is the piece
    // that lets "Play Justin Bieber" and "Play Shape of You" both work
    // without the user ever saying the word "artist".
    async function resolveAmbiguousPlay(query){
      let items = [];
      try{
        items = await fetchItunesResults(query, 'US', 'song', 15);
      }catch(e){ items = []; }
      if (!items.length) return null;

      const nQuery = norm(query);
      const topArtistName = norm(items[0].artistName || '');
      const looksLikeArtist = topArtistName && (topArtistName === nQuery || nQuery.includes(topArtistName));

      if (looksLikeArtist){
        const tracks = await findArtistTracks(items[0].artistName);
        if (tracks && tracks.length){
          return { intent: 'play_artist', artist: items[0].artistName, tracks };
        }
      }
      // Fall back to treating it as a song title search.
      const best = items[0];
      const queue = items.slice(0, 15).map(trackFromItunesItem);
      return { intent: 'play_song', title: best.trackName, artist: best.artistName, track: trackFromItunesItem(best), queue };
    }

    return { findBestSong, findArtistTracks, resolveAmbiguousPlay, trackFromItunesItem };
  })();

  /* ------------------------------------------------------------------ *
   * 6. PLAYLIST SEARCH — fuzzy match against the logged-in user's playlists
   * ------------------------------------------------------------------ */
  const PlaylistSearch = (function(){
    const FAVORITES_WORDS = ['favorite', 'favorites', 'favourite', 'favourites', 'liked songs', 'liked song', 'favorit', 'kesukaan', 'lagu favorit', 'lagu yang disukai'];

    function findByName(spokenName){
      if (!spokenName) return null;
      const n = norm(spokenName);
      if (FAVORITES_WORDS.some(w => n === norm(w) || n.includes(norm(w)))){
        if (typeof ensureLikedPlaylist === 'function') ensureLikedPlaylist();
        return (typeof playlists !== 'undefined' && playlists[LIKED_PLAYLIST_ID]) || null;
      }
      if (typeof playlists === 'undefined') return null;

      let best = null, bestScore = 0;
      Object.keys(playlists).forEach(id => {
        const pl = playlists[id];
        if (!pl || !pl.name) return;
        const pn = norm(pl.name);
        let score = 0;
        if (pn === n) score = 1;
        else if (pn.includes(n) || n.includes(pn)) score = 0.7;
        else score = wordOverlapScore(spokenName, pl.name) * 0.6;
        if (score > bestScore){ bestScore = score; best = pl; }
      });
      return bestScore >= 0.4 ? best : null;
    }

    return { findByName };
  })();

  /* ------------------------------------------------------------------ *
   * 7. PLAYBACK CONTROLLER — the only module that touches the real player
   * ------------------------------------------------------------------ */
  const PlaybackController = (function(){

    function getVolEl(){ return document.getElementById('vol'); }
    function getVolume(){ const el = getVolEl(); return el ? (parseInt(el.value, 10) || 0) : 0; }
    function setVolume(v){
      const el = getVolEl();
      if (!el) return;
      v = Math.max(0, Math.min(100, Math.round(v)));
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    let _mutedPrevVolume = null;

    function playTrack(track, queue){
      if (queue && queue.length) curQueue = queue;
      else curQueue = [track];
      loadPlay(track, null);
    }

    function playPlaylist(pl){
      if (!pl || !pl.tracks || !pl.tracks.length) return false;
      curQueue = [...pl.tracks];
      loadPlay(pl.tracks[0], pl.id || null);
      return true;
    }

    function pause(){
      try{
        if (curTrack && curTrack.offline){
          const dl = document.getElementById('dl-audio');
          if (dl) dl.pause();
          return;
        }
        if (YTP && typeof playing !== 'undefined' && playing) YTP.pauseVideo();
      }catch(e){}
    }

    function resume(){
      try{
        if (curTrack && curTrack.offline){
          const dl = document.getElementById('dl-audio');
          if (dl) dl.play().catch(()=>{});
          return;
        }
        if (YTP && !playing) YTP.playVideo();
        else if (!YTP && curTrack) loadPlay(curTrack, null);
      }catch(e){}
    }

    function stopPlayback(){
      try{
        if (curTrack && curTrack.offline){
          const dl = document.getElementById('dl-audio');
          if (dl){ dl.pause(); dl.currentTime = 0; }
          return;
        }
        if (YTP){ YTP.pauseVideo(); YTP.seekTo(0, true); }
      }catch(e){}
    }

    function next(){ if (typeof playNext === 'function') playNext(); }
    function prev(){ if (typeof playPrev === 'function') playPrev(); }

    function repeatAll(){
      let tries = 0;
      while (typeof _repeatMode !== 'undefined' && _repeatMode !== 'all' && tries < 3){ toggleRepeatMode(); tries++; }
    }
    function repeatOne(){
      let tries = 0;
      while (typeof _repeatMode !== 'undefined' && _repeatMode !== 'one' && tries < 3){ toggleRepeatMode(); tries++; }
    }
    function repeatOff(){
      let tries = 0;
      while (typeof _repeatMode !== 'undefined' && _repeatMode !== 'off' && tries < 3){ toggleRepeatMode(); tries++; }
    }

    function shuffleQueue(){
      if (typeof curQueue === 'undefined' || curQueue.length < 2) return false;
      const currentIdx = curTrack ? curQueue.findIndex(t => t._query === curTrack._query) : -1;
      const current = currentIdx !== -1 ? curQueue[currentIdx] : null;
      let rest = curQueue.filter((_, i) => i !== currentIdx);
      if (typeof _shuffleArray === 'function') rest = _shuffleArray(rest);
      else rest = rest.map(v => [Math.random(), v]).sort((a,b)=>a[0]-b[0]).map(p=>p[1]);
      curQueue = current ? [current, ...rest] : rest;
      return true;
    }

    function volumeUp(){ setVolume(getVolume() + 10); return getVolume(); }
    function volumeDown(){ setVolume(getVolume() - 10); return getVolume(); }
    function setVolumeTo(n){ setVolume(n); return getVolume(); }

    function mute(){ if (_mutedPrevVolume === null) _mutedPrevVolume = getVolume(); setVolume(0); }
    function unmute(){ setVolume(_mutedPrevVolume === null ? 80 : _mutedPrevVolume); _mutedPrevVolume = null; }

    // Volume ducking while Lolu is listening/processing a command.
    let _duckPrevVolume = null;
    function duck(){
      if (typeof playing === 'undefined' || !playing) return;
      _duckPrevVolume = getVolume();
      setVolume(Math.max(4, Math.round(_duckPrevVolume * 0.18)));
    }
    function unduck(){
      if (_duckPrevVolume === null) return;
      setVolume(_duckPrevVolume);
      _duckPrevVolume = null;
    }

    return {
      playTrack, playPlaylist, pause, resume, stopPlayback, next, prev,
      repeatAll, repeatOne, repeatOff, shuffleQueue,
      volumeUp, volumeDown, setVolumeTo, mute, unmute,
      duck, unduck, getVolume, setVolume
    };
  })();

  /* ------------------------------------------------------------------ *
   * 8. INTENT PARSER — turns recognized text into structured commands
   * ------------------------------------------------------------------ */
  const IntentParser = (function(){

    // Deterministic (rule-based) patterns cover every command in the spec
    // without needing a network round-trip for anything except resolving
    // which song/artist/playlist the user meant.
    function parse(rawText){
      const text = (rawText || '').trim();
      const n = norm(text);
      if (!n) return { intent: 'unknown', raw: rawText };

      // ── Volume: explicit percentage ────────────────────────────────
      let m = n.match(/(?:set\s+)?(?:the\s+)?volume\s+(?:to|at|ke)?\s*(\d{1,3})\s*(?:%|percent|persen)?$/)
            || n.match(/(?:atur|set)\s+volume\s+(?:ke|jadi)\s*(\d{1,3})/);
      if (m) return { intent: 'set_volume', level: Math.max(0, Math.min(100, parseInt(m[1], 10))), raw: text };

      // ── Mute / Unmute ───────────────────────────────────────────────
      if (/^(unmute|suarakan|nyalakan suara|bunyikan lagi)\b/.test(n)) return { intent: 'unmute', raw: text };
      if (/^(mute|bisukan|senyapkan|diamkan)\b/.test(n)) return { intent: 'mute', raw: text };

      // ── Volume up / down ─────────────────────────────────────────────
      if (/\b(volume\s*up|turn\s*(it\s*)?up|louder|naikkan\s*volume|kencangkan(?:\s*volume)?|besarkan\s*volume)\b/.test(n))
        return { intent: 'volume_up', raw: text };
      if (/\b(volume\s*down|turn\s*(it\s*)?down|quieter|lower\s*(?:the\s*)?volume|kecilkan\s*volume|pelankan(?:\s*volume)?)\b/.test(n))
        return { intent: 'volume_down', raw: text };

      // ── Repeat this song (repeat-one) vs generic repeat (repeat-all) ─
      if (/\b(repeat\s+this\s+song|repeat\s+one|ulangi\s+lagu\s+ini|ulang\s+lagu\s+ini)\b/.test(n))
        return { intent: 'repeat_one', raw: text };
      if (/\b(repeat|ulangi|ulang)\b/.test(n))
        return { intent: 'repeat_all', raw: text };

      // ── Shuffle ───────────────────────────────────────────────────────
      if (/\b(shuffle|acak(?:kan)?)\b/.test(n)) return { intent: 'shuffle', raw: text };

      // ── Next / Previous ───────────────────────────────────────────────
      if (/\b(next\s*(song|track)?|skip(?:\s+this\s+song)?|lagu\s*berikutnya|selanjutnya)\b/.test(n))
        return { intent: 'next_track', raw: text };
      if (/\b(previous\s*(song|track)?|go\s*back|lagu\s*sebelumnya|sebelumnya|balik\s*lagu)\b/.test(n))
        return { intent: 'previous_track', raw: text };

      // ── Stop vs Pause (check "stop" before generic pause wording) ────
      if (/^(stop|berhenti)\b(?!\s*sebentar)/.test(n)) return { intent: 'stop', raw: text };
      if (/^(pause|jeda|berhenti\s*sebentar)\b/.test(n)) return { intent: 'pause', raw: text };

      // ── Resume (bare "play"/"putar" with nothing else spoken) ────────
      if (/^(resume|continue|unpause|lanjutkan|lanjut|terusin)\b$/.test(n)) return { intent: 'resume', raw: text };
      if (/^(play|putar)$/.test(n)) return { intent: 'resume', raw: text };

      // ── Search (explicit "find"/"search"/"cari") ──────────────────────
      m = text.match(/^(?:find|search(?:\s+for)?|cari(?:\s+lagu)?)\s+(?:songs?\s+)?(?:by\s+)?(.+)$/i);
      if (m) return { intent: 'search_music', query: m[1].trim(), raw: text };

      // ── Play playlist ──────────────────────────────────────────────
      // "play my workout playlist" / "play my favorites" / "putar playlist X"
      m = text.match(/^(?:play|putar)\s+my\s+(.+?)\s+playlist$/i)
       || text.match(/^(?:play|putar)\s+(?:the\s+)?playlist\s+(.+)$/i)
       || text.match(/^(?:play|putar)\s+(.+?)\s+playlist$/i)
       || text.match(/^(?:play|putar)\s+my\s+(favorites?|favourites?|liked\s*songs?)$/i)
       || text.match(/^(?:play|putar)\s+playlist\s*(?:saya|ku)?\s+(.+)$/i);
      if (m) return { intent: 'play_playlist', playlist: m[1].trim(), raw: text };

      // ── Play song "X by Y" / "putar X dari/oleh Y" ────────────────────
      m = text.match(/^(?:play|putar)\s+(.+?)\s+(?:by|dari|oleh)\s+(.+)$/i);
      if (m) return { intent: 'play_song', title: m[1].trim(), artist: m[2].trim(), raw: text };

      // ── Play <ambiguous song-or-artist> — resolved later by MusicSearch ─
      m = text.match(/^(?:play|putar)\s+(.+)$/i);
      if (m) return { intent: 'play_resolve', query: m[1].trim(), raw: text };

      return { intent: 'unknown', raw: text };
    }

    return { parse };
  })();

  /* ------------------------------------------------------------------ *
   * 9. RESPONSE TEXT — human-readable confirmations (spoken + shown)
   * ------------------------------------------------------------------ */
  function responseFor(intentResult, lang){
    const id = lang === 'id-ID';
    switch (intentResult.intent){
      case 'play_song':      return id ? `Memutar ${intentResult.title} dari ${intentResult.artist}.` : `Playing ${intentResult.title} by ${intentResult.artist}.`;
      case 'play_artist':    return id ? `Memutar lagu-lagu dari ${intentResult.artist}.` : `Playing songs by ${intentResult.artist}.`;
      case 'play_playlist':  return id ? `Memutar playlist ${intentResult.playlistName}.` : `Playing your ${intentResult.playlistName} playlist.`;
      case 'pause':           return id ? 'Musik dijeda.' : 'Pausing your music.';
      case 'resume':          return id ? 'Melanjutkan musik.' : 'Resuming playback.';
      case 'stop':             return id ? 'Musik dihentikan.' : 'Stopping playback.';
      case 'next_track':      return id ? 'Lanjut ke lagu berikutnya.' : 'Skipping to the next song.';
      case 'previous_track':  return id ? 'Kembali ke lagu sebelumnya.' : 'Playing the previous song.';
      case 'shuffle':          return id ? 'Antrian diacak.' : 'Shuffling your queue.';
      case 'repeat_all':      return id ? 'Mode ulangi semua diaktifkan.' : 'Repeat is on.';
      case 'repeat_one':      return id ? 'Mengulang lagu ini.' : 'Repeating this song.';
      case 'volume_up':       return id ? 'Volume dinaikkan.' : 'Volume up.';
      case 'volume_down':     return id ? 'Volume diturunkan.' : 'Volume down.';
      case 'set_volume':      return id ? `Volume diatur ke ${intentResult.level} persen.` : `Volume set to ${intentResult.level} percent.`;
      case 'mute':              return id ? 'Suara dibisukan.' : 'Muted.';
      case 'unmute':           return id ? 'Suara dinyalakan lagi.' : 'Unmuted.';
      case 'search_music':    return id ? `Menampilkan hasil pencarian untuk ${intentResult.query}.` : `Here's what I found for ${intentResult.query}.`;
      case 'not_found':        return id ? 'Maaf, aku tidak menemukan itu.' : "Sorry, I couldn't find that.";
      default:                  return id ? 'Maaf, aku tidak mengerti perintah itu.' : "Sorry, I didn't catch that command.";
    }
  }

  /* ------------------------------------------------------------------ *
   * 10. COMMAND EXECUTOR — glues Intent Parser + Search modules to the
   *     Playback Controller, then reports back through UI + TTS.
   * ------------------------------------------------------------------ */
  async function executeIntent(intentResult, lang){
    let final = intentResult;

    try{
      switch (intentResult.intent){

        case 'play_resolve': {
          const resolved = await MusicSearch.resolveAmbiguousPlay(intentResult.query);
          if (!resolved) { final = { intent: 'not_found', raw: intentResult.raw }; break; }
          if (resolved.intent === 'play_artist'){
            PlaybackController.playTrack(resolved.tracks[0], resolved.tracks);
            final = { intent: 'play_artist', artist: resolved.artist };
          } else {
            PlaybackController.playTrack(resolved.track, resolved.queue);
            final = { intent: 'play_song', title: resolved.title, artist: resolved.artist };
          }
          break;
        }

        case 'play_song': {
          const found = await MusicSearch.findBestSong(intentResult.title, intentResult.artist);
          if (!found) { final = { intent: 'not_found', raw: intentResult.raw }; break; }
          PlaybackController.playTrack(found.track, found.queue);
          final = { intent: 'play_song', title: found.track.title, artist: found.track.artist };
          break;
        }

        case 'play_playlist': {
          const pl = PlaylistSearch.findByName(intentResult.playlist);
          if (!pl) { final = { intent: 'not_found', raw: intentResult.raw }; break; }
          PlaybackController.playPlaylist(pl);
          final = { intent: 'play_playlist', playlistName: pl.name };
          break;
        }

        case 'search_music': {
          if (typeof showSearchView === 'function') showSearchView();
          const qInput = document.getElementById('q') || document.getElementById('home-q');
          if (qInput) qInput.value = intentResult.query;
          if (typeof doSearch === 'function') { await doSearch(); }
          final = { intent: 'search_music', query: intentResult.query };
          break;
        }

        case 'pause':          PlaybackController.pause(); break;
        case 'resume':         PlaybackController.resume(); break;
        case 'stop':            PlaybackController.stopPlayback(); break;
        case 'next_track':     PlaybackController.next(); break;
        case 'previous_track': PlaybackController.prev(); break;
        case 'shuffle': {
          const ok = PlaybackController.shuffleQueue();
          if (!ok) final = { intent: 'not_found', raw: intentResult.raw };
          break;
        }
        case 'repeat_all':     PlaybackController.repeatAll(); break;
        case 'repeat_one':     PlaybackController.repeatOne(); break;
        case 'volume_up':      PlaybackController.volumeUp(); break;
        case 'volume_down':    PlaybackController.volumeDown(); break;
        case 'set_volume':     PlaybackController.setVolumeTo(intentResult.level); break;
        case 'mute':             PlaybackController.mute(); break;
        case 'unmute':          PlaybackController.unmute(); break;

        default:
          final = { intent: 'unknown', raw: intentResult.raw };
      }
    }catch(e){
      console.error('Voice AI DJ: command failed', e);
      final = { intent: 'not_found', raw: intentResult.raw };
    }

    return final;
  }

  /* ------------------------------------------------------------------ *
   * 11. MAIN FLOW — wires the mic button to everything above
   * ------------------------------------------------------------------ */
  const L = {
    listening: 'Listening...',
    listening_id: 'Mendengarkan...',
    processing: 'Processing...',
    processing_id: 'Memproses...'
  };

  function beginListening(){
    if (SpeechRecognitionModule.isListening()) return; // ignore double taps
    const lang = SpeechRecognitionModule.currentLang();
    const isId = lang === 'id-ID';

    PlaybackController.duck();
    UIStateManager.setFabState('listening');
    UIStateManager.showBubble('listening', isId ? L.listening_id : L.listening, '');

    SpeechRecognitionModule.start({
      onStart(){ /* mic is live */ },

      onResult(text){
        UIStateManager.setFabState('processing');
        UIStateManager.showBubble('processing', isId ? L.processing_id : L.processing, text);
        handleTranscript(text, lang);
      },

      onError(err){
        PlaybackController.unduck();
        UIStateManager.setFabState('idle');
        if (err === 'no-speech'){
          UIStateManager.showBubble('error', isId ? 'Tidak terdengar suara.' : "Didn't hear anything.", '');
        } else if (err === 'not-allowed' || err === 'service-not-allowed'){
          UIStateManager.showBubble('error', isId ? 'Izin mikrofon ditolak.' : 'Microphone access was denied.', '');
        } else {
          UIStateManager.showBubble('error', isId ? 'Terjadi kesalahan.' : 'Something went wrong.', '');
        }
        UIStateManager.hideBubble(2200);
      },

      onEnd(){
        // If onResult already fired, this is a no-op; if not (e.g. aborted),
        // make sure the mic button doesn't stay stuck lit up.
        if (fabEl && fabEl.classList.contains('listening')){
          PlaybackController.unduck();
          UIStateManager.setFabState('idle');
          UIStateManager.hideBubble(300);
        }
      }
    });
  }

  async function handleTranscript(text, lang){
    const isId = lang === 'id-ID';
    const intentResult = IntentParser.parse(text);
    const finalResult = await executeIntent(intentResult, lang);
    const responseText = responseFor(finalResult, lang);

    UIStateManager.setFabState('speaking');
    UIStateManager.showBubble(
      finalResult.intent === 'not_found' || finalResult.intent === 'unknown' ? 'error' : 'speaking',
      responseText,
      text
    );

    TTS.speak(responseText, lang, () => {
      PlaybackController.unduck();
      UIStateManager.setFabState('idle');
      UIStateManager.hideBubble(1600);
    });

    // Safety net in case TTS never fires onend (disabled/unsupported).
    setTimeout(() => {
      if (fabEl && (fabEl.classList.contains('speaking') || fabEl.classList.contains('processing'))){
        PlaybackController.unduck();
        UIStateManager.setFabState('idle');
        UIStateManager.hideBubble(1200);
      }
    }, 4500);
  }

  function onMicButtonClick(){
    if (SpeechRecognitionModule.isListening()){
      SpeechRecognitionModule.stop();
      return;
    }
    beginListening();
  }

  if (fabEl) fabEl.addEventListener('click', onMicButtonClick);
  // Tombol mic besar di halaman penuh DJ dipanggil lewat onclick="VoiceDJ.toggle()"
  // di HTML (lihat #vdj-page-mic-btn), bukan addEventListener di sini, supaya
  // tidak double-fire kalau kedua cara sama-sama dipasang.

  /* ------------------------------------------------------------------ *
   * 12. Public API (handy for debugging / future extension)
   * ------------------------------------------------------------------ */
  window.VoiceDJ = {
    toggleLanguage: SpeechRecognitionModule.toggleLanguage,
    start: beginListening,
    stop: SpeechRecognitionModule.stop,
    toggle: onMicButtonClick, // dipakai tombol mic besar di halaman penuh DJ
    parseIntent: IntentParser.parse,     // exposed so new commands can be tested from the console
    setTTSEnabled: TTS.setEnabled,
    _modules: { SpeechRecognitionModule, IntentParser, MusicSearch, PlaylistSearch, PlaybackController, UIStateManager, TTS }
  };

})();
