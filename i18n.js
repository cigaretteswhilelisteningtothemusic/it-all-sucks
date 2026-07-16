// ============================================================
// Vibexa i18n — auto-translate halaman via Cloudflare Workers AI
// Pasang <script src="i18n.js"></script> di halaman yang mau
// otomatis diterjemahkan (vibexa.html, profile.html, dst).
//
// Bahasa dipilih di follow-artists.html dan disimpan di
// localStorage key 'vbx_lang'. Kalau belum pernah pilih / value
// = 'id', halaman ditampilkan apa adanya (Bahasa Indonesia).
// ============================================================
(function () {
  'use strict';

  const CFG = {
    // GANTI dengan URL Worker kamu setelah deploy, contoh:
    // 'https://vibexa-translate.USERNAME.workers.dev/translate'
    WORKER_URL: 'https://vibexa-translate.efotbalakun70.workers.dev/translate',
    LANG_KEY: 'vbx_lang',
    CACHE_KEY: 'vbx_i18n_cache',
    DEFAULT_LANG: 'id',
    DEBOUNCE_MS: 400,
    BATCH_SIZE: 60,
  };

  function getLang() {
    return localStorage.getItem(CFG.LANG_KEY) || CFG.DEFAULT_LANG;
  }
  window.vbxGetLang = getLang;

  const lang = getLang();
  if (lang === CFG.DEFAULT_LANG) return; // sudah Bahasa Indonesia, tidak perlu translate

  if (!CFG.WORKER_URL || CFG.WORKER_URL.includes('GANTI-DENGAN-URL-WORKER-KAMU')) {
    console.warn('[vbx-i18n] WORKER_URL belum diisi di i18n.js — translate dimatikan sementara.');
    return;
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CFG.CACHE_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveCache(cache) {
    try { localStorage.setItem(CFG.CACHE_KEY, JSON.stringify(cache)); }
    catch (e) { /* storage penuh, abaikan */ }
  }

  const cache = loadCache();
  if (!cache[lang]) cache[lang] = {};

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);
  const doneTextNodes = new WeakSet();

  // ── Konten "entitas" yang TIDAK BOLEH diterjemahkan ─────────
  // Nama artis, judul lagu, nama playlist, pesan chat, nama user, dll
  // bukan teks UI — ini data asli yang harus tetap apa adanya.
  // Kalau ada elemen lain yang ikut ketranslate padahal seharusnya
  // tidak, tambahkan atribut data-no-translate="true" langsung di HTML-nya.
  const NO_TRANSLATE_CLASS_HINTS = [
    'artist', 'track-title', 'track-name', 'song-title', 'song-name',
    'playlist-title', 'pl-name', 'chat-bubble', 'tr-title', 'tr-artist',
    'sugg-picker', 'friend-fav', 'fav-note-author', 'peer-name',
    'display-name', 'username', 'sender-name', 'conv-name', 'np-track',
    'weekday-playlist-title', 'lyr-artist',
  ];
  const NO_TRANSLATE_IDS = [
    'h-artist', 'lyr-album-artist', 'bar-artist', 'np-track-title',
    'finder-song-title', 'add-song-track-name', 'weekday-playlist-title',
  ];

  function isNoTranslateEl(el) {
    if (!el || el.nodeType !== 1) return false;
    let cur = el, depth = 0;
    while (cur && depth < 5) {
      if (cur.hasAttribute && cur.hasAttribute('data-no-translate')) return true;
      if (NO_TRANSLATE_IDS.includes(cur.id)) return true;
      const cls = typeof cur.className === 'string' ? cur.className : '';
      if (cls && NO_TRANSLATE_CLASS_HINTS.some((k) => cls.includes(k))) return true;
      cur = cur.parentElement;
      depth++;
    }
    return false;
  }

  function isTranslatable(raw) {
    const t = (raw || '').trim();
    if (!t || t.length > 400) return false;
    if (/^[\d\s.,:%+\-\/()|•·]+$/.test(t)) return false; // angka/simbol murni
    return true;
  }

  let queueSet = new Set();
  let pending = []; // { type:'text', node, key } | { type:'attr', el, attr, key }
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, CFG.DEBOUNCE_MS);
  }

  function enqueue(key) {
    if (cache[lang][key] !== undefined) return;
    queueSet.add(key);
  }

  function collect(root) {
    if (!root) return;

    if (root.nodeType === 3) {
      handleTextNode(root);
    } else if (root.nodeType === 1) {
      if (SKIP_TAGS.has(root.tagName) || isNoTranslateEl(root)) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (doneTextNodes.has(node)) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p || SKIP_TAGS.has(p.tagName) || isNoTranslateEl(p)) return NodeFilter.FILTER_REJECT;
          return isTranslatable(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let n;
      while ((n = walker.nextNode())) handleTextNode(n);

      const els = root.querySelectorAll('[placeholder],[title],[aria-label]');
      els.forEach(handleAttrEl);
      if (root.matches && root.matches('[placeholder],[title],[aria-label]')) handleAttrEl(root);
    }
    scheduleFlush();
  }

  function handleTextNode(node) {
    if (doneTextNodes.has(node)) return;
    const p = node.parentElement;
    if (p && isNoTranslateEl(p)) return;
    const key = (node.nodeValue || '').trim();
    if (!isTranslatable(key)) return;
    pending.push({ type: 'text', node, key });
    enqueue(key);
  }

  function handleAttrEl(el) {
    if (isNoTranslateEl(el)) return;
    ['placeholder', 'title', 'aria-label'].forEach((attr) => {
      if (!el.hasAttribute(attr)) return;
      if (el.dataset['i18nDone_' + attr]) return;
      const val = el.getAttribute(attr);
      const key = (val || '').trim();
      if (!isTranslatable(key)) return;
      pending.push({ type: 'attr', el, attr, key });
      enqueue(key);
    });
  }

  async function flush() {
    flushTimer = null;
    const texts = Array.from(queueSet).filter((k) => cache[lang][k] === undefined);
    queueSet.clear();

    for (let i = 0; i < texts.length; i += CFG.BATCH_SIZE) {
      const chunk = texts.slice(i, i + CFG.BATCH_SIZE);
      try {
        const res = await fetch(CFG.WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: chunk, target: lang }),
        });
        const data = await res.json();
        const translations = (data && data.translations) || [];
        chunk.forEach((orig, idx) => { cache[lang][orig] = translations[idx] || orig; });
      } catch (e) {
        console.warn('[vbx-i18n] gagal translate batch:', e);
        chunk.forEach((orig) => { cache[lang][orig] = orig; });
      }
    }
    if (texts.length) saveCache(cache);
    applyPending();
  }

  function applyPending() {
    const items = pending;
    pending = [];
    items.forEach((item) => {
      const translated = cache[lang][item.key];
      if (translated === undefined) return;
      if (item.type === 'text') {
        if (item.node.nodeValue && item.node.nodeValue.includes(item.key)) {
          item.node.nodeValue = item.node.nodeValue.replace(item.key, translated);
        }
        doneTextNodes.add(item.node);
      } else if (item.type === 'attr') {
        item.el.setAttribute(item.attr, translated);
        item.el.dataset['i18nDone_' + item.attr] = '1';
      }
    });
  }

  function start() {
    collect(document.body);

    // Pantau konten yang dirender belakangan (fetch data, grid artis, feed, dll)
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes && m.addedNodes.forEach((node) => collect(node));
        if (m.type === 'characterData' && !doneTextNodes.has(m.target)) {
          const p = m.target.parentElement;
          if (!p || !isNoTranslateEl(p)) {
            handleTextNode(m.target);
            scheduleFlush();
          }
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
