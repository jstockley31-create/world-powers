// World Powers — self-hosted game server. No dependencies: run `node server.js`.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const FILE = path.join(DATA_DIR, 'world.json');
const COLS = ['nations', 'chat', 'online'];
const MAX_DOC = 256 * 1024;
const SESSION_DAYS = 30;
const MAP_VERSION = 2;
const START = Date.now();
const DEFAULT_CONFIG = { cd: 1, income: 1, xp: 1, protectH: 48, war: true, signups: true, motd: '' };

fs.mkdirSync(DATA_DIR, { recursive: true });
let S = { users: {}, sessions: {}, docs: {}, meta: {}, flags: [], audit: [], config: { ...DEFAULT_CONFIG } };
try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') { console.error('Could not read', FILE, e.message); process.exit(1); } }
S.config = { ...DEFAULT_CONFIG, ...(S.config || {}) };
S.meta = S.meta || {}; S.flags = S.flags || []; S.audit = S.audit || [];
if (S.mapVersion !== MAP_VERSION) {
  // New world map: old nations no longer fit. Keep accounts, clear the world.
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/') || k.startsWith('online/') || (k.startsWith('chat/') && k !== 'chat/_system')) delete S.docs[k];
  S.mapVersion = MAP_VERSION;
}

const health = { lastSave: 0, saveError: null, errors: [], reqs: new Map(), writes: 0 };
let saveTimer = null;
function writeNow() {
  try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, FILE); health.lastSave = Date.now(); health.saveError = null; }
  catch (e) { health.saveError = e.message; logErr('Saving failed: ' + e.message); }
}
function persist(now) { clearTimeout(saveTimer); if (now) writeNow(); else saveTimer = setTimeout(writeNow, 1500); }
persist();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { persist(true); process.exit(0); });
function logErr(msg) { health.errors.unshift({ t: Date.now(), msg: String(msg).slice(0, 500) }); health.errors.length = Math.min(health.errors.length, 100); console.error(msg); }
process.on('uncaughtException', e => logErr('Crash avoided: ' + (e.stack || e)));

// ---------- passwords ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }; }
function checkPw(pw, u) { return crypto.timingSafeEqual(crypto.scryptSync(pw, u.salt, 64), Buffer.from(u.hash, 'hex')); }
const findByEmail = email => Object.entries(S.users).find(([, u]) => u.email === email);

// ---------- command line tools ----------
const [, , cmd, a1, a2] = process.argv;
if (cmd === 'reset-password') {
  const f = findByEmail((a1 || '').toLowerCase());
  if (!f || !a2 || a2.length < 8) { console.log('Usage: node server.js reset-password <email> <new password (8+ chars)>'); process.exit(1); }
  Object.assign(f[1], hashPw(a2)); for (const [t, s] of Object.entries(S.sessions)) if (s.uid === f[0]) delete S.sessions[t];
  persist(true); console.log('Password reset for', a1); process.exit(0);
}
if (cmd === 'make-admin' || cmd === 'remove-admin') {
  const f = findByEmail((a1 || '').toLowerCase());
  if (!f) { console.log(`Usage: node server.js ${cmd} <email>`); process.exit(1); }
  f[1].admin = cmd === 'make-admin'; persist(true); console.log('Done:', a1); process.exit(0);
}
if (cmd === 'list-users') { for (const [id, u] of Object.entries(S.users)) console.log(id, u.email, u.name, u.admin ? '(admin)' : '', u.banned ? '(banned)' : ''); process.exit(0); }

