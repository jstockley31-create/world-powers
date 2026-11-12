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
{ const landT = require('./geo-land.js')(); if (landT) core.setLandTest(landT); } // real coastlines, so nuclear tests happen in open water
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
// World Council votes: players only (AI nations don't vote), 3 hours, a majority of the votes cast wins (at least 2 yes), and a vote closes early once the result is certain
const COUNCIL_H = 3, COUNCIL_MIN_YES = 2;
const HOUR = 36e5;
const ACTIVE_WINDOW = 2 * HOUR; // nations keep producing for 2 hours after their leader was last seen
const NOTE_KINDS = ['ready', 'attack', 'war', 'diplo', 'mail', 'election', 'event', 'council', 'covert', 'economy', 'rank', 'mention', 'admin'];
const DEFAULT_PREFS = { ready: true, attack: true, war: true, diplo: true, mail: true, election: true, event: true, council: true, covert: true, economy: true, rank: false, mention: true, admin: true };

fs.mkdirSync(BACKUP_DIR, { recursive: true });
let S = { users: {}, sessions: {}, docs: {}, meta: {}, flags: [], audit: [], config: { ...WP.DEFCFG } };
try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') { console.error('Could not read', FILE, e.message); process.exit(1); } }
S.config = { ...WP.DEFCFG, ...(S.config || {}) };
if (!S.councilAutoOffV1) { S.config.councilAuto = false; S.councilAutoOffV1 = 1; } // automatic World Council resolutions are off; only players propose
// one-time 24-hour pause on overstretch penalties, starting when this update first boots
if (!S.overPauseSet) { S.overPause = Date.now() + 24 * 36e5; S.overPauseSet = 1; }
if (!S.migLS24) { S.config.lastStandH = 24; S.migLS24 = true; } // the capital warning period became 24 hours
for (const k of ['meta', 'mail', 'notes', 'push', 'stats', 'actlog']) S[k] = S[k] || {};
for (const k of ['polls', 'finance', 'flags', 'audit', 'reports', 'fallen', 'bugs', 'schedule', 'nukes', 'strikes', 'strikeLog', 'ntests', 'ntestPending']) S[k] = S[k] || [];
const voteBonus = n => Math.min(25e6, Math.max(1e6, Math.round((n.gdp || 0) * .01 / 1e5) * 1e5));
// nuclear tests are announced ahead of time; at the scheduled moment everyone gets a 30-second countdown, then the blast
const NT_COUNT = 30e3, oceanPhrase = o => o === 'Hudson Bay' ? 'Hudson Bay' : 'the ' + o;
function armTest(fx) { setTimeout(() => fireTest(fx.id), Math.max(0, fx.go - Date.now())); }
function fireTest(id) {
  const i = S.ntestPending.findIndex(x => x.id === id); if (i < 0) return;
  const fx = { ...S.ntestPending.splice(i, 1)[0], fired: Date.now() }; S.ntests.unshift(fx); S.ntests = S.ntests.slice(0, 50); persist();
  broadcast('ntest', fx);
  setTimeout(() => systemMessage(`☢ NUCLEAR TEST: ${fx.byName} detonated a nuclear device in ${oceanPhrase(fx.ocean)}. The world condemns the test.`), NT_COUNT + 500);
}
// after a restart: re-arm tests still to come; one that should have fired more than 3 minutes ago is simply recorded
setTimeout(() => { for (const fx of S.ntestPending.slice()) { if (Date.now() - fx.go > 3 * 60e3) { S.ntestPending = S.ntestPending.filter(x => x.id !== fx.id); S.ntests.unshift({ ...fx, fired: fx.go, missed: true }); } else armTest(fx); } }, 2000);
// provinces still burning after air and missile strikes: { province: { t: last hit, n: hits } }. Fires smoulder for a day; a new hit re-ignites them.
const BURN_MS = 24 * HOUR; S.burn = S.burn && typeof S.burn === 'object' && !Array.isArray(S.burn) ? S.burn : {};
function burnList() { const now = Date.now(), out = []; for (const [h, b] of Object.entries(S.burn)) { if (now - b.t < BURN_MS) out.push([+h, b.t, b.n]); else delete S.burn[h]; } return out; }
S.council = S.council || { props: [], active: {} };
S.blocs = Object.assign(Object.create(null), S.blocs && typeof S.blocs === 'object' ? S.blocs : {}); // alliances (teams)
S.crisis = S.crisis || null; S.crisisHist = S.crisisHist || []; S.games = S.games || null; S.gamesHist = S.gamesHist || []; S.dis = Array.isArray(S.dis) ? S.dis : []; if (!S.nextGames) S.nextGames = Date.now() + 12 * HOUR; if (!S.nextDis) S.nextDis = Date.now() + 3 * HOUR; if (!S.nextCrisis) S.nextCrisis = Date.now() + 36 * HOUR; // world crises
// the Council no longer raises inspection votes on its own (nuclear nations pay a daily inspection fee instead): withdraw any that are still open
for (const p of S.council.props || []) if (p.status === 'open' && p.auto && p.type === 'inspect') { p.status = 'failed'; p.result = 'withdrawn'; p.end = Date.now(); }
if (S.mapVersion !== MAP_VERSION) {
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/') || k.startsWith('online/') || (k.startsWith('chat/') && k !== 'chat/_system')) delete S.docs[k];
  S.council = { props: [], active: {} }; S.event = null; S.blocs = Object.create(null); S.crisis = null; S.games = null; S.dis = []; S.mapVersion = MAP_VERSION;
}
// every id-keyed map gets no prototype, so ids like "__proto__" or "constructor" can never match anything
for (const k of ['users', 'sessions', 'docs', 'meta', 'mail', 'notes', 'push', 'stats', 'actlog']) S[k] = Object.assign(Object.create(null), S[k]);
if (!S.adminPath) S.adminPath = '/hq-' + crypto.randomBytes(12).toString('hex');
if (!S.vapid) S.vapid = PUSH.makeVapid();
if (!S.nextEvent) S.nextEvent = Date.now() + 6 * HOUR;
// ---------- fair play: a fingerprint of the exact game code running, its release history, and a public log of admin game actions ----------
const FAIR_ACTIONS = new Set(['Changed game settings', 'Edited nation', 'Reset nation', 'Rolled back the world', 'Wiped the world', 'Started world event', 'Ended world event', 'Scheduled', 'Cancelled scheduled event', 'Cancelled council vote', 'Added AI nation', 'Removed AI nation', 'Restored nation from snapshot', 'Started the World Games', 'Ended the World Games', 'Triggered a disaster', 'Triggered a nuclear accident', 'Started world crisis', 'Ended world crisis', 'Disbanded alliance']);
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
STATIC['/hof'] = loadFile('hof.html', HTML, 'no-cache'); STATIC['/play'] = GAME; STATIC['/terms'] = loadFile('terms.html', HTML, 'no-cache'); STATIC['/privacy'] = loadFile('privacy.html', HTML, 'no-cache'); STATIC['/fair'] = loadFile('fair.html', HTML, 'no-cache'); STATIC['/faq'] = loadFile('faq.html', HTML, 'no-cache');
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
// same network = a home connection both accounts used. An address many players share (satellite internet like Starlink, mobile carriers,
// schools: one public address for thousands of people) says nothing about who owns an account, so it doesn't count.
let ipUseT = 0, ipUse = new Map();
const ipUsers = ip => { if (Date.now() - ipUseT > 60e3) { ipUse = new Map(); for (const m of Object.values(S.meta)) for (const x of new Set((m && m.ips) || [])) ipUse.set(x, (ipUse.get(x) || 0) + 1); ipUseT = Date.now(); } return ipUse.get(ip) || 0; };
const SHARED_IP = 4;
const sharesNetwork = (a, b) => { const A = (S.meta[a] || {}).ips || [], B = (S.meta[b] || {}).ips || []; return A.some(ip => B.includes(ip) && ipUsers(ip) < SHARED_IP); };
const isMuted = uid => (S.users[uid] && S.users[uid].mutedUntil || 0) > Date.now();
const nationName = uid => (S.docs['nations/' + uid] || {}).name || (S.users[uid] || {}).name || 'Unknown';

// ---------- what other players may see ----------
function publicView(n) {
  return { name: n.name, color: n.color, gov: n.gov, created: n.created, cap: n.cap, hexes: n.hexes, xp: n.xp, pop: n.pop, troops: n.troops, ships: n.ships, air: n.air, tech: n.tech, train: n.train, infra: n.infra, fort: n.fort,
    approval: n.approval, stability: n.stability, aggr: n.aggr, bloc: n.bloc || null, dev: n.dev || {}, prestige: n.prestige || 0, medals: n.medals || null, regroup: n.regroup, lastStand: n.lastStand || 0, overlord: n.overlord || null, vassalT: n.vassalT || 0, office: n.office || 0, outposts: n.outposts || null, titles: n.titles || null, shield: n.shield || 0, gens: (n.gens || []).map(g => ({ name: g.name, type: g.type, stars: g.stars })), laws: n.laws || [], wonders: n.wonders || {}, proj: n.proj ? { k: n.proj.k, stage: n.proj.stage } : null, flag: n.flag || null, motto: n.motto || '', ach: n.ach || {}, nuke: n.nuke || 0, warhead: n.warhead ? (n.warhead.ready <= Date.now() ? 2 : 1) : 0, nuked: n.nuked || null, dome: n.dome ? { t: n.dome.t, ready: n.dome.ready, lvl: n.dome.lvl || 1, off: (n.cash || 0) < 0 } : null, rad: n.rad && n.rad.until > Date.now() ? { h: n.rad.h, t: n.rad.t, until: n.rad.until } : undefined, fallout: n.fallout || 0, winter: n.winter || 0, rogue: n.rogue || 0, armsEmb: n.armsEmb || 0, condemned: n.condemned || 0, ceasefire: n.ceasefire || 0, guarantee: n.guarantee || 0, inspected: n.inspected || 0, frozen: n.frozen ? { amt: n.frozen.amt, until: n.frozen.until } : null, conqN: Object.keys(n.conq || {}).length, rel: n.rel, trades: n.trades, res: { oil: n.res && n.res.oil > 0 ? 1 : 0 }, ai: n.ai ? { p: n.ai.p, boss: !!n.ai.boss, ...(n.ai.defX ? { defX: n.ai.defX } : {}), ...(n.ai.atkX ? { atkX: n.ai.atkX } : {}) } : undefined,
    gdp: n.gdp, gdpHist: n.gdpHist, debt: n.debt, unemp: n.unemp, infl: n.infl, morale: n.morale, defaulted: n.defaulted, embargo: n.embargo, nextElection: n.nextElection, lastElection: n.lastElection,
    out: (n.out || []).filter(e => e.type === 'news' || e.type === 'battle').slice(0, 30).map(e => e.type === 'battle' ? { id: e.id, t: e.t, type: e.type, to: e.to, h: e.h, X: e.X, win: e.win, lossA: e.lossA, lossD: e.lossD, sea: e.sea, vassal: e.vassal || 0 } : e) };
}

// ---------- live stream ----------
const clients = new Set();
function write(c, event, data) { if (c.res.writableEnded || c.res.destroyed) { clients.delete(c); return; } try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} }
function writeRaw(c, str) { if (c.res.writableEnded || c.res.destroyed) { clients.delete(c); return; } try { c.res.write(str); } catch (e) {} }
function broadcast(event, data) { if (!clients.size) return; const str = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) writeRaw(c, str); }
// ---- polls: questions the admin sends to every player; each player sees the pop-up once (answer or skip) ----
const pollOpen = q => q && q.active && (!q.ends || q.ends > Date.now());
const pollPublic = q => ({ id: q.id, title: q.title, intro: q.intro, questions: q.questions, ends: q.ends || 0 });
const pollFor = uid => S.polls.filter(q => pollOpen(q) && !(q.answers || {})[uid] && !(q.skips || {})[uid]).slice(0, 3).map(pollPublic);
function sendTo(uid, event, data) { for (const c of clients) if (c.uid === uid) write(c, event, data); }
const isOnline = uid => [...clients].some(c => c.uid === uid);
// serialize once per nation (one copy for its owner, one public copy for everyone else) instead of once per connected player
function sendNation(id) {
  if (!clients.size) return; const n = S.docs['nations/' + id];
  const pub = `event: doc\ndata: ${JSON.stringify({ col: 'nations', id, data: n == null ? null : publicView(n) })}\n\n`;
  let own = null; for (const c of clients) { if (c.uid === id && n != null) { own = own || `event: doc\ndata: ${JSON.stringify({ col: 'nations', id, data: n })}\n\n`; writeRaw(c, own); } else writeRaw(c, pub); }
}
function setDoc(col, id, data) { const key = col + '/' + id; if (data == null) delete S.docs[key]; else S.docs[key] = data; persist(); if (col === 'nations') sendNation(id); else broadcast('doc', { col, id, data: data == null ? null : data }); }
const playerVotes = v => Object.fromEntries(Object.entries(v || {}).filter(([u]) => !BOTS.isBot(u)));
const anonVotes = p => { const v = { ...(p.votes || {}) }; if (v[p.by] != null) { v['anon:' + p.id] = v[p.by]; delete v[p.by]; } return v; }; // the secret proposer's vote still counts, without their name
const councilView = () => ({ props: S.council.props.slice(0, 40).map(({ debts, net, ...p }) => (p.anon ? { ...p, by: null, votes: playerVotes(anonVotes(p)) } : { ...p, votes: playerVotes(p.votes) })), active: S.council.active, pacts: (S.council.pacts || []).filter(x => x.until > Date.now()), decl: (S.council.decl || []).filter(x => x.until > Date.now()) });
// alliances: everyone sees names, flags, members, projects and treasuries; only members read their own message board
function blocsView(uid) { const out = {}; for (const [id, b] of Object.entries(S.blocs)) { const mem = (b.members || []).includes(uid); out[id] = { ...b, wall: mem ? (b.wall || []) : [], log: mem ? (b.log || []) : [] }; } return out; }
const crisisView = () => S.crisis ? { ...S.crisis } : null;
const disView = () => S.dis.filter(d => Date.now() < d.until + 6 * HOUR);
function sendBlocs() { for (const c of clients) write(c, 'blocs', blocsView(c.uid)); }
function snapshot(uid) {
  const cols = {}; for (const c of COLS) cols[c] = {};
  for (const [p, d] of Object.entries(S.docs)) { const [c, id] = p.split('/'); if (!cols[c]) continue; cols[c][id] = c === 'nations' && id !== uid ? publicView(d) : d; }
  const users = {}; for (const [id, u] of Object.entries(S.users)) if (!u.banned) users[id] = u.name;
  return { voteAt: meta(uid).voteT || 0, cols, users, config: (({ boss, ...c }) => c)(effCfg()), awaySince: meta(uid).prevSeen || 0, council: councilView(), polls: pollFor(uid), nukes: S.nukes.filter(x => Date.now() - x.t < 12 * HOUR), blocs: blocsView(uid), crisis: crisisView(), games: S.games, dis: disView(), event: S.event, notes: (S.notes[uid] || []).slice(0, 60), mailUnread: (S.mail[uid] || []).filter(m => m.box === 'in' && !m.read).length, prefs: prefsOf(uid), muted: meta(uid).muted || [], vapid: PUSH.vapidPublic(S.vapid), pushOn: (S.push[uid] || []).length > 0, fallen: S.docs['nations/' + uid] ? null : (meta(uid).fallen || null), fallenList: S.fallen.slice(0, 30), strikes: S.strikes.filter(x => Date.now() - x.t < 20 * 60e3), ver: GAME.etag, burn: burnList(), ntests: S.ntests.filter(x => Date.now() - (x.fired || x.t) < 3 * 60e3 && !x.missed), ntestPending: S.ntestPending };
}
// a visible heartbeat every 20 seconds: browsers that hear nothing for a while know their stream has stalled and reconnect
setInterval(() => { const hb = `event: hb\ndata: ${Date.now()}\n\n`; for (const c of clients) writeRaw(c, hb); }, 20000).unref();
function systemMessage(text) { const doc = S.docs['chat/_system'] || { m: [] }; doc.m = [{ t: Date.now(), x: String(text).slice(0, 2000) }, ...(doc.m || [])].slice(0, 40); setDoc('chat', '_system', doc); }

