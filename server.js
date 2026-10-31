// Striphe's World Powers — self-hosted game server. No dependencies: just run `node server.js`.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const FILE = path.join(DATA_DIR, 'world.json');
const COLS = ['nations', 'chat', 'online'];
const MAX_DOC = 256 * 1024;
const SESSION_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
let S = { users: {}, sessions: {}, docs: {} };
try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') { console.error('Could not read', FILE, e.message); process.exit(1); } }

let saveTimer = null;
function persist(now) {
  clearTimeout(saveTimer);
  const write = () => { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, FILE); };
  if (now) write(); else saveTimer = setTimeout(write, 1500);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { persist(true); process.exit(0); });

// ---------- passwords ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw, u) {
  const h = crypto.scryptSync(pw, u.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
}
const findByEmail = email => Object.entries(S.users).find(([, u]) => u.email === email);

// ---------- command line tools ----------
const [, , cmd, a1, a2] = process.argv;
if (cmd === 'reset-password') {
  const f = findByEmail((a1 || '').toLowerCase());
  if (!f || !a2 || a2.length < 8) { console.log('Usage: node server.js reset-password <email> <new password (8+ chars)>'); process.exit(1); }
  Object.assign(f[1], hashPw(a2));
  for (const [t, s] of Object.entries(S.sessions)) if (s.uid === f[0]) delete S.sessions[t];
  persist(true); console.log('Password reset for', a1); process.exit(0);
}
if (cmd === 'make-admin' || cmd === 'remove-admin') {
  const f = findByEmail((a1 || '').toLowerCase());
  if (!f) { console.log(`Usage: node server.js ${cmd} <email>`); process.exit(1); }
  f[1].admin = cmd === 'make-admin'; persist(true); console.log(cmd === 'make-admin' ? 'Now an admin:' : 'No longer an admin:', a1); process.exit(0);
}
if (cmd === 'list-users') {
  for (const [id, u] of Object.entries(S.users)) console.log(id, u.email, u.name, u.admin ? '(admin)' : '', u.banned ? '(banned)' : '');
  process.exit(0);
}

