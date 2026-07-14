// ════════════════════════════════════════════════════════════════
// Vibexa Service Worker
// - Menangani install PWA dasar
// - Menampilkan notifikasi push (FCM) saat app sedang tertutup/background
// ════════════════════════════════════════════════════════════════

const CACHE_NAME = 'vibexa-cache-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Tidak melakukan caching agresif — biarkan browser ambil langsung dari
// jaringan seperti biasa, service worker ini fokus untuk push notification.
self.addEventListener('fetch', event => {
  // no-op: biarkan request jalan normal
});

// ─── Firebase Cloud Messaging (push notification) ──────────────────
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// Config sama persis dengan firebaseConfig di vibexa.html
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

// Dipanggil browser saat notifikasi datang dan tab Vibexa TIDAK sedang
// aktif/terbuka. Menampilkan notifikasi sistem di perangkat user.
messaging.onBackgroundMessage(payload => {
  const title = payload?.notification?.title || 'Vibexa';
  const options = {
    body: payload?.notification?.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png'
  };
  self.registration.showNotification(title, options);
});

// Saat notifikasi diklik, buka/fokuskan tab Vibexa
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
