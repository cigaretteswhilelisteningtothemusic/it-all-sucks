// sw.js — Service Worker Vibexa
// Gabungan: (1) caching PWA/offline app-shell, (2) Firebase push notification (chat).
//
// PERUBAHAN PENTING (perbaikan background audio):
// Sebelumnya, firebase-app-compat.js + firebase-messaging-compat.js di-import
// dan firebase.messaging() di-init di scope PALING ATAS file ini — artinya
// SETIAP KALI service worker ini "dibangunkan" browser (termasuk untuk event
// 'fetch' biasa, bukan cuma saat ada push masuk), seluruh SDK Firebase ikut
// di-load & di-init. ini beban ekstra yang membuat "jatah" eksekusi background
// situs ini di Android lebih cepat habis dibanding situs tanpa service worker
// sama sekali — begitu jatah itu habis, Android jadi lebih agresif men-discard
// SELURUH tab (termasuk Media Session custom yang bikin notifikasi lagu
// hilang total, bukan cuma pause).
//
// Sekarang Firebase Messaging SDK hanya di-import & di-init LAZY, persis saat
// event 'push' benar-benar masuk. Untuk event 'install'/'activate'/'fetch'
// (yang jalan jauh lebih sering), service worker ini sama sekali tidak
// menyentuh Firebase — jauh lebih ringan.

const CACHE_VERSION = 'vibexa-v4';
const APP_SHELL = [
  './vibexa.html',
  './manifest.json'
];

// Konfigurasi Firebase — sama persis dengan firebaseConfig di vibexa.html.
// Dipakai nanti di dalam _initMessaging(), bukan di scope atas.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCeMRU4JgIOlS_M9hgZfDKrkIHyAFncVjE",
  authDomain: "nevermind-c246a.firebaseapp.com",
  databaseURL: "https://nevermind-c246a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nevermind-c246a",
  storageBucket: "nevermind-c246a.firebasestorage.app",
  messagingSenderId: "703998258491",
  appId: "1:703998258491:web:ea9cceaa10af71db61db1e"
};

let _messagingReady = null;
// Lazy-load: import & init Firebase Messaging HANYA saat dipanggil (dari
// dalam event 'push'), bukan di scope atas file. Hasilnya di-cache di
// _messagingReady supaya push berikutnya (selama SW masih "bangun") tidak
// perlu import ulang.
function _getMessaging() {
  if (_messagingReady) return _messagingReady;
  _messagingReady = (async () => {
    importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    return firebase.messaging();
  })();
  return _messagingReady;
}

// ── PWA APP-SHELL CACHING ─────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Lewati request cross-origin (YouTube, font CDN, Firebase, dll) — biar langsung ke network.
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./vibexa.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (request.method === 'GET' && response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});

// ── FIREBASE PUSH NOTIFICATION (CHAT) ─────────────────────
// Firebase Messaging SDK di-load LAZY di sini (lihat _getMessaging() di atas),
// bukan di scope atas file — supaya event fetch/install/activate yang jauh
// lebih sering terjadi tidak ikut menyeret beban Firebase.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    try {
      await _getMessaging(); // pastikan Firebase siap dulu (untuk konsistensi/kompatibilitas)
    } catch (e) { /* tetap lanjut tampilkan notifikasi walau init gagal */ }

    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) {}

    const title = payload?.notification?.title || 'Vibexa';
    const body = payload?.notification?.body || '';
    const chatId = payload?.data?.chatId || '';
    const fromUid = payload?.data?.fromUid || '';

    await self.registration.showNotification(title, {
      body,
      icon: 'icons/launchericon-192x192.png',
      badge: 'icons/launchericon-192x192.png',
      // tag = fromUid: notif dari orang yang SAMA akan menggantikan notif
      // sebelumnya (jadi 1 notif per lawan chat), bukan menumpuk per pesan.
      // renotify: true supaya tetap muncul/berbunyi ulang walau tag sama.
      tag: fromUid ? `chat_${fromUid}` : (chatId || undefined),
      renotify: true,
      data: { chatId, fromUid },
    });
  })());
});

// Klik notifikasi → buka/fokuskan tab Vibexa, langsung ke chat terkait.
// Pakai mekanisme ?startChatWith=<uid> yang sudah ada di vibexa.html
// (biasanya dipicu dari tombol "Chat" di profile.html).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const fromUid = event.notification?.data?.fromUid || '';
  const targetUrl = fromUid ? `./?startChatWith=${encodeURIComponent(fromUid)}` : './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
