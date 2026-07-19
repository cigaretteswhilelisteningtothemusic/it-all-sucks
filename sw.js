// sw.js — Service Worker Vibexa
// Gabungan: (1) caching PWA/offline app-shell, (2) Firebase push notification (chat).

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// Konfigurasi sama persis dengan firebaseConfig di vibexa.html.
firebase.initializeApp({
  apiKey: "AIzaSyCeMRU4JgIOlS_M9hgZfDKrkIHyAFncVjE",
  authDomain: "nevermind-c246a.firebaseapp.com",
  databaseURL: "https://nevermind-c246a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nevermind-c246a",
  storageBucket: "nevermind-c246a.firebasestorage.app",
  messagingSenderId: "703998258491",
  appId: "1:703998258491:web:ea9cceaa10af71db61db1e"
});

const messaging = firebase.messaging();

// ── PWA APP-SHELL CACHING ─────────────────────────────────
// Bump versi ini setiap kali vibexa.html/asset berubah, supaya user dapat update.
const CACHE_VERSION = 'vibexa-v4';
const APP_SHELL = [
  './vibexa.html',
  './manifest.json'
];

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
// Notifikasi masuk saat tab/app TERTUTUP atau di background — inilah yang
// bikin perilakunya persis WhatsApp (dapat notif walau app tidak dibuka).
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'Vibexa';
  const body = payload?.notification?.body || '';
  const chatId = payload?.data?.chatId || '';
  const fromUid = payload?.data?.fromUid || '';

  self.registration.showNotification(title, {
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