// ---------- notifications (in-game bell + phone/desktop push) ----------
const prefsOf = uid => ({ ...DEFAULT_PREFS, ...(meta(uid).prefs || {}) });
function addNote(uid, kind, text, url) {
  if (!S.users[uid]) return; // AI nations have no inbox
  const n = { id: rid(), t: Date.now(), kind, text: String(text).slice(0, 1000), read: false };
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
  c.overPause = S.overPause || 0;
  c.season = S.seasons && S.seasons.cur && S.seasons.cur.status === 'live' ? S.seasons.cur.id : null;
  c.countdown = S.countdown && S.countdown.at + 2 * HOUR > now ? { id: S.countdown.id, text: S.countdown.text, at: S.countdown.at } : null;
  c.bossPause = (S.bossFell || 0) + bossBreatherH() * HOUR > now; // a breather after the Rising Power falls
  return c;
}
const bossBreatherH = () => { const h = +((S.config.boss || {}).breatherH); return isFinite(h) && h >= 0 ? h : 48; };
const extW = () => ({ games: S.games, dis: S.dis });
const mkWorld = () => core.world(nationsMap(), effCfg(), Date.now(), S.event, S.council, S.blocs, S.crisis, extW());
// how long a nuclear missile takes to reach its target on everyone's globe (the client uses the same formula), plus the camera's lead-in
function nukeFlightMs(fx) { const a = core.P[fx.from], b = core.P[fx.h]; if (!a || !b) return 4000; const r = Math.PI / 180, s2 = Math.sin((b.c[1] - a.c[1]) * r / 2) ** 2 + Math.cos(a.c[1] * r) * Math.cos(b.c[1] * r) * Math.sin((b.c[0] - a.c[0]) * r / 2) ** 2, d = 2 * Math.asin(Math.min(1, Math.sqrt(s2))); return Math.round(Math.max(26000, Math.min(48000, 26000 + d * 9000)) + 1500); }
function commit(W) {
  for (const f of W.fallen || []) {
    { const was = S.docs['nations/' + f.id]; if (was && was.ai && was.ai.boss) { S.bossFell = Date.now(); systemMessage(`🎉 The Rising Power ${f.name} has fallen to ${f.byName}! The world is safe — for now. Another power may rise in ${bossBreatherH()} hours.`); broadcast('announce', { text: `The Rising Power ${f.name} has fallen!` }); } }
    delete S.docs['nations/' + f.id];
    const rec = { t: f.t, id: f.id, name: f.name, color: f.color, by: f.by, byName: f.byName, days: Math.round(f.days * 10) / 10, rank: f.peakRank, leader: BOTS.isBot(f.id) ? null : (S.users[f.id] || {}).name || null, ai: BOTS.isBot(f.id) };
    S.fallen.unshift(rec); S.fallen = S.fallen.slice(0, 100);
    if (!BOTS.isBot(f.id)) { meta(f.id).fallen = rec; sendTo(f.id, 'fallen', rec); addNote(f.id, 'attack', `${f.name} has fallen. ${f.byName} captured your capital. You can found a new nation at any time.`); }
    sendNation(f.id);
    broadcast('announce', { text: `${f.name} has fallen to ${f.byName}.` }); broadcast('fallenlist', S.fallen.slice(0, 30));
  }
  rebelSpawn(W);
  for (const u of W.changed) { if (W.A[u]) S.docs['nations/' + u] = W.A[u]; sendNation(u); }
  if (W.bch) { W.bch = false; persist(); sendBlocs(); }
  if (W.crch) { W.crch = false; persist(); broadcast('crisis', crisisView()); }
  if (W.gch) { W.gch = false; persist(); broadcast('games', S.games); }
  if (W.disch) { W.disch = false; persist(); broadcast('dis', disView()); }
  if (W.changed.size) persist();
  for (const nt of W.notes) addNote(nt.u, nt.kind, nt.text);
  // nuclear tests: everyone online watches it happen
  for (const fx of W.ntestFx || []) {
    S.ntestPending.push(fx); if (fx.delay) broadcast('ntestwarn', fx);
    for (const id of Object.keys(S.users)) if (id !== fx.by && S.docs['nations/' + id]) addNote(id, 'war', fx.delay ? `☢ ${fx.byName} will conduct a nuclear test in ${oceanPhrase(fx.ocean)} in ${fx.delay} minutes. Watch it live on the globe.` : `☢ ${fx.byName} is conducting a nuclear test in ${oceanPhrase(fx.ocean)} right now. Watch the globe.`);
    armTest(fx);
  }
  W.ntestFx = [];
  if ((W.strikeFx || []).length) { const now = Date.now(); for (const fx of W.strikeFx) { broadcast('strike', fx); S.strikes.unshift(fx); S.strikeLog.unshift({ t: now, by: fx.by, byName: fx.byName, to: fx.to, toName: fx.toName, kind: fx.kind, n: fx.n, hits: fx.hits, lost: fx.lost, place: fx.place, target: fx.target }); if (!fx.dirty) { const b = S.burn[fx.h]; S.burn[fx.h] = { t: now, n: Math.min(20, (b && now - b.t < BURN_MS ? b.n : 0) + 1) }; } } S.strikes = S.strikes.filter(x => now - x.t < 20 * 60e3).slice(0, 80); S.strikeLog = S.strikeLog.slice(0, 400); burnList(); }
  for (const fx of W.nukeFx || []) {
    const t = fx.intercepted ? `🛡 NUCLEAR MISSILE INTERCEPTED: ${fx.toName}'s Golden Dome destroyed the missile ${fx.byName} fired at ${fx.place}.` : `☢ NUCLEAR DETONATION: ${fx.byName} ${fx.retaliation ? 'retaliated against' : 'struck'} ${fx.toName} at ${fx.place}. Fallout is spreading.`;
    // the chat line lands after the missile's flight, which everyone is watching
    const fl = nukeFlightMs(fx); setTimeout(() => systemMessage(t), fl); broadcast('nuke', fx); S.nukes.unshift(fx); S.nukes = S.nukes.slice(0, 50);
    if (!fx.intercepted) S.burn[fx.h] = { t: Date.now() + fl, n: 20 }; // ground zero burns for a day
    persist();
  }
  if (W.welcome) { systemMessage(W.welcome); broadcast('announce', { text: W.welcome }); }
}
const humans = W => Object.keys(W.A).filter(u => !BOTS.isBot(u));
// provinces that broke away become small AI nations (a few at most; beyond that the land is simply free to settle)
function rebelSpawn(W) {
  const list = W.breakaways || []; W.breakaways = []; if (!list.length) return;
  // provinces that went free are announced together (one message, not one per province)
  const freed = list.filter(b => b.free); if (freed.length) { S.freedQ = (S.freedQ || 0) + freed.length; S.freedLast = freed.slice(-3).map(b => core.pname(b.h)); }
  if (S.freedQ && Date.now() - (S.freedAt || 0) > 6 * 36e5) { systemMessage(`🏴 ${S.freedQ === 1 ? `${S.freedLast[0]} broke away from its empire and is` : `${S.freedQ} provinces broke away from empires recently (${S.freedLast.join(', ')}…) and are`} now free land anyone can settle.`); S.freedQ = 0; S.freedAt = Date.now(); }
  for (const b of list) {
    if (b.free) continue;
    const rebels = Object.values(W.A).filter(n => n.ai && n.ai.rebel).length; if (rebels >= WP.REBEL.maxNations) { S.freedQ = (S.freedQ || 0) + 1; S.freedLast = [...(S.freedLast || []), core.pname(b.h)].slice(-3); continue; }
    const id = 'ai_' + crypto.randomBytes(5).toString('hex'), from = W.A[b.from]; const name = core.foundRebel(W, id, b.h, { color: BOTS.distinctColor(W), dev: b.dev, from: b.from, fromName: b.fromName, tech: from ? from.tech : 2 });
    if (name) { W.changed.add(id); systemMessage(`🏴 ${core.pname(b.h)} has declared independence from ${b.fromName} as ${name}. Its land is up for grabs.`); }
  }
}

// AI nations: keep the configured number, retiring the weakest as real players join.
function botTarget(W) { const real = humans(W).length; const want = Math.max(0, Math.min(30, +S.config.bots || 0)); return S.config.botRetire ? Math.max(0, want - Math.floor(real / 3)) : want; }
function removeBot(W, u, why) { const n = W.A[u]; if (!n) return; delete W.A[u]; W.changed.delete(u); for (const v of Object.keys(W.A)) if (W.A[v].rel && W.A[v].rel[u]) { delete W.A[v].rel[u]; W.changed.add(v); } setDoc('nations', u, null); W.OWN = core.computeOwn(W.A); if (why) systemMessage(`${n.name} (AI) has withdrawn from the world${why === 'retire' ? ' to make room for new leaders' : ''}.`); }
function manageBots(W) {
  const bots = Object.keys(W.A).filter(u => BOTS.isBot(u) && !(W.A[u].ai && W.A[u].ai.rebel)); const target = botTarget(W); // breakaway nations don't count: they exist until someone conquers them
  if (bots.length < target) for (let i = 0; i < target - bots.length; i++) BOTS.spawn(W);
  else if (bots.length > target) { const weakest = bots.filter(b => !(W.A[b].ai && W.A[b].ai.boss)).sort((a, b) => core.score(W, a) - core.score(W, b))[0]; if (weakest) removeBot(W, weakest, 'retire'); } // the Rising Power is never quietly retired: it has to be beaten
}

