// World Powers — self-hosted game server. No dependencies: run `node server.js`.
// The server is authoritative: every rule, every dice roll and every change to a nation happens here.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const WP = require('./public/core.js');
const SCENARIOS = require('./public/scenarios.js');
const PROV = require('./prov-lite.json');
const core = WP.Core(PROV, SCENARIOS);
const makeBots = require('./bots.js');
const PUSH = require('./push.js');
const MOD = require('./moderation.js');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BUG_DIR = path.join(DATA_DIR, 'bugs');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const FILE = path.join(DATA_DIR, 'world.json');
const COLS = ['nations', 'chat', 'online'];
const SESSION_DAYS = 30;
const MAP_VERSION = 4;
const START = Date.now();
const HOUR = 36e5;
const ACTIVE_WINDOW = 2 * HOUR; // nations keep producing for 2 hours after their leader was last seen
const NOTE_KINDS = ['ready', 'attack', 'war', 'diplo', 'mail', 'election', 'event', 'council', 'covert', 'economy', 'rank', 'mention', 'admin'];
const DEFAULT_PREFS = { ready: true, attack: true, war: true, diplo: true, mail: true, election: true, event: true, council: true, covert: true, economy: true, rank: false, mention: true, admin: true };

fs.mkdirSync(BACKUP_DIR, { recursive: true });
let S = { users: {}, sessions: {}, docs: {}, meta: {}, flags: [], audit: [], config: { ...WP.DEFCFG } };
try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') { console.error('Could not read', FILE, e.message); process.exit(1); } }
S.config = { ...WP.DEFCFG, ...(S.config || {}) };
if (!S.migLS24) { S.config.lastStandH = 24; S.migLS24 = true; } // the capital warning period became 24 hours
for (const k of ['meta', 'mail', 'notes', 'push', 'stats']) S[k] = S[k] || {};
for (const k of ['flags', 'audit', 'reports', 'fallen', 'bugs', 'schedule']) S[k] = S[k] || [];
S.council = S.council || { props: [], active: {} };
if (S.mapVersion !== MAP_VERSION) {
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/') || k.startsWith('online/') || (k.startsWith('chat/') && k !== 'chat/_system')) delete S.docs[k];
  S.council = { props: [], active: {} }; S.event = null; S.mapVersion = MAP_VERSION;
}
// every id-keyed map gets no prototype, so ids like "__proto__" or "constructor" can never match anything
for (const k of ['users', 'sessions', 'docs', 'meta', 'mail', 'notes', 'push', 'stats']) S[k] = Object.assign(Object.create(null), S[k]);
if (!S.adminPath) S.adminPath = '/hq-' + crypto.randomBytes(12).toString('hex');
if (!S.vapid) S.vapid = PUSH.makeVapid();
if (!S.nextEvent) S.nextEvent = Date.now() + 6 * HOUR;

const health = { lastSave: 0, saveError: null, errors: [], reqs: new Map(), cmds: 0, pushes: 0 };
let saveTimer = null;
function writeNow() {
  try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, FILE); health.lastSave = Date.now(); health.saveError = null; }
  catch (e) { health.saveError = e.message; logErr('Saving failed: ' + e.message); }
}
function persist(now) { if (now) { clearTimeout(saveTimer); saveTimer = null; return writeNow(); } if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 1500); }
persist(true);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { persist(true); process.exit(0); });
let lastAlert = 0;
function logErr(msg) {
  health.errors.unshift({ t: Date.now(), msg: String(msg).slice(0, 600) }); health.errors.length = Math.min(health.errors.length, 100); console.error(msg);
  if (Date.now() - lastAlert > 30 * 60e3 && typeof addNote === 'function') { lastAlert = Date.now(); setImmediate(() => { try { for (const [id, u] of Object.entries(S.users)) if (u.admin) addNote(id, 'admin', 'Server alert: ' + String(msg).split('\n')[0].slice(0, 160)); } catch (e) {} }); }
}
process.on('uncaughtException', e => logErr('Crash avoided: ' + (e.stack || e)));
process.on('unhandledRejection', e => logErr('Async error: ' + (e && e.stack || e)));
const rng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const BOTS = makeBots(core, WP, rng);
const rid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

// ---------- passwords ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }; }
const tokHash = t => crypto.createHash('sha256').update(t).digest('hex');
const DUMMY_PW = hashPw('dummy-password-for-timing');
function checkPw(pw, u) { return crypto.timingSafeEqual(crypto.scryptSync(pw, u.salt, 64), Buffer.from(u.hash, 'hex')); }
const inviteCode = id => crypto.createHash('sha256').update('inv:' + id + S.adminPath).digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 7);
const byInvite = code => typeof code === 'string' && /^[A-Za-z0-9]{7}$/.test(code) ? Object.keys(S.users).find(id => inviteCode(id) === code) : null;
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
if (cmd === 'admin-link') { console.log('Admin page:', S.adminPath); process.exit(0); }

// ---------- static files ----------
const STATIC = {};
function loadFile(file, type, cache) { const buf = fs.readFileSync(path.join(__dirname, 'public', file)); return { type, buf, gz: zlib.gzipSync(buf, { level: 9 }), br: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }), etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"', cache }; }
const HTML = 'text/html; charset=utf-8', JS = 'text/javascript; charset=utf-8';
const GAME = loadFile('index.html', HTML, 'no-cache'), LANDING = loadFile('landing.html', HTML, 'no-cache');
STATIC['/play'] = GAME; STATIC['/terms'] = loadFile('terms.html', HTML, 'no-cache'); STATIC['/privacy'] = loadFile('privacy.html', HTML, 'no-cache'); STATIC['/faq'] = loadFile('faq.html', HTML, 'no-cache');
STATIC['/vendor/d3.min.js'] = loadFile('vendor/d3.min.js', JS, 'public, max-age=604800');
STATIC['/core.js'] = loadFile('core.js', JS, 'no-cache'); STATIC['/scenarios.js'] = loadFile('scenarios.js', JS, 'no-cache');
STATIC['/sw.js'] = loadFile('sw.js', JS, 'no-cache');
STATIC['/landing-land.js'] = loadFile('landing-land.js', JS, 'public, max-age=604800');
STATIC['/prov.js'] = loadFile('prov.js', JS, 'public, max-age=31536000, immutable'); // the URL carries a version number, so browsers keep it until the map changes
STATIC['/og.jpg'] = loadFile('og.jpg', 'image/jpeg', 'public, max-age=604800');
STATIC['/robots.txt'] = { type: 'text/plain; charset=utf-8', buf: Buffer.from('User-agent: *\nAllow: /$\nAllow: /faq\nAllow: /n/\nAllow: /terms\nAllow: /privacy\nDisallow: /\n'), cache: 'public, max-age=86400' };
Object.assign(STATIC['/robots.txt'], { gz: zlib.gzipSync(STATIC['/robots.txt'].buf), br: zlib.brotliCompressSync(STATIC['/robots.txt'].buf), etag: '"robots2"' });
const NOTFOUND = loadFile('404.html', HTML, 'no-cache');
STATIC['/manifest.webmanifest'] = loadFile('manifest.webmanifest', 'application/manifest+json', 'no-cache');
STATIC['/icon.svg'] = loadFile('icon.svg', 'image/svg+xml', 'public, max-age=604800');
const ADMIN_HTML = { ...loadFile('admin.html', HTML, 'no-store') };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function secHeaders(req) {
  const h = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}