// ---------- helpers ----------
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = MAX_DOC + 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
function isHttps(req) { return req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function sessionCookie(req, token, maxAge) {
  return `wp_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
function auth(req) {
  const t = cookies(req).wp_s; if (!t) return null;
  const s = S.sessions[t]; if (!s) return null;
  if (s.exp < Date.now()) { delete S.sessions[t]; persist(); return null; }
  const u = S.users[s.uid]; if (!u || u.banned) return null;
  return { id: s.uid, ...u, token: t };
}
function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  S.sessions[token] = { uid, exp: Date.now() + SESSION_DAYS * 864e5 };
  persist(); return token;
}
const pub = u => ({ id: u.id, name: u.name, email: u.email, admin: !!u.admin });
const ip = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// simple rate limiters
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

// ---------- live stream (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.res.write(msg);
}
function snapshot() {
  const cols = {}; for (const c of COLS) cols[c] = {};
  for (const [p, d] of Object.entries(S.docs)) { const [c, id] = p.split('/'); if (cols[c]) cols[c][id] = d; }
  const users = {}; for (const [id, u] of Object.entries(S.users)) if (!u.banned) users[id] = u.name;
  return { cols, users };
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const NAME_RE = /^[A-Za-z0-9_ .-]{2,20}$/;
function cleanChat(d) {
  const m = Array.isArray(d.m) ? d.m : [];
  return { m: m.slice(0, 40).filter(x => x && typeof x.x === 'string' && Number.isFinite(x.t)).map(x => ({ t: Math.min(x.t, Date.now() + 5000), x: x.x.slice(0, 200) })) };
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
      return res.end(html);
    }
    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }

    if (p === '/api/signup' && req.method === 'POST') {
      if (limited('signup:' + ip(req), 5, 60 * 60e3)) return send(res, 429, { error: 'Too many sign-ups from your network. Try again later.' });
      const b = await readBody(req, 4096);
      const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (!NAME_RE.test(name)) return send(res, 400, { error: 'Ruler name must be 2–20 letters, numbers, spaces, dots, dashes or underscores.' });
      if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (findByEmail(email)) return send(res, 409, { error: 'An account with that email already exists. Log in instead.' });
      if (Object.values(S.users).some(u => u.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That ruler name is taken.' });
      const id = crypto.randomBytes(9).toString('base64url');
      const first = Object.keys(S.users).length === 0;
      S.users[id] = { email, name, ...hashPw(pw), created: Date.now(), admin: first || email === ADMIN_EMAIL };
      const token = newSession(id);
      broadcast('user', { id, name });
      return send(res, 200, pub({ id, ...S.users[id] }), { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (limited('login:' + ip(req), 15, 15 * 60e3)) return send(res, 429, { error: 'Too many login attempts. Wait 15 minutes.' });
      const b = await readBody(req, 4096);
      const f = findByEmail(String(b.email || '').trim().toLowerCase());
      if (!f || !checkPw(String(b.password || ''), f[1])) return send(res, 401, { error: 'Wrong email or password.' });
      if (f[1].banned) return send(res, 403, { error: 'This account has been banned.' });
      const token = newSession(f[0]);
      return send(res, 200, pub({ id: f[0], ...f[1] }), { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const t = cookies(req).wp_s; if (t) { delete S.sessions[t]; persist(); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    const me = auth(req);
    if (!me) return send(res, 401, { error: 'Not logged in.' });

    if (p === '/api/me' && req.method === 'GET') return send(res, 200, pub(me));

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      res.write(`event: init\ndata: ${JSON.stringify(snapshot())}\n\n`);
      const c = { res, uid: me.id }; clients.add(c);
      req.on('close', () => clients.delete(c));
      return;
    }

    let m = p.match(/^\/api\/doc\/([a-z]+)\/([A-Za-z0-9_-]{1,64})$/);
    if (m) {
      const [, col, id] = m; const key = col + '/' + id;
      if (!COLS.includes(col)) return send(res, 404, { error: 'Unknown collection.' });
      if (req.method === 'PUT') {
        if (id !== me.id) return send(res, 403, { error: 'You can only change your own data.' });
        if (limited('w:' + me.id, 40, 10e3)) return send(res, 429, { error: 'Slow down.' });
        let d = await readBody(req);
        if (!d || typeof d !== 'object' || Array.isArray(d)) return send(res, 400, { error: 'Bad data.' });
        if (col === 'online') d = { t: Date.now() };
        if (col === 'chat') {
          if (limited('chat:' + me.id, 12, 20e3)) return send(res, 429, { error: 'You are chatting too fast.' });
          d = cleanChat(d);
        }
        if (JSON.stringify(d).length > MAX_DOC) return send(res, 413, { error: 'Too large.' });
        S.docs[key] = d; persist();
        broadcast('doc', { col, id, data: d });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (id !== me.id && !me.admin) return send(res, 403, { error: 'Only admins can remove other players.' });
        delete S.docs[key]; persist();
        broadcast('doc', { col, id, data: null });
        return send(res, 200, { ok: true });
      }
    }

    if (p === '/api/admin/ban' && req.method === 'POST') {
      if (!me.admin) return send(res, 403, { error: 'Admins only.' });
      const b = await readBody(req, 1024); const u = S.users[b.id];
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      u.banned = true;
      for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
      for (const c of COLS) { if (S.docs[c + '/' + b.id]) { delete S.docs[c + '/' + b.id]; broadcast('doc', { col: c, id: b.id, data: null }); } }
      for (const c of clients) if (c.uid === b.id) c.res.end();
      persist();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    if (!e.status) console.error(e);
  }
}

http.createServer(handle).listen(PORT, () => {
  console.log(`World Powers is running on http://localhost:${PORT}`);
  console.log(`Saving the world to ${FILE}`);
  if (!Object.keys(S.users).length) console.log('The first account to sign up becomes the admin' + (ADMIN_EMAIL ? ` (and so will ${ADMIN_EMAIL})` : '') + '.');
});
