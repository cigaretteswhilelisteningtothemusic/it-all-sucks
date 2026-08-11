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

  // ── Bahasa fitur Lolu Voice — SEKARANG FIXED, tombol toggle "ID/EN" sudah
  // dihilangkan (permintaan: Lolu Voice cuma balas Bahasa Inggris, tapi
  // tetap harus paham kalau user ngomong pakai Bahasa Indonesia/bahasa
  // lain). Dipisah jadi dua konstanta:
  //   - RECOGNITION_LANG -> bahasa yang dipasang ke Web Speech API buat
  //     dengerin (Speech-to-Text). Tetap 'id-ID' supaya ucapan Bahasa
  //     Indonesia user tetap terdengar/ke-transkrip dengan akurat (intent
  //     parser di bawah sudah dwibahasa ID/EN, jadi ucapan Inggris simpel
  //     tetap kekenali juga lewat pola regex-nya).
  //   - OUTPUT_LANG -> bahasa balasan Lolu (teks bubble + suara TTS),
  //     SELALU Inggris, tidak bisa diganti user lagi.
  const RECOGNITION_LANG = 'id-ID';
  const OUTPUT_LANG = 'en-US';

  // Balasan teks yang lagi "menunggu" suara Piper BENERAN mulai diputar
  // (lihat UIState.setThinking() & bagian 10 - _lvShowSpeakingAnim). Selagi
  // ini ter-isi, bubble status masih menampilkan "Lolu lagi mikir..."
  // (BUKAN teks balasannya) supaya user tahu Lolu masih menyiapkan suara,
  // bukan diam tanpa tanda apa pun. Di-null-kan lagi begitu sudah dipakai.
  let _lvPendingReplyText = null;

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
      r.lang = RECOGNITION_LANG;
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

    function isListening() { return listening; }

    return { isSupported, start, stop, isListening };
  })();

  // ==========================================================================
  // 2) INTENT PARSER — "AI intent parser" lokal berbasis pola bahasa alami
  //    (ID + EN) yang mengubah teks bebas jadi objek command terstruktur.
  //    Berjalan 100% di browser (tanpa API/server) supaya responsif &
  //    tetap jalan walau koneksi lambat. Bisa dengan mudah disambungkan ke
  //    LLM (mis. _aiCallGemini yang sudah ada di vibexa.js) sebagai fallback
  //    untuk ucapan yang lebih rumit/ambigu — lihat fallback di bagian bawah.
  // ==========================================================================
  // ── Pola DJ (dipakai IntentParser di bawah, dan dipakai ulang oleh
  // lolu-dj.js lewat LoluVoiceDJ.parseIntent buat mengenali permintaan DJ
  // yang DIKETIK di Chat AI juga, bukan cuma diucapkan). Dwibahasa ID/EN. ──
  const DJ_START_RE = /\b(start dj mode|turn on dj mode|jadi(kan)? dj|mulai (mode )?dj|aktifkan (mode )?dj|nyalakan (mode )?dj|dj mode on)\b/i;
  const DJ_STOP_RE = /\b(stop dj mode|turn off dj mode|matikan (mode )?dj|berhenti (jadi|mode) dj|dj mode off|keluar dari mode dj)\b/i;
  const DJ_ASK_RE = /(what('?s| is) (this|the) song|what song is (this|playing)|who (sings|is singing|made) this|tell me about (this (song|artist|track)|the artist)|lagu apa (ini|yang lagi diputar)|siapa (yang nyanyi|penyanyi|artis)(nya)?( ini)?|info(nya)? (tentang )?(lagu|artis) ini)/i;

  // Kata pemicu supaya kata mood ambigu (mis. "sad") TIDAK ketangkep saat
  // user cuma curhat biasa ("aku lagi sedih") — harus disertai kata
  // permintaan lagu/musik dulu baru dianggap permintaan DJ.
  const DJ_MOOD_TRIGGER_RE = /\b(play|putar|puterin|give me|kasih(kan)?( aku| saya)?|mau (dengar|denger)|pengen (dengar|denger)|i want|aku (mau|pengen)|music|lagu|songs?|playlist)\b/i;
  const DJ_MOOD_DEFS = [
    { mood: 'chill', re: /\b(chill|santai|tenang|calm|relax(ing)?|mellow)\b/i },
    { mood: 'workout', re: /\b(work ?out|gym|olahraga|nge-?gym|semangat olahraga)\b/i },
    { mood: 'party', re: /\b(party|pesta|dugem|nge-?dance)\b/i },
    { mood: 'focus', re: /\b(focus|fokus|belajar|study(ing)?|nugas|deep work)\b/i },
    { mood: 'romantic', re: /\b(romantic|romantis|honeymoon)\b/i },
    { mood: 'throwback', re: /\b(throwback|nostalgia|jadul|lawas|zaman dulu)\b/i },
    { mood: 'favorites', re: /\b(similar to my favorites|mirip (lagu )?favorit(ku)?|based on my taste|sesuai selera(ku)?|mirip (punya)?ku)\b/i },
    { mood: 'surprise', re: /\b(surprise me|kejutkan (aku|saya)|terserah( kamu| lolu)?|whatever you want|populer|trending|viral|top hits?|top chart|paling hits|paling rame|lagi hits|hits banget)\b/i },
    { mood: 'happy', re: /\b(happy|senang|bahagia|ceria|mood booster)\b/i },
    { mood: 'sad', re: /\b(sad|sedih|galau|patah hati|baper)\b/i }
  ];
  function _detectMood(t) {
    if (!DJ_MOOD_TRIGGER_RE.test(t)) return null;
    for (const def of DJ_MOOD_DEFS) { if (def.re.test(t)) return def.mood; }
    return null;
  }

  // ── "Putar BANYAK lagu sekaligus" — dipakai supaya DJ bisa langsung
  // mengisi antrian (kotak "Next Song" di Now Playing, lihat vibexa.js
  // _renderNPNextSongBox()/_renderLyrNextSongBox()) dengan banyak lagu
  // sekaligus, bukan cuma 1 lagu. Dua bentuk yang didukung:
  //   1. "putarkan/putar N lagu dari/oleh <artis>" (EN: "play N songs
  //      from/by <artist>") -> mode 'artist'
  //   2. "putarkan/putar N lagu yang (sedang) populer/hits/trending/viral"
  //      (EN: "play N popular/trending/hit/top songs") -> mode 'popular'
  // Angka N OPSIONAL di kedua bentuk — kalau user tidak menyebut angka sama
  // sekali, count dikembalikan null (di-default-kan ke 20 lagu oleh
  // pemanggilnya, lihat DEFAULT_PLAY_MANY_COUNT di handleRecognizedText).
  // Dicek SEBELUM deteksi mood ("surprise" juga cocok dengan kata
  // "populer/trending") supaya "putarkan 15 lagu yang sedang populer"
  // ditangani sebagai daftar banyak lagu, bukan cuma ganti vibe/mood biasa. ──
  const MANY_POPULAR_RE = /\b(?:yang\s+)?(?:sedang\s+)?(populer|hits?|trending|viral|top\s*hits?|top\s*chart|paling\s+(?:rame|hits)|lagi\s+hits)\b/i;
  function _parsePlayMany(text) {
    // ID: "putar(kan)/puterin [N] lagu(-lagu)(nya) dari/oleh <artis>"
    let m = text.match(/^(?:putar(?:kan)?|puterin)\s+(\d+)?\s*lagu(?:-lagu)?(?:nya)?\s+(?:dari|oleh)\s+(.+)$/i);
    if (m && m[2] && m[2].trim()) return { mode: 'artist', count: m[1] ? parseInt(m[1], 10) : null, artist: m[2].trim() };

    // EN: "play [N] songs from/by <artist>"
    m = text.match(/^play\s+(\d+)?\s*songs?\s+(?:from|by)\s+(.+)$/i);
    if (m && m[2] && m[2].trim()) return { mode: 'artist', count: m[1] ? parseInt(m[1], 10) : null, artist: m[2].trim() };

    // ID: "putar(kan)/puterin [N] lagu(-lagu)(nya) ... populer/hits/trending/viral"
    m = text.match(/^(?:putar(?:kan)?|puterin)\s+(\d+)?\s*lagu(?:-lagu)?(?:nya)?\s+.+$/i);
    if (m && MANY_POPULAR_RE.test(text)) {
      return { mode: 'popular', count: m[1] ? parseInt(m[1], 10) : null };
    }

    // EN: "play [N] popular/trending/hit/top songs"
    m = text.match(/^play\s+(\d+)?\s*(?:popular|trending|viral|hit|top)\s*songs?\b/i);
    if (m) return { mode: 'popular', count: m[1] ? parseInt(m[1], 10) : null };
    m = text.match(/^play\s+(\d+)?\s*songs?\s+(?:that\s+are\s+)?(?:popular|trending|viral|hits?)\b/i);
    if (m) return { mode: 'popular', count: m[1] ? parseInt(m[1], 10) : null };

    return null;
  }

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

      // ── "Putar BANYAK lagu sekaligus" (lihat _parsePlayMany di atas) —
      // dicek SEBELUM deteksi mood/vibe DJ di bawah supaya "putarkan 15
      // lagu yang sedang populer" / "putarkan 20 lagu dari Oasis" ditangani
      // sebagai daftar banyak lagu berurutan (mengisi kotak "Next Song"),
      // bukan dianggap ganti mood/vibe biasa. ──
      const many = _parsePlayMany(text);
      if (many) return { intent: 'play_many', mode: many.mode, count: many.count, artist: many.artist || null, raw: text };

      // ── LOLU DJ (lihat lolu-dj.js) — mode "AI DJ" ala Spotify: putar queue
      // otomatis + komentar suara di antara lagu, ganti mood/vibe langsung,
      // dan tanya-jawab soal lagu yang lagi diputar. Dicek SEBELUM pola
      // "play X"/"putar X" generik supaya "play something chill" dkk tidak
      // ketangkep jadi pencarian judul lagu literal. ──
      if (DJ_START_RE.test(t)) return { intent: 'dj_start', raw: text };
      if (DJ_STOP_RE.test(t)) return { intent: 'dj_stop', raw: text };
      if (DJ_ASK_RE.test(t)) return { intent: 'dj_ask', raw: text };
      const _djMood = _detectMood(t);
      if (_djMood) return { intent: 'dj_mood', mood: _djMood, raw: text };

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

    // Ambil N lagu TERATAS yang sedang populer/trending, dipakai fitur DJ
    // "putarkan N lagu yang sedang populer". Pakai cache Top Songs (chart
    // Deezer) yang SUDAH ADA di vibexa.js (_ensureTopSongsFullCache/
    // _topSongToTrack) supaya konsisten dengan daftar "Top Songs" di Home —
    // bukan sumber data baru.
    async function findPopularTracks(count) {
      try {
        if (typeof window._ensureTopSongsFullCache !== 'function' || typeof window._topSongToTrack !== 'function') return [];
        const list = await window._ensureTopSongsFullCache();
        return (list || []).slice(0, count).map(window._topSongToTrack);
      } catch (e) { return []; }
    }

    // Sama seperti findArtistTracks() di atas, tapi jumlah lagunya bisa
    // ditentukan (dipakai fitur DJ "putarkan N lagu dari <artis>").
    async function findArtistTracksCount(artistName, count) {
      try {
        if (typeof window.fetchArtistTopTracks !== 'function') return [];
        const tracks = await fetchArtistTopTracks(artistName, count);
        return (tracks || []).map(t => ({
          title: t.title, artist: t.artist, thumb: t.thumb, album: '',
          preview: t.preview || null, videoId: null, photo: null,
          duration: t.duration, _query: `${t.artist}|||${t.title}|||${t.id}`
        }));
      } catch (e) { return []; }
    }

    return { findSong, findArtistTracks, findPopularTracks, findArtistTracksCount };
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

    function _hasCurTrack() { return !!curTrack; }

    function _playTrackAsQueue(track, queue) {
      if (queue && queue.length) curQueue = queue;
      if (typeof window.loadPlay === 'function') window.loadPlay(track, null);
    }

    // CATATAN PENTING soal `playing`/`YTP`/`_repeatMode` di bawah ini:
    // ketiganya dideklarasikan pakai `let` di top-level vibexa.js. Beda
    // dengan `var`/`function`, deklarasi `let`/`const` di top-level script
    // klasik TIDAK pernah otomatis jadi properti `window` — jadi
    // `window.playing`, `window.YTP`, `window._repeatMode` SELALU undefined
    // walau nilainya sudah berubah di vibexa.js, dan seluruh fungsi di
    // bawah ini diam-diam tidak pernah bekerja. Karena lolu-voice.js dimuat
    // lewat <script> biasa (bukan module) SETELAH vibexa.js di dokumen yang
    // sama, cukup pakai identifier bare (`playing`, `YTP`, `_repeatMode`)
    // supaya otomatis merujuk ke variabel global yang sama lewat scope
    // chain — tanpa perlu ubah apa pun di vibexa.js.
    function pause() {
      if (YTP && playing) { try { YTP.pauseVideo(); } catch (e) {} return true; }
      return false;
    }
    function resume() {
      if (!_hasCurTrack()) return false;
      if (YTP && !playing) { try { YTP.playVideo(); } catch (e) {} return true; }
      if (!YTP && typeof window._togglePlayPause === 'function') { window._togglePlayPause(); return true; }
      return false;
    }
    function stop() {
      if (YTP) { try { YTP.pauseVideo(); YTP.seekTo(0); } catch (e) {} return true; }
      return false;
    }
    function next() { if (typeof window.playNext === 'function') { window.playNext(); return true; } return false; }
    function prev() { if (typeof window.playPrev === 'function') { window.playPrev(); return true; } return false; }
    function repeatToggle() { if (typeof window.toggleRepeatMode === 'function') { window.toggleRepeatMode(); return _repeatMode; } return null; }
    function repeatOne() {
      // Paksa mode ke 'one' langsung (bukan cuma toggle bergilir)
      if (typeof window.toggleRepeatMode !== 'function') return null;
      let guard = 0;
      while (_repeatMode !== 'one' && guard < 3) { window.toggleRepeatMode(); guard++; }
      return _repeatMode;
    }
    function shuffle() {
      // Acak antrian (curQueue) yang sedang berjalan, kalau ada, lalu lanjut
      // dari lagu yang sedang diputar. Ini best-effort karena Vibexa belum
      // punya toggle "shuffle mode" permanen di player utama.
      if (Array.isArray(curQueue) && curQueue.length > 1 && typeof window._shuffleArray === 'function') {
        const rest = curQueue.filter(t => !curTrack || t.title !== curTrack.title || t.artist !== curTrack.artist);
        curQueue = [curTrack, ...window._shuffleArray(rest)].filter(Boolean);
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
        if (YTP) { try { YTP.setVolume(v); } catch (e) {} } // lihat catatan `playing`/`YTP` di atas
        if (spAudio) { try { spAudio.volume = v / 100; } catch (e) {} } // spAudio juga `let` top-level, sama kasusnya
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
      curQueue = [...pl.tracks];
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
    // NOTE: sekarang ada DUA "tempat" tombol mic + bubble status bisa
    // dipakai — bubble/tombol lama di dalam #ai-chat-overlay (tetap
    // dipertahankan biar tidak mengubah perilaku lama), dan yang baru di
    // halaman khusus #lolu-voice-page (lihat lolu-voice.css). Semua fungsi
    // di bawah sengaja menyasar KEDUANYA sekaligus lewat querySelectorAll,
    // supaya statusnya selalu sinkron di mana pun voice command dipicu.
    // NOTE: dulu ada #lolu-mic-btn (mic di halaman Chat AI) & #lv-mic-topbar-btn
    // (mic khusus mobile di topbar) — keduanya sudah dihapus dari HTML
    // (lihat vibexa.html), sekarang tombol mic cuma satu: #lv-mic-top-btn,
    // di tengah bawah foto burung, konsisten di semua ukuran layar.
    function micBtns() { return document.querySelectorAll('#lv-mic-top-btn'); }
    function bubbles() { return document.querySelectorAll('#lolu-voice-bubble, #lv-status-bubble'); }
    function bubbleTexts() { return document.querySelectorAll('#lolu-voice-bubble-text, #lv-status-text'); }
    // NOTE: #lv-bird-img SENGAJA tidak ikut disasar di sini — foto burung
    // Lolu di halaman Lolu Voice diam/statis (tidak ikut animasi pulsing)
    // sesuai permintaan, biar nyatu dengan halaman.
    function headIcons() { return document.querySelectorAll('#ai-chat-overlay .ai-chat-head-icon img'); }
    // Wrapper teks di bawah mic pada #lolu-voice-page — dipakai untuk
    // menyembunyikan judul+deskripsi idle ("Lolu dj...") selama bubble
    // status ("Listening.../Processing...") sedang tampil.
    function belowMicWrap() { return document.getElementById('lv-below-mic'); }

    function setIdle() {
      micBtns().forEach((b) => b.classList.remove('listening', 'processing'));
      bubbles().forEach((bub) => bub.classList.remove('show'));
      headIcons().forEach((hi) => hi.classList.remove('lolu-voice-pulsing'));
      const w = belowMicWrap(); if (w) w.classList.remove('lv-active');
    }
    function setListening() {
      micBtns().forEach((b) => { b.classList.add('listening'); b.classList.remove('processing'); });
      const label = 'Listening...';
      bubbleTexts().forEach((txt) => { txt.textContent = label; });
      bubbles().forEach((bub) => bub.classList.add('show'));
      headIcons().forEach((hi) => hi.classList.add('lolu-voice-pulsing'));
      const w = belowMicWrap(); if (w) w.classList.add('lv-active');
    }
    function setProcessing(heardText) {
      micBtns().forEach((b) => { b.classList.remove('listening'); b.classList.add('processing'); });
      const label = 'Processing: ' + '“' + (heardText || '') + '”';
      bubbleTexts().forEach((txt) => { txt.textContent = label; });
      bubbles().forEach((bub) => bub.classList.add('show'));
      const w = belowMicWrap(); if (w) w.classList.add('lv-active');
    }
    // Dipakai SELAGI teks balasan sudah ada TAPI suara Piper-nya belum
    // benar-benar mulai diputar (model/predict Piper masih berjalan) —
    // supaya user tetap lihat tanda "Lolu masih menyiapkan sesuatu", bukan
    // halaman diam tiba-tiba tanpa indikasi apa pun. TIDAK auto-hide seperti
    // setReply() — baru diganti ke teks balasan asli begitu suara Piper
    // BENERAN mulai (lihat _lvShowSpeakingAnim di bagian 10 file ini).
    function setThinking() {
      micBtns().forEach((b) => { b.classList.remove('listening'); b.classList.add('processing'); });
      const label = 'Lolu is thinking...';
      bubbleTexts().forEach((txt) => { txt.textContent = label; });
      bubbles().forEach((bub) => bub.classList.add('show'));
      headIcons().forEach((hi) => hi.classList.add('lolu-voice-pulsing'));
      const w = belowMicWrap(); if (w) w.classList.add('lv-active');
    }
    function setReply(text) {
      bubbleTexts().forEach((txt) => { txt.textContent = text; });
      bubbles().forEach((bub) => bub.classList.add('show'));
      const w = belowMicWrap(); if (w) w.classList.add('lv-active');
      setTimeout(() => {
        bubbles().forEach((bub) => bub.classList.remove('show'));
        if (w) w.classList.remove('lv-active');
      }, 3200);
      micBtns().forEach((b) => b.classList.remove('listening', 'processing'));
      headIcons().forEach((hi) => hi.classList.remove('lolu-voice-pulsing'));
    }
    function setError(text) { setReply(text); }
    // Tombol bahasa ("ID/EN", dulu #lv-lang-btn di topbar Lolu Voice) sudah
    // DIHILANGKAN — fitur Lolu Voice sekarang cuma balas Bahasa Inggris,
    // jadi tidak ada lagi yang perlu di-toggle. Fungsi ini dipertahankan
    // (bukan setLangBtnLabel lagi) sebagai jaring pengaman: kalau markup
    // HTML lama di halaman masih menyisakan elemen #lv-lang-btn/.lv-lang-btn
    // (mis. belum sempat dihapus dari file HTML), sembunyikan total di sini
    // lewat JS supaya tidak lagi tampil ke user.
    function hideLangBtn() {
      document.querySelectorAll('#lv-lang-btn, .lv-lang-btn').forEach((b) => {
        b.style.display = 'none';
        b.setAttribute('aria-hidden', 'true');
        b.disabled = true;
      });
    }
    return { setIdle, setListening, setProcessing, setThinking, setReply, setError, hideLangBtn };
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
        u.lang = OUTPUT_LANG;
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
        // { forceEnglish: true } -> khusus fitur Lolu Voice: Lolu WAJIB selalu
        // balas pakai Bahasa Inggris, meski tetap paham kalau user ngomong
        // pakai Bahasa Indonesia/bahasa lain (lihat _aiBuildSystemPrompt di
        // vibexa.js). Chat AI berbasis teks di halaman Lolu Chat TIDAK
        // terpengaruh sama sekali — di sana tetap dipanggil tanpa opsi ini.
        const systemPrompt = typeof _aiBuildSystemPrompt === 'function' ? _aiBuildSystemPrompt({ forceEnglish: true }) : undefined;
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
  // Balasan teks Lolu untuk tiap intent — SELALU Bahasa Inggris (fitur Lolu
  // Voice sekarang cuma balas Inggris). Parameter idText dipertahankan di
  // semua pemanggil supaya diff-nya minimal & gampang dibalikin, tapi tidak
  // lagi dipakai — enText yang selalu dipilih.
  // ==========================================================================
  function reply(idText, enText) { return enText; }

  // ==========================================================================
  // ORKESTRATOR UTAMA — menjalankan 1 siklus penuh voice command sesuai flow
  // yang diminta: tekan mic -> dengarkan -> kecilkan volume -> ubah ke teks ->
  // parse intent -> eksekusi -> balas teks+suara -> kembalikan volume.
  // ==========================================================================
  async function handleRecognizedText(text) {
    UIState.setProcessing(text);
    // Mulai urutan gif loading (openn -> think -> ending) TIAP KALI ada
    // permintaan user yang mulai diproses — BUKAN lagi saat halaman Lolu
    // Voice pertama dibuka (lihat openVoicePage() di bagian 9). Foto Lolu
    // Voice DJ (#lv-bird-img) sengaja disembunyikan sepanjang urutan gif
    // ini (lihat _lvShowLoadingSequence di bagian 9.5) supaya TIDAK muncul
    // sama sekali selagi loading/memproses — baru suara Piper + animasi
    // "voice recognition" (_lvShowSpeakingAnim, bagian 10) yang tampil
    // begitu gif ending selesai.
    _lvShowLoadingSequence();

    const intent = IntentParser.parse(text);
    let replyText = '';
    // true kalau balasannya sudah ditulis langsung ke riwayat Chat AI asli
    // (aiChatDisplay/aiApiHistory lewat AIChatBridge) supaya
    // _pushVoiceTurnToChatLog di bawah (yang cuma nulis versi "tampilan
    // doang", tanpa songs/sticker) TIDAK dobel-nambahin turn yang sama.
    let loggedViaAIChat = false;
    // true kalau LoluDJ.playRequestedSong() sudah menangani suara & bubble
    // balasannya sendiri (lihat lolu-dj.js) — blok TTS di bagian bawah
    // fungsi ini WAJIB dilewati supaya balasannya tidak diucapkan dua kali.
    let djHandledSpeech = false;

    // Lolu Voice & Lolu DJ SENGAJA disatukan: SETIAP permintaan "putar lagu
    // ..." lewat voice (play_song/play_query/play_playlist/search di bawah)
    // otomatis masuk ke mode Lolu DJ — bukan cuma kalau user kebetulan lagi
    // di halaman Lolu DJ. LoluDJ.playRequestedSong() (lolu-dj.js) yang
    // menangani semuanya: user TETAP di halaman Lolu Voice selagi Lolu
    // ngomong duluan, baru SETELAH suaranya selesai halaman Now Playing
    // dibuka & halaman Lolu Voice ditutup — bukan langsung diputar diam2
    // seperti command player biasa (pause/resume/next/dst tetap seperti
    // biasa, tidak lewat DJ).
    const djAvailable = window.LoluDJ && typeof window.LoluDJ.playRequestedSong === 'function';

    try {
      switch (intent.intent) {

        case 'play_song': {
          replyText = reply(`Mencari “${intent.title}”...`, `Looking for “${intent.title}”...`);
          UIState.setProcessing(text);
          const { track, all } = await MusicFinder.findSong(intent.title, intent.artist);
          if (track) {
            if (djAvailable) {
              replyText = await window.LoluDJ.playRequestedSong(track, all);
              djHandledSpeech = true;
            } else {
              PlaybackController.playSongTrack(track, all);
              replyText = reply(`Memutar ${track.title} dari ${track.artist}.`, `Playing ${track.title} by ${track.artist}.`);
            }
          } else {
            replyText = reply(`Maaf, aku tidak menemukan lagu itu.`, `Sorry, I couldn't find that song.`);
          }
          break;
        }

        case 'play_query': {
          // Coba sebagai judul lagu dulu
          const { track, all } = await MusicFinder.findSong(intent.query, '');
          if (track) {
            if (djAvailable) {
              replyText = await window.LoluDJ.playRequestedSong(track, all);
              djHandledSpeech = true;
            } else {
              PlaybackController.playSongTrack(track, all);
              replyText = reply(`Memutar ${track.title} dari ${track.artist}.`, `Playing ${track.title} by ${track.artist}.`);
            }
            break;
          }
          // Fallback: anggap sebagai nama artis
          const artistTracks = await MusicFinder.findArtistTracks(intent.query);
          if (artistTracks.length) {
            if (djAvailable) {
              replyText = await window.LoluDJ.playRequestedSong(artistTracks[0], artistTracks);
              djHandledSpeech = true;
            } else {
              PlaybackController.playSongTrack(artistTracks[0], artistTracks);
              replyText = reply(`Memutar lagu-lagu dari ${intent.query}.`, `Playing songs by ${intent.query}.`);
            }
          } else {
            replyText = reply(`Maaf, aku tidak menemukan “${intent.query}”.`, `Sorry, I couldn't find “${intent.query}”.`);
          }
          break;
        }

        case 'play_many': {
          // "putarkan 15 lagu yang sedang populer" / "putarkan 20 lagu dari
          // Oasis" dkk (lihat _parsePlayMany di IntentParser) — kalau user
          // tidak menyebut angka sama sekali, default ke 20 lagu.
          const DEFAULT_PLAY_MANY_COUNT = 20;
          const count = (intent.count && intent.count > 0) ? Math.min(intent.count, 100) : DEFAULT_PLAY_MANY_COUNT;
          replyText = intent.mode === 'artist'
            ? reply(`Menyiapkan ${count} lagu dari ${intent.artist}...`, `Lining up ${count} songs by ${intent.artist}...`)
            : reply(`Menyiapkan ${count} lagu yang lagi populer...`, `Lining up ${count} popular songs...`);
          UIState.setProcessing(text);
          const manyTracks = intent.mode === 'artist'
            ? await MusicFinder.findArtistTracksCount(intent.artist, count)
            : await MusicFinder.findPopularTracks(count);
          if (manyTracks.length) {
            if (djAvailable) {
              // playRequestedSong() mengisi curQueue dengan SELURUH daftar
              // (manyTracks) & otomatis menyalakan mode DJ kalau belum aktif
              // -> kotak "Next Song" di halaman Now Playing (mobile & PC)
              // otomatis terisi & tampil, lagu diputar berurutan dari sini.
              replyText = await window.LoluDJ.playRequestedSong(manyTracks[0], manyTracks);
              djHandledSpeech = true;
            } else {
              PlaybackController.playSongTrack(manyTracks[0], manyTracks);
              replyText = intent.mode === 'artist'
                ? reply(`Memutar ${manyTracks.length} lagu dari ${intent.artist}.`, `Playing ${manyTracks.length} songs by ${intent.artist}.`)
                : reply(`Memutar ${manyTracks.length} lagu yang lagi populer.`, `Playing ${manyTracks.length} popular songs.`);
            }
          } else {
            replyText = intent.mode === 'artist'
              ? reply(`Maaf, aku tidak menemukan lagu dari ${intent.artist}.`, `Sorry, I couldn't find songs by ${intent.artist}.`)
              : reply(`Maaf, lagi nggak nemu lagu populer sekarang.`, `Sorry, I couldn't find popular songs right now.`);
          }
          break;
        }

        case 'play_playlist': {
          const pl = PlaylistFinder.findByName(intent.playlist);
          if (pl && pl.tracks && pl.tracks.length) {
            if (djAvailable) {
              replyText = await window.LoluDJ.playRequestedSong(pl.tracks[0], pl.tracks);
              djHandledSpeech = true;
            } else if (PlaybackController.playPlaylist(pl)) {
              replyText = reply(`Memutar playlist ${pl.name}.`, `Playing your ${pl.name} playlist.`);
            }
          } else {
            replyText = reply(`Aku tidak menemukan playlist “${intent.playlist}”.`, `I couldn't find a playlist called “${intent.playlist}”.`);
          }
          break;
        }

        case 'search': {
          const { all } = await MusicFinder.findSong(intent.query, '');
          if (all && all.length) {
            if (djAvailable) {
              replyText = await window.LoluDJ.playRequestedSong(all[0], all);
              djHandledSpeech = true;
            } else {
              PlaybackController.playSongTrack(all[0], all);
              replyText = reply(`Ini hasil terbaik untuk “${intent.query}”: ${all[0].title}.`, `Here's the best match for “${intent.query}”: ${all[0].title}.`);
            }
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

        // ── LOLU DJ (lihat lolu-dj.js) — mode AI DJ ala Spotify. Semua
        // logika queue/rekomendasi/komentar suara ada di LoluDJ; di sini
        // cuma memanggil API publiknya & menampilkan hasilnya seperti
        // command lain. Aman dipanggil walau lolu-dj.js belum sempat
        // dimuat (fallback pesan error singkat). ──
        case 'dj_start':
          UIState.setProcessing(reply('Menyalakan mode DJ...', 'Starting DJ mode...'));
          replyText = window.LoluDJ
            ? await window.LoluDJ.start()
            : reply('Mode DJ belum siap, coba lagi ya.', 'DJ mode isn\'t ready yet, try again.');
          break;

        case 'dj_stop':
          replyText = window.LoluDJ
            ? window.LoluDJ.stop()
            : reply('Mode DJ memang belum aktif.', 'DJ mode isn\'t active.');
          break;

        case 'dj_mood':
          UIState.setProcessing(reply('Menyesuaikan vibe...', 'Switching up the vibe...'));
          replyText = window.LoluDJ
            ? await window.LoluDJ.setMood(intent.mood)
            : reply('Mode DJ belum siap, coba lagi ya.', 'DJ mode isn\'t ready yet, try again.');
          break;

        case 'dj_ask':
          UIState.setProcessing(reply('Lolu lagi mikir...', 'Lolu is thinking...'));
          replyText = window.LoluDJ
            ? await window.LoluDJ.askAboutCurrentSong(text)
            : reply('Mode DJ belum siap, coba lagi ya.', 'DJ mode isn\'t ready yet, try again.');
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

    // Kalau LoluDJ.playRequestedSong() sudah menangani suaranya sendiri
    // (lihat djHandledSpeech di atas — itu juga yang menahan lagunya sampai
    // Lolu selesai ngomong), suaranya SUDAH selesai diucapkan sebelum baris
    // ini jalan -> langsung tampilkan balasan final seperti biasa, JANGAN
    // ucapkan replyText lagi di sini supaya tidak dobel bicara.
    if (djHandledSpeech) {
      UIState.setReply(replyText);
    } else if (window.LoluPiperTTS && typeof window.LoluPiperTTS.speakDJ === 'function') {
      // Balasan suara Lolu memakai Piper TTS client-side (lihat lolu-piper-tts.js).
      // Sintesis suaranya (model/predict) bisa makan waktu beberapa detik —
      // selagi itu berjalan, tampilkan dulu tanda "Lolu is thinking..."
      // (BUKAN langsung teks balasannya) supaya user tahu Lolu masih
      // menyiapkan suara, bukan diam tanpa tanda apa pun. Begitu suara Piper
      // BENERAN mulai diputar, _lvShowSpeakingAnim (bagian 10 di bawah) akan
      // otomatis mengganti bubble ini ke teks balasan aslinya lewat
      // _lvPendingReplyText.
      UIState.setThinking();
      _lvPendingReplyText = replyText;
      window.LoluPiperTTS.speakDJ(replyText).catch(function () {
        // Piper gagal total (mis. modul gagal dimuat) -> fallback VoiceOutput
        // (Web Speech API bawaan browser), tampilkan balasan final sekarang juga.
        _lvPendingReplyText = null;
        UIState.setReply(replyText);
        VoiceOutput.speak(replyText);
        // Karena speakDJ gagal, _lvShowSpeakingAnim() (bagian 10) tidak
        // pernah sempat jalan -> foto Lolu Voice DJ bisa nyangkut
        // tersembunyi dari _lvShowLoadingSequence() (bagian 9.5). Paksa
        // balik ke idle (foto DJ tampil lagi) di sini sebagai jaring
        // pengaman.
        _lvResetLoadingSequence();
      });
    } else {
      // Modul Piper tidak tersedia sama sekali -> fallback VoiceOutput langsung.
      UIState.setReply(replyText);
      VoiceOutput.speak(replyText);
      // Sama seperti di atas: tidak ada speakDJ yang jalan sama sekali di
      // jalur ini, jadi pastikan foto DJ balik tampil (bukan nyangkut
      // tersembunyi dari urutan gif loading).
      _lvResetLoadingSequence();
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
  // 9) LOLU VOICE PAGE — halaman khusus (full page) untuk ngobrol pakai
  //    suara, dibuka lewat tombol mic di halaman Chat AI. Berisi 3 bagian
  //    yang disinkronkan dari data yang SUDAH ADA (bukan sumber data baru):
  //      - chat user<->Lolu -> dicerminkan dari aiChatDisplay milik
  //        vibexa.js (sama seperti AIChatBridge di atas)
  //      - "kotak play" -> dicerminkan dari kotak play utama (#bar) milik
  //        vibexa.js, plus tombol like/repeat/play-pause yang MEMANGGIL
  //        LANGSUNG fungsi asli (toggleLikeCurrentTrack, toggleRepeatMode,
  //        _togglePlayPause) supaya perilakunya identik dengan kotak play
  //        asli, bukan implementasi terpisah.
  //        (Kotak play & riwayat chat sudah DIHILANGKAN dari halaman ini
  //        sesuai desain baru — lihat #lv-greeting/#lv-below-mic.)
  // ==========================================================================
  function _lvPage() { return document.getElementById('lolu-voice-page'); }

  // Breakpoint SAMA PERSIS dengan @media (max-width:660px) di lolu-voice.css
  // yang mengubah #lolu-voice-page jadi position:fixed (mobile). Dipakai
  // untuk menentukan induk elemen yang tepat, lihat _lvSyncPageParent().
  const LV_MOBILE_MQ = '(max-width: 660px)';

  // Pastikan #lolu-voice-page berada di induk yang tepat sesuai lebar layar
  // saat ini:
  //  - Desktop (>660px): tetap jadi anak <main id="main"> supaya
  //    position:absolute miliknya (lihat lolu-voice.css) mengikuti area
  //    #main saja -- panel kiri & kanan tetap terlihat, senada halaman
  //    Chat AI.
  //  - Mobile (<=660px): dipindah jadi anak langsung <body> supaya
  //    position:fixed miliknya benar2 relatif ke viewport (bukan
  //    "terjebak" relatif ke #main kalau #main/ancestor punya CSS
  //    transform/filter/will-change), jadi tetap fullscreen menutupi
  //    seluruh layar termasuk search bar (.home-topbar) di luar #main.
  // Aman dipanggil berkali-kali (idempotent) & dipanggil ulang saat resize
  // supaya kalau user mengubah ukuran jendela browser selagi halaman ini
  // terbuka, posisinya otomatis menyesuaikan tanpa perlu ditutup dulu.
  function _lvSyncPageParent() {
    const page = _lvPage();
    if (!page) return;
    const isMobile = window.matchMedia(LV_MOBILE_MQ).matches;
    if (isMobile) {
      if (page.parentElement !== document.body) {
        document.body.appendChild(page);
      }
    } else {
      const main = document.getElementById('main');
      if (main && page.parentElement !== main) {
        main.appendChild(page);
      }
    }
  }

  // Jaga posisi tetap benar kalau user resize jendela browser selagi
  // halaman Lolu Voice sedang terbuka (mis. dari lebar desktop ke sempit
  // atau sebaliknya) — cukup sinkron ulang induknya, tidak perlu tutup
  // halaman.
  window.addEventListener('resize', function () {
    const page = _lvPage();
    if (page && page.classList.contains('show')) _lvSyncPageParent();
  });

  // Teks sapaan "Good morning/afternoon/evening/night" (atau versi Indonesia)
  // di atas foto Lolu, mengikuti jam perangkat saat halaman dibuka. Dipakai
  // untuk DUA tempat sekaligus: #lv-greeting (di dalam halaman Lolu Voice
  // penuh) dan #lvh-greeting (kotak promo Lolu Voice di halaman Home, HANYA
  // tampil di mobile — lihat .lolu-voice-home-card di lolu-voice.css).
  function _lvUpdateGreeting() {
    const els = [document.getElementById('lv-greeting'), document.getElementById('lvh-greeting')];
    if (!els.some(Boolean)) return;
    const h = new Date().getHours();
    // Fitur Lolu Voice sekarang cuma Bahasa Inggris — sapaan selalu Inggris.
    const text = (h >= 4 && h < 11) ? 'Good morning'
               : (h >= 11 && h < 15) ? 'Good afternoon'
               : (h >= 15 && h < 18) ? 'Good evening'
               : 'Good night';
    els.forEach((el) => { if (el) el.textContent = text; });
  }

  // Buka halaman Lolu Voice (dipanggil dari tombol mic di halaman Chat AI)
  // lalu LANGSUNG mulai mendengarkan, persis seperti perilaku tombol mic
  // sebelumnya — cuma sekarang sesi mendengarkannya berlangsung di halaman
  // penuh ini, bukan di dalam overlay Chat AI.
  function openVoicePage() {
    const page = _lvPage();
    // Cek status SEBELUM 'show' ditambahkan -- ini dipakai untuk
    // membedakan "user benar-benar baru masuk halaman ini dari kondisi
    // tertutup" vs "dipanggil ulang selagi halaman sudah terbuka".
    const wasAlreadyOpen = !!(page && page.classList.contains('show'));
    if (page) {
      // Taruh #lolu-voice-page di induk yang tepat SEBELUM ditampilkan:
      // anak <body> khusus mobile (fix fullscreen, lihat komentar di
      // _lvSyncPageParent) atau tetap anak #main di desktop supaya cuma
      // menutupi area halaman utama & panel kiri/kanan tetap terlihat.
      _lvSyncPageParent();
      page.classList.add('show');
      _lvUpdateGreeting();
    }
    // Foto Lolu Voice DJ (#lv-bird-img) SELALU yang pertama kali tampil
    // begitu user baru masuk ke halaman ini — urutan gif loading (openn ->
    // think -> ending) TIDAK lagi dipicu di sini. Sekarang gif itu cuma
    // dipicu tiap kali ada permintaan user yang mulai diproses (lihat
    // _lvShowLoadingSequence() dipanggil dari handleRecognizedText, bagian
    // 8 di atas, dan dari lolu-dj.js untuk aksi lewat tombol/chip).
    //
    // PENTING: openVoicePage() dipanggil BUKAN cuma sekali waktu user
    // pertama masuk halaman ini — lolu-dj.js (_djSpeakThenGoToNowPlaying,
    // juga awal start()/setMood()/playRequestedSong()) memanggil ulang
    // fungsi ini SETIAP KALI walau halaman ini sudah terbuka. Kalau reset
    // di bawah dijalankan tanpa syarat tiap kali itu terjadi, foto DJ akan
    // dipaksa muncul balik SETIAP re-entry -- baik selagi gif openn/think/
    // ending masih jalan, MAUPUN di jeda setelah gif itu selesai tapi
    // sebelum suara Piper beneran mulai (proses generate komentar AI +
    // build queue lagu seringkali lebih lambat dari total durasi gif,
    // jadi jeda ini nyata & sering terjadi). Makanya syaratnya BUKAN
    // "apakah gif sedang aktif" (_lvLoadingActive bisa saja sudah balik
    // false di jeda itu), melainkan "apakah halaman ini MEMANG baru
    // dibuka dari kondisi tertutup" -- reset & foto DJ cuma boleh tampil
    // di titik itu, bukan di re-entry mana pun di tengah satu siklus
    // permintaan yang sedang berjalan.
    if (!wasAlreadyOpen) {
      _lvResetLoadingSequence();
      // Sengaja TIDAK langsung startListening() -- halaman terbuka dalam
      // kondisi idle, mic baru aktif kalau user menekan tombol mic sendiri.
      UIState.setIdle();
    }
    // Tetap siapkan model Piper di background dari sekarang, diam-diam
    // TANPA menampilkan gif apa pun, supaya begitu user pencet mic &
    // ngomong permintaan pertama, prosesnya tidak perlu unduh model dari
    // nol. Aman dipanggil berkali-kali, tidak dobel unduh.
    if (window.LoluPiperTTS && typeof window.LoluPiperTTS.preload === 'function') {
      window.LoluPiperTTS.preload();
    }
  }

  // Tutup halaman Lolu Voice, kembali ke halaman Chat AI (yang tetap
  // terbuka di baliknya — tidak ikut ditutup). Hentikan voice recognition
  // & TTS yang mungkin masih berjalan.
  function closeVoicePage() {
    const page = _lvPage();
    if (page) page.classList.remove('show');
    try { SpeechInput.stop(); } catch (e) {}
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    _lvResetLoadingSequence();
    UIState.setIdle();
  }

  // ==========================================================================
  // 9.5) LOADING GIF SEQUENCE — menggantikan foto burung Lolu (#lv-bird-img)
  //      TEPAT di posisi yang sama dengan #lv-loading-gif SELAMA model suara
  //      Lolu Piper lagi disiapkan (dipicu tiap kali openVoicePage() jalan).
  //      Urutan tampil:
  //        openn.gif (4 detik, tetap) -> think.gif (sampai model Piper
  //        SIAP, lihat _lvPiperReadyPromise) -> ending__2_.gif (1 detik) ->
  //        balik ke foto burung seperti biasa.
  //      Kalau halaman ditutup/dibuka ulang di tengah jalan, urutan yang
  //      lama otomatis dibatalkan lewat token (_lvLoadingToken) supaya
  //      tidak "menimpa" urutan yang baru dengan tampilan basi.
  // ==========================================================================
  const LV_LOADING_GIF_OPEN = 'openn.gif';
  const LV_LOADING_GIF_THINK = 'think.gif';
  const LV_LOADING_GIF_ENDING = 'ending__2_.gif';
  // DIPERCEPAT: sebelumnya openn.gif SELALU tampil 4 detik PENUH & ending
  // gif SELALU tampil 1 detik PENUH, TIDAK PEDULI apakah model suara Piper
  // & balasannya sudah beneran siap lebih cepat dari itu — jadi user
  // SELALU nunggu minimal ~5 detik tiap kali fitur Lolu Voice ATAU Lolu DJ
  // dipakai (lolu-dj.js manggil sequence yang SAMA lewat openVoicePage()),
  // bahkan kalau prosesnya sendiri jauh lebih cepat. Angka di bawah
  // dipangkas jadi cuma cukup supaya animasinya tetap sempat kelihatan
  // sekilas (bukan "meng-hilang tiba-tiba"), TANPA jadi jeda buatan yang
  // berasa lambat. Kalau model/balasannya ternyata belum siap, alur tetap
  // otomatis nunggu di gif "think" (lihat readyPromise di bawah) — itu
  // bagian yang MEMANG perlu, bukan bagian yang dipercepat di sini.
  const LV_LOADING_OPEN_MS = 700;    // durasi tetap gif openn.gif (dulu 4000)
  const LV_LOADING_ENDING_MS = 350;  // durasi tetap gif ending__2_.gif (dulu 1000)
  // Jaga-jaga: kalau preload() tidak pernah "selesai" dengan benar (mis.
  // error jaringan yang tidak reject Promise-nya), jangan biarkan
  // think.gif nyangkut selamanya — anggap siap paksa setelah ini.
  const LV_LOADING_MAX_WAIT_MS = 12000; // dulu 20000 — user tidak perlu nunggu selama itu utk fallback
  // Kalau LoluPiperTTS.preload() ternyata tidak mengembalikan Promise sama
  // sekali (API-nya beda), tetap kasih jeda singkat supaya think.gif
  // sempat kelihatan sebelum lanjut ke ending.gif.
  const LV_LOADING_FALLBACK_WAIT_MS = 500; // dulu 1200

  let _lvLoadingToken = 0;   // dinaikkan tiap kali sequence baru dimulai/dibatalkan
  let _lvLoadingActive = false;

  function _lvLoadingGifEl() { return document.getElementById('lv-loading-gif'); }
  function _lvSleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // ── PENDING-SPEAK — jembatan antara urutan gif loading & pembungkus
  // window.LoluPiperTTS.speakDJ (bagian 9.6 di bawah) ────────────────────
  // Model Piper bisa saja SUDAH siap (preload() selesai) padahal teks
  // balasan yang SEBENARNYA (replyText/commentary) belum diketahui sama
  // sekali — itu baru muncul belakangan, sesudah intent diproses / AI chat
  // / komentar DJ selesai digenerate. Kalau think.gif cuma menunggu model
  // siap, gerbang suara bisa terbuka lebih awal padahal predict() utk teks
  // balasan itu SENDIRI belum mulai — hasilnya celah kosong (gif sudah
  // hilang, tapi speakDJ() baru mulai sintesis suara sesudahnya).
  // Begitu speakDJ(text) BENERAN dipanggil (dari file ini atau dari
  // lolu-dj.js), pembungkusnya langsung memanggil LoluPiperTTS.prepare(text)
  // SEKARANG JUGA (tidak menunggu gerbang) & mendaftarkan promise-nya di
  // sini lewat _lvRegisterPendingSpeak() — supaya sintesisnya jalan
  // PARALEL dengan sisa waktu think.gif, dan _lvTrueReadyPromise() di bawah
  // bisa ikut menunggunya sebelum pindah ke gif ending.
  let _lvPendingSpeakPromise = null;

  function _lvRegisterPendingSpeak(promise) {
    _lvPendingSpeakPromise = (promise && typeof promise.then === 'function') ? promise : null;
  }

  // ── GERBANG suara Piper ────────────────────────────────────────────────
  // "Tertutup" (Promise pending) selama urutan gif loading masih berjalan,
  // "terbuka" (resolve) tepat setelah ending__2_.gif selesai tampil 1
  // detik. Dipakai untuk MENAHAN suara Lolu Piper & animasi "voice
  // recognition" supaya tidak mulai lebih dulu daripada gif loading
  // selesai — lihat pembungkus window.LoluPiperTTS.speakDJ di bawah.
  let _lvLoadingGateResolve = null;
  let _lvLoadingGatePromise = Promise.resolve(); // default terbuka: tidak ada gif loading yang menahan

  function _lvLoadingGateReady() { return _lvLoadingGatePromise; }
  function _lvLoadingGateClose() {
    _lvLoadingGatePromise = new Promise(function (resolve) { _lvLoadingGateResolve = resolve; });
  }
  function _lvLoadingGateOpen() {
    if (_lvLoadingGateResolve) { _lvLoadingGateResolve(); _lvLoadingGateResolve = null; }
  }

  // Promise yang resolve begitu suara Lolu (model Piper) siap dipakai.
  // Sekalian memicu LoluPiperTTS.preload() di sini (bukan cuma menunggu),
  // supaya proses unduh/siapnya beneran mulai di titik yang sama dengan
  // munculnya gif openn.gif.
  function _lvPiperReadyPromise() {
    try {
      if (window.LoluPiperTTS && typeof window.LoluPiperTTS.preload === 'function') {
        const p = window.LoluPiperTTS.preload();
        if (p && typeof p.then === 'function') {
          return Promise.race([
            p.then(function () {}, function () {}), // resolve baik sukses maupun gagal
            _lvSleep(LV_LOADING_MAX_WAIT_MS)
          ]);
        }
      }
    } catch (e) {}
    return _lvSleep(LV_LOADING_FALLBACK_WAIT_MS);
  }

  // "Siap SEBENARNYA" = model Piper sudah bisa dipakai DAN (kalau ada)
  // suara utk teks balasan yang didaftarkan lewat _lvRegisterPendingSpeak()
  // sudah selesai disintesis. Karena teks balasan sering baru diketahui
  // BELAKANGAN (sesudah AI chat/pencarian lagu selesai, yang bisa terjadi
  // kapan saja selagi think.gif masih tampil ATAU bahkan sesudah model
  // saja sudah siap), fungsi ini polling singkat menunggu pendaftaran itu
  // muncul dulu sebelum ikut menunggu wav-nya — dibatasi LV_LOADING_MAX_WAIT_MS
  // total supaya tidak nyangkut selamanya kalau speakDJ() ternyata tidak
  // pernah dipanggil sama sekali di siklus ini (mis. djHandledSpeech atau
  // fallback non-Piper, yang keduanya sudah membuka gerbang sendiri lewat
  // _lvResetLoadingSequence()/_lvLoadingGateOpen() langsung).
  async function _lvTrueReadyPromise() {
    const deadline = Date.now() + LV_LOADING_MAX_WAIT_MS;
    await _lvPiperReadyPromise(); // minimum: model harus siap dulu
    while (!_lvPendingSpeakPromise && Date.now() < deadline) {
      await _lvSleep(150);
    }
    if (_lvPendingSpeakPromise) {
      await _lvPendingSpeakPromise.then(function () {}, function () {});
    }
  }

  async function _lvShowLoadingSequence() {
    const gif = _lvLoadingGifEl();
    const bird = _lvBirdImgEl();
    if (!gif) return;

    const token = ++_lvLoadingToken;
    _lvLoadingActive = true;
    _lvLoadingGateClose(); // tutup gerbang suara Piper selama sequence ini berjalan
    _lvPendingSpeakPromise = null; // reset dari siklus sebelumnya

    if (bird) bird.classList.add('lv-hidden');
    gif.src = LV_LOADING_GIF_OPEN;
    gif.classList.remove('lv-hidden');

    // Mulai siapkan model Piper SEKARANG, paralel dengan tahap openn.gif
    // di bawah (bukan menunggu openn.gif selesai dulu baru mulai). SEKALIAN
    // menunggu suara utk teks balasan sebenarnya (lihat _lvTrueReadyPromise
    // di atas) — bukan cuma model-nya saja.
    const readyPromise = _lvTrueReadyPromise();

    await _lvSleep(LV_LOADING_OPEN_MS);
    if (token !== _lvLoadingToken) return; // dibatalkan (halaman ditutup/dibuka ulang)

    gif.src = LV_LOADING_GIF_THINK;
    await readyPromise;
    if (token !== _lvLoadingToken) return;

    gif.src = LV_LOADING_GIF_ENDING;
    await _lvSleep(LV_LOADING_ENDING_MS);
    if (token !== _lvLoadingToken) return;

    gif.classList.add('lv-hidden');
    // SENGAJA TIDAK menampilkan lagi foto Lolu Voice DJ (bird) di sini —
    // begitu gif ending selesai, yang harus langsung tampil berikutnya
    // adalah suara Piper + animasi "voice recognition" (_lvShowSpeakingAnim,
    // bagian 10 di bawah), BUKAN foto DJ yang numpang lewat sebentar di
    // antara gif dan animasi bicara. Foto DJ baru muncul lagi nanti lewat
    // _lvHideSpeakingAnim() begitu Lolu selesai bicara (balik ke idle).
    _lvLoadingActive = false;
    // ending__2_.gif baru saja selesai tampil 1 detik PENUH — itu SATU-
    // SATUNYA alasan jeda ini ada (supaya gif ending sempat kelihatan
    // dulu). Di titik ini suara Lolu Piper (readyPromise di atas sudah
    // resolve) SUDAH SEPENUHNYA siap, tidak ada proses lagi yang ditunggu
    // — jadi begitu 1 detik ini lewat, gerbang suara langsung dibuka dan
    // speakDJ() yang tertahan (lihat pembungkus di bawah) langsung mulai
    // bersuara + memicu animasi "voice recognition" TANPA jeda tambahan.
    _lvLoadingGateOpen();
  }

  // Batalkan sequence yang sedang berjalan & langsung balik ke tampilan
  // idle (foto burung tampil, gif loading disembunyikan) — dipanggil saat
  // halaman Lolu Voice ditutup supaya kalau dibuka lagi nanti mulai bersih
  // dari awal, bukan "nyangkut" di tengah gif sebelumnya. Gerbang suara
  // Piper JUGA dibuka paksa di sini supaya tidak ada speakDJ() yang
  // nyangkut menunggu selamanya kalau halaman ditutup di tengah sequence.
  function _lvResetLoadingSequence() {
    _lvLoadingToken++;
    _lvLoadingActive = false;
    _lvPendingSpeakPromise = null;
    const gif = _lvLoadingGifEl();
    const bird = _lvBirdImgEl();
    if (gif) gif.classList.add('lv-hidden');
    if (bird) bird.classList.remove('lv-hidden');
    _lvLoadingGateOpen();
  }

  // ==========================================================================
  // 9.6) BUNGKUS window.LoluPiperTTS.speakDJ — satu-satunya pintu masuk
  //      suara Lolu Piper BENERAN diputar (dipanggil dari file ini & dari
  //      lolu-dj.js) — supaya setiap panggilan menunggu _lvLoadingGateReady()
  //      dulu sebelum benar-benar memanggil versi aslinya. Kalau tidak ada
  //      gif loading yang sedang tampil, gerbangnya sudah terbuka (resolve)
  //      jadi TIDAK ada delay tambahan sama sekali di kondisi normal.
  // ==========================================================================
  document.addEventListener('DOMContentLoaded', function () {
    if (window.LoluPiperTTS && typeof window.LoluPiperTTS.speakDJ === 'function' && !window.LoluPiperTTS.speakDJ._lvGated) {
      const _origSpeakDJ = window.LoluPiperTTS.speakDJ.bind(window.LoluPiperTTS);
      const _gatedSpeakDJ = function (text) {
        // Segera mulai sintesis suara utk teks ini SEKARANG JUGA (tidak
        // menunggu gerbang) & daftarkan ke urutan gif loading (kalau ada
        // yang sedang berjalan) lewat _lvRegisterPendingSpeak() — supaya
        // predict()-nya jalan paralel dengan sisa waktu think.gif, bukan
        // baru mulai sesudah gerbang kebuka (itu penyebab celah kosongnya).
        // _origSpeakDJ di bawah nanti otomatis memakai wav yang sudah/lagi
        // disiapkan ini (lihat cek preparedText di lolu-piper-tts.js),
        // JADI TIDAK sintesis dua kali.
        if (typeof window.LoluPiperTTS.prepare === 'function') {
          try { _lvRegisterPendingSpeak(window.LoluPiperTTS.prepare(text)); } catch (e) {}
        }
        return _lvLoadingGateReady().then(function () { return _origSpeakDJ(text); });
      };
      _gatedSpeakDJ._lvGated = true;
      window.LoluPiperTTS.speakDJ = _gatedSpeakDJ;
    }
  });

  // ==========================================================================
  // 10) VOICE RECOGNITION ANIMATION — menggantikan foto burung Lolu
  //     (#lv-bird-img di halaman Lolu Voice) dengan animasi Lottie "voice
  //     recognition" (Voice_recognition.json) SELAMA suara Lolu Piper
  //     BENERAN sedang diputar, lalu balik lagi ke foto burung begitu
  //     suaranya selesai. Terhubung lewat LoluPiperTTS.setSpeakingHandlers()
  //     (lolu-piper-tts.js) supaya otomatis berlaku di MANA PUN suara Piper
  //     dipicu — voice command satu-kali biasa di file ini, AIChatBridge
  //     (obrolan bebas), maupun komentar Lolu DJ (lolu-dj.js) — TANPA
  //     lolu-piper-tts.js perlu tahu apa pun soal DOM/UI halaman ini.
  // ==========================================================================
  const VOICE_RECOGNITION_LOTTIE_URL = 'Voice_recognition.json';
  let _lvVoiceAnim = null; // instance lottie, dimuat sekali (lazy) saat pertama dibutuhkan

  function _lvVoiceAnimEl() { return document.getElementById('lv-voice-anim'); }
  function _lvBirdImgEl() { return document.getElementById('lv-bird-img'); }

  function _lvShowSpeakingAnim() {
    try {
      // Suara Piper BENERAN mulai diputar sekarang — kalau ada balasan yang
      // tadi "ditahan" lewat UIState.setThinking() (lihat pemanggil
      // speakDJ() di bagian 8), ganti bubble dari "Lolu is thinking..." ke
      // teks balasan aslinya persis di momen ini, supaya teksnya muncul
      // serempak dengan suaranya, bukan lebih dulu/lebih lambat.
      if (_lvPendingReplyText) {
        UIState.setReply(_lvPendingReplyText);
        _lvPendingReplyText = null;
      }
      const anim = _lvVoiceAnimEl();
      const bird = _lvBirdImgEl();
      if (!anim) return;
      if (!_lvVoiceAnim) {
        if (typeof lottie === 'undefined') return; // lottie-web belum/tidak dimuat -> aman diabaikan, foto burung tetap tampil
        _lvVoiceAnim = lottie.loadAnimation({
          container: anim,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          path: VOICE_RECOGNITION_LOTTIE_URL
        });
      } else {
        try { _lvVoiceAnim.play(); } catch (e) {}
      }
      if (bird) bird.classList.add('lv-hidden');
      anim.classList.add('show');
    } catch (e) {}
  }

  function _lvHideSpeakingAnim() {
    try {
      const anim = _lvVoiceAnimEl();
      const bird = _lvBirdImgEl();
      if (anim) anim.classList.remove('show');
      if (bird) bird.classList.remove('lv-hidden');
      // Dijeda (bukan destroy) selagi tidak kelihatan — hemat CPU tapi
      // instance-nya tetap disimpan supaya kemunculan berikutnya langsung
      // play() lagi tanpa perlu reload file JSON-nya dari server.
      if (_lvVoiceAnim) { try { _lvVoiceAnim.pause(); } catch (e) {} }
    } catch (e) {}
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.LoluPiperTTS && typeof window.LoluPiperTTS.setSpeakingHandlers === 'function') {
      window.LoluPiperTTS.setSpeakingHandlers(_lvShowSpeakingAnim, _lvHideSpeakingAnim);
    }
    // Isi sapaan "Good morning" dst di kotak promo Lolu Voice (#lvh-greeting,
    // halaman Home) sedari awal — jangan tunggu user membuka halaman Lolu
    // Voice penuh dulu (openVoicePage() baru memanggil ini juga).
    _lvUpdateGreeting();
  });

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  function toggleListening() {
    if (SpeechInput.isListening()) {
      SpeechInput.stop();
      // onEnd bawaan SpeechInput.start() tidak reset tampilan (lihat
      // komentar di startListening), jadi harus di-reset manual di sini
      // supaya tombol mic & bubble status langsung balik ke idle begitu
      // user menekan mic untuk MEMATIKANNYA (bukan cuma berhenti dengar
      // di background tanpa update tampilan).
      UIState.setIdle();
      PlaybackController.restoreVolumeAfterDuck();
      return;
    }
    startListening();
  }

  function startListening() {
    if (!SpeechInput.isSupported()) {
      UIState.setError(reply('Browser ini tidak mendukung voice command.', 'This browser doesn\'t support voice commands.'));
      return;
    }
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

  // Tombol bahasa "ID/EN" di halaman Lolu Voice SUDAH DIHILANGKAN — fitur
  // ini sekarang cuma balas Bahasa Inggris (lihat OUTPUT_LANG), jadi tidak
  // ada lagi yang perlu di-toggle. Fungsi ini dipertahankan sebagai no-op
  // (bukan dihapus total) HANYA supaya markup HTML lama yang masih punya
  // atribut onclick="LoluVoiceDJ.toggleLanguage(event)" (kalau ada & belum
  // sempat dihapus dari file HTML) tidak error saat diklik — sekarang tidak
  // melakukan apa-apa lagi.
  function toggleLanguage(e) {
    if (e) e.stopPropagation();
  }

  window.LoluVoiceDJ = {
    toggleListening,
    startListening,
    stopListening: SpeechInput.stop,
    toggleLanguage,
    isSupported: SpeechInput.isSupported,
    openVoicePage,
    closeVoicePage,
    // Dipakai lolu-dj.js supaya aksi DJ yang dipicu LANGSUNG dari tombol/
    // chip UI (mis. mood "For You", "Chill", dst — bukan lewat voice
    // command) JUGA menampilkan urutan gif loading (openn->think->ending),
    // bukan cuma diam menampilkan foto DJ selama proses berlangsung.
    // isLoadingSequenceActive() dipakai supaya lolu-dj.js tidak memicu
    // sequence baru kalau satu sudah berjalan (mis. dipicu lebih dulu oleh
    // voice command lewat handleRecognizedText).
    showLoadingSequence: _lvShowLoadingSequence,
    isLoadingSequenceActive: function () { return _lvLoadingActive; },
    // Dipakai lolu-dj.js supaya permintaan DJ ("play something chill", "jadi
    // dj", dst) yang DIKETIK di Chat AI bisa dikenali dengan pola yang SAMA
    // persis dipakai voice command — tanpa duplikasi regex di dua tempat.
    parseIntent: IntentParser.parse,
    // Dipakai lolu-dj.js buat "menahan" lagu (pause sesaat setelah mulai
    // dimuat, resume lagi setelah Lolu selesai ngomong) — reuse PlaybackController
    // yang sama dipakai command "pause"/"resume" biasa, bukan logic baru.
    pause: PlaybackController.pause,
    resume: PlaybackController.resume
  };

  // ── Init: sembunyikan sisa tombol bahasa (kalau masih ada di markup HTML
  // lama) dan hentikan voice recognition otomatis kalau overlay Chat AI
  // ditutup. ─────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    UIState.hideLangBtn();
    if (!SpeechInput.isSupported()) {
      // #lolu-mic-btn (dulu di halaman Chat AI) sudah dihapus — sekarang
      // tombol mic satu-satunya adalah #lv-mic-top-btn di halaman Lolu
      // Voice (tengah, bawah foto burung).
      const b = document.getElementById('lv-mic-top-btn');
      if (b) { b.disabled = true; b.title = 'Voice command tidak didukung browser ini'; b.classList.add('unsupported'); }
    }

    // ── Percepat "loading suara Lolu" ────────────────────────────────────
    // Model Piper (~63MB) sekarang sudah mulai diunduh SEDINI MUNGKIN,
    // langsung dari lolu-piper-tts.js sendiri begitu file itu di-parse
    // browser (lihat baris "PERCEPAT KEMUNCULAN SUARA LOLU" di ujung
    // lolu-piper-tts.js) — TIDAK nunggu requestIdleCallback/timeout lagi.
    // Panggilan preload() di sini cuma dipertahankan sebagai jaring
    // pengaman (mis. kalau lolu-piper-tts.js gagal load duluan lalu baru
    // berhasil belakangan) — aman & idempotent, tidak dobel unduh.
    if (window.LoluPiperTTS && typeof window.LoluPiperTTS.preload === 'function') {
      window.LoluPiperTTS.preload();
    }
  });

  // Sinyal lebih awal lagi: begitu user buka halaman Chat AI (sebelum
  // sempat mikir buat pencet mic), langsung pastikan preload sudah/lagi
  // jalan. Aman dipanggil berkali-kali — ensureModel() di lolu-piper-tts.js
  // sudah nge-cache Promise-nya, jadi tidak dobel unduh.
  const _origOpenAIChatOverlay = window.openAIChatOverlay;
  if (typeof _origOpenAIChatOverlay === 'function') {
    window.openAIChatOverlay = function () {
      try {
        if (window.LoluPiperTTS && typeof window.LoluPiperTTS.preload === 'function') {
          window.LoluPiperTTS.preload();
        }
      } catch (e) {}
      return _origOpenAIChatOverlay.apply(this, arguments);
    };
  }

  // Bungkus closeAIChatOverlay yang sudah ada supaya voice recognition ikut
  // berhenti begitu halaman Chat AI ditutup (tanpa mengubah file vibexa.js).
  const _origCloseAIChatOverlay = window.closeAIChatOverlay;
  if (typeof _origCloseAIChatOverlay === 'function') {
    window.closeAIChatOverlay = function () {
      try { SpeechInput.stop(); } catch (e) {}
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
      // Halaman Lolu Voice dibuka DI ATAS #ai-chat-overlay (bukan menggantikan
      // -nya), jadi kalau Chat AI ditutup (mis. lewat tombol back atau ganti
      // halaman lain), halaman Lolu Voice yang mungkin masih terbuka di
      // atasnya harus ikut ditutup supaya tidak jadi overlay "hantu" yang
      // menutupi halaman lain.
      closeVoicePage();
      return _origCloseAIChatOverlay.apply(this, arguments);
    };
  }

})();