function serveStatic(req, res, f) {
  const h = { ...secHeaders(req), 'Content-Type': f.type, 'Cache-Control': f.cache, ETag: f.etag, Vary: 'Accept-Encoding, Cookie' };
  if (f.type.startsWith('text/html')) h['Content-Security-Policy'] = CSP;
  if (f === STATIC['/sw.js']) h['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  const ae = req.headers['accept-encoding'] || '';
  if (/\bbr\b/.test(ae)) { res.writeHead(200, { ...h, 'Content-Encoding': 'br' }); return res.end(f.br); }
  if (/\bgzip\b/.test(ae)) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(f.gz); }
  res.writeHead(200, h); res.end(f.buf);
}
// public nation pages: worldpowersgame.com/n/zeiro-kingdom
const slugify = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const escH = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function nationPage(req, res, slug) {
  slug = String(slug || '').toLowerCase().replace(/\/$/, ''); if (!/^[a-z0-9-]{1,60}$/.test(slug)) return notFound(req, res);
  const W = mkWorld(); const id = Object.keys(W.A).find(u => slugify(W.A[u].name) === slug); if (!id) return notFound(req, res);
  const n = W.A[id], ids = Object.keys(W.A).sort((a, b) => core.score(W, b) - core.score(W, a)), place = ids.indexOf(id) + 1;
  const leader = n.ai ? 'AI nation' : (S.users[id] || {}).name || '—', rank = core.rankName(n), gov = (WP.GOV[n.gov] || {}).n || '';
  const allies = core.allies(W, id).map(v => W.A[v].name), wars = core.wars(W, id).map(v => W.A[v].name);
  const news = (n.out || []).filter(e => e.type === 'news').slice(0, 8);
  const desc = `${n.name} — #${place} of ${ids.length} nations in World Powers. ${rank}, ${gov}, ${core.hexesOf(W, id).length} provinces, GDP ${WP.moneyS(n.gdp || 0)}. Led by ${leader}.`;
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(n.name)} — World Powers</title><link rel="icon" href="/icon.svg">
<meta name="description" content="${escH(desc)}"><meta property="og:type" content="website"><meta property="og:title" content="${escH(n.name)} — World Powers"><meta property="og:description" content="${escH(desc)}"><meta property="og:image" content="https://worldpowersgame.com/og.jpg"><meta name="twitter:card" content="summary_large_image">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>body{margin:0;background:#06090d;color:#e6edf3;font:16px/1.6 Inter,system-ui,sans-serif}.w{max-width:820px;margin:0 auto;padding:28px 20px 70px}a{color:#d4a64a}.top{display:flex;justify-content:space-between;align-items:center}.logo{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.22em;font-size:14px;color:#e6edf3;text-decoration:none}.logo i{width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#4c7ca5,#0d2236 70%)}.play{background:#d4a64a;color:#111;padding:9px 18px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px}
.hero{margin:34px 0 20px;display:flex;align-items:center;gap:16px}.flag{width:54px;height:54px;border-radius:12px;flex:none}h1{margin:0;font-size:34px;line-height:1.1}.sub{color:#8b98a5}.tag{font-size:11px;border:1px solid #2a3542;border-radius:4px;padding:1px 6px;margin-left:8px;color:#8b98a5;vertical-align:middle}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin:18px 0}.grid div{background:#0c1218;border:1px solid #1e2833;border-radius:10px;padding:12px}.grid span{display:block;color:#8b98a5;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.grid b{font-size:18px}
h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#d4a64a;margin:30px 0 8px}ul{padding-left:18px;color:#c5ced8}.cta{margin-top:36px;padding:22px;border:1px solid #2a3542;border-radius:12px;text-align:center;background:#0c1218}</style></head>
<body><div class="w"><div class="top"><a class="logo" href="/"><i></i>WORLD POWERS</a><a class="play" href="/play">Play free</a></div>
<div class="hero"><div class="flag" style="background:${escH(n.color)}"></div><div><h1>${escH(n.name)}${n.ai ? '<span class="tag">AI</span>' : ''}${n.nuke ? '<span class="tag">☢ Nuclear power</span>' : ''}</h1><div class="sub">${escH(rank)} · ${escH(gov)} · led by ${escH(leader)} · #${place} in the world</div></div></div>
<div class="grid">${row('Provinces', core.hexesOf(W, id).length)}${row('GDP', WP.moneyS(n.gdp || 0))}${row('Population', WP.num(Math.round(n.pop)))}${row('Army', WP.num(n.troops || 0))}${row('Navy / Air', `${n.ships || 0} / ${n.air || 0}`)}${row('Tech level', n.tech || 0)}${row('Approval', Math.round(n.approval) + '%')}${row('Founded', new Date(n.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</div>
${allies.length ? `<h2>Allies</h2><p>${allies.map(escH).join(', ')}</p>` : ''}${wars.length ? `<h2>At war with</h2><p>${wars.map(escH).join(', ')}</p>` : ''}
${news.length ? `<h2>Recent history</h2><ul>${news.map(e => `<li>${escH(e.x)}</li>`).join('')}</ul>` : ''}
<div class="cta"><b style="font-size:20px">Build your own nation</b><p class="sub" style="margin:6px 0 16px">A free real-time strategy game played with everyone at once.</p><a class="play" href="/play#signup">Found your nation — free</a></div></div></body></html>`;
  const buf = Buffer.from(html); res.writeHead(200, { ...secHeaders(req), 'Content-Type': HTML, 'Content-Security-Policy': CSP, 'Cache-Control': 'public, max-age=60' }); res.end(buf);
}
function notFound(req, res) { const h = { ...secHeaders(req), 'Content-Type': HTML, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' }; if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(404, { ...h, 'Content-Encoding': 'gzip' }); return res.end(NOTFOUND.gz); } res.writeHead(404, h); res.end(NOTFOUND.buf); }

// ---------- helpers ----------
function send(res, code, obj, headers = {}) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(JSON.stringify(obj)); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    let big = false;
    req.on('data', c => { size += c.length; if (size > limit) { big = true; chunks.length = 0; if (size > limit * 16) req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (big) return reject(Object.assign(new Error('That is too long.'), { status: 413 })); try { const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; resolve(v); } catch (e) { reject(Object.assign(new Error('Bad request.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function cookies(req) { const out = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) {} } } return out; }
const isHttps = req => req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const sessionCookie = (req, token, maxAge) => `wp_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
function sameOrigin(req) { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } }
function auth(req) {
  const t = cookies(req).wp_s; if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
  const k = tokHash(t); let s = S.sessions[k];
  if (!s && S.sessions[t]) { s = S.sessions[t]; delete S.sessions[t]; S.sessions[k] = s; persist(); } // upgrade a session created before tokens were hashed
  if (!s) return null;
  if (s.exp < Date.now()) { delete S.sessions[k]; persist(); return null; }
  const u = S.users[s.uid]; if (!u || u.banned) return null;
  return { id: s.uid, ...u, token: t };
}
function newSession(uid) { for (const [t, s] of Object.entries(S.sessions)) if (s.exp < Date.now()) delete S.sessions[t]; const token = crypto.randomBytes(32).toString('hex'); S.sessions[tokHash(token)] = { uid, exp: Date.now() + SESSION_DAYS * 864e5 }; persist(); return token; }
const pub = u => ({ id: u.id, name: u.name, email: u.email, guest: !!u.guest, admin: !!u.admin, ...(u.admin ? { adminPath: S.adminPath } : {}) });
function meta(uid) { return S.meta[uid] || (S.meta[uid] = { ips: [], lastSeen: 0 }); }
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function stat(key, uid) { const d = S.stats[today()] || (S.stats[today()] = { active: [], signups: 0, cmds: 0, chat: 0, mail: 0, nations: 0 }); if (key === 'active') { if (!d.active.includes(uid)) d.active.push(uid); } else d[key] = (d[key] || 0) + 1; }
function touch(uid, req) { const m = meta(uid); if (m.lastSeen && Date.now() - m.lastSeen > 30 * 60e3) m.prevSeen = m.lastSeen; m.lastSeen = Date.now(); stat('active', uid); const ip = req && ipOf(req); if (ip && !m.ips.includes(ip)) { m.ips.unshift(ip); m.ips = m.ips.slice(0, 8); persist(); } }
function audit(by, action, target, detail) { S.audit.unshift({ t: Date.now(), by, action, target: target || null, detail: detail || null }); S.audit = S.audit.slice(0, 500); persist(); }
const buckets = new Map();
function limited(key, max, windowMs) { const now = Date.now(); let b = buckets.get(key); if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); } return ++b.n > max; }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); const cut = Math.floor(now / 60000) - 60; for (const k of health.reqs.keys()) if (k < cut) health.reqs.delete(k); }, 60000).unref();
function flag(uid, r) { if (S.flags.some(f => f.uid === uid && f.r === r && Date.now() - f.t < 10 * 60e3)) return; S.flags.unshift({ t: Date.now(), uid, r }); S.flags = S.flags.slice(0, 2000); persist(); }
const sharesNetwork = (a, b) => { const A = (S.meta[a] || {}).ips || [], B = (S.meta[b] || {}).ips || []; return A.some(ip => B.includes(ip)); };
const isMuted = uid => (S.users[uid] && S.users[uid].mutedUntil || 0) > Date.now();
const nationName = uid => (S.docs['nations/' + uid] || {}).name || (S.users[uid] || {}).name || 'Unknown';

// ---------- what other players may see ----------
function publicView(n) {
  return { name: n.name, color: n.color, gov: n.gov, created: n.created, cap: n.cap, hexes: n.hexes, xp: n.xp, pop: n.pop, troops: n.troops, ships: n.ships, air: n.air, tech: n.tech, train: n.train, infra: n.infra, fort: n.fort,
    approval: n.approval, stability: n.stability, aggr: n.aggr, regroup: n.regroup, lastStand: n.lastStand || 0, gens: (n.gens || []).map(g => ({ name: g.name, type: g.type, stars: g.stars })), nuke: n.nuke || 0, warhead: n.warhead ? (n.warhead.ready <= Date.now() ? 2 : 1) : 0, nuked: n.nuked || null, fallout: n.fallout || 0, winter: n.winter || 0, rogue: n.rogue || 0, conqN: Object.keys(n.conq || {}).length, rel: n.rel, trades: n.trades, res: { oil: n.res && n.res.oil > 0 ? 1 : 0 }, ai: n.ai ? { p: n.ai.p } : undefined,
    gdp: n.gdp, gdpHist: n.gdpHist, debt: n.debt, unemp: n.unemp, infl: n.infl, morale: n.morale, defaulted: n.defaulted, embargo: n.embargo, nextElection: n.nextElection, lastElection: n.lastElection,
    out: (n.out || []).filter(e => e.type === 'news' || e.type === 'battle').slice(0, 30).map(e => e.type === 'battle' ? { id: e.id, t: e.t, type: e.type, to: e.to, h: e.h, X: e.X, win: e.win, lossA: e.lossA, lossD: e.lossD, sea: e.sea } : e) };
}

// ---------- live stream ----------
const clients = new Set();
function write(c, event, data) { if (c.res.writableEnded || c.res.destroyed) { clients.delete(c); return; } try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} }
function writeRaw(c, str) { if (c.res.writableEnded || c.res.destroyed) { clients.delete(c); return; } try { c.res.write(str); } catch (e) {} }
function broadcast(event, data) { if (!clients.size) return; const str = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) writeRaw(c, str); }
function sendTo(uid, event, data) { for (const c of clients) if (c.uid === uid) write(c, event, data); }
const isOnline = uid => [...clients].some(c => c.uid === uid);
// serialize once per nation (one copy for its owner, one public copy for everyone else) instead of once per connected player
function sendNation(id) {
  if (!clients.size) return; const n = S.docs['nations/' + id];
  const pub = `event: doc\ndata: ${JSON.stringify({ col: 'nations', id, data: n == null ? null : publicView(n) })}\n\n`;
  let own = null; for (const c of clients) { if (c.uid === id && n != null) { own = own || `event: doc\ndata: ${JSON.stringify({ col: 'nations', id, data: n })}\n\n`; writeRaw(c, own); } else writeRaw(c, pub); }
}
function setDoc(col, id, data) { const key = col + '/' + id; if (data == null) delete S.docs[key]; else S.docs[key] = data; persist(); if (col === 'nations') sendNation(id); else broadcast('doc', { col, id, data: data == null ? null : data }); }
const councilView = () => ({ props: S.council.props.slice(0, 40), active: S.council.active });
function snapshot(uid) {
  const cols = {}; for (const c of COLS) cols[c] = {};
  for (const [p, d] of Object.entries(S.docs)) { const [c, id] = p.split('/'); if (!cols[c]) continue; cols[c][id] = c === 'nations' && id !== uid ? publicView(d) : d; }
  const users = {}; for (const [id, u] of Object.entries(S.users)) if (!u.banned) users[id] = u.name;
  return { cols, users, config: effCfg(), awaySince: meta(uid).prevSeen || 0, council: councilView(), event: S.event, notes: (S.notes[uid] || []).slice(0, 60), mailUnread: (S.mail[uid] || []).filter(m => m.box === 'in' && !m.read).length, prefs: prefsOf(uid), muted: meta(uid).muted || [], vapid: PUSH.vapidPublic(S.vapid), pushOn: (S.push[uid] || []).length > 0, fallen: S.docs['nations/' + uid] ? null : (meta(uid).fallen || null), fallenList: S.fallen.slice(0, 30) };
}
setInterval(() => { for (const c of clients) writeRaw(c, ': ping\n\n'); }, 25000).unref();
function systemMessage(text) { const doc = S.docs['chat/_system'] || { m: [] }; doc.m = [{ t: Date.now(), x: String(text).slice(0, 300) }, ...(doc.m || [])].slice(0, 40); setDoc('chat', '_system', doc); }