// ---------- world crises ----------
const CRISIS_DEF = { auto: true, everyD: 4, hours: 24, diff: 'normal', types: ['pandemic', 'asteroid', 'aliens'] };
const crisisCfg = () => { const c = { ...CRISIS_DEF, ...(S.config.crisis || {}) }; c.types = (Array.isArray(c.types) ? c.types : CRISIS_DEF.types).filter(k => WP.CRISES[k]); return c; };
const crisisLive = () => !!(S.crisis && !S.crisis.over && Date.now() < S.crisis.end + 60e3);
function crisisStart(key, hours, diff, by) {
  const K = WP.CRISES[key]; if (!K) throw Object.assign(new Error('Unknown crisis.'), { status: 400 });
  if (crisisLive()) throw Object.assign(new Error('A world crisis is already under way. End it first.'), { status: 400 });
  hours = Math.max(2, Math.min(96, Math.round(+hours || crisisCfg().hours))); diff = WP.CRISIS.diff[diff] ? diff : 'normal';
  let W = mkWorld(); const now = Date.now(); let boss = null;
  if (key === 'boss') {
    boss = Object.keys(W.A).find(u => W.A[u].ai && W.A[u].ai.boss) || null;
    if (!boss) { if (!Object.keys(W.A).some(k => BOTS.isBot(k))) throw Object.assign(new Error('There are no AI nations to become the Rising Power.'), { status: 400 });
      S.bossFell = 0; S.config.aiBoss = true; W = mkWorld(); boss = BOTS.raiseBoss(W, W.cfg, ''); if (!boss) throw Object.assign(new Error('Could not raise a Rising Power right now.'), { status: 400 }); commit(W); W = mkWorld(); }
    S.config.aiBoss = true;
  }
  S.crisis = { id: rid(), key, diff, start: now, end: now + hours * HOUR, goal: core.crisisGoal(W, diff), pool: 0, botPool: 0, contrib: {}, choice: {}, by: by || null };
  if (boss) { S.crisis.boss = boss; S.crisis.bossName = W.A[boss].name; S.crisis.bossProv0 = core.hexesOf(W, boss).length; }
  const t = `${K.ic} WORLD CRISIS — ${K.n}: ${K.d} ${key === 'boss' ? `Bring down ${S.crisis.bossName}` : `The world needs ${WP.moneyS(S.crisis.goal)}`} within ${hours} hours. Cooperate or exploit: choose on your Overview page.`;
  systemMessage(t); broadcast('announce', { text: `World crisis: ${K.n}` }); broadcast('crisis', crisisView());
  for (const u of Object.keys(S.users)) if (S.docs['nations/' + u]) addNote(u, 'event', t);
  persist(); return S.crisis;
}
function crisisFinish(W, ok, why) {
  const cr = S.crisis; if (!cr || cr.over) return; W.CR = cr; const K = WP.CRISES[cr.key];
  let line;
  if (ok === null) { cr.over = Date.now(); cr.ok = null; line = `${K.ic} The world crisis "${K.n}" was called off${why ? ` (${why})` : ''}.`; }
  else { line = core.crisisEnd(W, ok, rng); if (W.impact != null) { S.burn[W.impact] = { t: Date.now(), n: 20 }; burnList(); broadcast('firesout'); } }
  cr.result = line; S.crisisHist.unshift({ id: cr.id, key: cr.key, start: cr.start, over: cr.over, ok: cr.ok, goal: cr.goal, pool: cr.pool, top: cr.top || [], coop: Object.values(cr.choice || {}).filter(x => x === 'coop').length, exploit: Object.values(cr.choice || {}).filter(x => x === 'exploit').length, result: line });
  S.crisisHist = S.crisisHist.slice(0, 30); const c = crisisCfg(); S.nextCrisis = Date.now() + c.everyD * 864e5 * (.8 + rng() * .4);
  W.crch = true; systemMessage(line); broadcast('announce', { text: line.slice(0, 140) }); persist();
}
// AI nations take part: most cooperate and chip in a little now and then (never more than 45% of the goal in total, so players decide the outcome)
function crisisBots(W) {
  const cr = S.crisis; if (!core.crisisOn(W)) return;
  for (const u of Object.keys(W.A)) { if (!BOTS.isBot(u)) continue; const n = W.A[u]; if (n.ai && n.ai.boss) continue; const ch = (cr.choice || {})[u];
    if (!ch) { if (rng() < .03) { const ex = n.ai && n.ai.p === 'warlord' ? .6 : .12; try { core.exec(W, u, { c: 'crisis', op: rng() < ex ? 'exploit' : 'coop' }, rng); } catch (e) { if (!e.user) throw e; } } continue; }
    if (ch === 'coop' && cr.key !== 'boss' && (cr.botPool || 0) < cr.goal * WP.CRISIS.botShare && rng() < 1 / 40) { const a = Math.floor(Math.min((n.cash || 0) * .006, cr.goal * WP.CRISIS.botShare - (cr.botPool || 0))); if (a >= WP.CRISIS.minGive) try { core.exec(W, u, { c: 'crisis', op: 'give', amt: a }, rng); } catch (e) { if (!e.user) throw e; } }
  }
}
function crisisCheck(W) {
  const cr = S.crisis; if (!cr || cr.over) return; const now = Date.now(); W.CR = cr;
  if (cr.key === 'boss') { const b = W.A[cr.boss]; if (!b) return crisisFinish(W, true); if (!(b.ai && b.ai.boss)) return crisisFinish(W, null, 'its backers pulled out'); }
  else if ((cr.pool || 0) >= cr.goal) return crisisFinish(W, true);
  if (now >= cr.end) return crisisFinish(W, false);
}
function crisisLoop(W) {
  const now = Date.now(), c = crisisCfg();
  if (S.crisis && !S.crisis.over) { crisisBots(W); crisisCheck(W); return; }
  if (S.crisis && S.crisis.over && now - S.crisis.over > 12 * HOUR) { S.crisis = null; W.crch = true; }
  if (c.auto && c.types.length && now >= S.nextCrisis && !crisisLive() && humans(W).length >= 2) {
    const last = (S.crisisHist[0] || {}).key, pool = c.types.filter(k => k !== last); const key = (pool.length ? pool : c.types)[Math.floor(rng() * (pool.length || c.types.length))];
    S.nextCrisis = now + HOUR; setTimeout(() => { try { crisisStart(key, c.hours, c.diff, null); } catch (e) { S.nextCrisis = Date.now() + 6 * HOUR; } }, 0); // after this world update has been saved
  }
}
// ---------- the World Games ----------
const GAMES_DEF = { auto: true, everyD: 3, hours: 24 };
const gamesCfg = () => ({ ...GAMES_DEF, ...(S.config.games || {}) });
function gamesStart(hours, by) {
  if (S.games && !S.games.over) throw Object.assign(new Error('The World Games are already on.'), { status: 400 });
  hours = Math.max(2, Math.min(96, Math.round(+hours || gamesCfg().hours))); const now = Date.now();
  S.games = { id: rid(), start: now, end: now + hours * HOUR, inv: {}, spent: {}, botSpent: 0, by: by || null };
  const t = `🏅 THE WORLD GAMES HAVE BEGUN! For ${hours} hours nations compete in Athletics, the Science Expo and the Culture Festival. Invest on your Overview page: gold, silver and bronze bring prestige and approval.`;
  systemMessage(t); broadcast('announce', { text: 'The World Games have begun!' }); broadcast('games', S.games); for (const u of Object.keys(S.users)) if (S.docs['nations/' + u]) addNote(u, 'event', t); persist();
}
function gamesFinish(W) { const G = S.games; if (!G || G.over) return; W.G = G; const line = core.gamesEnd(W); S.gamesHist.unshift({ id: G.id, start: G.start, over: G.over, results: G.results, champ: G.champ || null }); S.gamesHist = S.gamesHist.slice(0, 20); S.nextGames = Date.now() + gamesCfg().everyD * 864e5 * (.85 + rng() * .3); W.gch = true; systemMessage(line); broadcast('announce', { text: line.slice(0, 140) }); persist(); }
function gamesLoop(W) {
  const now = Date.now(), c = gamesCfg(), G = S.games;
  if (G && !G.over) {
    if (now >= G.end) return gamesFinish(W);
    const tot = Object.values(G.spent || {}).reduce((a, b) => a + b, 0);
    for (const u of Object.keys(W.A)) { if (!BOTS.isBot(u) || rng() > 1 / 60) continue; const n = W.A[u]; if (n.ai && n.ai.boss) continue; if ((G.botSpent || 0) > Math.max(5e7, tot * WP.GAMES.botShare)) break;
      const cat = Object.keys(WP.GAMES.cats)[Math.floor(rng() * 3)], a = Math.floor((n.cash || 0) * .004); if (a >= WP.GAMES.minGive) try { core.exec(W, u, { c: 'games', cat, amt: a }, rng); } catch (e) { if (!e.user) throw e; } }
    return;
  }
  if (G && G.over && now - G.over > 12 * HOUR) { S.games = null; W.gch = true; }
  if (c.auto && now >= S.nextGames && humans(W).length >= 2) { S.nextGames = now + HOUR; setTimeout(() => { try { gamesStart(c.hours, null); } catch (e) {} }, 0); }
}
// ---------- natural disasters ----------
const DIS_DEF = { auto: true, everyH: 6 };
const disCfg = () => ({ ...DIS_DEF, ...(S.config.dis || {}) });
function disasterStrike(W, u, kind) {
  const ids = u ? [u] : Object.keys(W.A).filter(v => core.hexesOf(W, v).length && !(W.A[v].ai && W.A[v].ai.boss)); if (!ids.length) return null;
  const v = ids[Math.floor(rng() * ids.length)], hs = core.hexesOf(W, v), h = hs[Math.floor(rng() * hs.length)], p = core.P[h];
  kind = WP.DISASTER[kind] && kind.length < 8 ? kind : p.m ? 'quake' : p.co && rng() < .6 ? 'storm' : p.r ? 'flood' : 'fire';
  const rec = core.disasterHit(W, v, h, kind); if (!rec) return null; S.dis.unshift(rec); S.dis = S.dis.filter(d => Date.now() < d.until + 24 * HOUR).slice(0, 30); W.disch = true;
  if (kind === 'fire' || kind === 'quake') S.burn[h] = { t: Date.now(), n: kind === 'fire' ? 8 : 4 };
  systemMessage(`${WP.DISASTER[kind].ic} DISASTER: ${/^[aeiou]/i.test(WP.DISASTER[kind].n) ? 'an' : 'a'} ${WP.DISASTER[kind].n.toLowerCase()} has struck ${rec.place} in ${rec.name}. Send relief from your Overview page to earn prestige.`); return rec;
}
function disLoop(W) {
  const now = Date.now(), c = disCfg();
  for (const d of S.dis) { if (d.until <= now || d.done || !W.A[d.u] || BOTS.isBot(d.u) && rng() > .5) continue; // AI nations chip in for others now and then (up to 40% of the appeal)
    for (const u of Object.keys(W.A)) { if (!BOTS.isBot(u) || u === d.u || rng() > 1 / 90) continue; const bot = Object.keys(d.aid).filter(BOTS.isBot).reduce((s, x) => s + d.aid[x], 0); if (bot >= d.need * .4) break; const a = Math.floor(Math.min((W.A[u].cash || 0) * .003, d.need * .4 - bot)); if (a >= WP.DISASTER.minGive) try { core.exec(W, u, { c: 'relief', id: d.id, amt: a }, rng); } catch (e) { if (!e.user) throw e; } } }
  if (c.auto && now >= S.nextDis && humans(W).length >= 1) { S.nextDis = now + c.everyH * HOUR * (.5 + rng()); disasterStrike(W, null, null); }
}
// nuclear accidents: rare and random for nations with a nuclear program (about once a month each, never twice in a week)
function nukeAccLoop(W) {
  const now = Date.now(), K = WP.NUKEACC; if (S.config.nukeAcc === false) return;
  for (const [u, n] of Object.entries(W.A)) { if (!n.nuke || now - (n.nukeAcc || 0) < K.gapD * 864e5) continue;
    if (rng() < K.perDay * (n.warhead ? K.warheadX : 1) / 2880) nukeAccidentNow(W, u); }
}
function nukeAccidentNow(W, u) {
  const r = core.nukeAccident(W, u, rng); if (!r) return null; S.burn[r.h] = { t: Date.now(), n: 12 }; burnList();
  systemMessage(`☢ NUCLEAR ACCIDENT in ${r.name}: a reactor failure at ${r.place} has released radiation. ${WP.num(r.lost)} people lost; crops in the area are contaminated.`); broadcast('announce', { text: `☢ Nuclear accident in ${r.name}` }); return r;
}
// one world law a day goes to the Council, so world politics never sleeps
const DAILY_LAWS = ['climate', 'arms', 'freetrade', 'science', 'food', 'health', 'peacekeeping', 'nonukes', 'tariffs', 'freemarket', 'truce'];
function councilDaily(W) {
  if (S.config.councilAuto === false) return; const now = Date.now(); if (now - (S.council.lastDaily || 0) < 24 * HOUR) return;
  if (S.council.props.some(p => p.status === 'open' && WP.RESOLUTIONS[p.type] && WP.RESOLUTIONS[p.type].kind === 'global')) return;
  const pool = DAILY_LAWS.filter(k => !((S.council.active[k] || 0) > now)); if (!pool.length) return; const type = pool[Math.floor(rng() * pool.length)];
  S.council.lastDaily = now; S.council.props.unshift({ id: rid(), by: null, auto: true, why: 'The law of the day: every nation may vote.', type, target: null, t: now, end: now + COUNCIL_H * HOUR, votes: {}, status: 'open' }); S.council.props = S.council.props.slice(0, 60);
  systemMessage(`⚖ World Council — law of the day: “${WP.RESOLUTIONS[type].n}”. ${WP.RESOLUTIONS[type].d} Vote within ${COUNCIL_H} hours on the World Council page.`); broadcast('council', councilView());
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
const resLabel = (type, name, p) => p && p.plea ? `${name || 'A nation'}'s petition to have its sanctions lifted` : type === 'custom' && p ? `Custom resolution: “${p.text}”` : WP.RESOLUTIONS[type].n + (type === 'pact' && p ? ` (${PACT_SCOPE[p.scope] || ''})` : '') + (name ? (WP.RESOLUTIONS[type].kind === 'protect' ? ' for ' : ' against ') + name : '');
const nukedRecently = (u, now) => S.nukes.some(x => x.by === u && !x.retaliation && now - x.t < 72 * HOUR);
// why a resolution cannot be put to the vote against/for this nation right now (null = fine)
function resBlocked(W, type, v) {
  const n = W.A[v], now = Date.now(), M = k => core.measure(W, n, k);
  if (type === 'inspect' && !n.nuke) return `${n.name} has no nuclear program to inspect.`;
  if (type === 'ceasefire' && !core.wars(W, v).length) return `${n.name} is not at war with anyone.`;
  if ((type === 'aid' || type === 'guarantee') && core.rogue(W, n)) return `${n.name} is a rogue state. The Council will not support it until sanctions are lifted.`;
  if (type === 'lift') { if (!(M('embargo') || M('armsEmb') || M('frozen') || M('condemned') || core.rogue(W, n) || core.sanctioned(n))) return `${n.name} is not under any sanctions.`; if (nukedRecently(v, now)) return `${n.name} launched a nuclear strike less than 72 hours ago. Its sanctions cannot be lifted yet.`; }
  return null;
}
// paying off the Council: lifts sanctions, rogue status and Council measures at once, announced to the whole world. The money is simply gone.
function councilBribe(uid) {
  const W = mkWorld(), n = W.A[uid], now = Date.now(); if (!n) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  if (!core.bribeNeeded(W, n)) throw Object.assign(new Error('Your nation is not under sanctions, rogue status or Council measures.'), { status: 400 });
  if (nukedRecently(uid, now)) throw Object.assign(new Error('No amount of money will buy the Council within 72 hours of a nuclear strike.'), { status: 400 });
  const price = core.bribePrice(W, n); if ((n.cash || 0) < price) throw Object.assign(new Error(`The Council's price is ${WP.money(price)}. Your treasury doesn't cover it.`), { status: 400 });
  const wasRogue = core.rogue(W, n);
  n.cash -= price; n.bribes = [...core.bribeRecent(n, now), now];
  const back = n.frozen ? n.frozen.amt || 0 : 0; n.cash += back; n.frozen = null; n.embargo = 0; n.armsEmb = 0; n.condemned = 0;
  if (wasRogue) { n.rogue = 0; delete n.rogueT; } n.aggr = Math.min(n.aggr || 0, 30); W.changed.add(uid);
  core.news(W, uid, `💰 ${n.name} bribed the World Council to lift its ${wasRogue ? 'rogue-state status' : 'sanctions'} (${WP.moneyS(price)}).`);
  commit(W); persist();
  systemMessage(`💰 ${n.name} paid the World Council ${WP.moneyS(price)} to make its ${wasRogue ? 'rogue-state status' : 'sanctions'} disappear.`);
  return { msg: `Paid ${WP.money(price)}. ${wasRogue ? 'Your rogue status' : 'Your sanctions'} and all Council measures are lifted${back ? `, and ${WP.money(back)} in frozen assets is back in your treasury` : ''}. Your aggression is now ${Math.round(n.aggr)}.` };
}
function councilPropose(uid, b) {
  const W = mkWorld(), n = W.A[uid]; if (!n) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const type = typeof b.type === 'string' ? b.type : ''; if (!RES_KEYS.includes(type)) throw Object.assign(new Error('Unknown resolution.'), { status: 400 });
  const plea = type === 'lift' && b.target === uid; // a nation under sanctions petitioning for its own sanctions to be lifted
  if (!plea && core.rankOf(n.xp) < 2) throw Object.assign(new Error('You must be at least a Mayor to propose resolutions.'), { status: 400 });
  if (plea && Date.now() - ((S.council.plea || {})[uid] || 0) < 6 * HOUR) { const h = Math.ceil((6 * HOUR - (Date.now() - S.council.plea[uid])) / HOUR); throw Object.assign(new Error(`You can petition the Council once every 6 hours. Try again in ${h} hour${h === 1 ? '' : 's'}.`), { status: 400 }); }
  const R = WP.RESOLUTIONS[type]; let target = null;
  if (isTargeted(type)) {
    target = typeof b.target === 'string' ? b.target : ''; if (!Object.prototype.hasOwnProperty.call(W.A, target) || (target === uid && !plea)) throw Object.assign(new Error('Choose another nation as the target.'), { status: 400 });
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
    if (text.length > 500) throw Object.assign(new Error('Keep it under 500 characters.'), { status: 400 });
    if (MOD.isProfane(text)) throw Object.assign(new Error('Please reword your resolution.'), { status: 400 });
    hours = [24, 48, 72].includes(+b.hours) ? +b.hours : 48;
  }
  if (!plea) { const cost = b.anon ? 1e7 : 1e6; if (n.cash < cost) throw Object.assign(new Error(b.anon ? 'An anonymous resolution costs $10,000,000.' : 'Submitting a resolution costs $1,000,000.'), { status: 400 }); n.cash -= cost; W.changed.add(uid); commit(W); } // $1M, or $10M to stay anonymous
  else (S.council.plea = S.council.plea || {})[uid] = Date.now();
  const p = { id: rid(), by: uid, type, target, t: Date.now(), end: Date.now() + COUNCIL_H * HOUR, votes: { [uid]: 'y' }, status: 'open' };
  if (b.anon && !plea) p.anon = true; // proposer stays secret: never sent to players (kept only in the saved game data)
  if (scope) p.scope = scope; if (text) { p.text = text; p.hours = hours; } if (plea) p.plea = true;
  if (type === 'debt') p.debts = Object.fromEntries(Object.entries(W.A).filter(([, x]) => (x.debt || 0) > 0).map(([u, x]) => [u, Math.round(x.debt)]));
  S.council.props.unshift(p); S.council.props = S.council.props.slice(0, 60); persist(); broadcast('council', councilView());
  const txt = plea ? `${n.name} petitions the World Council to lift its sanctions and welcome it back. Vote now.` : `${p.anon ? 'An anonymous nation' : n.name} proposes to the World Council: ${resLabel(type, target && W.A[target].name, p)}.`;
  systemMessage(txt); for (const u of Object.keys(S.users)) if (u !== uid) addNote(u, 'council', txt + ` Voting closes in ${COUNCIL_H} hours.`);
  return p;
}
function councilVote(uid, b) {
  if (!S.docs['nations/' + uid]) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const p = S.council.props.find(x => x.id === b.id && x.status === 'open'); if (!p || Date.now() >= p.end) throw Object.assign(new Error('That vote has closed.'), { status: 400 });
  if (!['y', 'n'].includes(b.vote)) throw Object.assign(new Error('Vote yes or no.'), { status: 400 });
  if (!p.votes[uid]) { const twins = Object.keys(p.votes).filter(o => o !== uid && S.users[o] && sharesNetwork(uid, o)); if (twins.length) { flag(uid, `Voted on the same World Council resolution as ${twins.map(o => S.users[o].name).join(', ')}, from the same network (possible second account)`); (p.net = p.net || []).push(uid); } }
  p.votes[uid] = b.vote; { const W = mkWorld(); if (decideEarly(W, p)) { councilResolve(W); commit(W); } } persist(); broadcast('council', councilView()); return p;
}
// who could still vote: players active in the last 3 days who have a nation (AI nations don't vote)
function canStillVote(W, p) { const now = Date.now(); let n = 0; for (const u of Object.keys(W.A)) { if (p.votes[u] || BOTS.isBot(u)) continue; if (S.users[u] && now - ((S.meta[u] || {}).lastSeen || 0) < 72 * HOUR) n++; } return n; }
// a vote closes early once the outcome is certain: it passes when yes leads by more than the votes still out (and has at least 3), and fails when yes can no longer win
function decideEarly(W, p) {
  if (p.status !== 'open' || Date.now() >= p.end) return false;
  const pv = Object.values(playerVotes(p.votes)), ys = pv.filter(v => v === 'y').length, ns = pv.filter(v => v === 'n').length, left = canStillVote(W, p);
  if ((ys >= COUNCIL_MIN_YES && ys > ns + left) || ys + left <= ns || ys + left < COUNCIL_MIN_YES) { p.end = Date.now(); p.early = true; return true; }
  return false;
}
function councilResolve(W) {
  const now = Date.now(); let changed = false;
  for (const p of S.council.props) { if (decideEarly(W, p)) changed = true; }
  for (const p of S.council.props) {
    if (p.status !== 'open' || now < p.end) continue;
    const pv = Object.values(playerVotes(p.votes)), ys = pv.filter(v => v === 'y').length, ns = pv.filter(v => v === 'n').length;
    const R = WP.RESOLUTIONS[p.type], tn = p.target && W.A[p.target];
    if (p.target && !tn) { p.status = 'failed'; changed = true; continue; }
    p.status = ys > ns && ys >= COUNCIL_MIN_YES ? 'passed' : 'failed'; p.result = `${ys}–${ns}${p.early ? ', decided early' : ''}`; changed = true;
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
    case 'custom': (S.council.decl = S.council.decl || []).push({ id: p.id, text: p.text, by: p.anon ? null : p.by, anon: !!p.anon, yes: Object.keys(p.votes).filter(u => p.votes[u] === 'y' && !(p.anon && u === p.by)), until, t: now }); return 'It is now in force.';
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
    if (core.defending(W, h.u, h.v)) continue; // fighting back against a member is not aggression: the pact only answers real aggressors
    if (pc.members.includes(h.u)) { pc.members = pc.members.filter(m => m !== h.u); systemMessage(`🛡 ${a.name} attacked a fellow member of the Collective Defense Pact and has been expelled from it.`); }
    const joined = pc.members.filter(m => m !== h.v && m !== h.u && W.A[m] && core.pactWar(W, m, h.u, h.v));
    const key = pc.id + h.u; if (joined.length && !said.has(key)) { said.add(key); systemMessage(`🛡 Collective Defense Pact invoked: ${a.name} attacked ${v.name}. ${joined.map(m => W.A[m].name).join(', ')} ${joined.length === 1 ? 'is' : 'are'} now at war with ${a.name}.`); }
  }
}
// ---------- the World Council takes notice on its own ----------
// Bad behaviour puts a resolution to the vote automatically. Players vote (AI nations don't); nothing passes without a majority.
const AUTO_RULES = [
  // [type, test(nation, recent attacks, W, id) -> reason or null]
  ['sanction', (n, atk, W, u) => !core.rogue(W, n) && ((n.aggr || 0) >= 60 || atk.victims >= 3) ? (atk.victims >= 3 ? `attacked ${atk.victims} different nations in 12 hours` : `pushed its aggression to ${Math.round(n.aggr)}`) : null],
  ['condemn', (n, atk, W, u) => !core.rogue(W, n) && ((n.aggr || 0) >= 35 || atk.n >= 3) ? `${atk.n >= 3 ? `launched ${atk.n} attacks in 6 hours` : `pushed its aggression to ${Math.round(n.aggr)}`}` : null],
  ['aid', (n, atk, W, u) => n.nuked && Date.now() - n.nuked.t < 6 * HOUR && !core.rogue(W, n) ? 'was struck by a nuclear weapon' : null],
  ['condemn', (n, atk, W, u) => n.nuke && Date.now() - n.nuke < 3 * HOUR ? 'tested a nuclear weapon' : null],
  ['condemn', (n, atk, W, u) => n.dirtyAt && Date.now() - n.dirtyAt < 3 * HOUR ? 'detonated a dirty bomb on another nation' : null]
];
function councilWatch(W) {
  if (S.config.councilAuto === false) return; const now = Date.now(); S.council.watch = S.council.watch || {};
  for (const [k, t] of Object.entries(S.council.watch)) if (now - t > 48 * HOUR) delete S.council.watch[k];
  const open = () => S.council.props.filter(p => p.status === 'open');
  if (open().filter(p => p.auto).length >= 3) return;
  for (const [u, n] of Object.entries(W.A)) {
    if (open().some(p => p.target === u)) continue;
    const battles = (n.out || []).filter(e => e.type === 'battle' && e.to && e.to !== u && W.A[e.to] && !BOTS.isBot(e.to) /* only attacks on real players count: fighting AI nations is part of the game */ && !((W.A[e.to].out || []).some(x => x.type === 'battle' && x.to === u && x.t < e.t && e.t - x.t < 24 * HOUR)) && !core.defending(W, u, e.to));
    const atk = { n: battles.filter(e => now - e.t < 6 * HOUR).length, victims: new Set(battles.filter(e => now - e.t < 12 * HOUR).map(e => e.to)).size };
    for (const [type, test] of AUTO_RULES) {
      const why = test(n, atk, W, u); if (!why || resBlocked(W, type, u)) continue; const key = type + ':' + u;
      if (S.council.watch[key] && now - S.council.watch[key] < 24 * HOUR) continue;
      S.council.watch[key] = now; const R = WP.RESOLUTIONS[type];
      S.council.props.unshift({ id: rid(), by: null, auto: true, why, type, target: u, t: now, end: now + COUNCIL_H * HOUR, votes: {}, status: 'open' }); S.council.props = S.council.props.slice(0, 60);
      const txt = `The World Council has taken notice: ${n.name} ${why}. A vote on "${resLabel(type, n.name)}" is now open.`;
      systemMessage('🏛 ' + txt); const hit = new Set(battles.map(e => e.to)), nuclear = /nuclear/.test(why);
      for (const v of Object.keys(S.users)) if (v !== u && (nuclear || hit.has(v))) addNote(v, 'council', txt + ` Voting closes in ${COUNCIL_H} hours.`);
      if (S.users[u]) addNote(u, 'council', R.kind === 'protect' ? `The World Council is voting on "${R.n}" for your nation because it ${why}.` : `The World Council is voting on "${R.n}" against your nation because it ${why}. You have 6 hours to make your case in chat.`);
      persist(); broadcast('council', councilView());
      if (open().filter(p => p.auto).length >= 3) return;
      break; // at most one new resolution per nation at a time
    }
  }
}
// AI nations cast votes according to their personality and relations
function botVotes(W) {
  return; // AI nations no longer vote in the World Council (players decide everything); the old voting logic is kept below in case it is wanted again
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
          if (t.ai && t.ai.boss && !war) yes = .2; // the Rising Power has friends (and money): AI nations rarely vote against it unless at war with it
          else if (war) yes = .95; else if (ally) yes = Math.min(.05, bad); else { yes = Math.max(.05, bad); if (trade) yes *= .5; }
          if (p.type === 'inspect' && !ally && !(t.ai && t.ai.boss)) yes = Math.max(yes, per === 'warlord' ? .35 : .7); // non-proliferation is popular
          if (p.type === 'freeze' && per === 'merchant') yes *= .7; // bankers dislike seizing deposits
        } else { // support for a nation
          if (war) yes = p.type === 'aid' ? .25 : .03; else if (ally) yes = .95;
          else if (p.type === 'lift' && p.plea) { // a petition: judged on whether it has stopped fighting
            const since = Date.now() - 12 * HOUR, fought = (t.out || []).some(e => e.type === 'battle' && e.t > since) || Object.values(W.A).some(x => x.hitBy && (x.hitBy[p.target] || 0) > since);
            yes = fought ? .05 : Math.min(.9, .6 + ((t.aggr || 0) < 60 ? .15 : 0) + (per === 'merchant' ? .1 : per === 'warlord' ? -.15 : 0));
          }
          else if (p.type === 'lift') yes = Math.max(.05, .8 - bad);
          else if (p.type === 'aid') yes = Math.min(.95, .35 + victim + (per === 'merchant' || per === 'isolationist' ? .1 : 0) - bad * .5);
          else if (p.type === 'ceasefire') yes = Math.min(.9, .45 + victim + (per === 'warlord' ? -.25 : per === 'isolationist' ? .15 : 0));
          else yes = Math.max(.05, Math.min(.9, .3 + victim - bad + (trade ? .2 : 0)));
        }
      }
      else yes = ({ climate: { isolationist: .8, merchant: .6, warlord: .3, expansionist: .4 }, arms: { isolationist: .8, merchant: .6, warlord: .1, expansionist: .3 }, freetrade: { merchant: .95, expansionist: .6, warlord: .4, isolationist: .3 }, peacekeeping: { isolationist: .85, merchant: .7, warlord: .1, expansionist: .3 },
        npt: { isolationist: .85, merchant: .7, warlord: me.nuke ? .5 : .2, expansionist: .45 }, health: { isolationist: .7, merchant: .55, warlord: .35, expansionist: .5 }, science: { isolationist: .7, merchant: .75, warlord: .5, expansionist: .7 },
        food: { isolationist: .75, merchant: .4, warlord: .55, expansionist: .6 }, debt: { isolationist: .5, merchant: .25, warlord: .6, expansionist: .6 }, nonukes: { isolationist: .85, merchant: .75, warlord: me.nuke ? .15 : .4, expansionist: .5 }, tariffs: { isolationist: .7, merchant: .1, warlord: .5, expansionist: .35 }, freemarket: { merchant: .95, expansionist: .65, warlord: .4, isolationist: .25 }, truce: { isolationist: .85, merchant: .7, warlord: .1, expansionist: .3 } }[p.type] || {})[per] || .5;
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

