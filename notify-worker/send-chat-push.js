// ════════════════════════════════════════════════════════════════
// Vibexa — Chat Push Notification Worker (dijalankan via GitHub Actions,
// TANPA perlu Cloud Functions / plan Blaze / kartu kredit).
//
// Cara kerja:
//   1. Setiap kali user mengirim pesan chat (lihat vibexa.html:
//      sendChatMessage / sendChatMediaMessage / sendGifMessage), selain
//      menyimpan pesan seperti biasa, sekarang juga dituliskan entri kecil
//      ke "notifyQueue/{msgKey}" = { chatId, from, to, ts, preview }.
//   2. Script ini dijalankan berkala oleh GitHub Actions (lihat
//      .github/workflows/chat-push-notify.yml, default tiap 5 menit —
//      jeda minimum yang diizinkan GitHub Actions untuk cron).
//   3. Tiap kali jalan: baca semua isi "notifyQueue", untuk tiap entri:
//        - skip kalau lawan bicara (to) sedang membuka PERSIS percakapan
//          itu (activeChat/{to} === from) — pesan sudah kelihatan live
//          di layarnya, tak perlu push.
//        - ambil nama pengirim dari "directory/{from}".
//        - ambil semua token FCM milik penerima dari "users/{to}/fcmTokens".
//        - kirim push data-only lewat FCM (lihat catatan panjang di
//          functions/index.js soal kenapa data-only, bukan "notification").
//        - hapus token yang sudah invalid/kadaluarsa.
//      Lalu entri di notifyQueue dihapus (baik berhasil maupun gagal
//      dikirim), supaya antrian selalu bersih & kecil untuk run berikutnya.
//
// CATATAN: karena ini polling berkala (bukan trigger real-time), notifikasi
// TIDAK instan seperti WhatsApp — ada jeda sekitar 5-15 menit tergantung
// beban jadwal GitHub Actions saat itu. Kalau nanti sudah siap upgrade ke
// plan Blaze, pindah ke functions/index.js akan membuatnya instan.
// ════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const databaseURL = process.env.FIREBASE_DATABASE_URL;

if (!rawServiceAccount) fail('Secret FIREBASE_SERVICE_ACCOUNT_JSON belum diisi.');
if (!databaseURL) fail('Secret FIREBASE_DATABASE_URL belum diisi.');

let serviceAccount;
try {
  serviceAccount = JSON.parse(rawServiceAccount);
} catch (e) {
  fail('FIREBASE_SERVICE_ACCOUNT_JSON bukan JSON yang valid: ' + e.message);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL,
});

const db = admin.database();
const MAX_BODY_LEN = 120;

function trimBody(text) {
  const t = (text || '').trim();
  if (t.length > MAX_BODY_LEN) return t.slice(0, MAX_BODY_LEN - 1) + '…';
  return t;
}

async function main() {
  const snap = await db.ref('notifyQueue').get();
  const queue = snap.val() || {};
  const keys = Object.keys(queue);

  if (!keys.length) {
    console.log('Tidak ada pesan baru di antrian. Selesai.');
    return;
  }
  console.log(`Ditemukan ${keys.length} pesan yang perlu diproses.`);

  // Cache kecil supaya tidak baca ulang data yang sama berkali-kali dalam 1 run.
  const activeChatCache = new Map();
  const directoryCache = new Map();
  const tokensCache = new Map();

  async function getActiveChat(uid) {
    if (!activeChatCache.has(uid)) {
      const s = await db.ref('activeChat/' + uid).get();
      activeChatCache.set(uid, s.exists() ? s.val() : null);
    }
    return activeChatCache.get(uid);
  }
  async function getSenderName(uid) {
    if (!directoryCache.has(uid)) {
      const s = await db.ref('directory/' + uid).get();
      const v = s.val() || {};
      directoryCache.set(uid, v.displayName || 'Someone');
    }
    return directoryCache.get(uid);
  }
  async function getTokens(uid) {
    if (!tokensCache.has(uid)) {
      const s = await db.ref('users/' + uid + '/fcmTokens').get();
      tokensCache.set(uid, Object.keys(s.val() || {}));
    }
    return tokensCache.get(uid);
  }

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const key of keys) {
    const item = queue[key] || {};
    const { chatId, from, to, preview } = item;

    try {
      if (!chatId || !from || !to) {
        console.warn(`Entri ${key} tidak lengkap, dilewati.`);
        continue;
      }

      const activePeerChat = await getActiveChat(to);
      if (activePeerChat === from) {
        skippedCount++;
        continue; // penerima memang sedang membuka chat ini, tak perlu push
      }

      const tokens = await getTokens(to);
      if (!tokens.length) {
        continue; // tidak ada device yang terdaftar utk terima push
      }

      const senderName = await getSenderName(from);
      const message = {
        tokens,
        data: {
          title: senderName,
          body: trimBody(preview),
          senderUid: from,
          chatId: chatId,
        },
        webpush: {
          headers: { Urgency: 'high' },
          fcmOptions: { link: '/?startChatWith=' + from },
        },
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      sentCount += response.successCount;
      failedCount += response.failureCount;

      // Bersihkan token yang sudah invalid/kadaluarsa
      const staleTokens = [];
      response.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            staleTokens.push(tokens[i]);
          }
        }
      });
      if (staleTokens.length) {
        const updates = {};
        staleTokens.forEach((t) => { updates[`users/${to}/fcmTokens/${t}`] = null; });
        await db.ref().update(updates);
      }
    } catch (e) {
      failedCount++;
      console.error(`Gagal proses entri ${key}:`, e.message || e);
    } finally {
      // Selalu hapus dari antrian (berhasil ataupun gagal) supaya antrian
      // tidak menumpuk dan tidak dicoba kirim berkali-kali tanpa henti.
      await db.ref('notifyQueue/' + key).remove().catch(() => {});
    }
  }

  console.log(
    `Selesai. Push terkirim: ${sentCount}, dilewati (chat sedang dibuka): ${skippedCount}, gagal: ${failedCount}.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Worker gagal total:', e);
    process.exit(1);
  });