// ---------- notifications (in-game bell + phone/desktop push) ----------
const prefsOf = uid => ({ ...DEFAULT_PREFS, ...(meta(uid).prefs || {}) });
function addNote(uid, kind, text, url) {
  if (!S.users[uid]) return; // AI nations have no inbox
  const n = { id: rid(), t: Date.now(), kind, text: String(text).slice(0, 300), read: false };
  S.notes[uid] = [n, ...(S.notes[uid] || [])].slice(0, 100); persist();
  sendTo(uid, 'note', n);
  if (prefsOf(uid)[kind] !== false && !isOnline(uid)) pushTo(uid, { title: 'World Powers', body: n.text, url: url || '/play', tag: kind });
}
async function pushTo(uid, data) {
  const subs = S.push[uid] || []; if (!subs.length) return;
  for (const sub of subs.slice()) { const code = await PUSH.send(S.vapid, sub, data, 'mailto:admin@world-powers.game'); health.pushes++; if (code === 404 || code === 410) { S.push[uid] = (S.push[uid] || []).filter(s => s.endpoint !== sub.endpoint); persist(); } }
}

// ---------- the game world ----------
function nationsMap() { const A = {}; for (const [k, d] of Object.entries(S.docs)) if (k.startsWith('nations/')) A[k.slice(8)] = core.normalize(d); return A; }
// game settings as they apply right now, including any scheduled boost (double XP, double income, faster timers)
const BOOSTS = { xp2: 'Double XP', income2: 'Double income', cd50: 'Operations twice as fast' };
function effCfg() {
  const c = { ...S.config }, now = Date.now(); const on = S.schedule.filter(x => BOOSTS[x.type] && x.start <= now && now < x.end);
  for (const x of on) { if (x.type === 'xp2') c.xp *= 2; if (x.type === 'income2') c.income *= 2; if (x.type === 'cd50') c.cd *= .5; }
  if (on.length) c.boost = { label: on.map(x => x.label || BOOSTS[x.type]).join(' + '), end: Math.min(...on.map(x => x.end)) };
  return c;
}
const mkWorld = () => core.world(nationsMap(), effCfg(), Date.now(), S.event, S.council);
function commit(W) {
  for (const f of W.fallen || []) {
    delete S.docs['nations/' + f.id];
    const rec = { t: f.t, id: f.id, name: f.name, color: f.color, by: f.by, byName: f.byName, days: Math.round(f.days * 10) / 10, rank: f.peakRank, leader: BOTS.isBot(f.id) ? null : (S.users[f.id] || {}).name || null, ai: BOTS.isBot(f.id) };
    S.fallen.unshift(rec); S.fallen = S.fallen.slice(0, 100);
    if (!BOTS.isBot(f.id)) { meta(f.id).fallen = rec; sendTo(f.id, 'fallen', rec); addNote(f.id, 'attack', `${f.name} has fallen. ${f.byName} captured your capital. You can found a new nation at any time.`); }
    sendNation(f.id);
    broadcast('announce', { text: `${f.name} has fallen to ${f.byName}.` }); broadcast('fallenlist', S.fallen.slice(0, 30));
  }
  for (const u of W.changed) { if (W.A[u]) S.docs['nations/' + u] = W.A[u]; sendNation(u); }
  if (W.changed.size) persist();
  for (const nt of W.notes) addNote(nt.u, nt.kind, nt.text);
  for (const fx of W.nukeFx || []) { const t = `☢ NUCLEAR DETONATION: ${fx.byName} ${fx.retaliation ? 'retaliated against' : 'struck'} ${fx.toName} at ${fx.place}. Fallout is spreading.`; systemMessage(t); broadcast('nuke', fx); }
  if (W.welcome) { systemMessage(W.welcome); broadcast('announce', { text: W.welcome }); }
}
const humans = W => Object.keys(W.A).filter(u => !BOTS.isBot(u));

// AI nations: keep the configured number, retiring the weakest as real players join.
function botTarget(W) { const real = humans(W).length; const want = Math.max(0, Math.min(30, +S.config.bots || 0)); return S.config.botRetire ? Math.max(0, want - Math.floor(real / 3)) : want; }
function removeBot(W, u, why) { const n = W.A[u]; if (!n) return; delete W.A[u]; W.changed.delete(u); for (const v of Object.keys(W.A)) if (W.A[v].rel && W.A[v].rel[u]) { delete W.A[v].rel[u]; W.changed.add(v); } setDoc('nations', u, null); W.OWN = core.computeOwn(W.A); if (why) systemMessage(`${n.name} (AI) has withdrawn from the world${why === 'retire' ? ' to make room for new leaders' : ''}.`); }
function manageBots(W) {
  const bots = Object.keys(W.A).filter(BOTS.isBot); const target = botTarget(W);
  if (bots.length < target) for (let i = 0; i < target - bots.length; i++) BOTS.spawn(W);
  else if (bots.length > target) { const weakest = bots.sort((a, b) => core.score(W, a) - core.score(W, b))[0]; removeBot(W, weakest, 'retire'); }
}

// ---------- world events ----------
function startEvent(key, W) {
  const e = WP.EVENTS[key]; if (!e) return false;
  const now = Date.now(); S.event = { key, start: now, end: now + e.h * HOUR }; S.lastEventKey = key;
  W = W || mkWorld(); W.ev = S.event; W.m = core.mods(S.event, S.council, now); core.startEvent(W, key); commit(W);
  systemMessage(`WORLD EVENT — ${e.n}: ${e.d}`); broadcast('event', S.event); broadcast('announce', { text: `World event: ${e.n}` });
  for (const u of Object.keys(S.users)) addNote(u, 'event', `World event: ${e.n}. ${e.d}`);
  persist(); return true;
}
function endEvent(silent) { if (!S.event) return; const e = WP.EVENTS[S.event.key]; S.event = null; S.nextEvent = Date.now() + (10 + rng() * 8) * HOUR; broadcast('event', null); if (!silent && e) systemMessage(`The ${e.n} has ended.`); persist(); }

// ---------- World Council ----------
const RES_KEYS = Object.keys(WP.RESOLUTIONS);
function councilPropose(uid, b) {
  const W = mkWorld(), n = W.A[uid]; if (!n) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const type = String(b.type || ''); if (!RES_KEYS.includes(type)) throw Object.assign(new Error('Unknown resolution.'), { status: 400 });
  if (core.rankOf(n.xp) < 2) throw Object.assign(new Error('You must be at least a Mayor to propose resolutions.'), { status: 400 });
  const R = WP.RESOLUTIONS[type]; let target = null;
  if (R.target) { target = String(b.target || ''); if (!W.A[target] || target === uid) throw Object.assign(new Error('Choose another nation as the target.'), { status: 400 }); }
  const open = S.council.props.filter(p => p.status === 'open');
  if (open.some(p => p.by === uid)) throw Object.assign(new Error('You already have a resolution under vote.'), { status: 400 });
  if (open.length >= 4) throw Object.assign(new Error('The Council agenda is full. Try again after a vote closes.'), { status: 400 });
  if (open.some(p => p.type === type && p.target === target)) throw Object.assign(new Error('That resolution is already being voted on.'), { status: 400 });
  if (n.cash < 1e5) throw Object.assign(new Error('Submitting a resolution costs $100,000.'), { status: 400 });
  n.cash -= 1e5; W.changed.add(uid); commit(W);
  const p = { id: rid(), by: uid, type, target, t: Date.now(), end: Date.now() + 6 * HOUR, votes: { [uid]: 'y' }, status: 'open' };
  S.council.props.unshift(p); S.council.props = S.council.props.slice(0, 60); persist(); broadcast('council', councilView());
  const txt = `${n.name} proposes to the World Council: ${R.n}${target ? ' against ' + W.A[target].name : ''}.`;
  systemMessage(txt); for (const u of Object.keys(S.users)) if (u !== uid) addNote(u, 'council', txt + ' Voting closes in 6 hours.');
  return p;
}
function councilVote(uid, b) {
  if (!S.docs['nations/' + uid]) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const p = S.council.props.find(x => x.id === b.id && x.status === 'open'); if (!p) throw Object.assign(new Error('That vote has closed.'), { status: 400 });
  if (!['y', 'n'].includes(b.vote)) throw Object.assign(new Error('Vote yes or no.'), { status: 400 });
  p.votes[uid] = b.vote; persist(); broadcast('council', councilView()); return p;
}
function councilResolve(W) {
  const now = Date.now(); let changed = false;
  for (const p of S.council.props) {
    if (p.status !== 'open' || now < p.end) continue;
    const ys = Object.values(p.votes).filter(v => v === 'y').length, ns = Object.values(p.votes).filter(v => v === 'n').length;
    const R = WP.RESOLUTIONS[p.type], tn = p.target && W.A[p.target];
    if (p.target && !tn) { p.status = 'failed'; changed = true; continue; }
    p.status = ys > ns && ys >= 3 ? 'passed' : 'failed'; p.result = `${ys}–${ns}`; changed = true;
    const label = R.n + (tn ? ' against ' + tn.name : '');
    if (p.status === 'passed') {
      if (p.type === 'sanction') { tn.aggr = Math.max(tn.aggr || 0, 80); W.changed.add(p.target); }
      else if (p.type === 'embargo') { tn.embargo = now + 24 * HOUR; W.changed.add(p.target); }
      else if (p.type === 'condemn') { tn.approval = Math.max(0, tn.approval - 8); tn.stability = Math.max(0, tn.stability - 5); W.changed.add(p.target); }
      else S.council.active[p.type] = now + 24 * HOUR;
      systemMessage(`World Council resolution PASSED (${p.result}): ${label}.`);
      if (p.target) addNote(p.target, 'council', `The World Council passed a resolution against you: ${R.n}.`);
    } else systemMessage(`World Council resolution failed (${p.result}): ${label}.`);
    if (S.users[p.by]) addNote(p.by, 'council', `Your resolution "${label}" ${p.status} (${p.result}).`);
  }
  for (const [k, until] of Object.entries(S.council.active)) if (until < now) { delete S.council.active[k]; changed = true; }
  if (changed) { persist(); broadcast('council', councilView()); }
}
// AI nations cast votes according to their personality and relations
function botVotes(W) {
  for (const p of S.council.props) {
    if (p.status !== 'open') continue;
    for (const u of Object.keys(W.A)) {
      if (!BOTS.isBot(u) || p.votes[u] || rng() > .15) continue;
      const me = W.A[u], per = (me.ai || {}).p; let yes = .5;
      if (p.target) { const t = W.A[p.target]; if (!t) continue; if (p.target === u) yes = 0; else { if (core.atWar(W, u, p.target)) yes = .95; else if (core.pact(W, u, p.target, 'ally')) yes = .05; else if (core.pact(W, u, p.target, 'trade')) yes = .25; yes = Math.max(yes, Math.min(.9, (t.aggr || 0) / 70)); } }
      else yes = { climate: { isolationist: .8, merchant: .6, warlord: .3, expansionist: .4 }, arms: { isolationist: .8, merchant: .6, warlord: .1, expansionist: .3 }, freetrade: { merchant: .95, expansionist: .6, warlord: .4, isolationist: .3 }, peacekeeping: { isolationist: .85, merchant: .7, warlord: .1, expansionist: .3 } }[p.type][per] || .5;
      p.votes[u] = rng() < yes ? 'y' : 'n';
    }
  }
}

