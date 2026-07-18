// sw.js — Service Worker Vibexa
//
// CATATAN: kalau kamu SUDAH punya sw.js (misalnya untuk caching PWA/offline),
// JANGAN timpa filenya — gabungkan isi di bawah ini (importScripts +
// onBackgroundMessage + notificationclick) ke dalam sw.js yang sudah ada,
// supaya fitur lama tidak hilang.

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

// Notifikasi masuk saat tab/app TERTUTUP atau di background — inilah yang
// bikin perilakunya persis WhatsApp (dapat notif walau app tidak dibuka).
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'Vibexa';
  const body = payload?.notification?.body || '';
  const chatId = payload?.data?.chatId || '';
  const fromUid = payload?.data?.fromUid || '';

  self.registration.showNotification(title, {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
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
