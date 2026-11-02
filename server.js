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
for (const k of ['meta', 'mail', 'notes', 'push', 'stats', 'actlog']) S[k] = S[k] || {};
for (const k of ['flags', 'audit', 'reports', 'fallen', 'bugs', 'schedule', 'nukes', 'strikes']) S[k] = S[k] || [];
S.council = S.council || { props: [], active: {} };
if (S.mapVersion !== MAP_VERSION) {
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/') || k.startsWith('online/') || (k.startsWith('chat/') && k !== 'chat/_system')) delete S.docs[k];
  S.council = { props: [], active: {} }; S.event = null; S.mapVersion = MAP_VERSION;
}
// every id-keyed map gets no prototype, so ids like "__proto__" or "constructor" can never match anything
for (const k of ['users', 'sessions', 'docs', 'meta', 'mail', 'notes', 'push', 'stats', 'actlog']) S[k] = Object.assign(Object.create(null), S[k]);
if (!S.adminPath) S.adminPath = '/hq-' + crypto.randomBytes(12).toString('hex');
if (!S.vapid) S.vapid = PUSH.makeVapid();
if (!S.nextEvent) S.nextEvent = Date.now() + 6 * HOUR;
// ---------- fair play: a fingerprint of the exact game code running, its release history, and a public log of admin game actions ----------
const FAIR_ACTIONS = new Set(['Changed game settings', 'Edited nation', 'Reset nation', 'Rolled back the world', 'Wiped the world', 'Started world event', 'Ended world event', 'Scheduled', 'Cancelled scheduled event', 'Cancelled council vote', 'Added AI nation', 'Removed AI nation', 'Restored nation from snapshot']);
const CODE_FILES = ['server.js', 'bots.js', 'moderation.js', 'push.js', 'public/core.js', 'public/scenarios.js', 'public/index.html', 'public/prov.js', 'public/admin.html'];
const CODE = CODE_FILES.filter(f => fs.existsSync(path.join(__dirname, f))).map(f => ({ name: f, sha: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, f))).digest('hex') }));
const FINGERPRINT = crypto.createHash('sha256').update(CODE.map(c => c.name + ':' + c.sha).join('\n')).digest('hex');
S.releases = S.releases || [];
if (!S.releases.length || S.releases[0].fp !== FINGERPRINT) { S.releases.unshift({ t: START, fp: FINGERPRINT }); S.releases = S.releases.slice(0, 200); }
if (!S.fairlog) S.fairlog = (S.audit || []).filter(a => FAIR_ACTIONS.has(a.action)).map(a => ({ t: a.t, action: a.action, target: a.target, detail: a.detail }));