// ---------- passive simulation, events, council, reminders, backups. Runs every 30 seconds. ----------
// AI nations show in the online list while they are awake (they sleep about 9 hours a day, like people do)
function botPresence(W) {
  const now = Date.now(), hour = new Date(now).getUTCHours();
  for (const [u, n] of Object.entries(W.A)) {
    if (!BOTS.isBot(u) || !n.ai) continue;
    const awake = (hour - (n.ai.sleep != null ? n.ai.sleep : 0) + 24) % 24 >= 9;
    const cur = S.docs['online/' + u];
    if (awake && (!cur || now - (cur.t || 0) > 150e3)) setDoc('online', u, { t: now, ai: 1 });
  }
}
function worldLoop() {
  try {
    const W = mkWorld(); const now = Date.now();
    for (const u of Object.keys(W.A)) { const active = BOTS.isBot(u) || now - ((S.meta[u] || {}).lastSeen || 0) < ACTIVE_WINDOW; core.tick(W, u, active, rng); }
    manageBots(W);
    for (const u of Object.keys(W.A)) if (BOTS.isBot(u)) { try { BOTS.turn(W, u, W.cfg); } catch (e) { logErr('AI nation error: ' + (e.stack || e)); } }
    botVotes(W); councilResolve(W);
    W.welcome = null; commit(W);
    // world events
    if (S.event && now >= S.event.end) endEvent();
    if (!S.event && S.config.eventsOn && now >= S.nextEvent && Object.keys(W.A).length >= 2) { const keys = Object.keys(WP.EVENTS).filter(k => k !== S.lastEventKey); startEvent(keys[Math.floor(rng() * keys.length)]); }
    readyReminders(W); smartReminders(W); runSchedule();
    nightlyBackup(); if (now - lastSnap >= 10 * 60e3) takeSnap();
  } catch (e) { logErr('World update failed: ' + (e.stack || e)); }
}
setInterval(worldLoop, 30000).unref(); setTimeout(worldLoop, 1000);
// remind players by push when their main operations are ready (at most once an hour, only if they were active today)
// scheduled events: announce on start and end, start world events on time
function runSchedule() {
  const now = Date.now(); let changed = false;
  for (const x of S.schedule) {
    if (!x.started && now >= x.start && now < x.end) { x.started = true; changed = true;
      if (x.type.startsWith('event:')) { const k = x.type.slice(6); if (WP.EVENTS[k]) { if (S.event) endEvent(true); startEvent(k); } }
      else { const t = `${x.label || BOOSTS[x.type]} has begun! It runs until ${new Date(x.end).toUTCString().slice(0, 22)} UTC.`; systemMessage(t); broadcast('announce', { text: t }); for (const id of Object.keys(S.users)) addNote(id, 'event', t); } }
    if (x.started && !x.ended && now >= x.end) { x.ended = true; changed = true; if (BOOSTS[x.type]) { const t = `${x.label || BOOSTS[x.type]} has ended. Thanks for playing!`; systemMessage(t); broadcast('announce', { text: t }); } }
  }
  if (changed) { S.schedule = S.schedule.filter(x => !x.ended || now - x.end < 7 * 864e5); persist(); broadcast('config', effCfg()); }
}
// reminders that matter: forces mobilized, army regrouped, election coming up
function smartReminders(W) {
  const now = Date.now();
  for (const u of Object.keys(W.A)) {
    if (BOTS.isBot(u) || !S.users[u]) continue; const n = W.A[u], m = meta(u); m.rem = m.rem || {};
    if (n.gov === 'dem' && n.nextElection && n.nextElection > now && n.nextElection - now < 2 * HOUR && m.rem.elec !== n.nextElection) {
      m.rem.elec = n.nextElection; const proj = Math.round(Math.max(3, Math.min(97, n.approval * .75 + 12 - n.unemp * .7 - Math.max(0, n.infl - 3) + (n.campaign || 0))));
      addNote(u, 'election', `Election in under 2 hours — projected vote ${proj}%.${proj < 50 ? ' Campaign now from Operations!' : ''}`);
    }
    for (const v of core.wars(W, u)) { const r = core.R(W, u, v); if (!r.war) continue; const ws = core.warSince(W, u, v), key = v + ':' + ws;
      if (now - ws >= W.m.mobilize * 60e3 && now - ws < 6 * HOUR && !m.rem[key]) { m.rem[key] = 1; addNote(u, 'war', `Your forces are mobilized against ${W.A[v].name}. Open the war planner to attack.`); } }
    if (n.regroup && n.regroup < now && now - n.regroup < 30 * 60e3 && m.rem.rg !== n.regroup) { m.rem.rg = n.regroup; addNote(u, 'ready', 'Your army has regrouped and is ready for action.'); }
    const keys = Object.keys(m.rem); if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete m.rem[k];
  }
}
function readyReminders(W) {
  const now = Date.now();
  for (const u of Object.keys(S.push)) {
    const n = W.A[u], m = S.meta[u]; if (!n || !m || !(S.push[u] || []).length || prefsOf(u).ready === false || isOnline(u)) continue;
    if (now - (m.lastSeen || 0) > 24 * HOUR || now - (m.lastReady || 0) < HOUR || now - (m.lastSeen || 0) < 10 * 60e3) continue;
    const readyOps = WP.ACTS.filter(a => !a.dem && !core.left(W, n, a.k)).length;
    if (readyOps >= 4) { m.lastReady = now; pushTo(u, { title: 'World Powers', body: `${n.name}: taxes and ${readyOps - 1} other operations are ready.`, url: '/play', tag: 'ready' }); }
  }
}
// ---------- rollback snapshots: the game world (nations, council, events) every 10 minutes, kept 26 hours ----------
const SNAP_DIR = path.join(DATA_DIR, 'snaps'); let lastSnap = 0;
function gameState() { const nations = {}; for (const [k, v] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = v; return { t: Date.now(), nations, council: S.council, event: S.event, nextEvent: S.nextEvent, lastEventKey: S.lastEventKey, fallen: S.fallen }; }
function takeSnap(tag) {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true }); const t = Date.now(); lastSnap = t;
    const name = `snap-${t}${tag ? '-' + tag : ''}.json.gz`; fs.writeFileSync(path.join(SNAP_DIR, name), zlib.gzipSync(JSON.stringify(gameState())));
    for (const f of fs.readdirSync(SNAP_DIR)) { const m = f.match(/^snap-(\d+)/); if (m && t - +m[1] > 26 * HOUR) fs.unlinkSync(path.join(SNAP_DIR, f)); }
    return name;
  } catch (e) { logErr('Snapshot failed: ' + e.message); return null; }
}
function listSnaps() { try { return fs.readdirSync(SNAP_DIR).map(f => { const m = f.match(/^snap-(\d+)(?:-([a-z]+))?\.json\.gz$/); return m && { name: f, t: +m[1], tag: m[2] || '', size: fs.statSync(path.join(SNAP_DIR, f)).size }; }).filter(Boolean).sort((a, b) => b.t - a.t); } catch (e) { return []; } }
function rollback(name, by) {
  const snaps = listSnaps(), sn = snaps.find(x => x.name === name); if (!sn) throw Object.assign(new Error('That snapshot no longer exists.'), { status: 404 });
  const st = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, sn.name))));
  takeSnap('undo'); const now = Date.now();
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/')) delete S.docs[k];
  for (const [id, n] of Object.entries(st.nations)) { n.lastTick = now; S.docs['nations/' + id] = n; }
  S.council = st.council || { props: [], active: {} }; S.event = st.event || null; S.nextEvent = st.nextEvent || now + 6 * HOUR; S.lastEventKey = st.lastEventKey; S.fallen = st.fallen || [];
  persist(true); const when = new Date(sn.t).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' });
  systemMessage(`⏪ The world has been rolled back to ${when} (Mountain time) by the administrators.`);
  broadcast('reload', { t: now }); audit(by, 'Rolled back the world', null, `to ${new Date(sn.t).toISOString()} (${Math.round((now - sn.t) / 60000)} min ago)`);
  return sn;
}
function nightlyBackup() {
  const now = new Date(); if (now.getUTCHours() < 9) return; // after ~3 AM US Mountain time
  const day = today(); if (S.lastBackup === day) return;
  try {
    fs.writeFileSync(path.join(BACKUP_DIR, `world-${day}.json`), JSON.stringify(S)); S.lastBackup = day; persist();
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^world-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 7))) fs.unlinkSync(path.join(BACKUP_DIR, f));
    // trim analytics to 60 days
    const keys = Object.keys(S.stats).sort(); for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete S.stats[k];
    for (const [id, u] of Object.entries(S.users)) if (u.guest && Date.now() - ((S.meta[id] || {}).lastSeen || u.created || 0) > 7 * 864e5) wipeUser(id); // guest accounts unused for a week
  } catch (e) { logErr('Nightly backup failed: ' + e.message); }
}

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const NAME_RE = /^[A-Za-z0-9_ .-]{2,20}$/;
function cleanChat(d) { const m = Array.isArray(d.m) ? d.m : []; return { m: m.slice(0, 40).filter(x => x && typeof x.x === 'string' && Number.isFinite(x.t)).map(x => ({ t: Math.min(Math.max(0, x.t), Date.now() + 5000), x: MOD.clean(x.x.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)) })).filter(x => x.x.trim()) }; }