// ---------- static files (pre-compressed) ----------
const STATIC = {};
function loadStatic(route, file, type) {
  const buf = fs.readFileSync(path.join(__dirname, 'public', file));
  STATIC[route] = { type, buf, gz: zlib.gzipSync(buf, { level: 9 }), etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"' };
}
loadStatic('/', 'index.html', 'text/html; charset=utf-8');
loadStatic('/admin', 'admin.html', 'text/html; charset=utf-8');
loadStatic('/vendor/d3.min.js', 'vendor/d3.min.js', 'text/javascript; charset=utf-8');
STATIC['/index.html'] = STATIC['/'];
function serveStatic(req, res, f) {
  const h = { 'Content-Type': f.type, 'Cache-Control': f.type.startsWith('text/javascript') ? 'public, max-age=86400' : 'no-cache', ETag: f.etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(f.gz); }
  res.writeHead(200, h); res.end(f.buf);
}

// ---------- helpers ----------
function send(res, code, obj, headers = {}) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = MAX_DOC + 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Too large.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('Bad request.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function cookies(req) { const out = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return out; }
const isHttps = req => req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const sessionCookie = (req, token, maxAge) => `wp_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
function auth(req) {
  const t = cookies(req).wp_s; if (!t) return null;
  const s = S.sessions[t]; if (!s) return null;
  if (s.exp < Date.now()) { delete S.sessions[t]; persist(); return null; }
  const u = S.users[s.uid]; if (!u || u.banned) return null;
  return { id: s.uid, ...u, token: t };
}
function newSession(uid) { const token = crypto.randomBytes(32).toString('hex'); S.sessions[token] = { uid, exp: Date.now() + SESSION_DAYS * 864e5 }; persist(); return token; }
const pub = u => ({ id: u.id, name: u.name, email: u.email, admin: !!u.admin });
function meta(uid) { return S.meta[uid] || (S.meta[uid] = { ips: [], lastSeen: 0 }); }
function touch(uid, req) {
  const m = meta(uid); m.lastSeen = Date.now(); const ip = ipOf(req);
  if (ip && !m.ips.includes(ip)) { m.ips.unshift(ip); m.ips = m.ips.slice(0, 8); persist(); }
}
function audit(by, action, target, detail) { S.audit.unshift({ t: Date.now(), by, action, target: target || null, detail: detail || null }); S.audit = S.audit.slice(0, 500); persist(); }
const buckets = new Map();
function limited(key, max, windowMs) { const now = Date.now(); let b = buckets.get(key); if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); } return ++b.n > max; }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); const cut = Math.floor(now / 60000) - 60; for (const k of health.reqs.keys()) if (k < cut) health.reqs.delete(k); }, 60000).unref();

// ---------- live stream ----------
const clients = new Set();
function broadcast(event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.res.write(msg); }
function setDoc(col, id, data) { const key = col + '/' + id; if (data == null) delete S.docs[key]; else S.docs[key] = data; persist(); broadcast('doc', { col, id, data: data == null ? null : data }); }
function snapshot() {
  const cols = {}; for (const c of COLS) cols[c] = {};
  for (const [p, d] of Object.entries(S.docs)) { const [c, id] = p.split('/'); if (cols[c]) cols[c][id] = d; }
  const users = {}; for (const [id, u] of Object.entries(S.users)) if (!u.banned) users[id] = u.name;
  return { cols, users, config: S.config };
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();
function systemMessage(text) { const doc = S.docs['chat/_system'] || { m: [] }; doc.m = [{ t: Date.now(), x: String(text).slice(0, 300) }, ...(doc.m || [])].slice(0, 40); setDoc('chat', '_system', doc); }

// ---------- cheat watch ----------
const RANK_XP = [0, 100, 300, 700, 1500, 3000, 6000, 12000, 25000, 50000, 100000];
const rankOf = xp => { let i = 0; RANK_XP.forEach((v, j) => { if ((xp || 0) >= v) i = j; }); return i; };
const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
function cheatCheck(prev, d) {
  const out = []; const C = S.config;
  if (!prev) return out;
  if (prev.created && d.created && prev.created !== d.created && d.created > prev.created + 1000) return out; // a brand-new nation
  const xm = Math.max(1, C.xp), im = Math.max(1, C.income);
  const dxp = num(d.xp) - num(prev.xp); if (dxp > 320 * xm) out.push(`XP jumped by ${Math.round(dxp)} in one save`);
  for (const k of ['tech', 'train', 'infra', 'fort']) { const dv = num(d[k]) - num(prev[k]); if (dv > 2) out.push(`${k === 'train' ? 'Training' : k === 'infra' ? 'Infrastructure' : k === 'fort' ? 'Fortifications' : 'Tech'} jumped by ${dv} in one save`); }
  const dtr = num(d.troops) - num(prev.troops); if (dtr > Math.max(800, num(prev.pop) * 0.03)) out.push(`Troops jumped by ${Math.round(dtr)} in one save`);
  const dc = num(d.cash) - num(prev.cash); if (dc > Math.max(4e6 * im, num(prev.cash) * 1.5 + 1e6 * im)) out.push(`Cash jumped by $${Math.round(dc).toLocaleString('en-US')} in one save`);
  for (const r of ['food', 'oil', 'steel', 'goods']) { const dr = num(d.res && d.res[r]) - num(prev.res && prev.res[r]); if (dr > 25000 * im) out.push(`${r} jumped by ${Math.round(dr)} in one save`); }
  if (num(d.approval) > 100.5 || num(d.stability) > 100.5 || num(d.approval) < -0.5 || num(d.stability) < -0.5) out.push('Approval or stability outside 0–100');
  if (num(d.troops) > num(d.pop) * 0.08 + 2000) out.push('More troops than the population allows');
  if (num(d.cash) > 1e12) out.push('Impossible amount of cash');
  const now = Date.now(), pc = prev.cd || {}, nc = d.cd || {};
  for (const k of Object.keys(pc)) if (num(pc[k]) > now + 2000 && num(nc[k]) < num(pc[k]) - 2000) out.push(`Skipped the "${k}" timer`);
  if (prev.cap != null && d.cap !== prev.cap) out.push('Moved their capital');
  const hexes = Object.keys(d.hexes || {}).length; if (hexes > 3 + rankOf(d.xp) * 4 + 25) out.push(`Holds ${hexes} provinces — far above their rank`);
  return out;
}
function flag(uid, reasons) { for (const r of reasons) S.flags.unshift({ t: Date.now(), uid, r }); S.flags = S.flags.slice(0, 2000); persist(); }

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const NAME_RE = /^[A-Za-z0-9_ .-]{2,20}$/;
function cleanChat(d) { const m = Array.isArray(d.m) ? d.m : []; return { m: m.slice(0, 40).filter(x => x && typeof x.x === 'string' && Number.isFinite(x.t)).map(x => ({ t: Math.min(x.t, Date.now() + 5000), x: x.x.slice(0, 200) })) }; }

// ---------- admin ----------
function dirSize() { try { return fs.statSync(FILE).size; } catch (e) { return 0; } }
function overview() {
  const now = Date.now();
  const nations = {}; for (const [k, d] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = d;
  const online = Object.entries(S.docs).filter(([k, d]) => k.startsWith('online/') && now - num(d.t) < 5 * 60e3).length;
  let reqs5 = 0; const m = Math.floor(now / 60000); for (let i = 0; i < 5; i++) reqs5 += health.reqs.get(m - i) || 0;
  const flagCount = {}; for (const f of S.flags) flagCount[f.uid] = (flagCount[f.uid] || 0) + 1;
  // accounts sharing an IP
  const byIp = {}; for (const [id, mt] of Object.entries(S.meta)) for (const ip of mt.ips || []) (byIp[ip] = byIp[ip] || []).push(id);
  const shared = Object.entries(byIp).filter(([, ids]) => ids.length > 1).map(([ip, ids]) => ({ ip, ids }));
  const players = Object.entries(S.users).map(([id, u]) => {
    const n = nations[id], mt = S.meta[id] || {};
    return { id, name: u.name, email: u.email, admin: !!u.admin, banned: !!u.banned, created: u.created, lastSeen: mt.lastSeen || 0, ips: mt.ips || [], flags: flagCount[id] || 0,
      nation: n ? { name: n.name, color: n.color, gov: n.gov, xp: n.xp, rank: rankOf(n.xp), cash: n.cash, pop: n.pop, troops: n.troops, provinces: Object.keys(n.hexes || {}).length + 1, tech: n.tech, approval: n.approval, stability: n.stability, aggr: n.aggr, created: n.created } : null,
      shared: shared.some(s => s.ids.includes(id)) };
  });
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
  return {
    health: {
      uptime: now - START, memoryMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      dataBytes: dirSize(), lastSave: health.lastSave, saveError: health.saveError, dataDir: DATA_DIR,
      onVolume: volume ? path.resolve(DATA_DIR).startsWith(path.resolve(volume)) : null, volume,
      streams: clients.size, online, reqs5, writes: health.writes, errors24: health.errors.filter(e => now - e.t < 864e5).length,
      node: process.version, load: os.loadavg()[0], accounts: Object.keys(S.users).length, nations: Object.keys(nations).length,
      sessions: Object.keys(S.sessions).length
    },
    players, flags: S.flags.slice(0, 300), audit: S.audit.slice(0, 200), errors: health.errors.slice(0, 50), shared, config: S.config
  };
}
const NUM_FIELDS = ['cash', 'pop', 'troops', 'xp', 'tech', 'train', 'infra', 'fort', 'tax', 'approval', 'stability', 'aggr'];
async function adminRoute(p, req, res, me) {
  if (!me.admin) return send(res, 403, { error: 'Admins only.' });
  if (p === '/api/admin/overview' && req.method === 'GET') return send(res, 200, overview());
  if (p === '/api/admin/backup' && req.method === 'GET') {
    audit(me.name, 'Downloaded a backup');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="world-powers-backup-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(S));
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found.' });
  const b = await readBody(req, 64 * 1024);
  const u = b.id ? S.users[b.id] : null;
  const target = u ? u.name : null;
  switch (p) {
    case '/api/admin/player': {
      if (!u) return send(res, 404, { error: 'Unknown player.' });
      return send(res, 200, { id: b.id, ...pub({ id: b.id, ...u }), banned: !!u.banned, created: u.created, meta: S.meta[b.id] || {}, nation: S.docs['nations/' + b.id] || null, flags: S.flags.filter(f => f.uid === b.id).slice(0, 100) });
    }
    case '/api/admin/nation': {
      const n = S.docs['nations/' + b.id]; if (!n) return send(res, 404, { error: 'That player has no nation.' });
      const changes = [];
      for (const k of NUM_FIELDS) if (b.patch && b.patch[k] != null && b.patch[k] !== '' && isFinite(+b.patch[k])) { changes.push(`${k}: ${n[k]} → ${+b.patch[k]}`); n[k] = +b.patch[k]; }
      if (b.patch && b.patch.res) { n.res = n.res || {}; for (const r of ['food', 'oil', 'steel', 'goods']) if (b.patch.res[r] != null && b.patch.res[r] !== '' && isFinite(+b.patch.res[r])) { changes.push(`${r}: ${n.res[r]} → ${+b.patch.res[r]}`); n.res[r] = +b.patch.res[r]; } }
      if (b.patch && typeof b.patch.name === 'string' && b.patch.name.trim()) { changes.push(`name: ${n.name} → ${b.patch.name.trim().slice(0, 24)}`); n.name = b.patch.name.trim().slice(0, 24); }
      if (b.resetCooldowns) { n.cd = {}; changes.push('cooldowns reset'); }
      if (b.resetCards) { n.cards = []; changes.push('decisions cleared'); }
      n._adm = Date.now(); setDoc('nations', b.id, n);
      audit(me.name, 'Edited nation', target, changes.join('; ') || 'no changes');
      return send(res, 200, { ok: true });
    }
    case '/api/admin/reset-nation': {
      if (!u) return send(res, 404, { error: 'Unknown player.' });
      meta(b.id).resetAt = Date.now(); setDoc('nations', b.id, null); audit(me.name, 'Reset nation', target); return send(res, 200, { ok: true });
    }
    case '/api/admin/ban': case '/api/admin/unban': {
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      if (p.endsWith('/ban')) {
        u.banned = true; for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
        meta(b.id).resetAt = Date.now();
        for (const c of COLS) if (S.docs[c + '/' + b.id]) setDoc(c, b.id, null);
        for (const c of clients) if (c.uid === b.id) c.res.end();
        broadcast('user', { id: b.id, name: null });
        audit(me.name, 'Banned player', target);
      } else { u.banned = false; broadcast('user', { id: b.id, name: u.name }); audit(me.name, 'Unbanned player', target); }
      persist(); return send(res, 200, { ok: true });
    }
    case '/api/admin/password': {
      if (!u) return send(res, 404, { error: 'Unknown player.' });
      if (String(b.password || '').length < 8) return send(res, 400, { error: 'Password must be 8+ characters.' });
      Object.assign(u, hashPw(String(b.password))); for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
      audit(me.name, 'Reset password', target); return send(res, 200, { ok: true });
    }
    case '/api/admin/role': {
      if (!u) return send(res, 404, { error: 'Unknown player.' });
      if (b.id === me.id && !b.admin) return send(res, 400, { error: 'You cannot remove your own admin access.' });
      u.admin = !!b.admin; audit(me.name, b.admin ? 'Made admin' : 'Removed admin', target); return send(res, 200, { ok: true });
    }
    case '/api/admin/delete-account': {
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      for (const c of COLS) if (S.docs[c + '/' + b.id]) setDoc(c, b.id, null);
      for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
      for (const c of clients) if (c.uid === b.id) c.res.end();
      delete S.users[b.id]; delete S.meta[b.id]; broadcast('user', { id: b.id, name: null });
      audit(me.name, 'Deleted account', target + ' (' + u.email + ')'); return send(res, 200, { ok: true });
    }
    case '/api/admin/clear-flags': {
      S.flags = b.id ? S.flags.filter(f => f.uid !== b.id) : []; audit(me.name, 'Cleared cheat flags', target || 'everyone'); return send(res, 200, { ok: true });
    }
    case '/api/admin/config': {
      const c = b.config || {}, nc = { ...S.config };
      for (const k of ['cd', 'income', 'xp']) if (c[k] != null && isFinite(+c[k])) nc[k] = Math.max(0.1, Math.min(10, +c[k]));
      if (c.protectH != null && isFinite(+c.protectH)) nc.protectH = Math.max(0, Math.min(720, +c.protectH));
      if (c.war != null) nc.war = !!c.war; if (c.signups != null) nc.signups = !!c.signups;
      if (c.motd != null) nc.motd = String(c.motd).slice(0, 300);
      const diff = Object.keys(nc).filter(k => nc[k] !== S.config[k]).map(k => `${k}: ${S.config[k]} → ${nc[k]}`).join('; ');
      S.config = nc; persist(); broadcast('config', nc); audit(me.name, 'Changed game settings', null, diff || 'no changes');
      return send(res, 200, { ok: true, config: nc });
    }
    case '/api/admin/announce': {
      const t = String(b.text || '').trim(); if (!t) return send(res, 400, { error: 'Type a message.' });
      systemMessage(t); audit(me.name, 'Announcement', null, t); return send(res, 200, { ok: true });
    }
    case '/api/admin/clear-chat': {
      for (const k of Object.keys(S.docs)) if (k.startsWith('chat/')) setDoc('chat', k.slice(5), null);
      audit(me.name, 'Cleared chat'); return send(res, 200, { ok: true });
    }
    case '/api/admin/wipe-world': {
      if (b.confirm !== 'WIPE') return send(res, 400, { error: 'Type WIPE to confirm.' });
      const backup = path.join(DATA_DIR, `backup-before-wipe-${Date.now()}.json`); fs.writeFileSync(backup, JSON.stringify(S));
      for (const k of Object.keys(S.docs)) { const [c, id] = k.split('/'); if (c === 'nations' || c === 'online' || c === 'chat') { meta(id).resetAt = Date.now(); setDoc(c, id, null); } }
      S.flags = []; systemMessage('A new era begins: the world has been reset. Found your nation again!');
      audit(me.name, 'Wiped the world', null, 'Backup saved as ' + path.basename(backup)); return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found.' });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  const minute = Math.floor(Date.now() / 60000); health.reqs.set(minute, (health.reqs.get(minute) || 0) + 1);
  try {
    if (req.method === 'GET' && STATIC[p]) return serveStatic(req, res, STATIC[p]);
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, uptime: Date.now() - START });
    if (!p.startsWith('/api/')) { res.writeHead(302, { Location: '/' }); return res.end(); }

    if (p === '/api/signup' && req.method === 'POST') {
      if (!S.config.signups) return send(res, 403, { error: 'Sign-ups are closed right now.' });
      if (limited('signup:' + ipOf(req), 5, 60 * 60e3)) return send(res, 429, { error: 'Too many sign-ups from your network. Try again later.' });
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
      meta(id).signupIp = ipOf(req); touch(id, req);
      const token = newSession(id); broadcast('user', { id, name });
      return send(res, 200, pub({ id, ...S.users[id] }), { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (limited('login:' + ipOf(req), 15, 15 * 60e3)) return send(res, 429, { error: 'Too many login attempts. Wait 15 minutes.' });
      const b = await readBody(req, 4096);
      const f = findByEmail(String(b.email || '').trim().toLowerCase());
      if (!f || !checkPw(String(b.password || ''), f[1])) return send(res, 401, { error: 'Wrong email or password.' });
      if (f[1].banned) return send(res, 403, { error: 'This account has been banned.' });
      touch(f[0], req); const token = newSession(f[0]);
      return send(res, 200, pub({ id: f[0], ...f[1] }), { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/logout' && req.method === 'POST') { const t = cookies(req).wp_s; if (t) { delete S.sessions[t]; persist(); } return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) }); }

    const me = auth(req);
    if (!me) return send(res, 401, { error: 'Not logged in.' });
    if (p === '/api/me' && req.method === 'GET') { touch(me.id, req); return send(res, 200, pub(me)); }
    if (p.startsWith('/api/admin/')) return adminRoute(p, req, res, me);

    if (p === '/api/stream' && req.method === 'GET') {
      touch(me.id, req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n'); res.write(`event: init\ndata: ${JSON.stringify(snapshot())}\n\n`);
      const c = { res, uid: me.id }; clients.add(c); req.on('close', () => clients.delete(c));
      return;
    }

    const m = p.match(/^\/api\/doc\/([a-z]+)\/([A-Za-z0-9_-]{1,64})$/);
    if (m) {
      const [, col, id] = m; const key = col + '/' + id;
      if (!COLS.includes(col)) return send(res, 404, { error: 'Unknown collection.' });
      if (req.method === 'PUT') {
        if (id !== me.id) return send(res, 403, { error: 'You can only change your own data.' });
        if (limited('w:' + me.id, 40, 10e3)) return send(res, 429, { error: 'Slow down.' });
        let d = await readBody(req);
        if (!d || typeof d !== 'object' || Array.isArray(d)) return send(res, 400, { error: 'Bad data.' });
        if (col === 'online') { d = { t: Date.now() }; meta(me.id).lastSeen = Date.now(); }
        if (col === 'chat') { if (limited('chat:' + me.id, 12, 20e3)) return send(res, 429, { error: 'You are chatting too fast.' }); d = cleanChat(d); }
        if (col === 'nations') {
          const prev = S.docs[key]; const mt = meta(me.id);
          // ignore stale saves after an admin edit or reset
          if (prev && num(prev._adm) > num(d._adm)) return send(res, 200, { ok: true, ignored: 'admin-edit' });
          if (!prev && mt.resetAt && num(d.created) < mt.resetAt) return send(res, 200, { ok: true, ignored: 'reset' });
          const reasons = cheatCheck(prev, d); if (reasons.length) flag(me.id, reasons);
          mt.lastSeen = Date.now(); health.writes++;
        }
        if (JSON.stringify(d).length > MAX_DOC) return send(res, 413, { error: 'Too large.' });
        setDoc(col, id, d);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (id !== me.id && !me.admin) return send(res, 403, { error: 'Only admins can remove other players.' });
        if (col === 'nations') meta(id).resetAt = Date.now();
        setDoc(col, id, null); if (id !== me.id) audit(me.name, 'Removed ' + col, S.users[id] && S.users[id].name);
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    if (!e.status) logErr(e.stack || e);
  }
}

http.createServer(handle).listen(PORT, () => {
  console.log(`World Powers is running on http://localhost:${PORT}`);
  console.log(`Saving the world to ${FILE}`);
  if (!Object.keys(S.users).length) console.log('The first account to sign up becomes the admin' + (ADMIN_EMAIL ? ` (and so will ${ADMIN_EMAIL})` : '') + '.');
});