const health = { lastSave: 0, saveError: null, errors: [], reqs: new Map(), cmds: 0, pushes: 0 };
let saveTimer = null;
function writeNow() {
  try { const t0 = process.hrtime.bigint(), tmp = FILE + '.tmp', js = JSON.stringify(S); fs.writeFileSync(tmp, js); fs.renameSync(tmp, FILE); health.lastSave = Date.now(); health.saveMs = Number(process.hrtime.bigint() - t0) / 1e6; health.dataBytes = js.length; health.saveError = null; }
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
STATIC['/play'] = GAME; STATIC['/terms'] = loadFile('terms.html', HTML, 'no-cache'); STATIC['/privacy'] = loadFile('privacy.html', HTML, 'no-cache'); STATIC['/fair'] = loadFile('fair.html', HTML, 'no-cache'); STATIC['/faq'] = loadFile('faq.html', HTML, 'no-cache');
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
.hero{margin:34px 0 20px;display:flex;align-items:center;gap:16px}.flagsvg svg{display:block;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.5)}.flag{width:54px;height:54px;border-radius:12px;flex:none}h1{margin:0;font-size:34px;line-height:1.1}.sub{color:#8b98a5}.tag{font-size:11px;border:1px solid #2a3542;border-radius:4px;padding:1px 6px;margin-left:8px;color:#8b98a5;vertical-align:middle}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin:18px 0}.grid div{background:#0c1218;border:1px solid #1e2833;border-radius:10px;padding:12px}.grid span{display:block;color:#8b98a5;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.grid b{font-size:18px}
h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#d4a64a;margin:30px 0 8px}ul{padding-left:18px;color:#c5ced8}.cta{margin-top:36px;padding:22px;border:1px solid #2a3542;border-radius:12px;text-align:center;background:#0c1218}</style></head>
<body><div class="w"><div class="top"><a class="logo" href="/"><i></i>WORLD POWERS</a><a class="play" href="/play">Play free</a></div>
<div class="hero">${n.flag ? `<div class="flagsvg">${WP.flagSVG(n.flag, 81, 54)}</div>` : `<div class="flag" style="background:${escH(n.color)}"></div>`}<div><h1>${escH(n.name)}${n.ai ? '<span class="tag">AI</span>' : ''}${n.nuke ? '<span class="tag">☢ Nuclear power</span>' : ''}</h1><div class="sub">${escH(rank)} · ${escH(gov)} · led by ${escH(leader)} · #${place} in the world</div>${n.motto ? `<div class="sub" style="font-style:italic;margin-top:2px">“${escH(n.motto)}”</div>` : ''}</div></div>
<div class="grid">${row('Provinces', core.hexesOf(W, id).length)}${row('GDP', WP.moneyS(n.gdp || 0))}${row('Population', WP.num(Math.round(n.pop)))}${row('Army', WP.num(n.troops || 0))}${row('Navy / Air', `${n.ships || 0} / ${n.air || 0}`)}${row('Tech level', n.tech || 0)}${row('Approval', Math.round(n.approval) + '%')}${row('Founded', new Date(n.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</div>
${Object.keys(n.wonders || {}).length ? `<h2>Wonders of the world</h2><p>${Object.keys(n.wonders).map(k => '🏛 ' + escH(WP.WONDERS[k].n)).join(' · ')}</p>` : ''}${(n.laws || []).length ? `<h2>Laws in force</h2><p>${n.laws.map(k => escH((WP.LAWS[k] || {}).n || k)).join(' · ')}</p>` : ''}${Object.keys(n.ach || {}).length ? `<h2>Achievements</h2><p>${Object.keys(n.ach).filter(k => WP.ACH[k]).map(k => '🏅 ' + escH(WP.ACH[k][0])).join(' · ')}</p>` : ''}
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
// Railway's edge strips any X-Forwarded-For the browser sent and puts the real client address first (per Railway support); the
// rightmost entries can be Railway/CDN hops shared by many players, so they must not be used for rate limits
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
function audit(by, action, target, detail) { S.audit.unshift({ t: Date.now(), by, action, target: target || null, detail: detail || null }); S.audit = S.audit.slice(0, 500);
  if (FAIR_ACTIONS.has(action)) { S.fairlog.unshift({ t: Date.now(), action, target: target || null, detail: detail || null }); S.fairlog = S.fairlog.slice(0, 3000); }
  persist(); }
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
    approval: n.approval, stability: n.stability, aggr: n.aggr, regroup: n.regroup, lastStand: n.lastStand || 0, gens: (n.gens || []).map(g => ({ name: g.name, type: g.type, stars: g.stars })), laws: n.laws || [], wonders: n.wonders || {}, proj: n.proj ? { k: n.proj.k, stage: n.proj.stage } : null, flag: n.flag || null, motto: n.motto || '', ach: n.ach || {}, nuke: n.nuke || 0, warhead: n.warhead ? (n.warhead.ready <= Date.now() ? 2 : 1) : 0, nuked: n.nuked || null, fallout: n.fallout || 0, winter: n.winter || 0, rogue: n.rogue || 0, armsEmb: n.armsEmb || 0, condemned: n.condemned || 0, ceasefire: n.ceasefire || 0, guarantee: n.guarantee || 0, inspected: n.inspected || 0, frozen: n.frozen ? { amt: n.frozen.amt, until: n.frozen.until } : null, conqN: Object.keys(n.conq || {}).length, rel: n.rel, trades: n.trades, res: { oil: n.res && n.res.oil > 0 ? 1 : 0 }, ai: n.ai ? { p: n.ai.p } : undefined,
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
const councilView = () => ({ props: S.council.props.slice(0, 40).map(({ debts, ...p }) => p), active: S.council.active, pacts: (S.council.pacts || []).filter(x => x.until > Date.now()), decl: (S.council.decl || []).filter(x => x.until > Date.now()) });
function snapshot(uid) {
  const cols = {}; for (const c of COLS) cols[c] = {};
  for (const [p, d] of Object.entries(S.docs)) { const [c, id] = p.split('/'); if (!cols[c]) continue; cols[c][id] = c === 'nations' && id !== uid ? publicView(d) : d; }
  const users = {}; for (const [id, u] of Object.entries(S.users)) if (!u.banned) users[id] = u.name;
  return { cols, users, config: effCfg(), awaySince: meta(uid).prevSeen || 0, council: councilView(), event: S.event, notes: (S.notes[uid] || []).slice(0, 60), mailUnread: (S.mail[uid] || []).filter(m => m.box === 'in' && !m.read).length, prefs: prefsOf(uid), muted: meta(uid).muted || [], vapid: PUSH.vapidPublic(S.vapid), pushOn: (S.push[uid] || []).length > 0, fallen: S.docs['nations/' + uid] ? null : (meta(uid).fallen || null), fallenList: S.fallen.slice(0, 30), strikes: S.strikes.filter(x => Date.now() - x.t < 15 * 60e3) };
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
function nationsMap() { const A = Object.create(null); /* no prototype: ids like "__proto__" can never match a nation */ for (const [k, d] of Object.entries(S.docs)) if (k.startsWith('nations/')) A[k.slice(8)] = core.normalize(d); return A; }
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
  if ((W.strikeFx || []).length) { const now = Date.now(); for (const fx of W.strikeFx) { broadcast('strike', fx); S.strikes.unshift(fx); } S.strikes = S.strikes.filter(x => now - x.t < 15 * 60e3).slice(0, 40); }
  for (const fx of W.nukeFx || []) { const t = `☢ NUCLEAR DETONATION: ${fx.byName} ${fx.retaliation ? 'retaliated against' : 'struck'} ${fx.toName} at ${fx.place}. Fallout is spreading.`; systemMessage(t); broadcast('nuke', fx); S.nukes.unshift(fx); S.nukes = S.nukes.slice(0, 50); persist(); }
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
const isTargeted = type => ['punish', 'protect'].includes(WP.RESOLUTIONS[type].kind);
const PACT_SCOPE = { ai: 'against AI attackers', all: 'against any attacker' };
const resLabel = (type, name, p) => type === 'custom' && p ? `Custom resolution: “${p.text}”` : WP.RESOLUTIONS[type].n + (type === 'pact' && p ? ` (${PACT_SCOPE[p.scope] || ''})` : '') + (name ? (WP.RESOLUTIONS[type].kind === 'protect' ? ' for ' : ' against ') + name : '');
const nukedRecently = (u, now) => S.nukes.some(x => x.by === u && now - x.t < 72 * HOUR);
// why a resolution cannot be put to the vote against/for this nation right now (null = fine)
function resBlocked(W, type, v) {
  const n = W.A[v], now = Date.now(), M = k => core.measure(W, n, k);
  if (type === 'inspect' && !n.nuke) return `${n.name} has no nuclear program to inspect.`;
  if (type === 'ceasefire' && !core.wars(W, v).length) return `${n.name} is not at war with anyone.`;
  if ((type === 'aid' || type === 'guarantee') && core.rogue(W, n)) return `${n.name} is a rogue state. The Council will not support it until sanctions are lifted.`;
  if (type === 'lift') { if (!(M('embargo') || M('armsEmb') || M('frozen') || M('condemned') || core.rogue(W, n))) return `${n.name} is not under any sanctions.`; if (nukedRecently(v, now)) return `${n.name} launched a nuclear strike less than 72 hours ago. Its sanctions cannot be lifted yet.`; }
  return null;
}
function councilPropose(uid, b) {
  const W = mkWorld(), n = W.A[uid]; if (!n) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const type = typeof b.type === 'string' ? b.type : ''; if (!RES_KEYS.includes(type)) throw Object.assign(new Error('Unknown resolution.'), { status: 400 });
  if (core.rankOf(n.xp) < 2) throw Object.assign(new Error('You must be at least a Mayor to propose resolutions.'), { status: 400 });
  const R = WP.RESOLUTIONS[type]; let target = null;
  if (isTargeted(type)) {
    target = typeof b.target === 'string' ? b.target : ''; if (!Object.prototype.hasOwnProperty.call(W.A, target) || target === uid) throw Object.assign(new Error('Choose another nation as the target.'), { status: 400 });
    const why = resBlocked(W, type, target); if (why) throw Object.assign(new Error(why), { status: 400 });
  }
  const open = S.council.props.filter(p => p.status === 'open');
  if (open.some(p => p.by === uid)) throw Object.assign(new Error('You already have a resolution under vote.'), { status: 400 });
  if (open.filter(p => !p.auto).length >= 4) throw Object.assign(new Error('The Council agenda is full. Try again after a vote closes.'), { status: 400 });
  if (type !== 'custom' && open.some(p => p.type === type && p.target === target && (type !== 'pact' || p.scope === b.scope))) throw Object.assign(new Error('That resolution is already being voted on.'), { status: 400 });
  if (type === 'debt' && Date.now() - ((S.council.passed || {}).debt || 0) < 72 * HOUR) throw Object.assign(new Error(`Debt relief can only pass once every 72 hours. It can be proposed again in ${Math.ceil((72 * HOUR - (Date.now() - S.council.passed.debt)) / HOUR)} hours.`), { status: 400 });
  if (WP.RESOLUTIONS[type].kind === 'global' && (S.council.active[type] || 0) > Date.now()) { const h = Math.ceil((S.council.active[type] - Date.now()) / HOUR); throw Object.assign(new Error(`“${R.n}” is already in force for another ${h} hour${h === 1 ? '' : 's'}.`), { status: 400 }); }
  let scope = null, text = null, hours = null;
  if (type === 'pact') { scope = b.scope === 'all' ? 'all' : b.scope === 'ai' ? 'ai' : null; if (!scope) throw Object.assign(new Error('Choose who the pact defends against.'), { status: 400 }); }
  if (type === 'custom') {
    text = typeof b.text === 'string' ? b.text.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (text.length < 10) throw Object.assign(new Error('Write the resolution (at least 10 characters).'), { status: 400 });
    if (text.length > 200) throw Object.assign(new Error('Keep it under 200 characters.'), { status: 400 });
    if (MOD.isProfane(text)) throw Object.assign(new Error('Please reword your resolution.'), { status: 400 });
    hours = [24, 48, 72].includes(+b.hours) ? +b.hours : 48;
  }
  if (n.cash < 1e5) throw Object.assign(new Error('Submitting a resolution costs $100,000.'), { status: 400 });
  n.cash -= 1e5; W.changed.add(uid); commit(W);
  const p = { id: rid(), by: uid, type, target, t: Date.now(), end: Date.now() + 6 * HOUR, votes: { [uid]: 'y' }, status: 'open' };
  if (scope) p.scope = scope; if (text) { p.text = text; p.hours = hours; }
  if (type === 'debt') p.debts = Object.fromEntries(Object.entries(W.A).filter(([, x]) => (x.debt || 0) > 0).map(([u, x]) => [u, Math.round(x.debt)]));
  S.council.props.unshift(p); S.council.props = S.council.props.slice(0, 60); persist(); broadcast('council', councilView());
  const txt = `${n.name} proposes to the World Council: ${resLabel(type, target && W.A[target].name, p)}.`;
  systemMessage(txt); for (const u of Object.keys(S.users)) if (u !== uid) addNote(u, 'council', txt + ' Voting closes in 6 hours.');
  return p;
}
function councilVote(uid, b) {
  if (!S.docs['nations/' + uid]) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const p = S.council.props.find(x => x.id === b.id && x.status === 'open'); if (!p || Date.now() >= p.end) throw Object.assign(new Error('That vote has closed.'), { status: 400 });
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
    const label = resLabel(p.type, tn && tn.name, p);
    if (p.status === 'passed' && p.target && resBlocked(W, p.type, p.target)) { p.status = 'failed'; p.result += ', no longer applies'; }
    if (p.status === 'passed') {
      const until = now + (p.hours || R.h) * HOUR, extra = enactResolution(W, p, tn, until); (S.council.passed = S.council.passed || {})[p.type] = now;
      systemMessage(`World Council resolution PASSED (${p.result}): ${label}.${extra ? ' ' + extra : ''}`);
      if (p.target && S.users[p.target]) addNote(p.target, 'council', R.kind === 'protect' ? `The World Council passed a resolution in your favor: ${R.n}.${extra ? ' ' + extra : ''}` : `The World Council passed a resolution against you: ${R.n}.${extra ? ' ' + extra : ''}`);
    } else systemMessage(`World Council resolution failed (${p.result}): ${label}.`);
    if (S.users[p.by]) addNote(p.by, 'council', `Your resolution "${label}" ${p.status} (${p.result}).`);
  }
  for (const [k, until] of Object.entries(S.council.active)) if (until < now) { delete S.council.active[k]; changed = true; }
  for (const k of ['pacts', 'decl']) if ((S.council[k] || []).some(x => x.until < now)) { S.council[k] = S.council[k].filter(x => x.until >= now); changed = true; }
  if (changed) { persist(); broadcast('council', councilView()); }
}
// what a passed resolution actually does. Returns a short note for the announcement.
function enactResolution(W, p, tn, until) {
  const now = Date.now(), v = p.target, ch = x => W.changed.add(x);
  switch (p.type) {
    case 'sanction': tn.aggr = Math.max(tn.aggr || 0, 80); core.rogueCheck(W, v); ch(v); return '';
    case 'embargo': tn.embargo = Math.max(tn.embargo || 0, until); ch(v); return '';
    case 'armsEmb': tn.armsEmb = Math.max(tn.armsEmb || 0, until); ch(v); return '';
    case 'freeze': { const amt = Math.max(0, Math.floor((tn.cash || 0) * .25)); tn.cash -= amt; tn.frozen = { amt: ((tn.frozen && tn.frozen.amt) || 0) + amt, until: Math.max((tn.frozen && tn.frozen.until) || 0, until) }; ch(v); return `${WP.moneyS(amt)} of ${tn.name}'s treasury is frozen for ${R_H(p)} hours.`; }
    case 'condemn': tn.approval = Math.max(0, tn.approval - 10); tn.stability = Math.max(0, tn.stability - 8); tn.aggr = Math.min(100, (tn.aggr || 0) + 20); tn.condemned = Math.max(tn.condemned || 0, until); core.rogueCheck(W, v); ch(v); return '';
    case 'inspect': { const had = tn.warhead && !core.warheadReady(W, tn); if (had) tn.warhead = null; tn.inspected = Math.max(tn.inspected || 0, until); ch(v); return had ? `Inspectors dismantled the warhead ${tn.name} was assembling.` : `Inspectors will monitor ${tn.name}'s program for ${R_H(p)} hours.`; }
    case 'ceasefire': { tn.ceasefire = Math.max(tn.ceasefire || 0, until); ch(v); const foes = core.wars(W, v); for (const f of foes) if (S.users[f]) addNote(f, 'council', `A World Council ceasefire with ${tn.name} is in force for ${R_H(p)} hours. No battles or strikes until it ends.`); return `No fighting between ${tn.name} and ${foes.map(f => W.A[f].name).join(', ')} for ${R_H(p)} hours.`; }
    case 'guarantee': tn.guarantee = Math.max(tn.guarantee || 0, until); ch(v); return '';
    case 'aid': {
      let cash = 0, food = 0, donors = 0;
      for (const [u, vote] of Object.entries(p.votes)) {
        const d = W.A[u]; if (vote !== 'y' || u === v || !d || core.rogue(W, d)) continue;
        if (S.users[u] && S.users[v] && sharesNetwork(u, v)) { flag(u, `Voted for World Council aid to ${tn.name}, which uses the same network (possible second account); no aid was sent from this account`); continue; }
        const c = Math.max(0, Math.min(2e6, Math.floor((d.cash || 0) * .01))), f = Math.max(0, Math.min(300, Math.floor(((d.res || {}).food || 0) * .05)));
        if (!c && !f) continue; d.cash -= c; d.res.food -= f; cash += c; food += f; donors++; ch(u);
        if (S.users[u]) addNote(u, 'council', `Your nation sent ${WP.moneyS(c)} and ${f} food in humanitarian aid to ${tn.name}.`);
      }
      tn.cash += cash; tn.res.food = (tn.res.food || 0) + food; tn.health = Math.min(100, (tn.health || 50) + 10); tn.stability = Math.min(100, tn.stability + 6); ch(v);
      return `${donors} nation${donors === 1 ? '' : 's'} sent ${WP.moneyS(cash)} and ${WP.num(food)} food.`;
    }
    case 'lift': {
      const back = tn.frozen ? tn.frozen.amt || 0 : 0; tn.cash += back; tn.frozen = null; tn.embargo = 0; tn.armsEmb = 0; tn.condemned = 0;
      if (core.rogue(W, tn)) tn.rogue = 0; tn.aggr = Math.min(tn.aggr || 0, 30); ch(v);
      return back ? `${WP.moneyS(back)} in frozen assets was returned.` : '';
    }
    case 'debt': {
      let total = 0; for (const [u, n] of Object.entries(W.A)) if ((n.debt || 0) > 0) { const f = Math.min(n.debt, (p.debts ? p.debts[u] || 0 : n.debt)) * .2; if (!(f > 0)) continue; n.debt -= f; total += f; ch(u); if (S.users[u]) addNote(u, 'council', `Debt relief: ${WP.moneyS(f)} of your national debt was forgiven.`); }
      S.council.active.debt = until; return `${WP.moneyS(total)} of debt was forgiven worldwide.`;
    }
    case 'health': { for (const [u, n] of Object.entries(W.A)) { const c = Math.max(0, Math.floor((n.cash || 0) * .005)); n.cash -= c; ch(u); } S.council.active.health = until; return 'Every nation contributed 0.5% of its treasury.'; }
    case 'pact': {
      const members = Object.keys(p.votes).filter(u => p.votes[u] === 'y' && W.A[u]);
      (S.council.pacts = S.council.pacts || []).push({ id: p.id, scope: p.scope, members, until, t: now });
      for (const u of members) if (S.users[u]) addNote(u, 'council', `You are a member of the Collective Defense Pact (${PACT_SCOPE[p.scope]}) for 72 hours. If anyone attacks a member, you will automatically be at war with them.`);
      return `Members: ${members.map(u => W.A[u].name).join(', ')}.`;
    }
    case 'custom': (S.council.decl = S.council.decl || []).push({ id: p.id, text: p.text, by: p.by, yes: Object.keys(p.votes).filter(u => p.votes[u] === 'y'), until, t: now }); return 'It is now in force.';
    default: S.council.active[p.type] = until; return '';
  }
}
const R_H = p => WP.RESOLUTIONS[p.type].h;
// collective defense: when anyone attacks a pact member, every other member goes to war with the attacker
function pactCheck(W) {
  const hits = W.hits || []; W.hits = []; const pacts = (S.council.pacts || []).filter(x => x.until > Date.now()); if (!hits.length || !pacts.length) return;
  const said = new Set();
  for (const h of hits) for (const pc of pacts) {
    const a = W.A[h.u], v = W.A[h.v]; if (!a || !v || !pc.members.includes(h.v)) continue;
    if (pc.scope === 'ai' && !BOTS.isBot(h.u)) continue; // this pact only covers attacks by AI nations
    if (pc.members.includes(h.u)) { pc.members = pc.members.filter(m => m !== h.u); systemMessage(`🛡 ${a.name} attacked a fellow member of the Collective Defense Pact and has been expelled from it.`); }
    const joined = pc.members.filter(m => m !== h.v && m !== h.u && W.A[m] && core.pactWar(W, m, h.u, h.v));
    const key = pc.id + h.u; if (joined.length && !said.has(key)) { said.add(key); systemMessage(`🛡 Collective Defense Pact invoked: ${a.name} attacked ${v.name}. ${joined.map(m => W.A[m].name).join(', ')} ${joined.length === 1 ? 'is' : 'are'} now at war with ${a.name}.`); }
  }
}
// ---------- the World Council takes notice on its own ----------
// Bad behaviour puts a resolution to the vote automatically. Everyone (players and AI) still votes; nothing passes without a majority.
const AUTO_RULES = [
  // [type, test(nation, recent attacks, W, id) -> reason or null]
  ['sanction', (n, atk, W, u) => !core.rogue(W, n) && ((n.aggr || 0) >= 60 || atk.victims >= 3) ? (atk.victims >= 3 ? `attacked ${atk.victims} different nations in 12 hours` : `pushed its aggression to ${Math.round(n.aggr)}`) : null],
  ['condemn', (n, atk, W, u) => !core.rogue(W, n) && ((n.aggr || 0) >= 35 || atk.n >= 3) ? `${atk.n >= 3 ? `launched ${atk.n} attacks in 6 hours` : `pushed its aggression to ${Math.round(n.aggr)}`}` : null],
  ['inspect', (n, atk, W, u) => n.warhead && !core.warheadReady(W, n) && Date.now() - (n.warhead.t || 0) < 6 * HOUR ? 'began assembling a launchable nuclear warhead' : null],
  ['aid', (n, atk, W, u) => n.nuked && Date.now() - n.nuked.t < 6 * HOUR && !core.rogue(W, n) ? 'was struck by a nuclear weapon' : null],
  ['condemn', (n, atk, W, u) => n.nuke && Date.now() - n.nuke < 3 * HOUR ? 'tested a nuclear weapon' : null]
];
function councilWatch(W) {
  if (S.config.councilAuto === false) return; const now = Date.now(); S.council.watch = S.council.watch || {};
  for (const [k, t] of Object.entries(S.council.watch)) if (now - t > 48 * HOUR) delete S.council.watch[k];
  const open = () => S.council.props.filter(p => p.status === 'open');
  if (open().filter(p => p.auto).length >= 3) return;
  for (const [u, n] of Object.entries(W.A)) {
    if (open().some(p => p.target === u)) continue;
    const battles = (n.out || []).filter(e => e.type === 'battle' && e.to && e.to !== u && W.A[e.to] && !((W.A[e.to].out || []).some(x => x.type === 'battle' && x.to === u && x.t < e.t && e.t - x.t < 24 * HOUR)));
    const atk = { n: battles.filter(e => now - e.t < 6 * HOUR).length, victims: new Set(battles.filter(e => now - e.t < 12 * HOUR).map(e => e.to)).size };
    for (const [type, test] of AUTO_RULES) {
      const why = test(n, atk, W, u); if (!why || resBlocked(W, type, u)) continue; const key = type + ':' + u;
      if (S.council.watch[key] && now - S.council.watch[key] < 24 * HOUR) continue;
      S.council.watch[key] = now; const R = WP.RESOLUTIONS[type];
      S.council.props.unshift({ id: rid(), by: null, auto: true, why, type, target: u, t: now, end: now + 6 * HOUR, votes: {}, status: 'open' }); S.council.props = S.council.props.slice(0, 60);
      const txt = `The World Council has taken notice: ${n.name} ${why}. A vote on "${resLabel(type, n.name)}" is now open.`;
      systemMessage('🏛 ' + txt); const hit = new Set(battles.map(e => e.to)), nuclear = /nuclear/.test(why);
      for (const v of Object.keys(S.users)) if (v !== u && (nuclear || hit.has(v))) addNote(v, 'council', txt + ' Voting closes in 6 hours.');
      if (S.users[u]) addNote(u, 'council', R.kind === 'protect' ? `The World Council is voting on "${R.n}" for your nation because it ${why}.` : `The World Council is voting on "${R.n}" against your nation because it ${why}. You have 6 hours to make your case in chat.`);
      persist(); broadcast('council', councilView());
      if (open().filter(p => p.auto).length >= 3) return;
      break; // at most one new resolution per nation at a time
    }
  }
}
// AI nations cast votes according to their personality and relations
function botVotes(W) {
  for (const p of S.council.props) {
    if (p.status !== 'open') continue;
    for (const u of Object.keys(W.A)) {
      if (!BOTS.isBot(u) || p.votes[u] || rng() > .15 || p.type === 'custom') continue;
      const me = W.A[u], per = (me.ai || {}).p, R = WP.RESOLUTIONS[p.type]; let yes = .5;
      if (p.type === 'pact') yes = ({ isolationist: .65, merchant: .55, warlord: .35, expansionist: .45 })[per] || .5;
      else if (R.kind !== 'global') {
        const t = W.A[p.target]; if (!t) continue;
        const bad = Math.min(.9, (t.aggr || 0) / 70) + (core.rogue(W, t) ? .3 : 0), war = core.atWar(W, u, p.target), ally = core.pact(W, u, p.target, 'ally'), trade = core.pact(W, u, p.target, 'trade');
        const victim = (t.nuked && Date.now() - t.nuked.t < 48 * HOUR ? .35 : 0) + (core.wars(W, p.target).length ? .15 : 0) + ((t.aggr || 0) < 20 ? .1 : 0);
        if (p.target === u) yes = R.kind === 'protect' ? 1 : 0;
        else if (R.kind === 'punish') {
          if (war) yes = .95; else if (ally) yes = Math.min(.05, bad); else { yes = Math.max(.05, bad); if (trade) yes *= .5; }
          if (p.type === 'inspect' && !ally) yes = Math.max(yes, per === 'warlord' ? .35 : .7); // non-proliferation is popular
          if (p.type === 'freeze' && per === 'merchant') yes *= .7; // bankers dislike seizing deposits
        } else { // support for a nation
          if (war) yes = p.type === 'aid' ? .25 : .03; else if (ally) yes = .95;
          else if (p.type === 'lift') yes = Math.max(.05, .8 - bad);
          else if (p.type === 'aid') yes = Math.min(.95, .35 + victim + (per === 'merchant' || per === 'isolationist' ? .1 : 0) - bad * .5);
          else if (p.type === 'ceasefire') yes = Math.min(.9, .45 + victim + (per === 'warlord' ? -.25 : per === 'isolationist' ? .15 : 0));
          else yes = Math.max(.05, Math.min(.9, .3 + victim - bad + (trade ? .2 : 0)));
        }
      }
      else yes = ({ climate: { isolationist: .8, merchant: .6, warlord: .3, expansionist: .4 }, arms: { isolationist: .8, merchant: .6, warlord: .1, expansionist: .3 }, freetrade: { merchant: .95, expansionist: .6, warlord: .4, isolationist: .3 }, peacekeeping: { isolationist: .85, merchant: .7, warlord: .1, expansionist: .3 },
        npt: { isolationist: .85, merchant: .7, warlord: me.nuke ? .5 : .2, expansionist: .45 }, health: { isolationist: .7, merchant: .55, warlord: .35, expansionist: .5 }, science: { isolationist: .7, merchant: .75, warlord: .5, expansionist: .7 },
        food: { isolationist: .75, merchant: .4, warlord: .55, expansionist: .6 }, debt: { isolationist: .5, merchant: .25, warlord: .6, expansionist: .6 } }[p.type] || {})[per] || .5;
      if (p.type === 'debt') yes = Math.min(.95, yes + ((me.debt || 0) > (me.gdp || 1) * .3 ? .35 : 0)); // nations in debt want relief
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
  const t0 = process.hrtime.bigint();
  try {
    const W = mkWorld(); const now = Date.now();
    for (const u of Object.keys(W.A)) { const active = BOTS.isBot(u) || now - ((S.meta[u] || {}).lastSeen || 0) < ACTIVE_WINDOW; core.tick(W, u, active, rng); }
    manageBots(W);
    for (const u of Object.keys(W.A)) if (BOTS.isBot(u)) { try { BOTS.turn(W, u, W.cfg); } catch (e) { logErr('AI nation error: ' + (e.stack || e)); } }
    pactCheck(W); councilWatch(W); botVotes(W); councilResolve(W);
    if (!RH.length || now - RH[RH.length - 1].t >= HOUR) rankPoint(W);
    W.welcome = null; commit(W);
    // world events
    if (S.event && now >= S.event.end) endEvent();
    if (!S.event && S.config.eventsOn && now >= S.nextEvent && Object.keys(W.A).length >= 2) { const keys = Object.keys(WP.EVENTS).filter(k => k !== S.lastEventKey); startEvent(keys[Math.floor(rng() * keys.length)]); }
    readyReminders(W); smartReminders(W); runSchedule();
    nightlyBackup(); if (now - lastSnap >= 10 * 60e3) takeSnap();
  } catch (e) { logErr('World update failed: ' + (e.stack || e)); }
  health.loopMs = Number(process.hrtime.bigint() - t0) / 1e6;
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
// ---------- ranking history: one point an hour per nation (score, GDP, military power, provinces), kept 7 days ----------
// Kept in its own file so the main save stays small. Served gzipped to the Rankings page.
const RANK_FILE = path.join(DATA_DIR, 'rankhist.json'); let RH = [], rhGz = null;
try { RH = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); if (!Array.isArray(RH)) RH = []; } catch (e) { RH = []; }
function rankPoint(W) {
  const n = {}; for (const u of Object.keys(W.A)) n[u] = [core.score(W, u), Math.round(W.A[u].gdp || 0), Math.round(core.power(W, u)), core.hexesOf(W, u).length];
  const now = Date.now(); RH.push({ t: now, n }); RH = RH.filter(p => now - p.t <= 7 * 24 * HOUR); rhGz = null;
  try { fs.writeFileSync(RANK_FILE + '.tmp', JSON.stringify(RH)); fs.renameSync(RANK_FILE + '.tmp', RANK_FILE); } catch (e) { logErr('Could not save ranking history: ' + e.message); }
}
function rankHistBody() { if (!rhGz) rhGz = zlib.gzipSync(JSON.stringify({ v: 1, fields: ['score', 'gdp', 'power', 'prov'], points: RH })); return rhGz; }

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
    fs.writeFileSync(path.join(BACKUP_DIR, `world-${day}.json`), JSON.stringify(S)); S.lastBackup = day; S.lastBackupT = Date.now(); persist();
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
  delete S.users[id]; delete S.meta[id]; delete S.actlog[id]; delete S.mail[id]; delete S.notes[id]; delete S.push[id]; broadcast('user', { id, name: null }); persist();
}
// per-player action history for the admin "what happened" timeline (last 150 commands, including refused ones)
const ACT_SKIP = new Set(['seen', 'ping', 'readlog']);
function actLog(uid, W, b, ok, msg) {
  if (!b || typeof b.c !== 'string' || ACT_SKIP.has(b.c)) return;
  const tv = typeof b.v === 'string' && W.A[b.v] ? W.A[b.v].name : null;
  const brief = x => { try { return JSON.stringify(x).slice(0, 80); } catch (e) { return '?'; } };
  const extra = ['k', 'kind', 'op', 'r', 'q', 'buy', 'h', 'x', 'air', 'i', 'on', 't', 'g', 'amt', 'repay', 'give', 'want', 'b'].filter(k => b[k] != null && b[k] !== '').map(k => `${k}=${typeof b[k] === 'object' ? brief(b[k]) : String(b[k]).slice(0, 24)}`).join(' ');
  const L = S.actlog[uid] = S.actlog[uid] || [];
  L.unshift({ t: Date.now(), c: b.c.slice(0, 24), v: tv, x: extra || null, ok, m: String(msg || '').replace(/<[^>]*>/g, '').slice(0, 180) });
  if (L.length > 150) L.length = 150;
}
// a light summary of one nation in each snapshot, for the admin timeline chart (cached; snapshots never change)
const snapCache = new Map(), provCount = n => new Set([...Object.keys(n.hexes || {}), String(n.cap)]).size;
// strikes from before the launch history existed: rebuild them from the ruins they left
if (!S.nukesBackfilled) {
  for (const [k, n] of Object.entries(S.docs)) if (k.startsWith('nations/') && n && n.nuked && n.nuked.h != null && !S.nukes.some(x => x.t === n.nuked.t)) {
    const by = S.docs['nations/' + n.nuked.by]; S.nukes.push({ by: n.nuked.by, byName: n.nuked.byName, to: k.slice(8), toName: n.name, from: by ? by.cap : null, h: n.nuked.h, place: core.pname(n.nuked.h), retaliation: false, t: n.nuked.t });
  }
  S.nukes.sort((a, b) => b.t - a.t); S.nukesBackfilled = true;
}
function snapSummary(sn) {
  if (snapCache.has(sn.name)) return snapCache.get(sn.name);
  let out = null;
  try {
    const st = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, sn.name)))); out = {};
    for (const [id, n] of Object.entries(st.nations || {})) out[id] = { name: n.name, cash: Math.round(n.cash || 0), debt: Math.round(n.debt || 0), prov: provCount(n), troops: n.troops || 0, ships: n.ships || 0, air: n.air || 0, pop: Math.round(n.pop || 0), ap: Math.round(n.approval || 0), st: Math.round(n.stability || 0), food: Math.round((n.res || {}).food || 0), oil: Math.round((n.res || {}).oil || 0), steel: Math.round((n.res || {}).steel || 0), goods: Math.round((n.res || {}).goods || 0) };
  } catch (e) { out = null; }
  snapCache.set(sn.name, out); if (snapCache.size > 200) snapCache.delete(snapCache.keys().next().value);
  return out;
}
function timeline(id) {
  const u = S.users[id], n = S.docs['nations/' + id], names = new Set([u && u.name, n && n.name].filter(Boolean)), ev = [];
  for (const a of S.actlog[id] || []) ev.push({ t: a.t, k: a.ok ? 'action' : 'refused', x: `${a.c}${a.v ? ' → ' + a.v : ''}${a.x ? ' (' + a.x + ')' : ''}${a.m ? ': ' + a.m : ''}` });
  for (const l of (n && n.log) || []) ev.push({ t: l.t, k: 'game', x: String(l.x) });
  for (const o of S.notes[id] || []) ev.push({ t: o.t, k: 'note', x: `[${o.kind}] ${o.text}` });
  for (const f of S.flags) if (f.uid === id) ev.push({ t: f.t, k: 'flag', x: f.r });
  for (const r of S.reports) if (r.about === id) ev.push({ t: r.t, k: 'report', x: `Reported by ${r.byName || '?'}: ${r.reason}` });
  for (const a of S.audit) if (a.target && names.has(a.target)) ev.push({ t: a.t, k: 'admin', x: `${a.by}: ${a.action}${a.detail ? ' — ' + a.detail : ''}` });
  for (const x of S.nukes) if (x.by === id || x.to === id) ev.push({ t: x.t, k: 'nuke', x: `${x.byName} ${x.retaliation ? 'retaliated against' : 'struck'} ${x.toName} at ${x.place}` });
  for (const m of (S.docs['chat/' + id] || {}).m || []) ev.push({ t: m.t, k: 'chat', x: String(m.x || '') });
  ev.sort((a, b) => b.t - a.t);
  // one point per hour from the rollback snapshots
  const snaps = listSnaps().filter(x => x.tag !== 'undo'), hist = []; let lastH = -1;
  for (const sn of snaps.slice().reverse()) { const hr = Math.floor(sn.t / HOUR); if (hr === lastH) continue; lastH = hr; const sm = snapSummary(sn); if (sm) hist.push({ t: sn.t, snap: sn.name, ...(sm[id] || { gone: true }) }); }
  if (n) hist.push({ t: Date.now(), now: true, cash: Math.round(n.cash || 0), debt: Math.round(n.debt || 0), prov: provCount(n), troops: n.troops || 0, ships: n.ships || 0, air: n.air || 0, pop: Math.round(n.pop || 0), ap: Math.round(n.approval || 0), st: Math.round(n.stability || 0) });
  return { events: ev.slice(0, 600), hist, snaps: snaps.map(x => ({ name: x.name, t: x.t })) };
}
// put one nation back the way it was in a snapshot without touching anyone else. Its relations, open deals, laws, wonders and
// warhead stay as they are now (those involve other nations); provinces another nation holds now are left with that nation.
const RESTORE_FIELDS = ['cash', 'pop', 'troops', 'ships', 'air', 'spies', 'xp', 'tech', 'train', 'infra', 'fort', 'tax', 'approval', 'stability', 'aggr', 'debt', 'unemp', 'infl', 'health', 'edu', 'morale', 'gdp', 'gdpHist', 'budget', 'cards', 'nextCard', 'cnt', 'laws', 'exped', 'mis', 'proj', 'gov', 'nextElection'];
function restoreNation(id, snapName, by) {
  const sn = listSnaps().find(x => x.name === snapName); if (!sn) throw Object.assign(new Error('That snapshot no longer exists.'), { status: 404 });
  const st = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, sn.name)))), old = (st.nations || {})[id];
  if (!old) throw Object.assign(new Error('This player had no nation at that time.'), { status: 400 });
  const W = mkWorld(), cur = W.A[id], OWN = core.computeOwn(W.A), mine = h => !OWN[h] || OWN[h].u === id;
  if (cur && cur.created !== old.created) throw Object.assign(new Error(`They founded ${cur.name} after that time, so that is a different nation. To bring the old one back, reset their current nation first, then restore.`), { status: 400 });
  if (!cur && !mine(old.cap)) throw Object.assign(new Error(`Their old capital now belongs to ${W.A[OWN[old.cap].u].name}, so the nation cannot be brought back. Try an earlier snapshot or reset them.`), { status: 400 });
  takeSnap('undo');
  let kept = 0, skipped = 0; const hexes = {};
  for (const [h, v] of Object.entries(old.hexes || {})) { if (mine(h)) { hexes[h] = v; kept++; } else skipped++; }
  if (cur) for (const [h, v] of Object.entries(cur.hexes || {})) if (!(h in hexes)) hexes[h] = v; // never take away land they hold now
  let n;
  if (cur) { // offers made after the snapshot hold goods the snapshot's stockpiles still include: drop them without a refund
    const had = new Set((old.offOut || []).map(o => o.id));
    for (const o of [...(cur.offOut || [])]) if (!had.has(o.id)) { cur.offOut = cur.offOut.filter(x => x.id !== o.id); const t = W.A[o.to]; if (t) { t.offIn = (t.offIn || []).filter(x => x.id !== o.id); W.changed.add(o.to); } }
  }
  if (cur) { n = cur; for (const k of RESTORE_FIELDS) if (old[k] !== undefined) n[k] = JSON.parse(JSON.stringify(old[k])); n.res = { ...(old.res || {}) }; n.frozen = old.frozen || null; n.hexes = hexes; } // a freeze holds treasury money, so it goes back with the cash
  else {
    n = JSON.parse(JSON.stringify(old)); n.hexes = hexes; n.rel = {}; n.offOut = []; n.offIn = []; n.warhead = null;
    for (const [v, x] of Object.entries(W.A)) if (x.rel && x.rel[id]) { delete x.rel[id]; W.changed.add(v); } // a clean diplomatic slate: no leftover wars
    const held = new Set(); for (const x of Object.values(W.A)) for (const k of Object.keys(x.wonders || {})) held.add(k);
    for (const k of Object.keys(n.wonders || {})) if (held.has(k)) delete n.wonders[k];
    S.fallen = S.fallen.filter(f => !(f.id === id && f.t >= sn.t)); delete meta(id).fallen;
  }
  if (n.proj && core.wonderHolder(W, n.proj.k) && core.wonderHolder(W, n.proj.k) !== id) n.proj = null; // someone else finished that wonder since
  n.cd = {}; n.lastTick = Date.now(); W.A[id] = n; W.changed.add(id); W.OWN = core.computeOwn(W.A); commit(W);
  const when = new Date(sn.t).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (!cur) sendTo(id, 'reload', { t: Date.now() });
  addNote(id, 'admin', `An administrator restored your nation to how it was at ${when} (Mountain time).`);
  audit(by, 'Restored nation from snapshot', (S.users[id] || {}).name, `${n.name} to ${when}${skipped ? `; ${skipped} province(s) now held by others were left with them` : ''}`);
  return { kept, skipped, revived: !cur };
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
    health: { uptime: now - START, memoryMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), dataBytes, lastSave: health.lastSave, loopMs: health.loopMs, saveMs: health.saveMs, saveError: health.saveError, dataDir: DATA_DIR,
      onVolume: volume ? path.resolve(DATA_DIR).startsWith(path.resolve(volume)) : null, volume, streams: clients.size, online, reqs5, cmds: health.cmds, pushes: health.pushes, errors24: health.errors.filter(e => now - e.t < 864e5).length,
      node: process.version, load: os.loadavg()[0], accounts: Object.keys(S.users).length, nations: Object.keys(nations).length, sessions: Object.keys(S.sessions).length, scenarios: SCENARIOS.length, lastBackup: S.lastBackupT || (S.lastBackup ? Date.parse(S.lastBackup + 'T09:00:00Z') : null), pushSubs: Object.values(S.push).reduce((a, s) => a + s.length, 0) },
    players, bots, botTarget: botTarget(W), flags: S.flags.slice(0, 300), audit: S.audit.slice(0, 200), errors: health.errors.slice(0, 50), shared, config: S.config, nukes: S.nukes.slice(0, 50), resNames: Object.fromEntries(Object.entries(WP.RESOLUTIONS).map(([k, r]) => [k, r.n])),
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
      for (const k of ['war', 'signups', 'botRetire', 'eventsOn', 'conquest', 'weakRule', 'nukeTest', 'councilAuto']) if (c[k] != null) nc[k] = !!c[k];
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
    case '/api/admin/timeline': { if (!u) return send(res, 404, { error: 'Unknown player.' }); return send(res, 200, timeline(b.id)); }
    case '/api/admin/restore-nation': {
      if (!u) return send(res, 404, { error: 'Unknown player.' }); if (b.confirm !== 'RESTORE') return send(res, 400, { error: 'Type RESTORE to confirm.' });
      try { return send(res, 200, { ok: true, ...restoreNation(b.id, String(b.snap || ''), me.name) }); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
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
      S.flags = []; S.council = { props: [], active: {} }; S.event = null; RH = []; rhGz = null; try { fs.unlinkSync(RANK_FILE); } catch (e) {} broadcast('council', councilView()); broadcast('event', null);
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
    if (req.method === 'GET' && p === '/api/nukes') return send(res, 200, { nukes: S.nukes.slice(0, 50) });
    if (req.method === 'GET' && p === '/api/rankhist') {
      const gz = rankHistBody(), hdr = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...hdr, 'Content-Encoding': 'gzip' }); return res.end(gz); }
      res.writeHead(200, hdr); return res.end(zlib.gunzipSync(gz));
    }
    if (req.method === 'GET' && p === '/api/fairplay') {
      const c = effCfg(), keys = ['cd', 'income', 'xp', 'protectH', 'lastStandH', 'war', 'conquest', 'weakRule', 'councilAuto', 'nukeTest', 'bots', 'botWar', 'electionH', 'eventsOn', 'signups'];
      return send(res, 200, { fingerprint: FINGERPRINT, files: CODE, live: START, releases: S.releases.slice(0, 50), log: S.fairlog.slice(0, 500), logTotal: S.fairlog.length,
        settings: Object.fromEntries(keys.map(k => [k, c[k]])), defaults: Object.fromEntries(keys.map(k => [k, WP.DEFCFG[k]])), boost: c.boost || null, council: S.council.active, event: S.event,
        world: { nations: Object.keys(S.docs).filter(k => k.startsWith('nations/')).length, players: Object.keys(S.users).length } }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/api/public/stats') return send(res, 200, publicStats(), { 'Cache-Control': 'public, max-age=30' });
    if (req.method === 'GET' && p === S.adminPath) { const me = auth(req); if (!me || !me.admin) return notFound(req, res); return serveStatic(req, res, ADMIN_HTML); }
    if (req.method === 'GET' && p.startsWith('/n/')) return await nationPage(req, res, p.slice(3));
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
    if (p.startsWith('/api/admin/')) return await adminRoute(p, req, res, me); // await, so its errors reach the catch below and always get an answer

    if (p === '/api/stream' && req.method === 'GET') {
      if (clients.size >= 5000) return send(res, 503, { error: 'The server is very busy. Try again shortly.' });
      touch(me.id, req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n'); write({ res }, 'init', snapshot(me.id));
      const mine = [...clients].filter(x => x.uid === me.id); if (mine.length >= 6) { try { mine[0].res.end(); } catch (e) {} clients.delete(mine[0]); }
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
      if (b.c === 'flag' && typeof b.motto === 'string' && MOD.isProfane(b.motto)) return send(res, 400, { error: 'Please choose a different motto.' });
      if (b.c === 'offer' && b.v && S.users[b.v] && sharesNetwork(me.id, b.v)) flag(me.id, `Sent a trade offer to ${(S.users[b.v] || {}).name || 'a player'}, who uses the same network (possible second account)`);
      let r;
      try { r = core.exec(W, me.id, b, rng); }
      catch (e) { if (e.user) { actLog(me.id, W, b, false, e.message); return send(res, 400, { error: e.message }); } throw e; }
      actLog(me.id, W, b, true, r.msg); pactCheck(W);
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

// last line of defence: whatever goes wrong, the request still gets an answer instead of hanging
http.createServer((req, res) => handle(req, res).catch(e => { try { if (!res.headersSent) send(res, e && e.status || 500, { error: e && e.status ? e.message : 'Server error.' }); else res.end(); } catch (_) {} if (!(e && e.status)) logErr('Request error: ' + (e && e.stack || e)); })).listen(PORT, () => {
  console.log(`World Powers is running on http://localhost:${PORT}`);
  console.log(`Saving the world to ${FILE}`);
  console.log(`Admin page (only works for admin accounts): ${S.adminPath}`);
  if (!Object.keys(S.users).length) console.log('The first account to sign up becomes the admin' + (ADMIN_EMAIL ? ` (and so will ${ADMIN_EMAIL})` : '') + '.');
});
