// Web Push (phone and desktop notifications) with no dependencies: VAPID signing + aes128gcm payload encryption (RFC 8291/8292).
'use strict';
const crypto = require('crypto');
const https = require('https');
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');

function makeVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' }), priv = privateKey.export({ format: 'jwk' });
  return { x: pub.x, y: pub.y, d: priv.d };
}
function vapidPublic(v) { return b64u(Buffer.concat([Buffer.from([4]), unb64u(v.x), unb64u(v.y)])); }
function vapidJwt(v, aud, subject) {
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: v.x, y: v.y, d: v.d }, format: 'jwk' });
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' });
  return h + '.' + p + '.' + b64u(sig);
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic), salt = crypto.randomBytes(16);
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}
// resolves to the HTTP status code (404/410 mean the subscription is gone)
function send(vapid, sub, data, subject) {
  return new Promise(resolve => {
    try {
      const url = new URL(sub.endpoint); if (url.protocol !== 'https:') return resolve(400);
      const body = encrypt(sub, JSON.stringify(data));
      const req = https.request(url, { method: 'POST', timeout: 10000, headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, TTL: '86400', Urgency: 'normal',
        Authorization: `vapid t=${vapidJwt(vapid, url.origin, subject)}, k=${vapidPublic(vapid)}` } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0)); req.on('timeout', () => { req.destroy(); resolve(0); }); req.end(body);
    } catch (e) { resolve(0); }
  });
}
module.exports = { makeVapid, vapidPublic, send, encrypt };
