// ════════════════════════════════════════════════════════════════
// Vibexa Service Worker (v2 — lebih aman)
// - Menangani install PWA dasar
// - Menampilkan notifikasi push (FCM) saat app sedang tertutup/background
// - Kalau bagian Firebase Messaging gagal dimuat, SW tetap jalan normal
//   (tidak akan bikin app/login jadi error), cuma push background yang
//   tidak aktif.
// ════════════════════════════════════════════════════════════════

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Tidak ada listener 'fetch' sama sekali — biar browser 100% pakai
// perilaku default (ambil langsung dari jaringan), supaya tidak ada
// risiko SW ikut campur di proses login/navigasi.

// ─── Firebase Cloud Messaging (push notification) ──────────────────
// Dibungkus try/catch: kalau gagal load/init, error-nya cuma tercatat
// di log SW, TIDAK menghentikan/merusak service worker secara keseluruhan.
try {
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

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
    const title = (payload && payload.notification && payload.notification.title) || 'Vibexa';
    const options = {
      body: (payload && payload.notification && payload.notification.body) || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png'
    };
    self.registration.showNotification(title, options);
  });
} catch (err) {
  console.error('[sw.js] Gagal setup Firebase Messaging:', err);
}

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
