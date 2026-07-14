// scripts/send-notif.js
// Dijalankan oleh GitHub Actions (bukan Cloud Functions), jadi TIDAK
// butuh Firebase Blaze plan / kartu kredit sama sekali.
//
// Cara kerja: script ini connect ke Firebase pakai Service Account key
// (disimpan sebagai GitHub Secret, bukan di dalam repo), ambil semua
// fcmTokens dari Realtime Database, lalu kirim notifikasi lewat FCM.

const admin = require('firebase-admin');

const MORNING_TEXT = 'Ready to discover something new? Vibexa has fresh recommendations and playlists waiting to become part of your daily soundtrack.';
const NIGHT_TEXT = 'Need a break from everything? Put on your headphones, open Vibexa, and let the music do the rest.';

// Argumen: "morning" atau "night" — ditentukan oleh workflow GitHub Actions
const slot = process.argv[2];
if (slot !== 'morning' && slot !== 'night') {
  console.error('Argumen tidak valid. Pakai: node send-notif.js morning|night');
  process.exit(1);
}

const body = slot === 'morning' ? MORNING_TEXT : NIGHT_TEXT;

// Service account JSON diambil dari GitHub Secret FIREBASE_SERVICE_ACCOUNT
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://nevermind-c246a-default-rtdb.asia-southeast1.firebasedatabase.app'
});

async function getAllTokens() {
  const snap = await admin.database().ref('users').once('value');
  const tokens = [];
  snap.forEach(userSnap => {
    const fcmTokens = userSnap.child('fcmTokens').val();
    if (fcmTokens) Object.keys(fcmTokens).forEach(t => tokens.push(t));
  });
  return tokens;
}

async function main() {
  const tokens = await getAllTokens();
  if (!tokens.length) {
    console.log('Tidak ada token FCM terdaftar. Tidak ada yang dikirim.');
    return;
  }

  const message = {
    notification: { title: 'Vibexa', body },
    tokens
  };

  const response = await admin.messaging().sendEachForMulticast(message);
  console.log(`Slot: ${slot} | Terkirim: ${response.successCount} | Gagal: ${response.failureCount}`);

  // Bersihkan token yang sudah tidak valid
  const staleTokens = [];
  response.responses.forEach((res, i) => {
    if (!res.success) {
      const code = res.error?.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        staleTokens.push(tokens[i]);
      }
    }
  });

  if (staleTokens.length) {
    const snap = await admin.database().ref('users').once('value');
    const updates = {};
    snap.forEach(userSnap => {
      const uid = userSnap.key;
      staleTokens.forEach(t => {
        if (userSnap.child('fcmTokens/' + t).exists()) {
          updates['users/' + uid + '/fcmTokens/' + t] = null;
        }
      });
    });
    if (Object.keys(updates).length) {
      await admin.database().ref().update(updates);
      console.log(`Menghapus ${staleTokens.length} token yang tidak valid.`);
    }
  }
}

main().catch(err => {
  console.error('Gagal mengirim notifikasi:', err);
  process.exit(1);
});
