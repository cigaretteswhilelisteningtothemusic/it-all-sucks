/**
 * Vibexa Chat Push Notification Worker
 * ------------------------------------
 * Menerima trigger dari client tiap kali ada pesan chat terkirim, lalu
 * mengirim notifikasi FCM ke semua device milik penerima — supaya dia tetap
 * dapat notifikasi ala WhatsApp walau tab/app sedang tertutup.
 *
 * Kenapa arsitektur ini (bukan Cloud Function)?
 * - Cloudflare Workers free tier: 100.000 request/hari, tanpa perlu upgrade
 *   plan Firebase ke Blaze.
 * - Tidak ada trigger "on database write" bawaan di Workers, jadi client
 *   sendiri yang memanggil Worker ini SETELAH berhasil menulis pesan ke
 *   Firebase Realtime Database (lihat perubahan di vibexa.html:
 *   triggerChatPushNotification()).
 *
 * Alur:
 * 1. Client kirim { idToken, toUid, chatId, title, body } ke endpoint ini.
 * 2. Worker verifikasi idToken (Firebase Auth ID token) langsung lewat
 *    public key Google — supaya tidak ada orang iseng yang bisa memicu
 *    notifikasi mengatasnamakan user lain.
 * 3. Worker cocokkan chatId dengan uid pengirim+penerima (chatId selalu
 *    [uidA,uidB].sort().join('_') di app ini) — mencegah spam notifikasi ke
 *    uid sembarangan.
 * 4. Worker mint access token dari Service Account Firebase (JWT RS256,
 *    ditandatangani pakai Web Crypto API bawaan Workers — tidak perlu
 *    library Node/npm apa pun).
 * 5. Worker ambil daftar fcmTokens milik penerima dari Realtime Database
 *    REST API (pakai access token tsb, jadi otomatis bypass Security Rules
 *    seperti Admin SDK).
 * 6. Worker kirim push ke tiap token lewat FCM HTTP v1 API. Token yang sudah
 *    tidak valid (uninstall/logout browser) otomatis dihapus dari database.
 */

