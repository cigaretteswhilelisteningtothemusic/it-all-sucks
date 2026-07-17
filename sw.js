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
  //
  // CATATAN: notifikasi pesan chat dikirim Cloud Function (lihat
  // functions/index.js: sendChatPushNotification) sebagai DATA-ONLY message
  // (tanpa field top-level "notification") supaya handler ini SELALU
  // dipanggil dan kita punya kendali penuh — termasuk menempelkan
  // senderUid/chatId ke dalam `data` notifikasi, supaya saat notifikasi
  // diklik (lihat notificationclick di bawah) kita tahu percakapan mana
  // yang harus dibuka.
  messaging.onBackgroundMessage(payload => {
    const d = (payload && payload.data) || {};
    const title = d.title || (payload && payload.notification && payload.notification.title) || 'Vibexa';
    const body = d.body || (payload && payload.notification && payload.notification.body) || '';
    const options = {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: d.chatId ? ('chat-' + d.chatId) : undefined, // notif baru dari chat yg sama menumpuk/ganti, bukan menumpuk terus
      renotify: !!d.chatId,
      data: {
        senderUid: d.senderUid || '',
        chatId: d.chatId || ''
      }
    };
    self.registration.showNotification(title, options);
  });
} catch (err) {
  console.error('[sw.js] Gagal setup Firebase Messaging:', err);
}

// Saat notifikasi diklik: buka/fokuskan tab Vibexa, lalu langsung arahkan ke
// percakapan dengan pengirim pesan (senderUid) — persis seperti WhatsApp
// membuka chat yang bersangkutan saat notifikasinya ditekan.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const senderUid = (event.notification.data && event.notification.data.senderUid) || '';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Kalau tab Vibexa sudah terbuka: fokuskan lalu kirim pesan ke halaman
      // itu (ditangkap oleh listener 'message' di vibexa.html) supaya chat
      // langsung dibuka TANPA reload halaman.
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (senderUid && 'postMessage' in client) {
            client.postMessage({ type: 'OPEN_CHAT_FROM_NOTIFICATION', uid: senderUid });
          }
          return;
        }
      }
      // Tidak ada tab yang terbuka sama sekali → buka tab baru dengan query
      // param ?startChatWith=uid (dibaca oleh _maybeAutoStartChatFromUrl()
      // di vibexa.html setelah user login).
      if (clients.openWindow) {
        const url = senderUid ? ('./?startChatWith=' + encodeURIComponent(senderUid)) : './';
        return clients.openWindow(url);
      }
    })
  );
});