// ===================== SEASONS & HALL OF FAME =====================
// A season ranks nations by what they achieve between its start and end. When it ends, the result is written to the Hall of Fame:
// an append-only file (one line per season). Nothing in the game or the admin page can edit or delete those lines.
const HOF_FILE = path.join(DATA_DIR, 'halloffame.jsonl'); let HOF = [];
try { HOF = fs.readFileSync(HOF_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return Object.freeze(JSON.parse(l)); } catch (e) { return null; } }).filter(Boolean); } catch (e) { HOF = []; }
const SEASON_METRICS = { score: { n: 'Score gained', title: 'Grand Strategist', fmt: v => Math.round(v).toLocaleString('en-US') }, land: { n: 'Provinces gained', title: 'Conqueror', fmt: v => (v > 0 ? '+' : '') + Math.round(v) }, gdp: { n: 'GDP growth', title: 'Tycoon', fmt: v => (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%' }, wins: { n: 'Battles won', title: 'Warlord', fmt: v => String(Math.round(v)) }, relief: { n: 'Relief sent', title: 'Philanthropist', fmt: v => '$' + Math.round(v).toLocaleString('en-US') } };
S.seasons = S.seasons || { cur: null, n: HOF.length };
S.countdown = S.countdown || null; // admin countdown banner: { id, text, at } shown to every player until 2 hours after it reaches zero
if (S.seasons.n < HOF.length) S.seasons.n = HOF.length;
function seasonVal(W, se, u, m) { const n = W.A[u]; if (!n) return 0; const b = se.base[u] || { score: 0, prov: 0, gdp: n.gdp || 0 }; const ss = n.ss && n.ss.id === se.id ? n.ss : {};
  if (m === 'score') return core.score(W, u) - b.score; if (m === 'land') return core.hexesOf(W, u).length - b.prov; if (m === 'gdp') return b.gdp > 0 ? (n.gdp || 0) / b.gdp - 1 : 0; if (m === 'wins') return ss.wins || 0; if (m === 'relief') return ss.relief || 0; return 0; }
function seasonEligible(W, se, u) { const n = W.A[u]; if (!n) return false; if (n.ai && n.ai.boss) return false; return se.who === 'all' || !n.ai; }
function seasonTable(W, se, m, max) { m = m || se.metric; return Object.keys(W.A).filter(u => seasonEligible(W, se, u)).map(u => ({ u, v: seasonVal(W, se, u, m) })).sort((a, b) => b.v - a.v).slice(0, max || 1e9); }
function seasonView(W, se, uid) { if (!se) return null; const live = se.status === 'live', t = live ? seasonTable(W, se) : [], M = SEASON_METRICS[se.metric]; const row = (x, i) => ({ r: i + 1, name: W.A[x.u].name, leader: (S.users[x.u] || {}).name || '', color: W.A[x.u].color, ai: !!W.A[x.u].ai, v: x.v, f: M.fmt(x.v), me: x.u === uid });
  const mi = t.findIndex(x => x.u === uid);
  return { id: se.id, n: se.n, name: se.name, msg: se.msg || '', status: se.status, start: se.start, end: se.end, metric: se.metric, metricName: M.n, who: se.who, prizes: se.prizes, xp: se.xp, cats: se.cats, top: t.slice(0, 20).map(row), me: mi >= 0 ? row(t[mi], mi) : null, count: t.length }; }
function seasonBegin(W) { const se = S.seasons.cur; se.status = 'live'; se.start = Date.now(); se.base = {};
  for (const u of Object.keys(W.A)) se.base[u] = { score: core.score(W, u), prov: core.hexesOf(W, u).length, gdp: W.A[u].gdp || 0 };
  const t = `🏆 ${se.name} has begun! Nations are ranked by ${SEASON_METRICS[se.metric].n.toLowerCase()}${se.end ? ` until ${new Date(se.end).toUTCString().slice(0, 22)} UTC` : ''}.${se.prizes && se.prizes[0] ? ` The champion wins $${Math.round(se.prizes[0]).toLocaleString('en-US')}.` : ''} See Rankings for the live standings.`;
  if (se.announce) { systemMessage(t); broadcast('announce', { text: t }); }
  persist(); broadcast('config', effCfg()); }
function seasonFinish(W, by) { const se = S.seasons.cur; if (!se || se.status !== 'live') return null; const M = SEASON_METRICS[se.metric], table = seasonTable(W, se), now = Date.now();
  const pick = x => { const n = W.A[x.u]; return { name: n.name, leader: (S.users[x.u] || {}).name || (n.ai ? 'AI' : ''), color: n.color, flag: n.flag || null, ai: !!n.ai, value: x.v, shown: M.fmt(x.v) }; };
  const ranked = table.filter(x => x.v > 0 || se.metric === 'gdp'), top = ranked.slice(0, 10);
  const cats = (se.cats || []).filter(k => SEASON_METRICS[k] && k !== se.metric).map(k => { const best = seasonTable(W, se, k, 1)[0]; return best && best.v > 0 ? { k, award: SEASON_METRICS[k].title, metric: SEASON_METRICS[k].n, ...pick(best), shown: SEASON_METRICS[k].fmt(best.v), u: best.u } : null; }).filter(Boolean);
  // prizes and titles
  const place = ['Champion', '2nd place', '3rd place'];
  top.slice(0, 3).forEach((x, i) => { const n = W.A[x.u]; if (!n) return; const cash = Math.max(0, +((se.prizes || [])[i]) || 0), xp = Math.max(0, +((se.xp || [])[i]) || 0); if (cash) n.cash += cash; if (xp) n.xp = (n.xp || 0) + xp;
    if (se.titles !== false) n.titles = [...(n.titles || []), { s: se.n, t: `${se.name} ${place[i]}`, r: i + 1 }].slice(-30);
    n.log = [{ t: now, x: `🏆 ${se.name} is over: you finished ${['1st', '2nd', '3rd'][i]}!${cash ? ` Prize: $${Math.round(cash).toLocaleString('en-US')}.` : ''}${xp ? ` +${xp} XP.` : ''}` }, ...(n.log || [])].slice(0, 120); W.changed.add(x.u); });
  if (se.titles !== false) for (const c of cats) { const n = W.A[c.u]; if (n) { n.titles = [...(n.titles || []), { s: se.n, t: `${se.name} ${c.award}` }].slice(-30); W.changed.add(c.u); } }
  const entry = { season: se.n, name: se.name, start: se.start, end: now, metric: se.metric, metricName: M.n, who: se.who, champion: top[0] ? pick(top[0]) : null, top: top.map((x, i) => ({ r: i + 1, ...pick(x) })), awards: cats.map(({ u, ...c }) => c), players: table.length, recorded: now };
  try { fs.appendFileSync(HOF_FILE, JSON.stringify(entry) + '\n'); } catch (e) { logErr('Could not write the Hall of Fame: ' + e.message); }
  HOF.push(Object.freeze(entry)); S.seasons.cur = null; audit(by || 'System', 'Season ended', se.name);
  const t = top[0] ? `🏆 ${se.name} is over! Champion: ${top[0] && W.A[top[0].u].name} (${M.fmt(top[0].v)}).${top[1] ? ` 2nd: ${W.A[top[1].u].name}.` : ''}${top[2] ? ` 3rd: ${W.A[top[2].u].name}.` : ''} They're now in the Hall of Fame forever.` : `${se.name} is over. No nation qualified this time.`;
  if (se.announce) { systemMessage(t); broadcast('announce', { text: t }); }
  persist(); broadcast('config', effCfg()); return entry; }
let SW = null; const seasonW = () => { if (!SW || Date.now() - SW.t > 15e3) SW = { t: Date.now(), W: mkWorld() }; return SW.W; };
function seasonTick(W) { const se = S.seasons.cur; if (!se) return; const now = Date.now();
  if (se.status === 'scheduled' && now >= se.start) seasonBegin(W);
  else if (se.status === 'live') { for (const u of Object.keys(W.A)) if (!se.base[u]) se.base[u] = { score: core.score(W, u), prov: core.hexesOf(W, u).length, gdp: W.A[u].gdp || 0 }; // nations founded mid-season start from zero
    if (se.end && now >= se.end) seasonFinish(W); } }


// casino bookkeeping for the admin page: totals by game and by day, biggest wins, recent plays
S.casino = S.casino || { tot: {}, days: {}, recent: [], big: [] };
const casinoTotals = () => Object.fromEntries(Object.entries((S.casino && S.casino.tot) || {}).map(([k, x]) => [k, { plays: x.plays, wag: x.wag, net: x.net, wins: x.wins, won: x.won || 0, lost: x.lost || 0 }])); // all-time table results, sums only
function casinoRecord(W) { const C_ = S.casino; for (const e of W.casinoEv || []) { const n = W.A[e.u] || {}, day = new Date(e.t).toISOString().slice(0, 10);
  const add = (o, k) => { const x = o[k] = o[k] || { plays: 0, wag: 0, net: 0, wins: 0 }; x.plays++; x.wag += e.bet; x.net += e.net; if (e.net > 0) { x.wins++; x.won = (x.won || 0) + e.net; } else if (e.net < 0) x.lost = (x.lost || 0) - e.net; };
  add(C_.tot, e.g); add(C_.tot, 'all'); C_.days[day] = C_.days[day] || {}; add(C_.days[day], e.g); add(C_.days[day], 'all');
  const row = { t: e.t, u: e.u, name: n.name || '?', leader: (S.users[e.u] || {}).name || '', g: e.g, bet: e.bet, net: e.net, d: e.d };
  C_.recent = [row, ...C_.recent].slice(0, 200); if (e.net > 0) C_.big = [...C_.big, row].sort((a, b) => b.net - a.net).slice(0, 25); }
  const keep = Object.keys(C_.days).sort().slice(-60); C_.days = Object.fromEntries(keep.map(k => [k, C_.days[k]])); W.casinoEv = null; }


// PROVABLY FAIR CASINO. Each player has a secret server seed (only its SHA-256 hash is shown before betting), a client seed they can change,
// and a bet counter (nonce). Every random number for a bet comes from HMAC-SHA256(server seed, "client seed:nonce:block"), 8 numbers per block.
// Revealing the seed lets anyone recompute every result on the Fair play page.
S.fair = S.fair || {};
const sha256 = x => crypto.createHash('sha256').update(String(x)).digest('hex');
function fairOf(uid) { let f = S.fair[uid]; if (!f) { f = S.fair[uid] = { seed: crypto.randomBytes(32).toString('hex'), client: crypto.randomBytes(8).toString('hex'), nonce: 0, from: 0, prev: [] }; } return f; }
function fairRng(f) { let i = 0, buf = []; return () => { if (!buf.length) { const h = crypto.createHmac('sha256', f.seed).update(`${f.client}:${f.nonce}:${i++}`).digest(); for (let k = 0; k < 32; k += 4) buf.push(h.readUInt32BE(k) / 4294967296); } return buf.shift(); }; }
const fairView = f => ({ hash: sha256(f.seed), client: f.client, nonce: f.nonce, prev: (f.prev || []).slice(0, 20) });

function worldLoop() {
  const t0 = process.hrtime.bigint();
  try {
    const W = mkWorld(); const now = Date.now();
    for (const u of Object.keys(W.A)) { const active = BOTS.isBot(u) || now - ((S.meta[u] || {}).lastSeen || 0) < ACTIVE_WINDOW; core.tick(W, u, active, rng); }
    manageBots(W);
    for (const u of Object.keys(W.A)) if (BOTS.isBot(u)) { try { BOTS.turn(W, u, W.cfg); } catch (e) { logErr('AI nation error: ' + (e.stack || e)); } }
    pactCheck(W); councilWatch(W); botVotes(W); councilResolve(W); core.blocTick(W); crisisLoop(W); gamesLoop(W); disLoop(W); councilDaily(W); nukeAccLoop(W);
    if (!RH.length || now - RH[RH.length - 1].t >= HOUR) rankPoint(W);
    try { seasonTick(W); } catch (e) { logErr('Season update failed: ' + (e.stack || e)); }
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
// total money in the world (sums only, no single treasury is revealed)
let WCASH = null;
function worldCash(W) { let all = 0, players = 0; for (const [u, n] of Object.entries(W.A)) { const c = Math.round(n.cash || 0); all += c; if (!n.ai) players += c; } return { all, players, ai: all - players, t: Date.now() }; }
function rankPoint(W) {
  const n = {}; for (const u of Object.keys(W.A)) n[u] = [core.score(W, u), Math.round(W.A[u].gdp || 0), Math.round(core.power(W, u)), core.hexesOf(W, u).length];
  const now = Date.now(), wc = worldCash(W); RH.push({ t: now, n, c: wc.all, cp: wc.players }); // world money totals only: each treasury stays private RH = RH.filter(p => now - p.t <= 7 * 24 * HOUR); rhGz = null;
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
// votes opened under the old rules: drop AI votes and close them within 3 hours
{ const lim = Date.now() + COUNCIL_H * HOUR; for (const p of (S.council && S.council.props) || []) if (p.status === 'open') { p.votes = playerVotes(p.votes); if (p.end > lim) p.end = lim; } }
// ---------- rollback snapshots: the game world (nations, council, events) every 10 minutes, kept 26 hours ----------
const SNAP_DIR = path.join(DATA_DIR, 'snaps'); let lastSnap = 0;
function gameState() { const nations = {}; for (const [k, v] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = v; return { t: Date.now(), nations, council: S.council, blocs: S.blocs, crisis: S.crisis, games: S.games, dis: S.dis, event: S.event, nextEvent: S.nextEvent, lastEventKey: S.lastEventKey, fallen: S.fallen }; }
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
  S.council = st.council || { props: [], active: {} }; if (st.blocs) S.blocs = Object.assign(Object.create(null), st.blocs); if (st.crisis !== undefined) S.crisis = st.crisis; if (st.games !== undefined) S.games = st.games; if (Array.isArray(st.dis)) S.dis = st.dis; S.event = st.event || null; S.nextEvent = st.nextEvent || now + 6 * HOUR; S.lastEventKey = st.lastEventKey; S.fallen = st.fallen || [];
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
function cleanChat(d) { const m = Array.isArray(d.m) ? d.m : []; return { m: m.slice(0, 40).filter(x => x && typeof x.x === 'string' && Number.isFinite(x.t)).map(x => ({ t: Math.min(Math.max(0, x.t), Date.now() + 5000), x: MOD.clean(x.x.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').slice(0, 1000)) })).filter(x => x.x.trim()) }; }

// ---------- mail ----------
function mailSend(me, b) {
  if ((S.users[me.id] || {}).guest) throw Object.assign(new Error('Save your account (Account page) to send mail.'), { status: 403 });
  const to = String(b.to || ''); if (!S.users[to] || to === me.id) throw Object.assign(new Error(BOTS.isBot(to) ? 'This nation is run by the computer and does not read mail.' : 'Choose a leader to write to.'), { status: 400 });
  if (isMuted(me.id)) throw Object.assign(new Error('You are muted by the administrators and cannot send mail right now.'), { status: 403 });
  const subj = MOD.clean(String(b.subj || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)) || 'No subject';
  const body = MOD.clean(String(b.body || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 5000)); if (!body) throw Object.assign(new Error('Write a message.'), { status: 400 });
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
  const days = []; for (let i = 13; i >= 0; i--) { const d = today(Date.now() - i * 864e5); const s = S.stats[d] || {}; days.push({ d, active: (s.active || []).length, signups: s.signups || 0, votes: s.votes || 0, cmds: s.cmds || 0, chat: s.chat || 0, mail: s.mail || 0, nations: s.nations || 0 }); }
  // day-1 retention: of the people who signed up on a day, how many came back the next day
  const ret = []; for (let i = 13; i >= 1; i--) { const d = today(Date.now() - i * 864e5), nx = today(Date.now() - (i - 1) * 864e5); const cohort = Object.entries(S.users).filter(([, u]) => u.created && today(u.created) === d).map(([id]) => id); const back = cohort.filter(id => ((S.stats[nx] || {}).active || []).includes(id)).length; ret.push({ d, cohort: cohort.length, back }); }
  const totalC = ret.reduce((a, r) => a + r.cohort, 0), totalB = ret.reduce((a, r) => a + r.back, 0);
  return { days, ret, d1: totalC ? Math.round(totalB / totalC * 100) : null };
}
function backups() { try { return fs.readdirSync(BACKUP_DIR).filter(f => /\.json$/.test(f)).sort().reverse().map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size })); } catch (e) { return []; } }
function bossPanel(W) {
  const now = Date.now(), ids = Object.keys(W.A), hum = ids.filter(k => !BOTS.isBot(k)), id = ids.find(k => BOTS.isBot(k) && W.A[k].ai && W.A[k].ai.boss);
  const topPow = hum.length ? Math.max(...hum.map(h => core.power(W, h))) : 0, br = bossBreatherH();
  const out = { settings: { ...BOTS.BOSS_DEF, ...(S.config.boss || {}), breatherH: br }, auto: S.config.aiBoss !== false, pause: (S.bossFell || 0) + br * HOUR > now ? S.bossFell + br * HOUR : 0, fell: S.bossFell || 0, topPow: Math.round(topPow), ranks: WP.RANKS.map(r => r[1]),
    candidates: ids.filter(k => BOTS.isBot(k)).map(k => ({ id: k, name: W.A[k].name, p: (BOTS.PERS[W.A[k].ai.p] || {}).n || '', score: core.score(W, k) })).sort((a, b) => b.score - a.score),
    targets: ids.filter(k => k !== id).map(k => ({ id: k, name: W.A[k].name, ai: BOTS.isBot(k), score: core.score(W, k), war: id ? core.atWar(W, id, k) : false })).sort((a, b) => b.score - a.score) };
  if (id) { const n = W.A[id], foes = core.wars(W, id);
    out.boss = { id, name: n.name, color: n.color, p: (BOTS.PERS[n.ai.p] || {}).n || '', power: Math.round(core.power(W, id)), score: core.score(W, id), provinces: core.hexesOf(W, id).length, cash: Math.round(n.cash), troops: n.troops, air: n.air || 0, ships: n.ships || 0, fort: n.fort || 0, tech: n.tech || 0, rank: core.rankOf(n.xp),
      aggr: Math.round(n.aggr || 0), rogue: core.rogue(W, n), nuke: !!n.nuke, warhead: n.warhead ? (core.warheadReady(W, n) ? 'ready' : 'building') : '', isolated: !!n.ai.isolated, missiles: core.maxMissiles(n),
      wars: foes.map(v => ({ id: v, name: (W.A[v] || {}).name, ai: BOTS.isBot(v), since: core.warSince(W, id, v) })), log: (n.log || []).slice(0, 25), cd: Object.fromEntries(Object.entries(n.cd || {}).filter(([, t]) => t > now)), regroup: n.regroup > now ? n.regroup : 0 }; }
  return out;
}
function overview() {
  const now = Date.now();
  const nations = {}; for (const [k, d] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = d;
  const W = core.world(Object.fromEntries(Object.entries(nations).map(([k, v]) => [k, core.normalize(v)])), effCfg(), now, S.event, S.council, S.blocs, S.crisis, extW());
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
    players, bots, botTarget: botTarget(W), bossPanel: bossPanel(W), gamesPanel: { games: S.games, hist: S.gamesHist.slice(0, 10), cfg: gamesCfg(), next: S.nextGames }, disPanel: { list: S.dis.slice(0, 15), cfg: disCfg(), next: S.nextDis }, crisisPanel: { crisis: S.crisis, hist: S.crisisHist.slice(0, 15), cfg: crisisCfg(), next: S.nextCrisis, types: Object.fromEntries(Object.entries(WP.CRISES).map(([k, v]) => [k, { n: v.n, ic: v.ic, d: v.d }])), goals: Object.fromEntries(Object.keys(WP.CRISIS.diff).map(d => [d, core.crisisGoal(W, d)])), names: Object.fromEntries(Object.entries(W.A).map(([k, v]) => [k, v.name])) }, blocsAdmin: Object.values(S.blocs).map(b => ({ id: b.id, name: b.name, tag: b.tag, members: (b.members || []).map(m => (W.A[m] || {}).name || m), leader: (W.A[b.leader] || {}).name || '', bank: b.bank || 0, done: Object.keys(b.done || {}).length, created: b.created })), flags: S.flags.slice(0, 300), audit: S.audit.slice(0, 200), errors: health.errors.slice(0, 50), shared, config: S.config, nukes: S.nukes.slice(0, 50), resNames: Object.fromEntries(Object.entries(WP.RESOLUTIONS).map(([k, r]) => [k, r.n])),
    analytics: analytics(), reports: S.reports.slice(0, 100), bugs: S.bugs.filter(x => x.kind !== 'idea').slice(0, 100), ideas: S.bugs.filter(x => x.kind === 'idea').slice(0, 150), schedule: S.schedule, boosts: BOOSTS, backups: backups(), snaps: listSnaps().map(({ name, t, tag }) => ({ name, t, tag })), event: S.event, nextEvent: S.nextEvent, events: Object.fromEntries(Object.entries(WP.EVENTS).map(([k, e]) => [k, e.n])), council: councilView(), war: warRoom(W, nations)
  };
}
// the admin's war room: every war, who started it, aggression, strikes, fires, pacts
function warRoom(W, nations) {
  const now = Date.now(), nm = id => (nations[id] || {}).name || (S.users[id] || {}).name || '?', seen = new Set(), wars = [];
  for (const id of Object.keys(nations)) for (const v of core.wars(W, id)) {
    const key = [id, v].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
    const ra = ((nations[id] || {}).rel || {})[v] || {}, rb = ((nations[v] || {}).rel || {})[id] || {}, since = Math.max(ra.war || 0, rb.war || 0), by = (ra.war || 0) >= (rb.war || 0) ? id : v, other = by === id ? v : id;
    const hits = k => (nations[k] && nations[k].out || []).filter(e => e.type === 'battle' && e.to === (k === by ? other : by) && now - e.t < 864e5).length;
    wars.push({ by, byName: nm(by), byAI: BOTS.isBot(by), vs: other, vsName: nm(other), vsAI: BOTS.isBot(other), since, aggrBy: Math.round((nations[by] || {}).aggr || 0), aggrVs: Math.round((nations[other] || {}).aggr || 0), battlesBy: hits(by), battlesVs: hits(other), pact: !!(ra.def || rb.def) });
  }
  wars.sort((a, b) => b.since - a.since);
  const hot = Object.entries(nations).filter(([, n]) => (n.aggr || 0) >= 20).map(([id, n]) => ({ id, name: n.name, ai: BOTS.isBot(id), boss: !!(n.ai && n.ai.boss), aggr: Math.round(n.aggr), sanctioned: core.sanctioned(n), rogue: core.rogue(W, n), wars: core.wars(W, id).length })).sort((a, b) => b.aggr - a.aggr);
  const boss = Object.entries(nations).find(([, n]) => n.ai && n.ai.boss);
  return { wars, hot, ntests: S.ntests.slice(0, 20), strikes: S.strikeLog.slice(0, 150), fires: burnList().length, pacts: (S.council.pacts || []).filter(x => x.until > now).map(x => ({ scope: x.scope, until: x.until, members: x.members.map(nm) })), bossPause: !boss && (S.bossFell || 0) + bossBreatherH() * HOUR > now ? (S.bossFell + bossBreatherH() * HOUR) : 0, boss: boss ? { id: boss[0], name: boss[1].name, aggr: Math.round(boss[1].aggr || 0), provinces: core.hexesOf(W, boss[0]).length } : null };
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
  if (p === '/api/admin/boss-now' && req.method === 'POST') { // raise the Rising Power right away (skips the 48-hour breather after one falls)
    const W0 = mkWorld(), ids = Object.keys(W0.A), cur = ids.find(k => BOTS.isBot(k) && W0.A[k].ai && W0.A[k].ai.boss);
    if (cur) return send(res, 400, { error: `${W0.A[cur].name} is already the Rising Power.` });
    if (!ids.some(k => BOTS.isBot(k))) { const Ws = mkWorld(), sp = BOTS.spawn(Ws); if (!sp) return send(res, 400, { error: 'There are no AI nations to raise, and there is no land to start a new one.' }); Ws.welcome = null; commit(Ws); } // no AI left: start one, then raise it
    if (!ids.some(k => !BOTS.isBot(k))) return send(res, 400, { error: 'There are no player nations yet.' });
    S.bossFell = 0; S.config.aiBoss = true;
    const W = mkWorld(), b = BOTS.raiseBoss(W, W.cfg); if (!b) return send(res, 400, { error: 'Could not raise a Rising Power right now.' });
    commit(W); persist(); systemMessage(`⚠ ${W.A[b].name} has become the Rising Power. Foreign backers are pouring money and weapons into its military. Stopping it will take the world working together.`);
    audit(me.name, 'Raised the Rising Power', W.A[b].name); return send(res, 200, { ok: true, name: W.A[b].name });
  }
  if (p === '/api/admin/casino' && req.method === 'GET') { // Admin page → Casino
    const W = mkWorld(), players = Object.entries(W.A).filter(([u, n]) => n.casino && n.casino.played).map(([u, n]) => ({ name: n.name, leader: (S.users[u] || {}).name || '', ai: !!n.ai, played: n.casino.played, wagered: n.casino.wagered, net: n.casino.net, best: n.casino.best || 0, cash: Math.round(n.cash || 0) }));
    return send(res, 200, { ...S.casino, players, limits: { min: WP.CASINO ? WP.CASINO.min : 1e4, max: WP.CASINO ? WP.CASINO.maxAbs : 1e9 } });
  }
  if (p === '/api/admin/season' && req.method === 'POST') { // Admin page → Seasons. The Hall of Fame itself has no edit or delete operation.
    const b = await readBody(req, 16384), op = String(b.op || ''), W = mkWorld(), clean = x => String(x == null ? '' : x).replace(/[\u0000-\u001f<>]/g, ' ').trim();
    if (op === 'list') return send(res, 200, { countdown: S.countdown, cur: seasonView(W, S.seasons.cur, null), curRaw: S.seasons.cur ? { ...S.seasons.cur, base: undefined } : null, next: S.seasons.n + 1, hof: HOF, metrics: Object.fromEntries(Object.entries(SEASON_METRICS).map(([k, v]) => [k, { n: v.n, title: v.title }])) });
    if (op === 'create') {
      if (S.seasons.cur) return send(res, 400, { error: 'A season is already scheduled or running. End or cancel it first.' });
      const metric = SEASON_METRICS[b.metric] ? b.metric : 'score', days = +b.days, startAt = b.startAt ? +new Date(b.startAt) : 0, start = startAt && startAt > Date.now() ? startAt : Date.now();
      if (b.startAt && !Number.isFinite(startAt)) return send(res, 400, { error: 'That start time is not a valid date.' });
      const n = S.seasons.n + 1, name = clean(b.name).slice(0, 60) || `Season ${n}`, num_ = v => Math.max(0, Math.min(1e12, Math.round(+v || 0)));
      const se = { id: crypto.randomBytes(5).toString('hex'), n, name, msg: clean(b.msg).slice(0, 300), metric, who: b.who === 'all' ? 'all' : 'players', start, end: days > 0 ? start + Math.min(365, days) * 864e5 : 0, prizes: (Array.isArray(b.prizes) ? b.prizes : []).slice(0, 3).map(num_), xp: (Array.isArray(b.xp) ? b.xp : []).slice(0, 3).map(v => Math.min(1e6, num_(v))), cats: (Array.isArray(b.cats) ? b.cats : []).filter(k => SEASON_METRICS[k]).slice(0, 5), titles: b.titles !== false, announce: b.announce !== false, status: 'scheduled', base: {}, by: me.name, created: Date.now() };
      S.seasons.cur = se; S.seasons.n = n; audit(me.name, start > Date.now() + 5000 ? 'Scheduled a season' : 'Started a season', name);
      if (start <= Date.now() + 5000) seasonBegin(W); else { persist(); if (se.announce) { const t = `🏆 ${name} starts ${new Date(start).toUTCString().slice(0, 22)} UTC. Nations will be ranked by ${SEASON_METRICS[metric].n.toLowerCase()}.`; systemMessage(t); broadcast('announce', { text: t }); } }
      return send(res, 200, { ok: true });
    }
    if (op === 'countdown') { // the countdown banner players see at the top of every page
      if (b.off) { S.countdown = null; persist(); broadcast('config', effCfg()); audit(me.name, 'Removed the countdown banner', ''); return send(res, 200, { ok: true }); }
      const text = clean(b.text).slice(0, 120) || 'The next season starts in', at = Math.round(+b.at);
      if (!Number.isFinite(at) || at <= Date.now() + 30e3) return send(res, 400, { error: 'Pick a time in the future for the countdown to end.' });
      if (at > Date.now() + 365 * 864e5) return send(res, 400, { error: 'The countdown can run for at most a year.' });
      S.countdown = { id: crypto.randomBytes(4).toString('hex'), text, at, by: me.name, t: Date.now() }; persist(); broadcast('config', effCfg());
      audit(me.name, 'Set the countdown banner', `${text} · ${new Date(at).toUTCString().slice(0, 22)} UTC`); return send(res, 200, { ok: true, countdown: S.countdown });
    }
    const se = S.seasons.cur; if (!se) return send(res, 404, { error: 'There is no season right now.' });
    if (op === 'end') { if (se.status !== 'live') return send(res, 400, { error: 'This season has not started yet. Cancel it instead.' }); const e = seasonFinish(W, me.name); commit(W); return send(res, 200, { ok: true, entry: e }); }
    if (op === 'cancel') { S.seasons.cur = null; if (se.n === S.seasons.n) S.seasons.n = Math.max(HOF.length, se.n - 1); persist(); broadcast('config', effCfg()); audit(me.name, 'Cancelled a season (nothing recorded)', se.name); if (se.announce && b.announce !== false) systemMessage(`${se.name} has been cancelled.`); return send(res, 200, { ok: true }); }
    if (op === 'extend') { const d = +b.days; if (!(d > 0) || !se.end) return send(res, 400, { error: 'Only seasons with an end date can be extended.' }); se.end += Math.min(90, d) * 864e5; persist(); audit(me.name, 'Extended a season', `${se.name} by ${d} days`); if (se.announce) systemMessage(`⏳ ${se.name} has been extended. It now ends ${new Date(se.end).toUTCString().slice(0, 22)} UTC.`); return send(res, 200, { ok: true }); }
    if (op === 'rename') { const nm = clean(b.name).slice(0, 60); if (!nm) return send(res, 400, { error: 'Give the season a name.' }); se.name = nm; se.msg = clean(b.msg).slice(0, 300); persist(); return send(res, 200, { ok: true }); }
    return send(res, 400, { error: 'Unknown operation.' });
  }
  if (p === '/api/admin/poll' && req.method === 'POST') { // Admin page → Polls: questions sent to every player
    const b = await readBody(req, 32768), op = String(b.op || ''), clean = x => String(x == null ? '' : x).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim();
    const find = () => S.polls.find(x => x.id === b.id);
    if (op === 'list') return send(res, 200, { polls: S.polls, players: Object.keys(S.users).filter(id => !S.users[id].banned && S.docs['nations/' + id]).length });
    if (op === 'create') {
      const title = clean(b.title).slice(0, 120), intro = clean(b.intro).slice(0, 600); if (!title) return send(res, 400, { error: 'Give the poll a title.' });
      const qs = (Array.isArray(b.questions) ? b.questions : []).slice(0, 10).map(x => ({ q: clean(x && x.q).slice(0, 300), opts: (Array.isArray(x && x.opts) ? x.opts : []).map(o => clean(o).slice(0, 120)).filter(Boolean).slice(0, 8), multi: !!(x && x.multi), other: !!(x && x.other) })).filter(x => x.q && (x.opts.length >= 2 || (x.other && !x.opts.length)));
      if (!qs.length) return send(res, 400, { error: 'Add at least one question with two or more answers (or a written answer).' });
      const hrs = +b.hours, q = { id: crypto.randomBytes(6).toString('hex'), t: Date.now(), by: me.name, title, intro, questions: qs, active: true, ends: hrs > 0 ? Date.now() + Math.min(24 * 30, hrs) * HOUR : 0, answers: {}, skips: {} };
      S.polls.unshift(q); S.polls = S.polls.slice(0, 100); persist(); audit(me.name, 'Sent a poll to players', title); broadcast('poll', pollPublic(q)); return send(res, 200, { ok: true, id: q.id });
    }
    const q = find(); if (!q) return send(res, 404, { error: 'Poll not found.' });
    if (op === 'close') { q.active = false; persist(); broadcast('pollend', { id: q.id }); return send(res, 200, { ok: true }); }
    if (op === 'reopen') { q.active = true; if (q.ends && q.ends < Date.now()) q.ends = 0; persist(); broadcast('poll', pollPublic(q)); return send(res, 200, { ok: true }); }
    if (op === 'delete') { S.polls = S.polls.filter(x => x !== q); persist(); broadcast('pollend', { id: q.id }); audit(me.name, 'Deleted a poll', q.title); return send(res, 200, { ok: true }); }
    return send(res, 400, { error: 'Unknown action.' });
  }
  if (p === '/api/admin/finance' && req.method === 'POST') { // Admin page → Money: donations and expenses shown on the public Fair play page
    const b = await readBody(req, 8192), op = String(b.op || '');
    const clean = x => String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').trim();
    const entry = (e = {}) => { const amt = Math.round(Math.abs(+b.amount) * 100) / 100; if (!isFinite(amt) || amt <= 0 || amt > 1e7) throw new Error('Enter an amount above $0.'); const label = clean(b.label).slice(0, 80); if (!label) throw new Error('Add a short description.');
      const d = Date.parse(String(b.date || '')); return { ...e, kind: b.kind === 'expense' ? 'expense' : 'donation', amount: amt, label, note: clean(b.note).slice(0, 300), date: isFinite(d) ? d : Date.now() }; };
    try {
      if (op === 'add') { const e = entry({ id: crypto.randomBytes(6).toString('hex'), t: Date.now() }); S.finance.unshift(e); S.finance.sort((x, y) => y.date - x.date); S.finance = S.finance.slice(0, 2000); persist(); audit(me.name, 'Added ' + e.kind, e.label, '$' + e.amount); return send(res, 200, { ok: true, finance: S.finance }); }
      if (op === 'edit') { const i = S.finance.findIndex(x => x.id === b.id); if (i < 0) return send(res, 404, { error: 'Entry not found.' }); S.finance[i] = entry(S.finance[i]); S.finance.sort((x, y) => y.date - x.date); persist(); audit(me.name, 'Edited ' + S.finance[i].kind, S.finance[i].label, '$' + S.finance[i].amount); return send(res, 200, { ok: true, finance: S.finance }); }
      if (op === 'del') { const i = S.finance.findIndex(x => x.id === b.id); if (i < 0) return send(res, 404, { error: 'Entry not found.' }); const [e] = S.finance.splice(i, 1); persist(); audit(me.name, 'Deleted ' + e.kind, e.label, '$' + e.amount); return send(res, 200, { ok: true, finance: S.finance }); }
      if (op === 'list') return send(res, 200, { ok: true, finance: S.finance });
    } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 400, { error: 'Unknown action.' });
  }
  if (p === '/api/admin/crisis' && req.method === 'POST') { // Admin page → World crises
    const b = await readBody(req, 4096), op = String(b.op || '');
    if (op === 'start') { const cr = crisisStart(String(b.key), b.hours, String(b.diff || ''), me.name); audit(me.name, 'Started world crisis', WP.CRISES[cr.key].n, `${Math.round((cr.end - cr.start) / HOUR)}h · ${cr.diff} · goal ${WP.moneyS(cr.goal)}`); return send(res, 200, { ok: true }); }
    if (op === 'settings') { const c = crisisCfg(); if (b.auto != null) c.auto = !!b.auto; if (isFinite(+b.everyD) && b.everyD !== '') c.everyD = Math.max(.5, Math.min(30, +b.everyD)); if (isFinite(+b.hours) && b.hours !== '') c.hours = Math.max(2, Math.min(96, Math.round(+b.hours))); if (WP.CRISIS.diff[b.diff]) c.diff = b.diff; if (Array.isArray(b.types)) c.types = b.types.filter(k => WP.CRISES[k]);
      S.config.crisis = c; if (b.nextH != null && isFinite(+b.nextH) && b.nextH !== '') S.nextCrisis = Date.now() + Math.max(0, +b.nextH) * HOUR; persist(); audit(me.name, 'Changed world crisis settings', JSON.stringify(c)); return send(res, 200, { ok: true }); }
    if (op === 'gstart') { gamesStart(b.hours, me.name); audit(me.name, 'Started the World Games', null, `${b.hours || gamesCfg().hours}h`); return send(res, 200, { ok: true }); }
    if (op === 'gend') { if (!S.games || S.games.over) return send(res, 400, { error: 'The World Games are not on.' }); const W = mkWorld(); if (b.cancel) { S.games = null; W.gch = true; systemMessage('The World Games were called off.'); } else gamesFinish(W); commit(W); audit(me.name, 'Ended the World Games', null, b.cancel ? 'cancelled' : 'medals awarded'); return send(res, 200, { ok: true }); }
    if (op === 'gsettings') { const c = gamesCfg(); if (b.auto != null) c.auto = !!b.auto; if (isFinite(+b.everyD) && b.everyD !== '') c.everyD = Math.max(.5, Math.min(30, +b.everyD)); if (isFinite(+b.hours) && b.hours !== '') c.hours = Math.max(2, Math.min(96, Math.round(+b.hours))); S.config.games = c; persist(); audit(me.name, 'Changed World Games settings', JSON.stringify(c)); return send(res, 200, { ok: true }); }
    if (op === 'dstrike') { const W = mkWorld(); const t = typeof b.target === 'string' && Object.prototype.hasOwnProperty.call(W.A, b.target) ? b.target : null; const rec = disasterStrike(W, t, String(b.kind || '')); if (!rec) return send(res, 400, { error: 'No nation to strike.' }); commit(W); audit(me.name, 'Triggered a disaster', rec.name, `${rec.kind} at ${rec.place}`); return send(res, 200, { ok: true }); }
    if (op === 'nukeacc') { const W = mkWorld(); const t = typeof b.target === 'string' && Object.prototype.hasOwnProperty.call(W.A, b.target) ? b.target : null; const pool = t ? [t] : Object.keys(W.A).filter(k => W.A[k].nuke); if (!pool.length) return send(res, 400, { error: 'No nation has a nuclear program.' }); if (t && !W.A[t].nuke) return send(res, 400, { error: `${W.A[t].name} has no nuclear program.` }); const r = nukeAccidentNow(W, pool[Math.floor(rng() * pool.length)]); commit(W); audit(me.name, 'Triggered a nuclear accident', r.name, r.place); return send(res, 200, { ok: true }); }
    if (op === 'dsettings') { const c = disCfg(); if (b.auto != null) c.auto = !!b.auto; if (isFinite(+b.everyH) && b.everyH !== '') c.everyH = Math.max(1, Math.min(168, +b.everyH)); S.config.dis = c; persist(); audit(me.name, 'Changed disaster settings', JSON.stringify(c)); return send(res, 200, { ok: true }); }
    if (op === 'blocdisband') { const bl = S.blocs[String(b.id)]; if (!bl || !Object.prototype.hasOwnProperty.call(S.blocs, String(b.id))) return send(res, 404, { error: 'No such alliance.' }); const W = mkWorld(); for (const m of bl.members || []) if (W.A[m]) { W.A[m].bloc = null; W.changed.add(m); } delete S.blocs[bl.id]; W.bch = true; commit(W); systemMessage(`The alliance ${bl.name} was disbanded by the administrators.`); audit(me.name, 'Disbanded alliance', bl.name); return send(res, 200, { ok: true }); }
    const cr = S.crisis; if (!cr || cr.over) return send(res, 400, { error: 'There is no world crisis under way.' });
    if (op === 'extend') { const h = Math.max(1, Math.min(48, Math.round(+b.hours || 6))); cr.end += h * HOUR; persist(); broadcast('crisis', crisisView()); audit(me.name, 'Extended world crisis', WP.CRISES[cr.key].n, `+${h}h`); return send(res, 200, { ok: true }); }
    if (op === 'goal') { const g = Math.round(+b.goal); if (!(g >= 1e6)) return send(res, 400, { error: 'Enter a goal of at least $1M.' }); cr.goal = g; persist(); broadcast('crisis', crisisView()); audit(me.name, 'Changed world crisis goal', WP.CRISES[cr.key].n, WP.moneyS(g)); const W = mkWorld(); crisisCheck(W); commit(W); return send(res, 200, { ok: true }); }
    if (op === 'end') { const W = mkWorld(); const res_ = b.result === 'success' ? true : b.result === 'fail' ? false : null; crisisFinish(W, res_, res_ === null ? 'by the administrators' : ''); commit(W); audit(me.name, 'Ended world crisis', WP.CRISES[cr.key].n, b.result || 'cancel'); return send(res, 200, { ok: true }); }
    return send(res, 400, { error: 'Unknown action.' });
  }
  if (p === '/api/admin/boss' && req.method === 'POST') { // Admin page → Rising Power
    const b = await readBody(req, 4096), op = String(b.op || '');
    const W = mkWorld(), id = Object.keys(W.A).find(k => BOTS.isBot(k) && W.A[k].ai && W.A[k].ai.boss);
    if (op === 'settings') {
      const c = b.settings || {}, bs = { ...BOTS.BOSS_DEF, ...(S.config.boss || {}) };
      if (['auto', 'manual'].includes(c.mode)) bs.mode = c.mode;
      for (const k of ['str', 'aggr']) if (c[k] != null && isFinite(+c[k])) bs[k] = Math.max(k === 'aggr' ? 0 : .25, Math.min(k === 'str' ? 5 : 3, +c[k]));
      for (const [k, lo, hi] of [['def', 1, 4], ['atk', 1, 4], ['coal', 0, 20], ['heal', 0, 6]]) if (c[k] != null && isFinite(+c[k])) bs[k] = Math.max(lo, Math.min(hi, +c[k]));
      if (['yes', 'no'].includes(c.dome)) bs.dome = c.dome;
      if (['yes', 'deter', 'no'].includes(c.nukes)) bs.nukes = c.nukes;
      if (c.target != null) bs.target = typeof c.target === 'string' && Object.prototype.hasOwnProperty.call(W.A, c.target) ? c.target : '';
      if (c.breatherH != null && isFinite(+c.breatherH)) bs.breatherH = Math.max(0, Math.min(720, Math.round(+c.breatherH)));
      const was = JSON.stringify(S.config.boss || {}); S.config.boss = bs; if (b.auto != null) S.config.aiBoss = !!b.auto; persist();
      audit(me.name, 'Changed Rising Power settings', `${was} → ${JSON.stringify(bs)}${b.auto != null ? ` · auto spawn ${S.config.aiBoss ? 'on' : 'off'}` : ''}`); return send(res, 200, { ok: true });
    }
    if (op === 'raise') {
      if (id) return send(res, 400, { error: `${W.A[id].name} is already the Rising Power. Retire it first.` });
      const want = typeof b.pick === 'string' && BOTS.isBot(b.pick) && W.A[b.pick] ? b.pick : '';
      if (!Object.keys(W.A).some(k => BOTS.isBot(k))) return send(res, 400, { error: 'There are no AI nations to raise. Turn AI nations on first.' });
      if (!Object.keys(W.A).some(k => !BOTS.isBot(k))) return send(res, 400, { error: 'There are no player nations yet.' });
      S.bossFell = 0; S.config.aiBoss = true;
      const W2 = mkWorld(), nb = BOTS.raiseBoss(W2, W2.cfg, want); if (!nb) return send(res, 400, { error: 'Could not raise a Rising Power right now.' });
      commit(W2); persist(); systemMessage(`⚠ ${W2.A[nb].name} has become the Rising Power. Foreign backers are pouring money and weapons into its military. Stopping it will take the world working together.`);
      audit(me.name, 'Raised the Rising Power', W2.A[nb].name); return send(res, 200, { ok: true, name: W2.A[nb].name });
    }
    if (!id) return send(res, 400, { error: 'There is no Rising Power right now.' });
    const n = W.A[id];
    if (op === 'retire') {
      n.ai.boss = false; n.ai.isolated = 0; n.ai.exBoss = Date.now(); delete n.ai.defX; delete n.ai.atkX; core.touch(W, id); S.bossFell = Date.now(); if (b.stopAuto) S.config.aiBoss = false; commit(W); persist();
      if (b.announce !== false) systemMessage(`🕊 ${n.name}'s foreign backers have pulled out. It is no longer the Rising Power.`);
      audit(me.name, 'Retired the Rising Power', n.name + (b.stopAuto ? ' (auto spawn off)' : '')); return send(res, 200, { ok: true });
    }
    if (op === 'grant') {
      const g = b.grant || {}, lim = { cash: 5e10, troops: 5e6, air: 5e4, ships: 5e4, tech: 20, fort: 12 }, done = [];
      for (const [k, mx] of Object.entries(lim)) { const x = Math.round(+g[k] || 0); if (!x) continue; const v = Math.max(-mx, Math.min(mx, x));
        if (k === 'fort') n.fort = Math.max(0, Math.min(12, (n.fort || 0) + v)); else n[k] = Math.max(0, (n[k] || 0) + v); done.push(`${k} ${v > 0 ? '+' : ''}${v}`); }
      { const x = Math.max(-1e6, Math.min(1e6, Math.round(+g.res || 0))); if (x) { n.res = n.res || {}; for (const r of ['oil', 'steel', 'food', 'goods']) n.res[r] = Math.max(0, (n.res[r] || 0) + x); done.push(`resources ${x > 0 ? '+' : ''}${x} each`); } }
      if (Number.isInteger(g.rank) && g.rank >= 0 && g.rank < WP.RANKS.length) { n.xp = WP.RANKS[g.rank][0]; done.push(`rank set to ${WP.RANKS[g.rank][1]}`); }
      if (g.heal) { n.approval = Math.max(n.approval, 70); n.stability = Math.max(n.stability, 70); n.regroup = 0; done.push('morale restored'); }
      if (!done.length) return send(res, 400, { error: 'Nothing to change.' });
      core.touch(W, id); commit(W); audit(me.name, 'Adjusted the Rising Power', `${n.name}: ${done.join(', ')}`); return send(res, 200, { ok: true });
    }
    if (op === 'cmd') {
      let r; try { r = BOTS.bossCommand(W, id, { kind: String(b.kind || ''), v: b.v, force: !!b.force, target: ['mil', 'infra', 'stock'].includes(b.target) ? b.target : 'mil' }, W.cfg); }
      catch (e) { if (e.user || e.message) return send(res, 400, { error: e.message }); throw e; }
      commit(W); audit(me.name, 'Ordered the Rising Power', `${b.kind}${b.v && W.A[b.v] ? ' → ' + W.A[b.v].name : ''}`);
      const tn = (W.A[b.v] || {}).name || 'the target'; return send(res, 200, { ok: true, msg: ({ war: `${n.name} declared war on ${tn}. Its forces must mobilize (about 10 minutes) before they can strike.`, peace: `${n.name} offered peace to ${tn}.` })[b.kind] || (r && r.msg) || 'Order carried out.' });
    }
    return send(res, 400, { error: 'Unknown request.' });
  }
  if (p === '/api/admin/peace' && req.method === 'POST') {
    const b = await readBody(req, 1024), A_ = S.docs['nations/' + b.a], B_ = S.docs['nations/' + b.b];
    if (typeof b.a !== 'string' || typeof b.b !== 'string' || b.a === b.b || !A_ || !B_ || !Object.prototype.hasOwnProperty.call(S.docs, 'nations/' + b.a) || !Object.prototype.hasOwnProperty.call(S.docs, 'nations/' + b.b)) return send(res, 400, { error: 'Pick two nations.' });
    const t = Date.now(); for (const [x, y] of [[A_, b.b], [B_, b.a]]) { x.rel = x.rel || {}; x.rel[y] = { ...(x.rel[y] || {}), peace: t }; }
    setDoc('nations', b.a, A_); setDoc('nations', b.b, B_); systemMessage(`🕊 The administrators have imposed peace between ${A_.name} and ${B_.name}.`);
    audit(me.name, 'Forced peace', `${A_.name} ↔ ${B_.name}`); return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/fires-out' && req.method === 'POST') { const n = Object.keys(S.burn).length; S.burn = {}; S.strikes = []; persist(); broadcast('firesout', {}); audit(me.name, 'Put out all fires', null, `${n} burning provinces`); return send(res, 200, { ok: true, n }); }
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
      for (const k of ['war', 'signups', 'botRetire', 'eventsOn', 'conquest', 'weakRule', 'nukeTest', 'councilAuto', 'aiBoss']) if (c[k] != null) nc[k] = !!c[k];
      if (c.lastStandH != null && isFinite(+c.lastStandH)) nc.lastStandH = Math.max(0, Math.min(168, +c.lastStandH));
      if (c.motd != null) nc.motd = String(c.motd).slice(0, 1000);
      if (c.donateUrl != null) { const d = String(c.donateUrl).trim(); if (d && !/^https:\/\/[^\s"'<>]+$/i.test(d)) return send(res, 400, { error: 'The donation link must start with https://' }); nc.donateUrl = d || WP.DEFCFG.donateUrl; }
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
      const backup = path.join(BACKUP_DIR, `backup-before-wipe-${Date.now()}.json`); fs.writeFileSync(backup, JSON.stringify(S)); S.burn = {}; S.strikes = [];
      for (const k of Object.keys(S.docs)) { const [c, id] = k.split('/'); if (COLS.includes(c)) setDoc(c, id, null); }
      S.flags = []; S.council = { props: [], active: {} }; S.blocs = Object.create(null); S.crisis = null; S.games = null; S.dis = []; S.event = null; RH = []; rhGz = null; try { fs.unlinkSync(RANK_FILE); } catch (e) {} broadcast('council', councilView()); broadcast('event', null);
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
    if (req.method === 'GET' && p === '/donate') { const d = /^https:\/\/[^\s"'<>]+$/i.test(S.config.donateUrl || '') ? S.config.donateUrl : WP.DEFCFG.donateUrl; res.writeHead(302, { Location: d, 'Cache-Control': 'no-store' }); return res.end(); } // anyone can donate, no account needed
    if (req.method === 'GET' && STATIC[p]) return serveStatic(req, res, STATIC[p]);
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/nukes') return send(res, 200, { nukes: S.nukes.slice(0, 50) });
    if (req.method === 'GET' && p === '/api/worldcash') { if (!WCASH || Date.now() - WCASH.t > 60e3) WCASH = worldCash(mkWorld()); return send(res, 200, WCASH); }
    if (req.method === 'GET' && p === '/api/rankhist') {
      const gz = rankHistBody(), hdr = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...hdr, 'Content-Encoding': 'gzip' }); return res.end(gz); }
      res.writeHead(200, hdr); return res.end(zlib.gunzipSync(gz));
    }
    if (req.method === 'GET' && p === '/api/fairplay') {
      const c = effCfg(), keys = ['cd', 'income', 'xp', 'protectH', 'lastStandH', 'war', 'conquest', 'weakRule', 'councilAuto', 'nukeTest', 'aiBoss', 'bots', 'botWar', 'electionH', 'eventsOn', 'signups'];
      return send(res, 200, { fingerprint: FINGERPRINT, files: CODE, live: START, releases: S.releases.slice(0, 50), log: S.fairlog.slice(0, 500), logTotal: S.fairlog.length,
        settings: Object.fromEntries(keys.map(k => [k, c[k]])), defaults: Object.fromEntries(keys.map(k => [k, WP.DEFCFG[k]])), boost: c.boost || null, council: S.council.active, event: S.event, finance: S.finance.slice(0, 500),
        world: { nations: Object.keys(S.docs).filter(k => k.startsWith('nations/')).length, players: Object.keys(S.users).length } }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/api/public/stats') return send(res, 200, publicStats(), { 'Cache-Control': 'public, max-age=30' });
    if (req.method === 'GET' && p === '/api/public/hof') { let cur = null; try { const se = S.seasons.cur; if (se) { const v = seasonView(seasonW(), se, null); cur = { ...v, top: v.top.slice(0, 10) }; } } catch (e) { } return send(res, 200, { hof: HOF, cur }, { 'Cache-Control': 'public, max-age=30' }); } // public: anyone can see the Hall of Fame
    if (req.method === 'GET' && p === S.adminPath) { const me = auth(req); if (!me || !me.admin) return notFound(req, res); return serveStatic(req, res, ADMIN_HTML); }
    if (req.method === 'GET' && p.startsWith('/n/')) return await nationPage(req, res, p.slice(3));
    if (!p.startsWith('/api/')) return notFound(req, res);

    if (req.method !== 'GET') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Forbidden.' });
      if (req.method !== 'DELETE' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required.' });
    }

    if (p === '/api/signup' && req.method === 'POST') {
      if (!S.config.signups) return send(res, 403, { error: 'Sign-ups are closed right now.' });
      if (limited('signup:' + ipOf(req), 15, 60 * 60e3)) return send(res, 429, { error: 'Too many sign-ups from your network. Try again later.' });
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
      if (limited('guest:' + ipOf(req), 8, 60 * 60e3)) return send(res, 429, { error: 'Too many guest games from your network. Create an account instead.' });
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
      if (limited('login:' + ipOf(req), 60, 15 * 60e3)) return send(res, 429, { error: 'Too many sign-in attempts. Wait 15 minutes.' });
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
    if (p === '/api/casino/fair') { const f = fairOf(me.id);
      if (req.method === 'GET') return send(res, 200, fairView(f));
      const b = await readBody(req, 1024);
      if (b.op === 'client') { const c = String(b.client || '').trim(); if (!/^[A-Za-z0-9_-]{1,64}$/.test(c)) return send(res, 400, { error: 'Use 1 to 64 letters, numbers, dashes or underscores.' }); const n = S.docs['nations/' + me.id]; if (n && n.bj) return send(res, 400, { error: 'Finish your blackjack hand first.' });
        if (f.nonce > (f.from || 0)) { f.prev = [{ seed: f.seed, hash: sha256(f.seed), client: f.client, from: f.from || 0, to: f.nonce - 1, t: Date.now() }, ...(f.prev || [])].slice(0, 50); f.seed = crypto.randomBytes(32).toString('hex'); f.from = f.nonce; } // a new client seed always starts a new server seed, so every revealed period checks out
        f.client = c; persist(); return send(res, 200, fairView(f)); }
      if (b.op === 'rotate') { const n = S.docs['nations/' + me.id]; if (n && n.bj) return send(res, 400, { error: 'Finish your blackjack hand first.' });
        f.prev = [{ seed: f.seed, hash: sha256(f.seed), client: f.client, from: f.from || 0, to: f.nonce - 1, t: Date.now() }, ...(f.prev || [])].slice(0, 50); f.seed = crypto.randomBytes(32).toString('hex'); f.from = f.nonce; persist(); return send(res, 200, fairView(f)); }
      return send(res, 400, { error: 'Unknown operation.' }); }
    if (p === '/api/casino/totals' && req.method === 'GET') return send(res, 200, { tot: casinoTotals() });
    if (p === '/api/season' && req.method === 'GET') return send(res, 200, { cur: seasonView(seasonW(), S.seasons.cur, me.id), hof: HOF });
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
      const b = await readBody(req, 1200 * 1024); const idea = b.kind === 'idea';
      if (limited((idea ? 'idea:' : 'bug:') + me.id, idea ? 10 : 6, 60 * 60e3)) return send(res, 429, { error: `Thanks — you have sent several ${idea ? 'ideas' : 'reports'} already. Try again later.` });
      const text = String(b.text || '').trim().slice(0, 2000); if (text.length < 5) return send(res, 400, { error: idea ? 'Please write your idea first.' : 'Please describe what happened.' });
      const id = rid(); let img = false;
      if (!idea && typeof b.img === 'string' && b.img.startsWith('data:image/jpeg;base64,')) { const buf = Buffer.from(b.img.slice(23), 'base64'); if (buf.length > 100 && buf.length < 1100 * 1024 && buf[0] === 0xff && buf[1] === 0xd8) { fs.mkdirSync(BUG_DIR, { recursive: true }); fs.writeFileSync(path.join(BUG_DIR, id + '.jpg'), buf); img = true; } }
      const ctx = { page: String(b.page || '').slice(0, 40), ua: String(req.headers['user-agent'] || '').slice(0, 200), screen: String(b.screen || '').slice(0, 30), errors: (Array.isArray(b.errors) ? b.errors : []).slice(0, 10).map(x => String(x).slice(0, 300)) };
      S.bugs.unshift({ id, t: Date.now(), by: me.id, byName: me.name, nation: nationName(me.id), text, img, ...ctx, ...(idea ? { kind: 'idea' } : {}), done: false });
      { const keep = k => S.bugs.filter(x => (x.kind === 'idea') === k).slice(0, 300); S.bugs = [...keep(false), ...keep(true)].sort((x, y) => y.t - x.t); } persist(); /* bugs and ideas each keep their latest 300 */
      for (const [aid2, u] of Object.entries(S.users)) if (u.admin) addNote(aid2, 'admin', `${idea ? '💡 Idea' : 'Bug report'} from ${me.name}: ${text.slice(0, 100)}`);
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
      if (b.c === 'bloc' && ['name', 'tag', 'motto', 'text'].some(k => typeof b[k] === 'string' && MOD.isProfane(b[k]))) return send(res, 400, { error: 'Please choose different wording.' });
      if (b.c === 'movecap' && typeof b.name === 'string' && MOD.isProfane(b.name)) return send(res, 400, { error: 'Please choose a different name for your nation.' });
      if (b.c === 'offer' && b.v && S.users[b.v] && sharesNetwork(me.id, b.v)) flag(me.id, `Sent a trade offer to ${(S.users[b.v] || {}).name || 'a player'}, who uses the same network (possible second account)`);
      let r;
      let fair = null, useRng = rng; if (b.c === 'casino') { fair = fairOf(me.id); W.fairNonce = fair.nonce; W.fairHash = sha256(fair.seed); useRng = fairRng(fair); }
      try { r = core.exec(W, me.id, b, useRng); }
      catch (e) { if (e.user) { actLog(me.id, W, b, false, e.message); return send(res, 400, { error: e.message }); } throw e; }
      if (fair) { if (r.casino) r.casino.fair = { nonce: fair.nonce, hash: W.fairHash }; fair.nonce++; }
      actLog(me.id, W, b, true, r.msg); pactCheck(W); if (W.crch || (b.c === 'attack' && S.crisis)) crisisCheck(W);
      if (b.c === 'found') { stat('nations'); inviteReward(W, me.id); }
      if (W.casinoEv) casinoRecord(W);
      commit(W);
      // your own nation comes back with the answer, so the screen updates the moment the action is done (no waiting on the live stream)
      return send(res, 200, { ok: true, msg: r.msg, battle: r.battle, promoted: W.promoted || null, selHex: W.selHex != null ? W.selHex : null, covert: r.ok, casino: r.casino ? { ...r.casino, tot: casinoTotals() } : undefined, me: S.docs['nations/' + me.id] || null });
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
      else if (b.all) { const box = b.box === 'out' ? 'out' : b.box === 'in' ? 'in' : null; S.mail[me.id] = box ? list.filter(m => m.box !== box) : []; } // delete all (one box, or everything)
      else S.mail[me.id] = list.filter(m => m.id !== b.id);
      persist(); sendTo(me.id, 'mail', { unread: (S.mail[me.id] || []).filter(m => m.box === 'in' && !m.read).length }); return send(res, 200, { ok: true });
    }
    // ---- notifications ----
    if (p === '/api/notes/read' && req.method === 'POST') { for (const n of S.notes[me.id] || []) n.read = true; persist(); return send(res, 200, { ok: true }); }
    if (p === '/api/notes/clear' && req.method === 'POST') { const b = await readBody(req, 1024); if (typeof b.id === 'string') S.notes[me.id] = (S.notes[me.id] || []).filter(n => n.id !== b.id); else S.notes[me.id] = []; persist(); return send(res, 200, { ok: true });}
    if (p === '/api/poll' && req.method === 'POST') {
      const b = await readBody(req, 8192), q = S.polls.find(x => x.id === b.id); if (!q) return send(res, 404, { error: 'That poll has ended.' });
      if (!pollOpen(q)) return send(res, 400, { error: 'That poll has closed.' }); q.answers = q.answers || {}; q.skips = q.skips || {};
      if (q.answers[me.id]) return send(res, 400, { error: 'You already answered this poll.' });
      if (b.skip) { q.skips[me.id] = Date.now(); persist(); return send(res, 200, { ok: true }); }
      const A = Array.isArray(b.answers) ? b.answers : [], out = [];
      for (let i = 0; i < q.questions.length; i++) { const Q = q.questions[i], a = A[i] || {}; let pick = (Array.isArray(a.pick) ? a.pick : [a.pick]).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x < Q.opts.length); pick = [...new Set(pick)]; if (!Q.multi) pick = pick.slice(0, 1);
        const other = Q.other ? MOD.clean(String(a.other || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300)) : ''; if (!pick.length && !other) return send(res, 400, { error: `Answer question ${i + 1} first.` }); out.push({ pick, other }); }
      q.answers[me.id] = { t: Date.now(), a: out, name: (S.users[me.id] || {}).name || '', nation: (S.docs['nations/' + me.id] || {}).name || '' }; delete q.skips[me.id]; persist();
      return send(res, 200, { ok: true });
    }
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
    // daily thank-you for voting for the game: once every 24 hours per account, 1% of GDP ($1M to $25M). The vote itself can't be checked, so the daily limit keeps it fair.
    if (p === '/api/vote-bonus' && req.method === 'POST') {
      touch(me.id, req); const n = S.docs['nations/' + me.id]; if (!n) return send(res, 400, { error: 'Found a nation first, then vote to get your daily bonus.' });
      const m = meta(me.id), now = Date.now(), wait = (m.voteT || 0) + 24 * HOUR - now;
      if (wait > 0) return send(res, 200, { ok: false, next: m.voteT + 24 * HOUR, msg: `Thanks for voting! Your next bonus is ready in ${Math.floor(wait / HOUR)}h ${Math.floor(wait % HOUR / 60e3)}m.` });
      const amt = voteBonus(n); n.cash = (n.cash || 0) + amt; m.voteT = now; (n.log = n.log || []).unshift({ t: now, x: `Thank you for voting for World Powers: +${WP.moneyS(amt)} daily bonus.` }); n.log = n.log.slice(0, 60);
      setDoc('nations', me.id, n); stat('votes'); return send(res, 200, { ok: true, amt, next: now + 24 * HOUR, msg: `Thanks for voting! +${WP.moneyS(amt)} has been added to your treasury.` });
    }
    if (p === '/api/council/bribe' && req.method === 'POST') { await readBody(req, 256); touch(me.id, req); const r = councilBribe(me.id); return send(res, 200, { ok: true, ...r }); }
    if (p === '/api/council/vote' && req.method === 'POST') { const b = await readBody(req, 1024); touch(me.id, req); councilVote(me.id, b); return send(res, 200, { ok: true }); }

    const m = p.match(/^\/api\/doc\/(chat|online)\/([A-Za-z0-9_-]{1,64})$/);
    if (m) {
      const [, col, id] = m;
      if (id !== me.id) return send(res, 403, { error: 'You can only change your own data.' });
      if (req.method === 'PUT') {
        if (limited('w:' + me.id, 30, 10e3)) return send(res, 429, { error: 'Slow down.' });
        let d = await readBody(req, 160 * 1024); // up to 40 messages of 1,000 characters
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