const FIREBASE_JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Cache in-memory sederhana (bertahan selama Worker isolate masih hidup —
// bonus performa, tapi tetap benar walau isolate baru & cache kosong).
let _googleAccessTokenCache = null; // { token, exp }
let _firebaseJwkCache = null;       // { keys, exp }

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── Base64URL helpers ───────────────────────────────────────────────────
function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function textToB64url(str) {
  return bytesToB64url(new TextEncoder().encode(str));
}

// ── Verifikasi Firebase ID Token (dari client) ──────────────────────────
async function getFirebaseJwks() {
  const now = Date.now();
  if (_firebaseJwkCache && _firebaseJwkCache.exp > now) return _firebaseJwkCache.keys;
  const res = await fetch(FIREBASE_JWK_URL);
  if (!res.ok) throw new Error('Gagal mengambil JWKS Firebase');
  const data = await res.json();
  _firebaseJwkCache = { keys: data.keys, exp: now + 60 * 60 * 1000 }; // cache 1 jam
  return data.keys;
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ID token tidak valid');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));

  if (header.alg !== 'RS256') throw new Error('Algoritma token tidak didukung');

  const keys = await getFirebaseJwks();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Kid token tidak dikenal (mungkin key sudah rotasi)');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );

  const signature = b64urlToBytes(sigB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedData);
  if (!valid) throw new Error('Signature token tidak valid');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('Token sudah kedaluwarsa');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Issuer token salah');
  if (payload.aud !== projectId) throw new Error('Audience token salah');
  if (!payload.sub) throw new Error('Token tidak punya uid (sub)');

  return payload.sub; // uid pengirim, terverifikasi
}

// ── Buat access token Google dari Service Account (untuk RTDB + FCM) ────
async function importServiceAccountKey(pem) {
  // PEM service account pakai base64 standar (bukan URL-safe) — decode manual.
  const clean = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey(
    'pkcs8', bytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
}

async function getGoogleAccessToken(env) {
  const now = Date.now();
  if (_googleAccessTokenCache && _googleAccessTokenCache.exp > now + 30000) {
    return _googleAccessTokenCache.token;
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database',
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp,
  };

  const headerB64 = textToB64url(JSON.stringify(header));
  const claimsB64 = textToB64url(JSON.stringify(claims));
  const unsigned = `${headerB64}.${claimsB64}`;

  const key = await importServiceAccountKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${bytesToB64url(new Uint8Array(signature))}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Gagal ambil access token Google: ' + JSON.stringify(data));
  }

  _googleAccessTokenCache = { token: data.access_token, exp: now + data.expires_in * 1000 };
  return data.access_token;
}

// ── Ambil + hapus fcmTokens penerima di Realtime Database ───────────────
async function getRecipientTokens(env, accessToken, toUid) {
  const url = `${env.FIREBASE_DB_URL}/users/${toUid}/fcmTokens.json?access_token=${accessToken}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data);
}

async function deleteRecipientToken(env, accessToken, toUid, token) {
  const url = `${env.FIREBASE_DB_URL}/users/${toUid}/fcmTokens/${encodeURIComponent(token)}.json?access_token=${accessToken}`;
  await fetch(url, { method: 'DELETE' }).catch(() => {});
}

// ── Kirim satu notifikasi lewat FCM HTTP v1 ──────────────────────────────
async function sendFcmMessage(env, accessToken, token, { title, body, data }) {
  const url = `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`;
  const link = data?.fromUid
    ? `${env.APP_URL || '/'}?startChatWith=${encodeURIComponent(data.fromUid)}`
    : (env.APP_URL || '/');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: data || {},
        webpush: {
          notification: { icon: 'icons/icon-192.png' },
          fcm_options: { link },
        },
      },
    }),
  });
  const result = await res.json().catch(() => ({}));
  return { ok: res.ok, result };
}

// ── Handler utama ────────────────────────────────────────────────────────
async function handleSendChatNotification(request, env) {
  const origin = request.headers.get('Origin');

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Body bukan JSON valid' }, 400, origin);
  }

  const { idToken, toUid, chatId, title, body } = payload || {};
  if (!idToken || !toUid || !chatId || !title) {
    return json({ error: 'Field wajib: idToken, toUid, chatId, title' }, 400, origin);
  }

  let fromUid;
  try {
    fromUid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
    console.log('[notif] ID token OK, fromUid=', fromUid);
  } catch (e) {
    console.log('[notif] ID token GAGAL diverifikasi:', e.message);
    return json({ error: 'Token tidak valid: ' + e.message }, 401, origin);
  }

  // Pastikan chatId memang milik pasangan (fromUid, toUid) ini — mencegah
  // user memicu notifikasi ke uid sembarangan yang bukan lawan chat-nya.
  const expectedChatId = [fromUid, toUid].sort().join('_');
  if (chatId !== expectedChatId) {
    console.log('[notif] chatId TIDAK COCOK. dikirim client:', chatId, '| seharusnya:', expectedChatId);
    return json({ error: 'chatId tidak cocok dengan peserta chat' }, 403, origin);
  }
  if (fromUid === toUid) {
    return json({ ok: true, skipped: 'self' }, 200, origin);
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(env);
    console.log('[notif] Google access token OK');
  } catch (e) {
    console.log('[notif] GAGAL ambil access token Google:', e.message);
    return json({ error: 'Gagal autentikasi ke Firebase: ' + e.message }, 500, origin);
  }

  const tokens = await getRecipientTokens(env, accessToken, toUid);
  console.log('[notif] toUid=', toUid, '| jumlah fcmTokens ditemukan:', tokens.length);
  if (!tokens.length) {
    return json({ ok: true, sent: 0, note: 'Penerima belum punya device terdaftar notifikasi' }, 200, origin);
  }

  const safeBody = String(body || '').slice(0, 150);
  const safeTitle = String(title).slice(0, 60);

  let sent = 0;
  await Promise.all(tokens.map(async (token) => {
    const { ok, result } = await sendFcmMessage(env, accessToken, token, {
      title: safeTitle,
      body: safeBody,
      data: { chatId, fromUid, type: 'chat_message' },
    });
    if (ok) {
      sent++;
      console.log('[notif] Kirim ke token', token.slice(0, 12) + '...', '→ SUKSES');
    } else {
      console.log('[notif] Kirim ke token', token.slice(0, 12) + '...', '→ GAGAL:', JSON.stringify(result?.error || result));
      const status = result?.error?.status;
      if (status === 'UNREGISTERED' || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT') {
        await deleteRecipientToken(env, accessToken, toUid, token);
        console.log('[notif] Token dihapus karena sudah tidak valid');
      }
    }
  }));

  console.log('[notif] SELESAI. Terkirim:', sent, '/', tokens.length);
  return json({ ok: true, sent, total: tokens.length }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname === '/send-chat-notification' && request.method === 'POST') {
      try {
        return await handleSendChatNotification(request, env);
      } catch (e) {
        return json({ error: 'Internal error: ' + e.message }, 500, origin);
      }
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