// ---------- mail ----------
function mailSend(me, b) {
  if ((S.users[me.id] || {}).guest) throw Object.assign(new Error('Save your account (Account page) to send mail.'), { status: 403 });
  const to = String(b.to || ''); if (!S.users[to] || to === me.id) throw Object.assign(new Error(BOTS.isBot(to) ? 'This nation is run by the computer and does not read mail.' : 'Choose a leader to write to.'), { status: 400 });
  if (isMuted(me.id)) throw Object.assign(new Error('You are muted by the administrators and cannot send mail right now.'), { status: 403 });
  const subj = MOD.clean(String(b.subj || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)) || 'No subject';
  const body = MOD.clean(String(b.body || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000)); if (!body) throw Object.assign(new Error('Write a message.'), { status: 400 });
  const t = Date.now(), id = rid();
  const msg = { id, from: me.id, to, t, subj, body };
  S.mail[me.id] = [{ ...msg, box: 'out', read: true }, ...(S.mail[me.id] || [])].slice(0, 200);
  const blocked = (meta(to).muted || []).includes(me.id);
  if (!blocked) { S.mail[to] = [{ ...msg, box: 'in', read: false }, ...(S.mail[to] || [])].slice(0, 200); sendTo(to, 'mail', { unread: S.mail[to].filter(m => m.box === 'in' && !m.read).length }); addNote(to, 'mail', `New mail from ${nationName(me.id)}: ${subj}`, '/play#mail'); }
  stat('mail'); persist(); return { ok: true };
}

// Only real browser push services (Chrome/Android, Firefox, Edge/Windows, Safari/iPhone) — never arbitrary servers
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com)\//;
// remove an account and everything tied to it; other nations forget it too
function wipeUser(id) {
  const W = mkWorld(); if (W.A[id]) { delete W.A[id]; for (const [u, n] of Object.entries(W.A)) if (n.rel && n.rel[id]) { delete n.rel[id]; W.changed.add(u); } commit(W); }
  for (const c of COLS) if (S.docs[c + '/' + id]) setDoc(c, id, null);
  for (const [t, s] of Object.entries(S.sessions)) if (s.uid === id) delete S.sessions[t];
  for (const c of clients) if (c.uid === id) { try { c.res.end(); } catch (e) {} }
  for (const k of Object.keys(S.mail)) S.mail[k] = (S.mail[k] || []).filter(m => m.from !== id && m.to !== id);
  delete S.users[id]; delete S.meta[id]; delete S.mail[id]; delete S.notes[id]; delete S.push[id]; broadcast('user', { id, name: null }); persist();
}
// invite rewards: both players gain when an invited friend founds a nation (not for the same network, max 20 per inviter)
function inviteReward(W, id) {
  const u = S.users[id]; if (!u || !u.ref || u.refDone) return; u.refDone = true; const inv = u.ref, im = meta(inv);
  if (sharesNetwork(id, inv)) { flag(id, `Invited by ${(S.users[inv] || {}).name} from the same network — no invite reward given`); return; }
  if ((im.invites || 0) >= 20 || !W.A[id]) return;
  W.A[id].cash += 5e5; addNote(id, 'economy', `Welcome bonus: $500,000 for joining through ${(S.users[inv] || {}).name || 'a friend'}'s invite.`);
  im.invites = (im.invites || 0) + 1;
  if (W.A[inv]) { W.A[inv].cash += 1e6; W.changed.add(inv); addNote(inv, 'economy', `${u.name} joined through your invite and founded ${W.A[id].name}. You received $1,000,000.`); }
}
// ---------- admin ----------
function analytics() {
  const days = []; for (let i = 13; i >= 0; i--) { const d = today(Date.now() - i * 864e5); const s = S.stats[d] || {}; days.push({ d, active: (s.active || []).length, signups: s.signups || 0, cmds: s.cmds || 0, chat: s.chat || 0, mail: s.mail || 0, nations: s.nations || 0 }); }
  // day-1 retention: of the people who signed up on a day, how many came back the next day
  const ret = []; for (let i = 13; i >= 1; i--) { const d = today(Date.now() - i * 864e5), nx = today(Date.now() - (i - 1) * 864e5); const cohort = Object.entries(S.users).filter(([, u]) => u.created && today(u.created) === d).map(([id]) => id); const back = cohort.filter(id => ((S.stats[nx] || {}).active || []).includes(id)).length; ret.push({ d, cohort: cohort.length, back }); }
  const totalC = ret.reduce((a, r) => a + r.cohort, 0), totalB = ret.reduce((a, r) => a + r.back, 0);
  return { days, ret, d1: totalC ? Math.round(totalB / totalC * 100) : null };
}
function backups() { try { return fs.readdirSync(BACKUP_DIR).filter(f => /\.json$/.test(f)).sort().reverse().map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size })); } catch (e) { return []; } }
function overview() {
  const now = Date.now();
  const nations = {}; for (const [k, d] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = d;
  const W = core.world(Object.fromEntries(Object.entries(nations).map(([k, v]) => [k, core.normalize(v)])), effCfg(), now, S.event, S.council);
  const online = Object.entries(S.docs).filter(([k, d]) => k.startsWith('online/') && !d.ai && now - (d.t || 0) < 5 * 60e3).length;
  let reqs5 = 0; const m = Math.floor(now / 60000); for (let i = 0; i < 5; i++) reqs5 += health.reqs.get(m - i) || 0;
  const flagCount = {}; for (const f of S.flags) flagCount[f.uid] = (flagCount[f.uid] || 0) + 1;
  const byIp = {}; for (const [id, mt] of Object.entries(S.meta)) if (S.users[id]) for (const ip of mt.ips || []) (byIp[ip] = byIp[ip] || []).push(id);
  const shared = Object.entries(byIp).filter(([, ids]) => ids.length > 1).map(([ip, ids]) => ({ ip, ids }));
  const players = Object.entries(S.users).map(([id, u]) => {
    const n = nations[id], mt = S.meta[id] || {};
    return { id, name: u.name, email: u.email, guest: !!u.guest, invitedBy: u.ref ? (S.users[u.ref] || {}).name || null : null, admin: !!u.admin, banned: !!u.banned, mutedUntil: u.mutedUntil || 0, created: u.created, lastSeen: mt.lastSeen || 0, ips: mt.ips || [], flags: flagCount[id] || 0, push: (S.push[id] || []).length,
      nation: n ? { name: n.name, color: n.color, gov: n.gov, xp: n.xp, rank: core.rankOf(n.xp), cash: n.cash, pop: n.pop, troops: n.troops, provinces: core.hexesOf(W, id).length, tech: n.tech, approval: n.approval, stability: n.stability, aggr: n.aggr, created: n.created, score: core.score(W, id), gdp: n.gdp, debt: n.debt } : null,
      shared: shared.some(s => s.ids.includes(id)) };
  });
  const bots = Object.entries(nations).filter(([id]) => BOTS.isBot(id)).map(([id, n]) => ({ id, name: n.name, color: n.color, p: (BOTS.PERS[(n.ai || {}).p] || {}).n || '?', rank: core.rankOf(n.xp), provinces: core.hexesOf(W, id).length, troops: n.troops, score: core.score(W, id), wars: core.wars(W, id).map(v => (nations[v] || {}).name) }));
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
  let dataBytes = 0; try { dataBytes = fs.statSync(FILE).size; } catch (e) {}
  return {
    health: { uptime: now - START, memoryMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), dataBytes, lastSave: health.lastSave, saveError: health.saveError, dataDir: DATA_DIR,
      onVolume: volume ? path.resolve(DATA_DIR).startsWith(path.resolve(volume)) : null, volume, streams: clients.size, online, reqs5, cmds: health.cmds, pushes: health.pushes, errors24: health.errors.filter(e => now - e.t < 864e5).length,
      node: process.version, load: os.loadavg()[0], accounts: Object.keys(S.users).length, nations: Object.keys(nations).length, sessions: Object.keys(S.sessions).length, scenarios: SCENARIOS.length, lastBackup: S.lastBackup || null, pushSubs: Object.values(S.push).reduce((a, s) => a + s.length, 0) },
    players, bots, botTarget: botTarget(W), flags: S.flags.slice(0, 300), audit: S.audit.slice(0, 200), errors: health.errors.slice(0, 50), shared, config: S.config,
    analytics: analytics(), reports: S.reports.slice(0, 100), bugs: S.bugs.slice(0, 100), schedule: S.schedule, boosts: BOOSTS, backups: backups(), snaps: listSnaps().map(({ name, t, tag }) => ({ name, t, tag })), event: S.event, nextEvent: S.nextEvent, events: Object.fromEntries(Object.entries(WP.EVENTS).map(([k, e]) => [k, e.n])), council: councilView()
  };
}
const NUM_FIELDS = ['cash', 'pop', 'troops', 'ships', 'air', 'spies', 'xp', 'tech', 'train', 'infra', 'fort', 'tax', 'approval', 'stability', 'aggr', 'debt', 'unemp', 'infl'];
async function adminRoute(p, req, res, me) {
  if (!me.admin) return send(res, 403, { error: 'Admins only.' });
  if (p === '/api/admin/overview' && req.method === 'GET') return send(res, 200, overview());
  if (p === '/api/admin/viewas' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || ''; const u = Object.prototype.hasOwnProperty.call(S.users, id) ? S.users[id] : null; if (!u) return send(res, 404, { error: 'Unknown player.' });
    audit(me.name, 'Viewed the game as', u.name); return send(res, 200, { snap: snapshot(id), me: pub({ id, ...u }) });
  }
  const bi = p.match(/^\/api\/admin\/bug-img\/([a-z0-9]{8,40})$/);
  if (bi && req.method === 'GET') { const f = path.join(BUG_DIR, bi[1] + '.jpg'); if (!fs.existsSync(f)) return send(res, 404, { error: 'Not found.' }); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }); return fs.createReadStream(f).pipe(res); }
  if (p === '/api/admin/backup' && req.method === 'GET') {
    audit(me.name, 'Downloaded a backup');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="world-powers-backup-${today()}.json"`, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(S));
  }
  const bm = p.match(/^\/api\/admin\/backups\/(world-\d{4}-\d{2}-\d{2}\.json|backup-before-wipe-\d+\.json)$/);
  if (bm && req.method === 'GET') {
    const f = path.join(BACKUP_DIR, bm[1]); if (!fs.existsSync(f)) { const g = path.join(DATA_DIR, bm[1]); if (!fs.existsSync(g)) return send(res, 404, { error: 'Not found.' }); }
    audit(me.name, 'Downloaded backup', bm[1]);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${bm[1]}"`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(fs.existsSync(f) ? f : path.join(DATA_DIR, bm[1])).pipe(res);
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found.' });
  const b = await readBody(req, 16 * 1024);
  const u = typeof b.id === 'string' && Object.prototype.hasOwnProperty.call(S.users, b.id) ? S.users[b.id] : null;
  const target = u ? u.name : null;
  switch (p) {
    case '/api/admin/player': {
      if (!u) return send(res, 404, { error: 'Unknown player.' });
      return send(res, 200, { id: b.id, name: u.name, email: u.email, admin: !!u.admin, banned: !!u.banned, mutedUntil: u.mutedUntil || 0, created: u.created, meta: S.meta[b.id] || {}, nation: S.docs['nations/' + b.id] || null, flags: S.flags.filter(f => f.uid === b.id).slice(0, 100), reports: S.reports.filter(r => r.about === b.id).slice(0, 50) });
    }
    case '/api/admin/nation': {
      const n = S.docs['nations/' + b.id]; if (!u || !n) return send(res, 404, { error: 'That player has no nation.' });
      const changes = [], pt = b.patch || {};
      for (const k of NUM_FIELDS) if (pt[k] != null && pt[k] !== '' && isFinite(+pt[k])) { const v = +pt[k]; if (v !== n[k]) { changes.push(`${k}: ${Math.round((n[k] || 0) * 100) / 100} → ${v}`); n[k] = v; } }
      if (pt.res && typeof pt.res === 'object') { n.res = n.res || {}; for (const r of ['food', 'oil', 'steel', 'goods']) if (pt.res[r] != null && pt.res[r] !== '' && isFinite(+pt.res[r])) { const v = +pt.res[r]; if (v !== n.res[r]) { changes.push(`${r}: ${Math.round(n.res[r])} → ${v}`); n.res[r] = v; } } }
      if (typeof pt.name === 'string' && pt.name.trim() && pt.name.trim() !== n.name) { changes.push(`name: ${n.name} → ${pt.name.trim().slice(0, 28)}`); n.name = pt.name.trim().slice(0, 28); }
      n.approval = Math.max(0, Math.min(100, n.approval)); n.stability = Math.max(0, Math.min(100, n.stability)); n.tax = Math.max(5, Math.min(50, Math.round(n.tax)));
      if (b.resetCooldowns) { n.cd = {}; changes.push('cooldowns reset'); }
      setDoc('nations', b.id, n); audit(me.name, 'Edited nation', target, changes.join('; ') || 'no changes');
      return send(res, 200, { ok: true });
    }
    case '/api/admin/reset-nation': { if (!u) return send(res, 404, { error: 'Unknown player.' }); setDoc('nations', b.id, null); audit(me.name, 'Reset nation', target); return send(res, 200, { ok: true }); }
    case '/api/admin/ban': case '/api/admin/unban': {
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      if (p.endsWith('/ban')) {
        u.banned = true; for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
        for (const c of COLS) if (S.docs[c + '/' + b.id]) setDoc(c, b.id, null);
        for (const c of clients) if (c.uid === b.id) c.res.end();
        broadcast('user', { id: b.id, name: null }); audit(me.name, 'Banned player', target);
      } else { u.banned = false; broadcast('user', { id: b.id, name: u.name }); audit(me.name, 'Unbanned player', target); }
      persist(); return send(res, 200, { ok: true });
    }
    case '/api/admin/mute': {
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      const h = Math.max(0, Math.min(24 * 30, +b.hours || 0)); u.mutedUntil = h ? Date.now() + h * HOUR : 0; persist();
      if (h) addNote(b.id, 'economy', `You have been muted in chat and mail for ${h} hour${h === 1 ? '' : 's'} by the administrators.`);
      audit(me.name, h ? `Muted for ${h}h` : 'Unmuted', target); return send(res, 200, { ok: true });
    }
    case '/api/admin/kick': {
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
      for (const c of clients) if (c.uid === b.id) c.res.end(); persist(); audit(me.name, 'Kicked (signed out)', target); return send(res, 200, { ok: true });
    }
    case '/api/admin/clear-user-chat': { if (!u) return send(res, 404, { error: 'Unknown player.' }); setDoc('chat', b.id, null); audit(me.name, 'Deleted chat messages', target); return send(res, 200, { ok: true }); }
    case '/api/admin/bug-done': { const x = S.bugs.find(y => y.id === b.bug); if (x) { x.done = !x.done; persist(); } return send(res, 200, { ok: true }); }
    case '/api/admin/schedule-add': {
      const type = String(b.type || ''); if (!BOOSTS[type] && !(type.startsWith('event:') && WP.EVENTS[type.slice(6)])) return send(res, 400, { error: 'Choose what to schedule.' });
      const start = +b.start, hours = +b.hours; if (!isFinite(start) || start < Date.now() - 60e3 || start > Date.now() + 60 * 864e5) return send(res, 400, { error: 'Choose a start time within the next 60 days.' });
      if (!(hours >= .5 && hours <= 168)) return send(res, 400, { error: 'Length must be between 30 minutes and 7 days.' });
      const x = { id: rid(), type, start, end: start + hours * HOUR, label: String(b.label || '').trim().slice(0, 60) || (BOOSTS[type] || WP.EVENTS[type.slice(6)].n) };
      S.schedule.push(x); persist(); audit(me.name, 'Scheduled', x.label, new Date(start).toUTCString()); runSchedule(); return send(res, 200, { ok: true });
    }
    case '/api/admin/schedule-cancel': { const x = S.schedule.find(y => y.id === b.id); if (x) { if (x.started && !x.ended) x.end = Date.now(); else S.schedule = S.schedule.filter(y => y !== x); persist(); runSchedule(); broadcast('config', effCfg()); audit(me.name, 'Cancelled scheduled event', x.label); } return send(res, 200, { ok: true }); }
    case '/api/admin/report-done': { const r = S.reports.find(x => x.id === b.report); if (r) { r.done = true; persist(); } return send(res, 200, { ok: true }); }
    case '/api/admin/password': {
      if (!u) return send(res, 404, { error: 'Unknown player.' });
      if (String(b.password || '').length < 8) return send(res, 400, { error: 'Password must be 8+ characters.' });
      Object.assign(u, hashPw(String(b.password))); for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
      audit(me.name, 'Reset password', target); return send(res, 200, { ok: true });
    }
    case '/api/admin/delete-account': {
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      const email = u.email; wipeUser(b.id);
      audit(me.name, 'Deleted account', target + ' (' + email + ')'); return send(res, 200, { ok: true });
    }
    case '/api/admin/clear-flags': { S.flags = u ? S.flags.filter(f => f.uid !== b.id) : []; audit(me.name, 'Cleared cheat flags', target || 'everyone'); return send(res, 200, { ok: true }); }
    case '/api/admin/config': {
      const c = b.config || {}, nc = { ...S.config };
      for (const k of ['cd', 'income', 'xp']) if (c[k] != null && isFinite(+c[k])) nc[k] = Math.max(0.1, Math.min(10, +c[k]));
      if (c.protectH != null && isFinite(+c.protectH)) nc.protectH = Math.max(0, Math.min(720, +c.protectH));
      if (c.electionH != null && isFinite(+c.electionH)) nc.electionH = Math.max(6, Math.min(720, +c.electionH));
      for (const k of ['war', 'signups', 'botRetire', 'eventsOn', 'conquest', 'weakRule']) if (c[k] != null) nc[k] = !!c[k];
      if (c.lastStandH != null && isFinite(+c.lastStandH)) nc.lastStandH = Math.max(0, Math.min(168, +c.lastStandH));
      if (c.motd != null) nc.motd = String(c.motd).slice(0, 300);
      if (c.bots != null && isFinite(+c.bots)) nc.bots = Math.max(0, Math.min(30, Math.round(+c.bots)));
      if (['yes', 'retaliate', 'no'].includes(c.botWar)) nc.botWar = c.botWar;
      const diff = Object.keys(nc).filter(k => nc[k] !== S.config[k]).map(k => `${k}: ${S.config[k]} → ${nc[k]}`).join('; ');
      S.config = nc; persist(); broadcast('config', effCfg()); audit(me.name, 'Changed game settings', null, diff || 'no changes');
      return send(res, 200, { ok: true, config: nc });
    }
    case '/api/admin/announce': { const t = String(b.text || '').trim(); if (!t) return send(res, 400, { error: 'Type a message.' }); systemMessage(t); broadcast('announce', { text: t }); for (const id of Object.keys(S.users)) addNote(id, 'event', 'Announcement: ' + t.slice(0, 200)); audit(me.name, 'Announcement', null, t); return send(res, 200, { ok: true }); }
    case '/api/admin/clear-chat': { for (const k of Object.keys(S.docs)) if (k.startsWith('chat/')) setDoc('chat', k.slice(5), null); audit(me.name, 'Cleared chat'); return send(res, 200, { ok: true }); }
    case '/api/admin/event-start': { const k = String(b.key || ''); if (!WP.EVENTS[k]) return send(res, 400, { error: 'Unknown event.' }); if (S.event) endEvent(true); startEvent(k); audit(me.name, 'Started world event', WP.EVENTS[k].n); return send(res, 200, { ok: true }); }
    case '/api/admin/event-end': { if (S.event) { const n = WP.EVENTS[S.event.key].n; endEvent(); audit(me.name, 'Ended world event', n); } return send(res, 200, { ok: true }); }
    case '/api/admin/council-cancel': { const pr = S.council.props.find(x => x.id === b.prop && x.status === 'open'); if (pr) { pr.status = 'cancelled'; persist(); broadcast('council', councilView()); audit(me.name, 'Cancelled council vote', WP.RESOLUTIONS[pr.type].n); } return send(res, 200, { ok: true }); }
    case '/api/admin/rollback': {
      if (b.confirm !== 'ROLLBACK') return send(res, 400, { error: 'Type ROLLBACK to confirm.' });
      let name = String(b.snap || ''); const snaps = listSnaps();
      if (!name && b.minutes) { const target = Date.now() - Math.max(1, +b.minutes) * 60e3; const sn = snaps.find(x => x.t <= target && x.tag !== 'undo'); if (!sn) return send(res, 400, { error: 'No snapshot that old yet — they are kept for 26 hours, starting from when this update went live.' }); name = sn.name; }
      try { const sn = rollback(name, me.name); return send(res, 200, { ok: true, t: sn.t }); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    case '/api/admin/wipe-world': {
      if (b.confirm !== 'WIPE') return send(res, 400, { error: 'Type WIPE to confirm.' });
      const backup = path.join(BACKUP_DIR, `backup-before-wipe-${Date.now()}.json`); fs.writeFileSync(backup, JSON.stringify(S));
      for (const k of Object.keys(S.docs)) { const [c, id] = k.split('/'); if (COLS.includes(c)) setDoc(c, id, null); }
      S.flags = []; S.council = { props: [], active: {} }; S.event = null; broadcast('council', councilView()); broadcast('event', null);
      systemMessage('A new era begins: the world has been reset. Found your nation again!');
      audit(me.name, 'Wiped the world', null, 'Backup saved as ' + path.basename(backup)); return send(res, 200, { ok: true });
    }
    case '/api/admin/rotate-link': { S.adminPath = '/hq-' + crypto.randomBytes(12).toString('hex'); persist(); audit(me.name, 'Changed the admin link'); return send(res, 200, { ok: true, adminPath: S.adminPath }); }
    case '/api/admin/bot-remove': {
      const id = String(b.bot || ''); if (!BOTS.isBot(id) || !S.docs['nations/' + id]) return send(res, 404, { error: 'Unknown AI nation.' });
      const W = mkWorld(); const name = W.A[id].name; removeBot(W, id, 'admin'); S.config.bots = Math.max(0, (S.config.bots || 0) - 1); commit(W); broadcast('config', effCfg());
      audit(me.name, 'Removed AI nation', name); return send(res, 200, { ok: true });
    }
    case '/api/admin/bot-add': {
      S.config.bots = Math.min(30, (S.config.bots || 0) + 1); const W = mkWorld(); const id = BOTS.spawn(W); W.welcome = null; commit(W); broadcast('config', effCfg());
      if (!id) return send(res, 400, { error: 'No room for another nation on the map.' });
      audit(me.name, 'Added AI nation', W.A[id].name); return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found.' });
}

// ---------- public stats for the home page (no private data) ----------
let publicCache = null;
function publicStats() {
  if (publicCache && Date.now() - publicCache.t < 30000) return publicCache.v;
  const W = mkWorld(); const now = Date.now();
  const ids = Object.keys(W.A).sort((a, b) => core.score(W, b) - core.score(W, a));
  const online = Object.entries(S.docs).filter(([k, d]) => k.startsWith('online/') && !d.ai && now - (d.t || 0) < 30 * 60e3).length;
  const newsl = []; for (const n of Object.values(W.A)) for (const e of n.out || []) if (e.type === 'news') newsl.push({ t: e.t, x: e.x });
  newsl.sort((a, b) => b.t - a.t);
  const v = { nations: ids.length, players: humans(W).length, online, provinces: core.P.length, scenarios: SCENARIOS.length,
    top: ids.slice(0, 5).map(u => ({ name: W.A[u].name, color: W.A[u].color, rank: core.rankName(W.A[u]), provinces: core.hexesOf(W, u).length, ai: !!W.A[u].ai })),
    news: newsl.filter(x => !/^A new nation has been founded/.test(x.x)).slice(0, 6), event: S.event && S.event.end > now ? { n: WP.EVENTS[S.event.key].n, d: WP.EVENTS[S.event.key].d } : null };
  publicCache = { t: Date.now(), v }; return v;
}

// ---------- routes ----------
async function handle(req, res) {
  let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { return notFound(req, res); }
  const minute = Math.floor(Date.now() / 60000); health.reqs.set(minute, (health.reqs.get(minute) || 0) + 1);
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(req, res, auth(req) ? GAME : LANDING);
    if (req.method === 'GET' && STATIC[p]) return serveStatic(req, res, STATIC[p]);
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/public/stats') return send(res, 200, publicStats(), { 'Cache-Control': 'public, max-age=30' });
    if (req.method === 'GET' && p === S.adminPath) { const me = auth(req); if (!me || !me.admin) return notFound(req, res); return serveStatic(req, res, ADMIN_HTML); }
    if (req.method === 'GET' && p.startsWith('/n/')) return nationPage(req, res, p.slice(3));
    if (!p.startsWith('/api/')) return notFound(req, res);

    if (req.method !== 'GET') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Forbidden.' });
      if (req.method !== 'DELETE' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required.' });
    }

    if (p === '/api/signup' && req.method === 'POST') {
      if (!S.config.signups) return send(res, 403, { error: 'Sign-ups are closed right now.' });
      if (limited('signup:' + ipOf(req), 5, 60 * 60e3)) return send(res, 429, { error: 'Too many sign-ups from your network. Try again later.' });
      if (limited('signup:all', 60, 60 * 60e3)) { logErr('Sign-up limit reached: more than 60 new accounts in an hour.'); return send(res, 429, { error: 'Lots of new leaders are joining right now. Please try again in a few minutes.' }); }
      const b = await readBody(req, 4096);
      const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (!NAME_RE.test(name)) return send(res, 400, { error: 'Leader name must be 2–20 letters, numbers, spaces, dots, dashes or underscores.' });
      if (MOD.isProfane(name)) return send(res, 400, { error: 'Please choose a different leader name.' });
      if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (!b.agree) return send(res, 400, { error: 'Please agree to the Terms and Privacy Policy.' });
      if (findByEmail(email)) return send(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
      if (Object.values(S.users).some(u => u.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That leader name is taken.' });
      const id = crypto.randomBytes(9).toString('base64url');
      const first = !Object.values(S.users).some(u => !u.guest);
      S.users[id] = { email, name, ...hashPw(pw), created: Date.now(), admin: first || (!!ADMIN_EMAIL && email === ADMIN_EMAIL) };
      const inv = byInvite(b.ref); if (inv && inv !== id) S.users[id].ref = inv;
      meta(id).signupIp = ipOf(req); touch(id, req); stat('signups');
      const shared = Object.keys(S.users).filter(o => o !== id && sharesNetwork(o, id)); if (shared.length) flag(id, `Signed up from the same network as ${shared.map(o => S.users[o].name).join(', ')}`);
      const token = newSession(id); broadcast('user', { id, name });
      return send(res, 200, pub({ id, ...S.users[id] }), { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/guest' && req.method === 'POST') {
      if (!S.config.signups) return send(res, 403, { error: 'New players are not being accepted right now.' });
      if (limited('guest:' + ipOf(req), 3, 60 * 60e3)) return send(res, 429, { error: 'Too many guest games from your network. Create an account instead.' });
      if (limited('guest:all', 40, 60 * 60e3)) return send(res, 429, { error: 'Lots of new leaders are joining right now. Please try again in a few minutes.' });
      const b = await readBody(req, 1024);
      let name; do { name = 'Guest ' + (1000 + crypto.randomInt(9000)); } while (Object.values(S.users).some(u => u.name === name));
      const id = crypto.randomBytes(9).toString('base64url');
      S.users[id] = { email: null, name, ...hashPw(crypto.randomBytes(24).toString('hex')), created: Date.now(), admin: false, guest: true };
      const inv = byInvite(b.ref); if (inv) S.users[id].ref = inv;
      meta(id).signupIp = ipOf(req); touch(id, req); stat('signups');
      const shared = Object.keys(S.users).filter(o => o !== id && sharesNetwork(o, id)); if (shared.length) flag(id, `Guest game started from the same network as ${shared.map(o => S.users[o].name).join(', ')}`);
      const token = newSession(id); broadcast('user', { id, name });
      return send(res, 200, pub({ id, ...S.users[id] }), { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (limited('login:' + ipOf(req), 15, 15 * 60e3)) return send(res, 429, { error: 'Too many sign-in attempts. Wait 15 minutes.' });
      const b = await readBody(req, 4096);
      const email = String(b.email || '').trim().toLowerCase();
      if (limited('loginE:' + email, 8, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts for this account. Wait 15 minutes.' });
      const f = findByEmail(email);
      const okPw = checkPw(String(b.password || '').slice(0, 200), f ? f[1] : DUMMY_PW);
      if (!f || !okPw) return send(res, 401, { error: 'Wrong email or password.' });
      if (f[1].banned) return send(res, 403, { error: 'This account has been banned.' });
      touch(f[0], req); const token = newSession(f[0]);
      return send(res, 200, pub({ id: f[0], ...f[1] }), { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/logout' && req.method === 'POST') { const t = cookies(req).wp_s; if (t && /^[a-f0-9]{64}$/.test(t)) { delete S.sessions[tokHash(t)]; delete S.sessions[t]; persist(); } return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) }); }

    const me = auth(req);
    if (!me) return send(res, 401, { error: 'Not signed in.' });
    if (p === '/api/me' && req.method === 'GET') { touch(me.id, req); return send(res, 200, pub(me)); }
    if (p === '/api/account/save' && req.method === 'POST') {
      const u = S.users[me.id]; if (!u.guest) return send(res, 400, { error: 'Your account is already saved.' });
      if (limited('save:' + me.id, 10, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
      const b = await readBody(req, 4096);
      const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (!NAME_RE.test(name)) return send(res, 400, { error: 'Leader name must be 2–20 letters, numbers, spaces, dots, dashes or underscores.' });
      if (MOD.isProfane(name)) return send(res, 400, { error: 'Please choose a different leader name.' });
      if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (!b.agree) return send(res, 400, { error: 'Please agree to the Terms and Privacy Policy.' });
      if (findByEmail(email)) return send(res, 409, { error: 'An account with that email already exists.' });
      if (Object.entries(S.users).some(([id2, x]) => id2 !== me.id && x.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That leader name is taken.' });
      Object.assign(u, { email, name, ...hashPw(pw) }); delete u.guest; persist(); broadcast('user', { id: me.id, name });
      return send(res, 200, { ok: true, me: pub({ id: me.id, ...u }) });
    }
    if (p === '/api/invite' && req.method === 'GET') {
      const code = inviteCode(me.id), joined = Object.values(S.users).filter(u => u.ref === me.id).length, rewarded = (meta(me.id).invites || 0);
      return send(res, 200, { code, joined, rewarded });
    }
    if (p === '/api/bug' && req.method === 'POST') {
      if (limited('bug:' + me.id, 6, 60 * 60e3)) return send(res, 429, { error: 'Thanks — you have sent several reports already. Try again later.' });
      const b = await readBody(req, 1200 * 1024); const text = String(b.text || '').trim().slice(0, 2000); if (text.length < 5) return send(res, 400, { error: 'Please describe what happened.' });
      const id = rid(); let img = false;
      if (typeof b.img === 'string' && b.img.startsWith('data:image/jpeg;base64,')) { const buf = Buffer.from(b.img.slice(23), 'base64'); if (buf.length > 100 && buf.length < 1100 * 1024 && buf[0] === 0xff && buf[1] === 0xd8) { fs.mkdirSync(BUG_DIR, { recursive: true }); fs.writeFileSync(path.join(BUG_DIR, id + '.jpg'), buf); img = true; } }
      const ctx = { page: String(b.page || '').slice(0, 40), ua: String(req.headers['user-agent'] || '').slice(0, 200), screen: String(b.screen || '').slice(0, 30), errors: (Array.isArray(b.errors) ? b.errors : []).slice(0, 10).map(x => String(x).slice(0, 300)) };
      S.bugs.unshift({ id, t: Date.now(), by: me.id, byName: me.name, nation: nationName(me.id), text, img, ...ctx, done: false }); S.bugs = S.bugs.slice(0, 300); persist();
      for (const [aid2, u] of Object.entries(S.users)) if (u.admin) addNote(aid2, 'admin', `Bug report from ${me.name}: ${text.slice(0, 100)}`);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/account/') && req.method === 'POST') {
      if (limited('acct:' + me.id, 6, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
      const b = await readBody(req, 4096); const u = S.users[me.id]; const cur = cookies(req).wp_s;
      const pwOk = () => checkPw(String(b.password || '').slice(0, 200), u);
      if (p === '/api/account/password') {
        if (!pwOk()) return send(res, 400, { error: 'Your current password is incorrect.' });
        const nx = String(b.next || ''); if (nx.length < 8 || nx.length > 200) return send(res, 400, { error: 'New password must be at least 8 characters.' });
        Object.assign(u, hashPw(nx)); for (const [t, s2] of Object.entries(S.sessions)) if (s2.uid === me.id && t !== tokHash(cur)) delete S.sessions[t];
        persist(); return send(res, 200, { ok: true });
      }
      if (p === '/api/account/signout-all') {
        for (const [t, s2] of Object.entries(S.sessions)) if (s2.uid === me.id) delete S.sessions[t];
        for (const c of clients) if (c.uid === me.id) { try { c.res.end(); } catch (e) {} }
        persist(); return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      }
      if (p === '/api/account/delete') {
        if (!pwOk()) return send(res, 400, { error: 'Your password is incorrect.' });
        if (b.confirm !== 'DELETE') return send(res, 400, { error: 'Type DELETE to confirm.' });
        if (u.admin && Object.values(S.users).filter(x => x.admin).length <= 1) return send(res, 400, { error: 'You are the only administrator, so this account cannot be deleted.' });
        const nm = u.name, em = u.email; wipeUser(me.id); audit(nm, 'Deleted their own account', nm + ' (' + em + ')');
        return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      }
      return send(res, 404, { error: 'Not found.' });
    }
    if (p.startsWith('/api/admin/')) return adminRoute(p, req, res, me);

    if (p === '/api/stream' && req.method === 'GET') {
      touch(me.id, req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n'); write({ res }, 'init', snapshot(me.id));
      const mine = [...clients].filter(x => x.uid === me.id); if (mine.length >= 6) { try { mine[0].res.end(); } catch (e) {} clients.delete(mine[0]); }
      if (clients.size >= 5000) return send(res, 503, { error: 'The server is very busy. Try again shortly.' });
      const c = { res, uid: me.id }; clients.add(c); res.on('error', () => clients.delete(c)); req.on('close', () => clients.delete(c));
      return;
    }

    // Every game action goes through here. The server validates it and applies it.
    if (p === '/api/cmd' && req.method === 'POST') {
      if (limited('cmd:' + me.id, 30, 10e3)) { flag(me.id, 'Sending game actions faster than a person can click (possible bot/script)'); return send(res, 429, { error: 'Slow down.' }); }
      const b = await readBody(req, 8 * 1024);
      touch(me.id, req); health.cmds++; stat('cmds');
      const W = mkWorld();
      if (b.c === 'aid' && typeof b.v === 'string' && sharesNetwork(me.id, b.v)) flag(me.id, `Sent aid to ${(S.users[b.v] || {}).name || 'a player'}, who uses the same network (possible second account)`);
      if (b.c === 'found' && typeof b.name === 'string' && MOD.isProfane(b.name)) return send(res, 400, { error: 'Please choose a different name for your nation.' });
      let r;
      try { r = core.exec(W, me.id, b, rng); }
      catch (e) { if (e.user) return send(res, 400, { error: e.message }); throw e; }
      if (b.c === 'found') { stat('nations'); inviteReward(W, me.id); }
      commit(W);
      return send(res, 200, { ok: true, msg: r.msg, battle: r.battle, promoted: W.promoted || null, selHex: W.selHex != null ? W.selHex : null, covert: r.ok });
    }

    // ---- mail ----
    if (p === '/api/mail' && req.method === 'GET') return send(res, 200, { mail: (S.mail[me.id] || []).map(m => ({ ...m, fromName: nationName(m.from), toName: nationName(m.to), fromLeader: (S.users[m.from] || {}).name, toLeader: (S.users[m.to] || {}).name })) });
    if (p === '/api/mail/send' && req.method === 'POST') {
      if (limited('mail:' + me.id, 10, 10 * 60e3)) return send(res, 429, { error: 'You are sending mail too quickly. Try again in a few minutes.' });
      const b = await readBody(req, 8 * 1024); touch(me.id, req); return send(res, 200, mailSend(me, b));
    }
    if ((p === '/api/mail/read' || p === '/api/mail/delete') && req.method === 'POST') {
      const b = await readBody(req, 1024); const list = S.mail[me.id] || [];
      if (p.endsWith('read')) { for (const m of list) if (b.all || m.id === b.id) if (m.box === 'in') m.read = true; }
      else S.mail[me.id] = list.filter(m => m.id !== b.id);
      persist(); sendTo(me.id, 'mail', { unread: (S.mail[me.id] || []).filter(m => m.box === 'in' && !m.read).length }); return send(res, 200, { ok: true });
    }
    // ---- notifications ----
    if (p === '/api/notes/read' && req.method === 'POST') { for (const n of S.notes[me.id] || []) n.read = true; persist(); return send(res, 200, { ok: true }); }
    if (p === '/api/notes/clear' && req.method === 'POST') { const b = await readBody(req, 1024); if (typeof b.id === 'string') S.notes[me.id] = (S.notes[me.id] || []).filter(n => n.id !== b.id); else S.notes[me.id] = []; persist(); return send(res, 200, { ok: true });}
    if (p === '/api/prefs' && req.method === 'POST') {
      const b = await readBody(req, 2048); const pr = prefsOf(me.id); for (const k of NOTE_KINDS) if (typeof b[k] === 'boolean') pr[k] = b[k]; meta(me.id).prefs = pr; persist(); return send(res, 200, { ok: true, prefs: pr });
    }
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const b = await readBody(req, 4096); const s = b.sub || {};
      if (typeof s.endpoint !== 'string' || !PUSH_HOST.test(s.endpoint) || s.endpoint.length > 1000 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return send(res, 400, { error: 'Invalid subscription.' });
      const clean = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) } };
      S.push[me.id] = [clean, ...(S.push[me.id] || []).filter(x => x.endpoint !== clean.endpoint)].slice(0, 5); persist();
      pushTo(me.id, { title: 'World Powers', body: 'Notifications are on. We will alert you about attacks, mail, diplomacy and more.', url: '/play', tag: 'welcome' });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') { const b = await readBody(req, 4096); S.push[me.id] = (S.push[me.id] || []).filter(x => !b.endpoint || x.endpoint !== b.endpoint); persist(); return send(res, 200, { ok: true }); }
    // ---- moderation by players ----
    if (p === '/api/mute' && req.method === 'POST') {
      const b = await readBody(req, 1024); const id = String(b.id || ''); if (!S.users[id] || id === me.id) return send(res, 400, { error: 'Unknown player.' });
      const m = meta(me.id); m.muted = (m.muted || []).filter(x => x !== id); if (b.mute) m.muted.push(id); m.muted = m.muted.slice(-200); persist(); return send(res, 200, { ok: true, muted: m.muted });
    }
    if (p === '/api/report' && req.method === 'POST') {
      if (limited('report:' + me.id, 10, 60 * 60e3)) return send(res, 429, { error: 'Too many reports. Try again later.' });
      const b = await readBody(req, 4096); const about = String(b.id || ''); if (!S.users[about]) return send(res, 400, { error: 'Unknown player.' });
      S.reports.unshift({ id: rid(), t: Date.now(), by: me.id, byName: me.name, about, aboutName: S.users[about].name, kind: ['chat', 'mail', 'name', 'other'].includes(b.kind) ? b.kind : 'other', text: String(b.text || '').slice(0, 500), reason: String(b.reason || '').slice(0, 300), done: false });
      S.reports = S.reports.slice(0, 500); persist(); return send(res, 200, { ok: true });
    }
    // ---- World Council ----
    if (p === '/api/council/propose' && req.method === 'POST') { const b = await readBody(req, 2048); touch(me.id, req); councilPropose(me.id, b); return send(res, 200, { ok: true }); }
    if (p === '/api/council/vote' && req.method === 'POST') { const b = await readBody(req, 1024); touch(me.id, req); councilVote(me.id, b); return send(res, 200, { ok: true }); }

    const m = p.match(/^\/api\/doc\/(chat|online)\/([A-Za-z0-9_-]{1,64})$/);
    if (m) {
      const [, col, id] = m;
      if (id !== me.id) return send(res, 403, { error: 'You can only change your own data.' });
      if (req.method === 'PUT') {
        if (limited('w:' + me.id, 30, 10e3)) return send(res, 429, { error: 'Slow down.' });
        let d = await readBody(req, 32 * 1024);
        if (col === 'online') { d = { t: Date.now() }; touch(me.id, req); }
        else {
          if (isMuted(me.id)) return send(res, 403, { error: 'You are muted by the administrators.' });
          if (limited('chat:' + me.id, 12, 20e3)) return send(res, 429, { error: 'You are sending messages too quickly.' });
          if (!S.docs['nations/' + me.id]) return send(res, 403, { error: 'Found your nation to join the conversation.' });
          const prevT = ((S.docs['chat/' + me.id] || {}).m || [])[0]?.t || 0;
          d = cleanChat(d); stat('chat');
          const nm = d.m[0]; if (nm && nm.t > prevT && nm.x.includes('@')) { const low = nm.x.toLowerCase(); let k = 0;
            for (const [uid2, u2] of Object.entries(S.users)) { if (k >= 3 || uid2 === me.id || u2.banned || !u2.name) continue; if (low.includes('@' + u2.name.toLowerCase()) && !((meta(uid2).muted || []).includes(me.id))) { k++; addNote(uid2, 'mention', `${nationName(me.id)} mentioned you in chat: “${nm.x.slice(0, 90)}”`); } } }
        }
        setDoc(col, id, d); return send(res, 200, { ok: true });
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
  console.log(`Admin page (only works for admin accounts): ${S.adminPath}`);
  if (!Object.keys(S.users).length) console.log('The first account to sign up becomes the admin' + (ADMIN_EMAIL ? ` (and so will ${ADMIN_EMAIL})` : '') + '.');
});
