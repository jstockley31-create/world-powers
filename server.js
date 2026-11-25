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
// Two maps ship with the game: v1 (961 provinces) and v2 (the bigger map: the same world with its big provinces split, 1,711 provinces).
// Every v1 province keeps its number in v2, so nothing saved needs renumbering. The game runs on v1 until the real world is back
// from the season, then switches to v2 for good (see map2Switch below).
const PROV1 = require('./prov-lite.json'), PROV2 = require('./prov2-lite.json');
function mkCore(prov) { const c = WP.Core(prov, SCENARIOS); try { const landT = require('./geo-land.js')(); if (landT) c.setLandTest(landT); } catch (e) {} return c; }
let PROV = PROV1, core = mkCore(PROV1);
const makeBots = require('./bots.js');
const PUSH = require('./push.js');
const MOD = require('./moderation.js');
const makeSupporters = require('./supporters.js'); let SUPP = null;

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
const COUNCIL_H = 3, COUNCIL_MIN_YES = 3; // a resolution needs at least 3 yes votes and more yes than no
// heavier penalties need more: sanctions two thirds of the vote and at least 5 yes, the other penalties at least 4 yes
const PENALTY_TYPES = ['sanction', 'embargo', 'armsEmb', 'freeze', 'condemn', 'inspect'];
const minYes = t => t === 'sanction' ? 5 : PENALTY_TYPES.includes(t) ? 4 : COUNCIL_MIN_YES;
const passes = (t, ys, ns) => ys >= minYes(t) && ys > ns && (t !== 'sanction' || ys * 3 >= (ys + ns) * 2);
const PENALTY_FEE = .01; // the proposer of a penalty pays 1% of its treasury, refunded if the vote passes
// bonus laws can pass at most once every 3 days (counted from when the last one ended for the 72-hour free market week)
const BONUS_LAWS = ['climate', 'arms', 'freetrade', 'peacekeeping', 'health', 'science', 'food', 'tariffs', 'freemarket'];
const bonusWait = k => { if (!BONUS_LAWS.includes(k)) return 0; const t = ((S.council && S.council.passed) || {})[k] || 0; if (!t) return 0; const R = WP.RESOLUTIONS[k]; return Math.max(72, (R.h || 24) + 48) * HOUR - (Date.now() - t); };
const HOUR = 36e5;
const ACTIVE_WINDOW = 2 * HOUR; // nations keep producing for 2 hours after their leader was last seen
const NOTE_KINDS = ['ready', 'attack', 'war', 'diplo', 'mail', 'election', 'event', 'council', 'covert', 'economy', 'rank', 'mention', 'admin'];
const DEFAULT_PREFS = { spygames: true, ready: true, attack: true, war: true, diplo: true, mail: true, election: true, event: true, council: true, covert: true, economy: true, rank: false, mention: true, admin: true };

fs.mkdirSync(BACKUP_DIR, { recursive: true });
let S = { users: {}, sessions: {}, docs: {}, meta: {}, flags: [], audit: [], config: { ...WP.DEFCFG } };
try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') { console.error('Could not read', FILE, e.message); process.exit(1); } }
S.config = { ...WP.DEFCFG, ...(S.config || {}) };
if (!S.councilAutoOffV1) { S.config.councilAuto = false; S.councilAutoOffV1 = 1; } // automatic World Council resolutions are off; only players propose
// one-time 24-hour pause on overstretch penalties, starting when this update first boots
if (!S.overPauseSet) { S.overPause = Date.now() + 24 * 36e5; S.overPauseSet = 1; }
if (!S.migLS24) { S.config.lastStandH = 24; S.migLS24 = true; } // the capital warning period became 24 hours
for (const k of ['meta', 'mail', 'notes', 'push', 'stats', 'actlog', 'botsig']) S[k] = S[k] || {};
const fallenPub = () => S.fallen.slice(0, 30).map(({ msg, leader, ...f }) => f); // the public fallen list never carries the conqueror's last message (that is only for the fallen player)
const LASTWORDS_MIN = 30, LASTWORDS_MAX = 200; // the conqueror's last message: how long they have to send it, and its length
for (const k of ['polls', 'finance', 'flags', 'audit', 'reports', 'fallen', 'bugs', 'schedule', 'nukes', 'strikes', 'strikeLog', 'ntests', 'ntestPending']) S[k] = S[k] || [];
const VOTE_SITES = { gt: 'Gametoor', mm: 'BrowserMMORPG', xt: 'XtremeTop100', m5: 'Top MMO Games', tw: 'Top Web Games', m1: 'MMORPG 100', ax: 'Apex Web Gaming' }, VOTE_GAP = 6 * HOUR; // one bonus per site each time its button lights up again
const voteBonus = n => Math.min(25e6, Math.max(2e6, Math.round((n.gdp || 0) * .02 / 1e5) * 1e5)); // at least $2M per vote (2% of GDP for bigger nations, up to $25M)
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
function ntestSweep() { for (const fx of S.ntestPending.slice()) { if (Date.now() - fx.go > 3 * 60e3) { S.ntestPending = S.ntestPending.filter(x => x.id !== fx.id); S.ntests.unshift({ ...fx, fired: fx.go, missed: true }); } else armTest(fx); } }
setTimeout(ntestSweep, 2000); // also run when the real world comes back after a season, so a test that was pending at the switch does not stay stuck
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
for (const k of ['users', 'sessions', 'docs', 'meta', 'mail', 'notes', 'push', 'stats', 'actlog', 'botsig']) S[k] = Object.assign(Object.create(null), S[k]);
if (!S.adminPath) S.adminPath = '/hq-' + crypto.randomBytes(12).toString('hex');
if (!S.vapid) S.vapid = PUSH.makeVapid();
if (!S.nextEvent) S.nextEvent = Date.now() + 6 * HOUR;
// ---------- fair play: a fingerprint of the exact game code running, its release history, and a public log of admin game actions ----------
const FAIR_ACTIONS = new Set(['Changed game settings', 'Edited nation', 'Set rogue status', 'Reset nation', 'Rolled back the world', 'Wiped the world', 'Started world event', 'Ended world event', 'Scheduled', 'Cancelled scheduled event', 'Cancelled council vote', 'Added AI nation', 'Removed AI nation', 'Restored nation from snapshot', 'Started the World Games', 'Ended the World Games', 'Triggered a disaster', 'Triggered a nuclear accident', 'Started world crisis', 'Ended world crisis', 'Disbanded alliance']);
const CODE_FILES = ['server.js', 'bots.js', 'moderation.js', 'push.js', 'supporters.js', 'public/core.js', 'public/scenarios.js', 'public/index.html', 'public/index2.html', 'public/prov.js', 'public/prov2.js', 'prov2-lite.json', 'public/admin.html'];
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
if (S.map2) { PROV = PROV2; core = mkCore(PROV2); } // the bigger map is already in use
let BOTS = makeBots(core, WP, rng);
// the pieces each v1 province was split into: { old number: [new numbers] }
const MAP2_PIECES = (() => { const m = {}; PROV2.p.forEach((p, i) => { if (p.of != null) (m[p.of] = m[p.of] || []).push(i); }); return m; })();
// a nation saved on the old map keeps every piece of each split province it held: the extra pieces are "legacy pieces" (no administration, no score)
function map2Grant(n) { if (!n || !n.hexes) return 0; let k = 0; for (const [h, ts] of Object.entries(n.hexes)) { const ps = MAP2_PIECES[h]; if (!ps) continue; for (const q of ps) if (n.hexes[q] == null) { n.hexes[q] = ts; (n.split = n.split || {})[q] = ts; k++; } } return k; }
function map2GrantAll() { let k = 0, c = 0; for (const [key, n] of Object.entries(S.docs)) if (key.startsWith('nations/')) { const g = map2Grant(n); if (g) { k += g; c++; } } return { pieces: k, nations: c }; }
// switch the running game to the bigger map: only ever called with the real world loaded and no Chaos world running
function map2Switch(why) {
  if (S.map2) return false; if (S.fresh || (S.chaos && S.chaos.on)) return false;
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(path.join(BACKUP_DIR, `before-bigger-map-${Date.now()}.json.gz`), zlib.gzipSync(JSON.stringify(S))); } catch (e) { logErr('Could not write the backup before the bigger map: ' + e.message); return false; } // no backup, no switch
  PROV = PROV2; core = mkCore(PROV2); BOTS = makeBots(core, WP, rng); S.map2 = Date.now(); const g = map2GrantAll();
  try { SW = null; publicCache = null; } catch (e) {} try { labStop(); } catch (e) {} persist(true);
  try { audit('System', 'The bigger map is live', `${PROV1.p.length} → ${PROV2.p.length} provinces (${why}). ${g.nations} nations kept ${g.pieces} extra pieces of their split provinces. Building tall now pays.`); } catch (e) {}
  try { systemMessage(`🗺 The world just got bigger: ${PROV2.p.length.toLocaleString('en-US')} provinces instead of ${PROV1.p.length}, with more detail in Europe. You kept every piece of your land, and the extra pieces don't count against your province limit. Well-developed nations now earn a bonus. See Updates for details.`); } catch (e) {}
  setTimeout(() => { try { broadcast('config', effCfg()); broadcast('reload', { t: Date.now() }); } catch (e) {} }, 400);
  return true;
}
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
// files are compressed quickly at start-up so the server answers within a second of a deploy; the smallest versions are made in the background a few seconds later.
// images and fonts are already compressed, so they are sent as they are.
const PACKED = /^(image\/(png|jpeg|webp)|font\/)/, SLOWZ = [];
function slowZip() { const f = SLOWZ.shift(); if (!f) return; zlib.brotliCompress(f.buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: f.buf.length } }, (e, br) => { if (!e && br.length < f.br.length) f.br = br; zlib.gzip(f.buf, { level: 9 }, (e2, gz) => { if (!e2 && gz.length < f.gz.length) f.gz = gz; setImmediate(slowZip); }); }); }
setTimeout(slowZip, 3000).unref();
function loadFile(file, type, cache) { const buf = fs.readFileSync(path.join(__dirname, 'public', file)); const packed = PACKED.test(type); const o = { type, buf, gz: packed ? null : zlib.gzipSync(buf, { level: 6 }), br: packed ? null : zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }), etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"', cache }; if (!packed) SLOWZ.push(o); return o; }
const HTML = 'text/html; charset=utf-8', JS = 'text/javascript; charset=utf-8';
const GAME = loadFile('index.html', HTML, 'no-cache'), LANDING = loadFile('landing.html', HTML, 'no-cache');
STATIC['/hof'] = loadFile('hof.html', HTML, 'no-cache'); STATIC['/donate'] = loadFile('donate.html', HTML, 'no-cache'); STATIC['/updates'] = loadFile('updates.html', HTML, 'no-cache'); STATIC['/dev'] = loadFile('dev.html', HTML, 'no-cache'); STATIC['/play'] = GAME; STATIC['/terms'] = loadFile('terms.html', HTML, 'no-cache'); STATIC['/privacy'] = loadFile('privacy.html', HTML, 'no-cache'); STATIC['/fair'] = loadFile('fair.html', HTML, 'no-cache'); STATIC['/faq'] = loadFile('faq.html', HTML, 'no-cache');
STATIC['/vendor/d3.min.js'] = loadFile('vendor/d3.min.js', JS, 'public, max-age=604800');
STATIC['/core.js'] = loadFile('core.js', JS, 'no-cache'); STATIC['/scenarios.js'] = loadFile('scenarios.js', JS, 'no-cache');
STATIC['/sw.js'] = loadFile('sw.js', JS, 'no-cache');
STATIC['/landing-land.js'] = loadFile('landing-land.js', JS, 'public, max-age=604800');
STATIC['/prov.js'] = loadFile('prov.js', JS, 'public, max-age=31536000, immutable'); STATIC['/prov2.js'] = loadFile('prov2.js', JS, 'public, max-age=31536000, immutable'); const GAME2 = loadFile('index2.html', HTML, 'no-cache'), gameFile = () => S.map2 ? GAME2 : GAME; // index2.html is index.html loading the bigger map // the URL carries a version number, so browsers keep it until the map changes
STATIC['/og.jpg'] = loadFile('og.jpg', 'image/jpeg', 'public, max-age=604800');
// the new-player tutorial video: served with byte ranges, which phones (Safari especially) need to play a video
const TUTV = (() => { try { const buf = fs.readFileSync(path.join(__dirname, 'public', 'tutorial.mp4')); return { buf, etag: '"t' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"' }; } catch (e) { return null; } })();
function serveVideo(req, res) { const v = TUTV, n = v.buf.length, h = { ...secHeaders(req), 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', ETag: v.etag };
  if (req.headers['if-none-match'] === v.etag) { res.writeHead(304, h); return res.end(); }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ''); if (!m) { res.writeHead(200, { ...h, 'Content-Length': n }); return res.end(v.buf); }
  let a = m[1] === '' ? Math.max(0, n - (+m[2] || 0)) : +m[1], b = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], n - 1) : n - 1;
  if (!(a <= b) || a >= n) { res.writeHead(416, { ...h, 'Content-Range': `bytes */${n}` }); return res.end(); }
  res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${n}`, 'Content-Length': b - a + 1 }); res.end(v.buf.subarray(a, b + 1)); }
for (const f of ['banner-240x100.png', 'banner-468x60.png', 'banner-728x90.png']) STATIC['/' + f] = loadFile(f, 'image/png', 'public, max-age=86400'); // banners for voting and link sites
for (const f of ['inter-latin.woff2', 'inter-latin-ext.woff2', 'cinzel-700.woff2', 'jbmono-500.woff2']) STATIC['/fonts/' + f] = loadFile('fonts/' + f, 'font/woff2', 'public, max-age=31536000, immutable');
STATIC['/fonts/fonts.css'] = loadFile('fonts/fonts.css', 'text/css; charset=utf-8', 'public, max-age=86400');
STATIC['/robots.txt'] = { type: 'text/plain; charset=utf-8', buf: Buffer.from('User-agent: *\nAllow: /$\nAllow: /faq\nAllow: /n/\nAllow: /terms\nAllow: /privacy\nAllow: /sitemap.xml\nDisallow: /\n\nSitemap: ' + (process.env.SITE_URL || 'https://worldpowersgame.com').replace(/\/$/, '') + '/sitemap.xml\n'), cache: 'public, max-age=86400' };
Object.assign(STATIC['/robots.txt'], { gz: zlib.gzipSync(STATIC['/robots.txt'].buf), br: zlib.brotliCompressSync(STATIC['/robots.txt'].buf), etag: '"robots3"' });
const NOTFOUND = loadFile('404.html', HTML, 'no-cache');
STATIC['/manifest.webmanifest'] = loadFile('manifest.webmanifest', 'application/manifest+json', 'no-cache');
STATIC['/icon.svg'] = loadFile('icon.svg', 'image/svg+xml', 'public, max-age=604800');
const ADMIN_HTML = { ...loadFile('admin.html', HTML, 'no-store') };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://www.googletagmanager.com https://www.google.com https://www.google.ca https://googleads.g.doubleclick.net https://www.googleadservices.com https://media.giphy.com https://*.giphy.com https://media.tenor.com https://*.tenor.com https://i.imgur.com https://i.redd.it; connect-src 'self' https://www.google.com https://www.googletagmanager.com https://googleads.g.doubleclick.net https://www.googleadservices.com https://*.google-analytics.com https://*.analytics.google.com; worker-src 'self'; frame-src https://td.doubleclick.net https://www.googletagmanager.com; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
function secHeaders(req) {
  const h = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}
function serveStatic(req, res, f) {
  const h = { ...secHeaders(req), 'Content-Type': f.type, 'Cache-Control': f.cache, ETag: f.etag, Vary: 'Accept-Encoding, Cookie' };
  if (f.type.startsWith('text/html')) h['Content-Security-Policy'] = CSP;
  if (f === STATIC['/sw.js']) h['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  const ae = req.headers['accept-encoding'] || '';
  if (f.br && /\bbr\b/.test(ae)) { res.writeHead(200, { ...h, 'Content-Encoding': 'br' }); return res.end(f.br); }
  if (f.gz && /\bgzip\b/.test(ae)) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(f.gz); }
  res.writeHead(200, h); res.end(f.buf);
}
// public nation pages: worldpowersgame.com/n/zeiro-kingdom
const slugify = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const escH = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function nationPage(req, res, slug) {
  slug = String(slug || '').toLowerCase().replace(/\/$/, ''); if (!/^[a-z0-9-]{1,60}$/.test(slug)) return notFound(req, res);
  const W = mkWorld(); const id = Object.keys(W.A).find(u => slugify(W.A[u].name) === slug); if (!id) return notFound(req, res);
  const n = W.A[id], ids = Object.keys(W.A).sort((a, b) => core.score(W, b) - core.score(W, a)), place = ids.indexOf(id) + 1;
  const rank = core.rankName(n), gov = (WP.GOV[n.gov] || {}).n || '';
  const allies = core.allies(W, id).map(v => W.A[v].name), wars = core.wars(W, id).map(v => W.A[v].name);
  const news = (n.out || []).filter(e => e.type === 'news').slice(0, 8);
  const desc = `${n.name} — #${place} of ${ids.length} nations in World Powers. ${rank}, ${gov}, ${core.hexesOf(W, id).length} provinces, GDP ${WP.moneyS(n.gdp || 0)}.${n.ai ? ' An AI nation.' : ''}`;
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(n.name)} — World Powers</title><link rel="icon" href="/icon.svg">
<meta name="description" content="${escH(desc)}"><meta property="og:type" content="website"><meta property="og:title" content="${escH(n.name)} — World Powers"><meta property="og:description" content="${escH(desc)}"><meta property="og:image" content="https://worldpowersgame.com/og.jpg"><meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/fonts/fonts.css">
<style>body{margin:0;background:#06090d;color:#e6edf3;font:16px/1.6 Inter,system-ui,sans-serif}.w{max-width:820px;margin:0 auto;padding:28px 20px 70px}a{color:#d4a64a}.top{display:flex;justify-content:space-between;align-items:center}.logo{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.22em;font-size:14px;color:#e6edf3;text-decoration:none}.logo i{width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#4c7ca5,#0d2236 70%)}.play{background:#d4a64a;color:#111;padding:9px 18px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px}
.hero{margin:34px 0 20px;display:flex;align-items:center;gap:16px}.flagsvg svg{display:block;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.5)}.flag{width:54px;height:54px;border-radius:12px;flex:none}h1{margin:0;font-size:34px;line-height:1.1}.sub{color:#8b98a5}.tag{font-size:11px;border:1px solid #2a3542;border-radius:4px;padding:1px 6px;margin-left:8px;color:#8b98a5;vertical-align:middle}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin:18px 0}.grid div{background:#0c1218;border:1px solid #1e2833;border-radius:10px;padding:12px}.grid span{display:block;color:#8b98a5;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.grid b{font-size:18px}
h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#d4a64a;margin:30px 0 8px}ul{padding-left:18px;color:#c5ced8}.cta{margin-top:36px;padding:22px;border:1px solid #2a3542;border-radius:12px;text-align:center;background:#0c1218}</style></head>
<body><div class="w"><div class="top"><a class="logo" href="/"><i></i>WORLD POWERS</a><a class="play" href="/play">Play free</a></div>
<div class="hero">${n.flag ? `<div class="flagsvg">${WP.flagSVG(n.flag, 81, 54)}</div>` : `<div class="flag" style="background:${escH(n.color)}"></div>`}<div><h1>${escH(n.name)}${n.ai ? '<span class="tag">AI</span>' : ''}${n.nuke ? '<span class="tag">☢ Nuclear power</span>' : ''}</h1><div class="sub">${escH(rank)} · ${escH(gov)}${n.ai ? ' · AI nation' : ''} · #${place} in the world</div>${n.motto ? `<div class="sub" style="font-style:italic;margin-top:2px">“${escH(n.motto)}”</div>` : ''}</div></div>
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
// ---------- blocked networks: addresses the admin has shut out of the whole site ("1.2.3.4", or "1.2.3.*" for a whole range) ----------
S.ipBans = Array.isArray(S.ipBans) ? S.ipBans : [];
const ipNorm = ip => String(ip || '').trim().replace(/^::ffff:/i, '').toLowerCase();
const ipMatch = (ip, pat) => { ip = ipNorm(ip); pat = ipNorm(pat); return pat.endsWith('*') ? ip.startsWith(pat.slice(0, -1)) : ip === pat; };
const ipBlocked = ip => !!ip && S.ipBans.some(x => ipMatch(ip, x.ip));
const BLOCK_PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>World Powers</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#090d12;color:#c5ced8;font:16px system-ui,sans-serif;text-align:center;padding:24px"><div><h1 style="font-size:22px;color:#e6edf3">Access blocked</h1><p>Access to World Powers from your network has been blocked by the administrators.</p></div></body></html>';
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
const pub = u => ({ id: u.id, name: u.name, email: u.email, guest: !!u.guest, admin: !!u.admin, coadmin: !u.admin && !!u.coadmin, ...(u.admin || u.coadmin ? { adminPath: S.adminPath } : {}) });
function meta(uid) { return S.meta[uid] || (S.meta[uid] = { ips: [], lastSeen: 0 }); }
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function stat(key, uid) { const d = S.stats[today()] || (S.stats[today()] = { active: [], signups: 0, cmds: 0, chat: 0, mail: 0, nations: 0 }); if (key === 'active') { if (!d.active.includes(uid)) d.active.push(uid); } else d[key] = (d[key] || 0) + 1; }
function touch(uid, req) { const m = meta(uid); if (m.lastSeen && Date.now() - m.lastSeen > 30 * 60e3) m.prevSeen = m.lastSeen; m.lastSeen = Date.now(); stat('active', uid); const ip = req && ipOf(req); if (ip && !m.ips.includes(ip)) { m.ips.unshift(ip); m.ips = m.ips.slice(0, 8); persist(); } }
// co-admins: helpers the owner (a full admin) can add from the admin page. They can moderate but never touch the
// world's history, money, settings or accounts, and everything they do is recorded in a log only the owner can read.
const COADMIN_OK = new Set(['overview', 'player', 'ipbans', 'ipblock', 'ipunblock', 'ban', 'unban', 'mute', 'kick', 'clear-chat', 'clear-user-chat', 'report-done', 'bug-done', 'announce', 'poll', 'bug-img', 'finale-preview', 'scriptcheck', 'cheatreview', 'hcrelease']); // moderation only: co-admins also play, so they never see other players' nations, actions or the world's numbers
const isStaff = u => !!(u && (u.admin || u.coadmin));
S.coLog = Array.isArray(S.coLog) ? S.coLog : [];
// Helpdesk: players mail questions to 'helpdesk'; the owner answers from the admin page and the answer arrives in the player's mail. Private: never on /fair or the audit log.
S.helpdesk = S.helpdesk && typeof S.helpdesk === 'object' && !Array.isArray(S.helpdesk) ? S.helpdesk : {};
const HD = 'helpdesk', HD_MAX = 400;
function hdView() {
  return Object.entries(S.helpdesk).map(([id, T]) => { const u = S.users[id]; const n = S.docs['nations/' + id];
    return { id, name: u ? u.name : 'Deleted player', nation: n ? n.name : '', gone: !u, open: !!T.open, unread: !!T.unread, last: T.last || 0, msgs: T.msgs || [] }; })
    .sort((a, b) => (b.open && b.unread) - (a.open && a.unread) || b.open - a.open || b.last - a.last);
}
function hdIn(me, b) {
  const subj = MOD.clean(String(b.subj || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)) || 'Question';
  const body = MOD.clean(String(b.body || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 5000)); if (!body) throw Object.assign(new Error('Write your question.'), { status: 400 });
  const t = Date.now(), T = S.helpdesk[me.id] || (S.helpdesk[me.id] = { msgs: [] });
  T.msgs = [...(T.msgs || []), { id: rid(), t, from: 'player', subj, body }].slice(-100); T.open = true; T.unread = true; T.last = t;
  const ids = Object.keys(S.helpdesk); if (ids.length > HD_MAX) { const old = ids.filter(k => !S.helpdesk[k].open).sort((x, y) => S.helpdesk[x].last - S.helpdesk[y].last); for (const k of old.slice(0, ids.length - HD_MAX)) delete S.helpdesk[k]; }
  S.mail[me.id] = [{ id: rid(), from: me.id, to: HD, t, subj, body, box: 'out', read: true }, ...(S.mail[me.id] || [])].slice(0, 200);
  for (const [id, u] of Object.entries(S.users)) if (u.admin) addNote(id, 'mail', `❓ New Helpdesk question from ${nationName(me.id)}: ${subj}. Answer it in the Helpdesk tab of the admin page.`);
  stat('mail'); persist(); return { ok: true, helpdesk: true };
}
function coLog(me, p, b, ok, note) { S.coLog.unshift({ t: Date.now(), by: me.name, id: me.id, act: p.replace('/api/admin/', ''), target: b && typeof b.id === 'string' && S.users[b.id] ? S.users[b.id].name : null, detail: b ? JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'id' && k !== 'password'))).slice(0, 300) : '', ok, note: note || null }); S.coLog = S.coLog.slice(0, 2000); persist(); }
function audit(by, action, target, detail) { S.audit.unshift({ t: Date.now(), by, action, target: target || null, detail: detail || null }); S.audit = S.audit.slice(0, 500);
  if (FAIR_ACTIONS.has(action)) { S.fairlog.unshift({ t: Date.now(), action, target: privTarget(target) || null, detail: detail || null }); S.fairlog = S.fairlog.slice(0, 3000); }
  persist(); }
const buckets = new Map();
function limited(key, max, windowMs) { const now = Date.now(); let b = buckets.get(key); if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); } return ++b.n > max; }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); const cut = Math.floor(now / 60000) - 60; for (const k of health.reqs.keys()) if (k < cut) health.reqs.delete(k); }, 60000).unref();
function flag(uid, r) { if (S.chaos && S.chaos.on) return; /* the chaos copy is meant to be wild: nothing in it is real */ if (S.flags.some(f => f.uid === uid && f.r === r && Date.now() - f.t < 10 * 60e3)) return; S.flags.unshift({ t: Date.now(), uid, r }); S.flags = S.flags.slice(0, 2000); persist(); }
// ---------- Dev corner: a forum and a chat room for ideas and talk about the game (signed-in players only) ----------
S.dev = S.dev || { threads: [], chat: [] };
const DEV_CATS = ['Ideas', 'Balance', 'Bugs', 'General'];
const devTxt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const devWho = id => { const u = S.users[id] || {}; return { by: id, name: S.users[id] ? pubName(id) : 'Leader', role: u.admin ? 'admin' : u.coadmin ? 'mod' : '' }; };
const devSum = t => ({ id: t.id, title: t.title, cat: t.cat, ...devWho(t.by), t: t.t, last: t.last, n: t.replies.length, likes: (t.likes || []).length, pinned: !!t.pinned, locked: !!t.locked, st: t.st || '', stNote: t.stNote || '', stT: t.stT || 0 });
const devFull = (t, uid) => ({ ...devSum(t), body: t.body, liked: (t.likes || []).includes(uid), replies: t.replies.map(r => ({ id: r.id, ...devWho(r.by), body: r.body, t: r.t, likes: (r.likes || []).length, liked: (r.likes || []).includes(uid) })) });
function devHandle(me, p, method, b, q) {
  const D = S.dev, mod = isStaff(me), find = id => D.threads.find(t => t.id === String(id || ''));
  if (method === 'GET') {
    if (p === '/api/dev') return { me: { id: me.id, name: me.name, mod, muted: isMuted(me.id) }, cats: DEV_CATS, threads: D.threads.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.last - a.last).slice(0, 200).map(devSum) };
    if (p === '/api/dev/t') { const t = find(q.get('id')); if (!t) throw Object.assign(new Error('That topic was removed.'), { status: 404 }); return { thread: devFull(t, me.id) }; }
    if (p === '/api/dev/chat') { const since = +q.get('since') || 0; return { msgs: D.chat.filter(m => m.t > since).slice(-100).map(m => ({ id: m.id, ...devWho(m.by), text: m.text, t: m.t })) }; }
    throw Object.assign(new Error('Not found.'), { status: 404 });
  }
  if (p === '/api/dev/mod') { if (!mod) throw Object.assign(new Error('Moderators only.'), { status: 403 }); const op = String(b.op || '');
    if (op === 'delchat') { D.chat = D.chat.filter(m => m.id !== String(b.cid)); persist(); return { ok: true }; }
    const t = find(b.id); if (!t) throw Object.assign(new Error('That topic was removed.'), { status: 404 });
    if (op === 'del') { if (b.rid) t.replies = t.replies.filter(r => r.id !== String(b.rid)); else D.threads = D.threads.filter(x => x !== t); }
    else if (op === 'pin') t.pinned = !t.pinned; else if (op === 'lock') t.locked = !t.locked;
    else if (op === 'status') { // a staff decision on a suggestion: accepted, done or rejected (or cleared), with an optional reason; the author is told and it is posted in the topic
      const st = String(b.st || ''); if (!['', 'accepted', 'done', 'rejected'].includes(st)) throw Object.assign(new Error('Unknown status.'), { status: 400 });
      const note = devTxt(b.note, 300).replace(/\n/g, ' '); t.st = st; t.stNote = st ? note : ''; t.stT = st ? Date.now() : 0;
      if (st) { const L = { accepted: '✅ Accepted', done: '🛠 Done', rejected: '❌ Rejected' }[st]; t.replies.push({ id: rid(), by: me.id, body: `${L}${note ? ': ' + note : ''}`, t: Date.now(), likes: [] }); t.last = Date.now();
        if (t.by !== me.id) addNote(t.by, 'rank', `${L}: your suggestion "${t.title.slice(0, 60)}"${note ? ' — ' + note : ''}`, '/dev#t=' + t.id); }
    }
    else throw Object.assign(new Error('Unknown action.'), { status: 400 });
    persist(); return { ok: true }; }
  if (p === '/api/dev/like') { const t = find(b.id); if (!t) throw Object.assign(new Error('That topic was removed.'), { status: 404 }); const o = b.rid ? t.replies.find(r => r.id === String(b.rid)) : t; if (!o) throw Object.assign(new Error('That reply was removed.'), { status: 404 }); o.likes = o.likes || []; const i = o.likes.indexOf(me.id); if (i >= 0) o.likes.splice(i, 1); else o.likes.push(me.id); persist(); return { ok: true, likes: o.likes.length, liked: i < 0 }; }
  if (isMuted(me.id)) throw Object.assign(new Error('You are muted by the administrators and cannot post right now.'), { status: 403 });
  if (p === '/api/dev/post') { if (limited('devpost:' + me.id, 3, 10 * 60e3)) throw Object.assign(new Error('You can start up to 3 topics every 10 minutes.'), { status: 429 });
    const title = devTxt(b.title, 100).replace(/\n/g, ' '), body = devTxt(b.body, 4000), cat = DEV_CATS.includes(b.cat) ? b.cat : 'General';
    if (title.length < 4) throw Object.assign(new Error('Give your topic a title (at least 4 characters).'), { status: 400 }); if (body.length < 2) throw Object.assign(new Error('Write something in your post.'), { status: 400 });
    const now = Date.now(), t = { id: rid(), by: me.id, title, body, cat, t: now, last: now, replies: [], likes: [] }; D.threads.unshift(t); if (D.threads.length > 300) { const keep = D.threads.filter(x => x.pinned), rest = D.threads.filter(x => !x.pinned).sort((a, b) => b.last - a.last).slice(0, 300 - keep.length); D.threads = [...keep, ...rest]; } persist(); return { ok: true, id: t.id }; }
  if (p === '/api/dev/reply') { if (limited('devrep:' + me.id, 10, 60e3)) throw Object.assign(new Error('Slow down a little.'), { status: 429 }); const t = find(b.id); if (!t) throw Object.assign(new Error('That topic was removed.'), { status: 404 }); if (t.locked && !mod) throw Object.assign(new Error('This topic is locked.'), { status: 400 });
    const body = devTxt(b.body, 3000); if (body.length < 1) throw Object.assign(new Error('Write a reply first.'), { status: 400 }); t.replies.push({ id: rid(), by: me.id, body, t: Date.now(), likes: [] }); t.replies = t.replies.slice(-300); t.last = Date.now(); persist(); return { ok: true }; }
  if (p === '/api/dev/chat') { if (limited('devchat:' + me.id, 10, 30e3)) throw Object.assign(new Error('Slow down a little.'), { status: 429 }); const text = devTxt(b.text, 500).replace(/\n/g, ' '); if (!text) throw Object.assign(new Error('Type a message first.'), { status: 400 });
    D.chat.push({ id: rid(), by: me.id, text, t: Date.now() }); D.chat = D.chat.slice(-300); persist(); return { ok: true }; }
  throw Object.assign(new Error('Not found.'), { status: 404 });
}
// ---------- human check: now and then an operation asks the player to tap one shape in a small picture ----------
// It comes at random, about once every 25-60 operations (never twice in 15 minutes), and about twice as often for accounts with
// cheat flags. The picture is drawn here and sent as an image, so a page script can't read the answer. Every answer is logged for Cheat watch.
const HC = { jailAfter: 5, min: 25, max: 60, gapMs: 15 * 60e3, susGapMs: 4 * 60e3, fastCodeMs: 1200, expireMs: 10 * 60e3, tries: 3, lockMs: 2 * 60e3, fastMs: 600, refreshes: 3, W: 300, H: 180 };
S.hc = S.hc || {};
for (const h of Object.values(S.hc)) if (h && h.n > HC.max) h.n = HC.min + crypto.randomInt(HC.max - HC.min); // countdowns set under the old, rarer schedule switch to the new one
const HC_NAMES = ['star', 'heart', 'triangle', 'circle', 'square', 'diamond', 'cross', 'moon'];
const HC_COLS = ['#e5484d', '#f5a524', '#3dd68c', '#3e9bff', '#b072ff', '#ff6fb1', '#f2e55c', '#5fd4e6'];
function hcPath(k, r) { // a shape centred on 0,0 with radius r
  const P = (pts) => 'M' + pts.map(p => p.map(v => v.toFixed(1)).join(',')).join('L') + 'Z', poly = (n, rr, off) => Array.from({ length: n }, (_, i) => { const a = off + i * 2 * Math.PI / n; return [Math.cos(a) * rr, Math.sin(a) * rr]; });
  if (k === 'star') return P(Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r; return [Math.cos(a) * rr, Math.sin(a) * rr]; }));
  if (k === 'triangle') return P(poly(3, r, -Math.PI / 2));
  if (k === 'square') return P(poly(4, r * 1.1, Math.PI / 4));
  if (k === 'diamond') return P([[0, -r], [r * .7, 0], [0, r], [-r * .7, 0]]);
  if (k === 'circle') return `M${-r},0a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;
  if (k === 'cross') { const t = r * .35; return P([[-t, -r], [t, -r], [t, -t], [r, -t], [r, t], [t, t], [t, r], [-t, r], [-t, t], [-r, t], [-r, -t], [-t, -t]]); }
  if (k === 'heart') return `M0,${r * .9}C${-r * 1.4},${-r * .1} ${-r * .6},${-r * 1.1} 0,${-r * .35}C${r * .6},${-r * 1.1} ${r * 1.4},${-r * .1} 0,${r * .9}Z`;
  if (k === 'moon') return `M${r * .2},${-r}A${r},${r} 0 1,0 ${r * .2},${r}A${r * .75},${r * .75} 0 1,1 ${r * .2},${-r}Z`;
  return '';
}
// ---- check pictures are drawn as real images (PNG), so a script has to actually see them: there is no drawing code to read ----
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function rNew(w, h, bg) { const d = Buffer.alloc(w * h * 3); for (let i = 0; i < w * h; i++) { d[i * 3] = bg[0]; d[i * 3 + 1] = bg[1]; d[i * 3 + 2] = bg[2]; } return { w, h, d }; }
function rPx(m, x, y, c, a) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= m.w || y >= m.h) return; const i = (y * m.w + x) * 3; for (let k = 0; k < 3; k++) m.d[i + k] = Math.round(m.d[i + k] * (1 - a) + c[k] * a); }
function rPoly(m, pts, c, a = 1) { let y0 = Infinity, y1 = -Infinity; for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(m.h - 1, Math.ceil(y1)); y++) { const yc = y + .5, xs = [];
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; if ((p[1] <= yc) !== (q[1] <= yc)) xs.push(p[0] + (yc - p[1]) / (q[1] - p[1]) * (q[0] - p[0])); }
    xs.sort((u, v) => u - v); for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.round(xs[i])); x < Math.min(m.w, Math.round(xs[i + 1])); x++) rPx(m, x, y, c, a); } }
function rLine(m, x0, y0, x1, y1, wd, c, a = 1, hard) { const r = wd / 2, dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
  for (let y = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1)); y <= Math.min(m.h - 1, Math.ceil(Math.max(y0, y1) + r + 1)); y++) for (let x = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1)); x <= Math.min(m.w - 1, Math.ceil(Math.max(x0, x1) + r + 1)); x++) {
    const t = Math.max(0, Math.min(1, ((x + .5 - x0) * dx + (y + .5 - y0) * dy) / L2)), ex = x0 + t * dx - x - .5, ey = y0 + t * dy - y - .5, d = Math.sqrt(ex * ex + ey * ey), cov = hard ? (d <= r ? 1 : 0) : Math.max(0, Math.min(1, r + .5 - d)); if (cov > 0) rPx(m, x, y, c, a * cov); } }
function rNoise(m, R, amt) { for (let i = 0; i < m.d.length; i++) { const v = m.d[i] + Math.round((R() - .5) * amt); m.d[i] = v < 0 ? 0 : v > 255 ? 255 : v; } }
function rPNG(m) { const rl = m.w * 3, raw = Buffer.alloc((rl + 1) * m.h); /* each row stored as the difference from the pixel to its left and the one above (PNG "Paeth" filter): many times smaller */
  for (let y = 0; y < m.h; y++) { const o = y * (rl + 1), r0 = y * rl; raw[o] = 4; for (let i = 0; i < rl; i++) { const a = i >= 3 ? m.d[r0 + i - 3] : 0, b = y ? m.d[r0 - rl + i] : 0, c = i >= 3 && y ? m.d[r0 - rl + i - 3] : 0, pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); raw[o + 1 + i] = (m.d[r0 + i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; } }
  const chunk = (t, b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); const tb = Buffer.from(t), c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([tb, b]))); return Buffer.concat([l, tb, b, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(m.w, 0); ih.writeUInt32BE(m.h, 4); ih[8] = 8; ih[9] = 2; ih[10] = 0; ih[11] = 0; ih[12] = 0;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]).toString('base64'); }
const hexRGB = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function hcPoly(k, r) { const poly = (n, rr, off) => Array.from({ length: n }, (_, i) => { const a = off + i * 2 * Math.PI / n; return [Math.cos(a) * rr, Math.sin(a) * rr]; });
  if (k === 'star') return Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r; return [Math.cos(a) * rr, Math.sin(a) * rr]; });
  if (k === 'triangle') return poly(3, r, -Math.PI / 2); if (k === 'square') return poly(4, r * 1.1, Math.PI / 4); if (k === 'diamond') return [[0, -r], [r * .7, 0], [0, r], [-r * .7, 0]];
  if (k === 'circle' || k === 'moon') return poly(40, r, 0);
  if (k === 'cross') { const t = r * .35; return [[-t, -r], [t, -r], [t, -t], [r, -t], [r, t], [t, t], [t, r], [-t, r], [-t, t], [-r, t], [-r, -t], [-t, -t]]; }
  if (k === 'heart') return Array.from({ length: 60 }, (_, i) => { const t = i / 60 * 2 * Math.PI; return [16 * Math.sin(t) ** 3 * r / 16, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * r / 16]; });
  return poly(6, r, 0); }
const xform = (pts, cx, cy, rot, s) => { const c = Math.cos(rot), n = Math.sin(rot); return pts.map(([x, y]) => [(cx + x * c - y * n) * s, (cy + x * n + y * c) * s]); };
// letters for the "type the code" check: none that look alike (no O/0, I/1, S/5, B/8, Z/2, G/6)
const HC_GLYPH = { A: [[[0, 1], [.5, 0], [1, 1]], [[.22, .62], [.78, .62]]], C: [[[.95, .18], [.7, 0], [.3, 0], [.05, .25], [.05, .75], [.3, 1], [.7, 1], [.95, .82]]], D: [[[0, 0], [0, 1], [.6, 1], [.95, .7], [.95, .3], [.6, 0], [0, 0]]],
  E: [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, .5], [.75, .5]]], F: [[[1, 0], [0, 0], [0, 1]], [[0, .5], [.75, .5]]], H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, .5], [1, .5]]], J: [[[1, 0], [1, .75], [.75, 1], [.25, 1], [0, .75]]],
  K: [[[0, 0], [0, 1]], [[1, 0], [0, .58]], [[.32, .42], [1, 1]]], M: [[[0, 1], [0, 0], [.5, .6], [1, 0], [1, 1]]], N: [[[0, 1], [0, 0], [1, 1], [1, 0]]], P: [[[0, 1], [0, 0], [.75, 0], [1, .2], [1, .36], [.75, .56], [0, .56]]],
  R: [[[0, 1], [0, 0], [.75, 0], [1, .2], [1, .36], [.75, .56], [0, .56]], [[.45, .56], [1, 1]]], T: [[[0, 0], [1, 0]], [[.5, 0], [.5, 1]]], U: [[[0, 0], [0, .75], [.25, 1], [.75, 1], [1, .75], [1, 0]]],
  V: [[[0, 0], [.5, 1], [1, 0]]], W: [[[0, 0], [.25, 1], [.5, .42], [.75, 1], [1, 0]]], X: [[[0, 0], [1, 1]], [[1, 0], [0, 1]]], Y: [[[0, 0], [.5, .5], [1, 0]], [[.5, .5], [.5, 1]]],
  3: [[[0, .12], [.25, 0], [.75, 0], [1, .2], [.75, .47], [.35, .47]], [[.75, .47], [1, .7], [.85, .95], [.5, 1], [.12, .95], [0, .85]]], 4: [[[.72, 1], [.72, 0], [0, .7], [1, .7]]], 7: [[[0, 0], [1, 0], [.4, 1]]],
  9: [[[1, .45], [.7, .6], [.3, .6], [0, .4], [0, .2], [.3, 0], [.7, 0], [1, .2], [1, .45], [.85, 1]]] };
const HC_CHARS = Object.keys(HC_GLYPH).filter(k => k !== '9'); // 9 is drawn but not used: in this style it looks too much like a q
const HC_SC = 1.5; // pictures are drawn at 1.5× size, so they stay sharp on phones
function hcMake(code) {
  const R = () => crypto.randomInt(1e6) / 1e6, id = crypto.randomBytes(8).toString('hex');
  if (code) { // "type the code": five letters, each tilted, sized and coloured differently, with lines through them
    const W = 300, H = 120, S = HC_SC, m = rNew(W * S, H * S, [20, 28, 38]); let txt = '';
    for (let i = 0; i < 14; i++) rLine(m, R() * W * S, R() * H * S, R() * W * S, R() * H * S, (1 + R() * 2) * S, hexRGB(HC_COLS[crypto.randomInt(8)]), .3, true);
    for (let i = 0; i < 5; i++) { const ch = HC_CHARS[crypto.randomInt(HC_CHARS.length)]; txt += ch; const cw = 30 + R() * 10, chh = 50 + R() * 16, cx = 30 + i * 54 + (R() - .5) * 10, cy = 60 + (R() - .5) * 18, rot = (R() - .5) * .8, col = hexRGB(HC_COLS[crypto.randomInt(8)]), wd = (4.5 + R() * 2.5) * S;
      for (const st of HC_GLYPH[ch]) { const pts = xform(st.map(([x, y]) => [(x - .5) * cw + (R() - .5) * 3, (y - .5) * chh + (R() - .5) * 3]), cx, cy, rot, S); for (let j = 0; j + 1 < pts.length; j++) rLine(m, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1], wd, col); } }
    for (let i = 0; i < 3; i++) { let x = 0, y = R() * H; const k = (R() - .5) * 1.2, col = hexRGB(HC_COLS[crypto.randomInt(8)]); for (let s = 0; s < 12; s++) { const nx = x + W / 12, ny = y + k * 10 + (R() - .5) * 14; rLine(m, x * S, y * S, nx * S, ny * S, 1.6 * S, col, .55); x = nx; y = ny; } }
    for (let i = 0; i < 260; i++) rPx(m, R() * W * S, R() * H * S, [255, 255, 255], R() * .4);
    return { id, type: 'code', want: txt, img: rPNG(m), t: Date.now(), tries: 0, refresh: 0 };
  }
  const pick = HC_NAMES.slice().sort(() => R() - .5).slice(0, 6), want = pick[crypto.randomInt(6)], cols = HC_COLS.slice().sort(() => R() - .5), cells = [0, 1, 2, 3, 4, 5].sort(() => R() - .5), items = [], S = HC_SC, bg = [20, 28, 38];
  const m = rNew(HC.W * S, HC.H * S, bg);
  for (let i = 0; i < 40; i++) rLine(m, R() * HC.W * S, R() * HC.H * S, R() * HC.W * S, R() * HC.H * S, (.5 + R() * 1.5) * S, hexRGB(HC_COLS[crypto.randomInt(8)]), .3, true);
  pick.forEach((k, i) => { const c = cells[i], cx = 50 + (c % 3) * 100 + (R() - .5) * 26, cy = 45 + Math.floor(c / 3) * 90 + (R() - .5) * 20, r = 20 + R() * 9, rot = (R() - .5) * .87, col = hexRGB(cols[i]);
    const pts = xform(hcPoly(k, r), cx, cy, rot, S); rPoly(m, pts, col); for (let j = 0; j < pts.length; j++) { const q = pts[(j + 1) % pts.length]; rLine(m, pts[j][0], pts[j][1], q[0], q[1], 2 * S, [11, 16, 22]); }
    if (k === 'moon') rPoly(m, xform(hcPoly('circle', r * .78), cx + r * .42 * Math.cos(rot) , cy + r * .42 * Math.sin(rot) - r * .12, rot, S), bg);
    items.push({ k, b: [cx - r - 8, cy - r - 8, cx + r + 8, cy + r + 8] }); });
  for (let i = 0; i < 6; i++) rLine(m, R() * HC.W * S, R() * HC.H * S, R() * HC.W * S, R() * HC.H * S, .8 * S, [230, 236, 242], .18);
  for (let i = 0; i < 160; i++) rPx(m, R() * HC.W * S, R() * HC.H * S, [255, 255, 255], R() * .35);
  return { id, type: 'tap', want, items, img: rPNG(m), t: Date.now(), tries: 0, refresh: 0 };
}
const hcState = uid => (S.hc[uid] = S.hc[uid] || { log: [] });
const hcPub = p => p ? (p.type === 'code' ? { id: p.id, type: 'code', img: p.img, prompt: 'Type the code' } : { id: p.id, type: 'tap', img: p.img, prompt: `Tap the ${p.want}`, want: p.want }) : null;
function hcLog(uid, r, info) { const h = hcState(uid); h.log.unshift({ t: Date.now(), r, ...(info || {}) }); h.log = h.log.slice(0, 60); }
const hcExempt = uid => !!(S.users[uid] && S.users[uid].admin); // the game's admins are never checked or jailed automatically
// clear proof of a script, from the last actions this player sent (see botRecord). Null when they play like a person.
function scriptProof(rows) {
  const Rw = rows.slice(-40); if (Rw.length < 12) return null;
  const nCode = Rw.filter(r => r[5] === 'u').length, nNoPage = Rw.filter(r => r[5] === 'x').length, nHid = Rw.filter(r => r[3] === 'h').length;
  if (nCode >= 3) return `${nCode} of its last ${Rw.length} actions were clicked by code, not by a person`;
  if (nNoPage >= 5) return `${nNoPage} of its last ${Rw.length} actions were sent straight to the server, not from the game page`;
  if (nHid >= 8) return `${nHid} of its last ${Rw.length} actions were sent while the game page was hidden`;
  const D = Rw.map(r => r[2]).filter(d => d >= 0); if (D.length >= 20) { const f = D.filter(d => d < 500).length; if (f / D.length >= .7) return `reacted within half a second of an action becoming ready ${f} times out of ${D.length}`; }
  const P = rows.slice(-60).map(r => r[8]).filter(p => p && p[2] >= 0).map(p => p[2]); if (P.length >= 30) { const mn = P.reduce((a, b) => a + b, 0) / P.length, sd = Math.sqrt(P.reduce((a, b) => a + (b - mn) ** 2, 0) / P.length); if (sd <= 3) return `held the button down for exactly the same time (${Math.round(mn)} ms, ±${sd.toFixed(1)}) on ${P.length} clicks in a row`; }
  const byK = {}; for (const r of rows) (byK[r[1]] = byK[r[1]] || []).push(r[0]);
  for (const [k, ts] of Object.entries(byK)) { let run = 1; for (let i = 2; i < ts.length; i++) { const g1 = ts[i] - ts[i - 1], g0 = ts[i - 1] - ts[i - 2]; if (g1 > 20e3 && Math.abs(g1 - g0) <= 800) { run++; if (run >= 15) return `ran "${k}" ${run + 1} times in a row at exactly the same interval (every ${Math.round(g1 / 1000)} s, within 0.8 s)`; } else run = 1; } }
  return null;
}
// softer signs: not proof, but such a player gets checked every few minutes until it's clear
function scriptLean(uid) { const rows = ((S.botsig || {})[uid] || {}).a || [], Rw = rows.slice(-40); if (Rw.length < 10) return false;
  if (Rw.some(r => r[5] === 'u' || r[5] === 'x') || Rw.filter(r => r[3] === 'h').length >= 2) return true;
  const D = Rw.map(r => r[2]).filter(d => d >= 0); if (D.length >= 15 && D.filter(d => d < 1000).length / D.length >= .25) return true;
  const P = Rw.map(r => r[8]).filter(p => p && p[2] >= 0).map(p => p[2]); if (P.length >= 20) { const mn = P.reduce((a, b) => a + b, 0) / P.length; if (Math.sqrt(P.reduce((a, b) => a + (b - mn) ** 2, 0) / P.length) <= 8) return true; }
  const byK = {}; for (const r of rows) (byK[r[1]] = byK[r[1]] || []).push(r[0]); for (const ts of Object.values(byK)) { let run = 1; for (let i = 2; i < ts.length; i++) { const g1 = ts[i] - ts[i - 1], g0 = ts[i - 1] - ts[i - 2]; if (g1 > 20e3 && Math.abs(g1 - g0) <= 1500) { if (++run >= 7) return true; } else run = 1; } }
  return false; }
const hcSus = uid => (S.flags || []).some(f => f.uid === uid && Date.now() - f.t < 72 * HOUR) || ['cheat', 'watch'].includes(((S.cheatReview || {})[uid] || {}).d) || scriptLean(uid);
// cheat jail: locks the account until an admin releases it
const JAIL_MSG = 'Your account is under investigation for cheating. Our anti-cheat system stopped it after repeated failed checks. An admin will review it soon. Your nation is safe and nothing has been taken, but you can’t play until the review is done.';
const JAIL_MSG_SCRIPT = 'Your account is under investigation for cheating. Our anti-cheat system detected automated play (a script or auto-clicker). An admin will review it soon. Your nation is safe and nothing has been taken, but you can’t play until the review is done.';
const suspMsg = j => `Your account is suspended for automated play (a script or auto-clicker) until ${new Date(j.until).toUTCString().slice(5, 22)} UTC. Your nation is protected from attack while you are locked out, and nothing has been taken. You were warned first; the evidence is in your mail. If you think this is a mistake, message the Helpdesk.`;
const hcJail = uid => { const h = (S.hc || {})[uid]; if (h && h.jail && h.jail.until && Date.now() >= h.jail.until) { delete h.jail; h.streak = 0; h.pend = null; hcLog(uid, 'released', { why: 'suspension ended' }); const a = (S.acl || {})[uid]; if (a) a.from = Date.now(); persist(); }
  return h && h.jail ? { error: h.jail.until ? suspMsg(h.jail) : h.jail.script ? JAIL_MSG_SCRIPT : JAIL_MSG, jail: { t: h.jail.t, until: h.jail.until || 0 } } : null; };
function autoJail(uid, why, script, hard) { if (hcExempt(uid)) return false; if (!hard && cleanPass(uid)) return false; /* you marked them Not cheating: only hard proof jails them */ const h = hcState(uid); if (h.jail && !h.jail.until) return true; const now = Date.now();
  h.jail = { t: now, why, script: script ? 1 : 0 }; h.pend = null; h.lock = 0; hcLog(uid, 'jailed', { why }); flag(uid, `Put in cheat jail automatically: ${why}`);
  (S.cheatReview = S.cheatReview || {})[uid] = { d: 'watch', t: now, by: 'Anti-cheat', note: `Jailed automatically: ${why}.` };
  try { sendTo(uid, 'jail', { msg: script ? JAIL_MSG_SCRIPT : JAIL_MSG }); } catch (e) {}
  persist(); return true; }
// called before every operation: returns a refusal with a picture when a check is due or still open
function hcGate(uid, isAct) {
  if (S.config && S.config.humanCheck === false) return null; if (hcExempt(uid)) return null;
  const h = hcState(uid), now = Date.now();
  if (h.lock > now) return { error: `Too many wrong answers. Operations unlock in ${Math.ceil((h.lock - now) / 1000)} seconds.`, hc: hcPub(h.pend), lock: h.lock };
  if (h.pend) { h.pendHits = (h.pendHits || 0) + 1; if (h.pendHits >= 40 && autoJail(uid, `kept sending ${h.pendHits} actions while ignoring an open human check`, true, true)) return hcJail(uid);
    if (now - h.pend.t > HC.expireMs) { hcLog(uid, 'expired', { want: h.pend.type === 'code' ? 'code' : h.pend.want }); h.pend = hcMake(h.pend.type === 'code'); persist(); }
    return { error: h.pend.type === 'code' ? 'Quick check: type the code to carry on.' : 'Quick check: tap the right shape to carry on.', hc: hcPub(h.pend) }; }
  const sus = hcSus(uid);
  if (h.n == null) h.n = HC.min + crypto.randomInt(HC.max - HC.min);
  if (isAct || sus) h.n -= sus ? 5 : 1; // every kind of action can be stopped by a check, but for an ordinary player only economy actions count down, so checks come no more often than before
  if (h.n > 0 || now - (h.last || 0) < (sus ? HC.susGapMs : HC.gapMs)) return null;
  h.pend = hcMake(crypto.randomInt(100) < (S.config && S.config.hcCodePct != null ? +S.config.hcCodePct : sus ? 70 : 35)); /* how often it's "type the code" rather than "tap the shape" */ h.pendHits = 0; persist();
  return { error: h.pend.type === 'code' ? 'Quick check: type the code to carry on.' : 'Quick check: tap the right shape to carry on.', hc: hcPub(h.pend) };
}
function hcAnswer(uid, b) {
  const h = hcState(uid), p = h.pend, now = Date.now(); if (h.jail) return { ok: false, jail: { t: h.jail.t }, msg: h.jail.script ? JAIL_MSG_SCRIPT : JAIL_MSG }; if (!p) return { ok: true, done: true };
  if (b.refresh) { if (p.refresh >= HC.refreshes) return { ok: false, msg: p.type === 'code' ? 'No more new codes. Type this one.' : 'No more new pictures. Pick a shape in this one.', hc: hcPub(p) }; hcLog(uid, 'new picture', { want: p.type === 'code' ? 'code' : p.want }); const n = hcMake(p.type === 'code'); n.refresh = p.refresh + 1; n.tries = p.tries; h.pend = n; persist(); return { ok: false, hc: hcPub(n) }; }
  if (String(b.id || '') !== p.id) return { ok: false, msg: 'That picture changed. Try this one.', hc: hcPub(p) };
  if (h.lock > now) return { ok: false, lock: h.lock, msg: `Wait ${Math.ceil((h.lock - now) / 1000)} seconds, then try again.`, hc: hcPub(p) };
  const isCode = p.type === 'code';
  if (isCode && b.code == null) { const n = hcMake(false); n.tries = p.tries; h.pend = n; persist(); return { ok: false, msg: 'Tap the shape it asks for.', hc: hcPub(n) }; } // a page from before this update cannot show a code box
  const info = { want: isCode ? 'code' : p.want, ms: Math.max(0, Math.min(6e5, Math.round(+b.ms || 0))), mv: Math.max(-1, Math.min(1e5, Math.round(b.mv == null ? -1 : +b.mv))), press: Math.max(-1, Math.min(9999, Math.round(b.press == null ? -1 : +b.press))), pt: ['m', 't', 'p', 'k'].includes(b.pt) ? b.pt : 'x', trusted: b.tr === 1 ? 1 : 0 };
  let right;
  if (isCode) { const got = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); info.pick = got || '(empty)'; info.keys = Math.max(0, Math.min(999, Math.round(+b.keys || 0))); right = got === p.want; }
  else { const W = +b.w, H = +b.h, x = +b.x / W * HC.W, y = +b.y / H * HC.H; const hit = isFinite(x) && isFinite(y) && W > 0 && H > 0 ? p.items.find(it => x >= it.b[0] && x <= it.b[2] && y >= it.b[1] && y <= it.b[3]) : null; info.pick = hit ? hit.k : 'empty space'; right = !!(hit && hit.k === p.want); }
  if (right) {
    const odd = [], fast = info.ms < (isCode ? HC.fastCodeMs : HC.fastMs); if (fast) odd.push(`solved in ${info.ms} ms`); if (!isCode && info.pt === 'm' && info.mv === 0) odd.push('mouse never moved');
    const byCode = isCode ? info.keys === 0 || !info.trusted : !info.trusted; if (byCode) odd.push(isCode ? 'code filled in by a program, not typed' : 'click made by code');
    hcLog(uid, odd.length ? 'pass (odd)' : 'pass', { ...info, odd: odd.join(', ') });
    if (byCode && autoJail(uid, isCode ? 'the human check was answered by a program (the code was never typed)' : 'the human check was clicked by code, not by a person', true, true)) return { ok: false, jail: { t: now }, msg: JAIL_MSG_SCRIPT };
    if (fast) { const prev = h.log.slice(1).filter(x => x.r === 'pass (odd)' && /solved in/.test(x.odd || '') && now - x.t < 48 * HOUR).length; if (prev >= 1 && autoJail(uid, `solved the human check faster than a person can, twice (${info.ms} ms)`, true)) return { ok: false, jail: { t: now }, msg: JAIL_MSG_SCRIPT }; }
    if (odd.length) flag(uid, `Human check passed oddly: ${odd.join(', ')}`);
    h.pend = null; h.pendHits = 0; h.last = now; h.streak = 0; h.n = HC.min + crypto.randomInt(HC.max - HC.min); persist(); return { ok: true, msg: 'Thanks! Carry on.' };
  }
  p.tries++; h.streak = (h.streak || 0) + 1; hcLog(uid, 'miss', info);
  if (h.streak >= HC.jailAfter && !hcExempt(uid) && !cleanPass(uid)) { h.jail = { t: now, why: `Answered the human check wrong ${h.streak} times in a row` }; h.pend = null; h.lock = 0; hcLog(uid, 'jailed', { want: info.want }); flag(uid, `Put in cheat jail automatically: ${h.jail.why}`); (S.cheatReview = S.cheatReview || {})[uid] = S.cheatReview[uid] || { d: 'watch', t: now, by: 'Anti-cheat', note: 'Jailed automatically after failing the human check.' }; persist(); return { ok: false, jail: { t: now }, msg: JAIL_MSG }; }
  if (p.tries >= HC.tries) { hcLog(uid, 'fail', { want: info.want }); flag(uid, `Failed the human check ${HC.tries} times in a row`); h.lock = now + HC.lockMs; h.pend = hcMake(isCode); persist(); return { ok: false, lock: h.lock, msg: `Three wrong answers. Operations are paused for ${HC.lockMs / 60e3} minutes.`, hc: hcPub(h.pend) }; }
  persist(); return { ok: false, msg: isCode ? `That's not the code. ${HC.tries - p.tries} ${HC.tries - p.tries === 1 ? 'try' : 'tries'} left.` : `That's not the ${p.want}. ${HC.tries - p.tries} ${HC.tries - p.tries === 1 ? 'try' : 'tries'} left.`, hc: hcPub(p) };
}
// a summary of one player's human checks over the last 48 hours, for Cheat watch
// iPhone taps used to be recorded as mouse clicks, so they were marked "mouse never moved". Checks from before this version are not held against anyone for that.
if (!S.hcTouchFixT) S.hcTouchFixT = Date.now();
const hcRes = x => x.r === 'pass (odd)' && x.t < S.hcTouchFixT && x.odd === 'mouse never moved' ? 'pass' : x.r;
function hcSummary(uid, from) { const L = ((S.hc[uid] || {}).log || []).filter(x => Date.now() - x.t < 48 * HOUR && (!from || x.t >= from)); if (!L.length && !(S.hc[uid] || {}).pend) return null; const c = k => L.filter(x => hcRes(x) === k).length, ms = L.filter(x => /^pass/.test(x.r)).map(x => x.ms).sort((a, b) => a - b);
  return { pass: c('pass'), odd: c('pass (odd)'), miss: c('miss'), fail: c('fail'), expired: c('expired'), pics: c('new picture'), medMs: ms.length ? ms[Math.floor(ms.length / 2)] : null, open: !!(S.hc[uid] || {}).pend, last: L.slice(0, 12) }; }
// same network = a home connection both accounts used. An address many players share (satellite internet like Starlink, mobile carriers,
// schools: one public address for thousands of people) says nothing about who owns an account, so it doesn't count.
let ipUseT = 0, ipUse = new Map();
const ipUsers = ip => { if (Date.now() - ipUseT > 60e3) { ipUse = new Map(); for (const m of Object.values(S.meta)) for (const x of new Set((m && m.ips) || [])) ipUse.set(x, (ipUse.get(x) || 0) + 1); ipUseT = Date.now(); } return ipUse.get(ip) || 0; };
const SHARED_IP = 4;
const sharesNetwork = (a, b) => { const A = (S.meta[a] || {}).ips || [], B = (S.meta[b] || {}).ips || []; return A.some(ip => B.includes(ip) && ipUsers(ip) < SHARED_IP); };
const isMuted = uid => (S.users[uid] && S.users[uid].mutedUntil || 0) > Date.now();
const nationName = uid => uid === 'helpdesk' ? 'Helpdesk' : (S.docs['nations/' + uid] || {}).name || (S.users[uid] ? 'New leader' : 'Unknown');
// Leader (account) names are private. Other players only ever see the nation name, or "New leader" before someone founds one.
// You see your own leader name; the admin pages still show everyone's for moderation.
const pubName = uid => (S.docs['nations/' + uid] || {}).name || 'New leader';
const privTarget = t => { if (!t || typeof t !== 'string') return t; for (const [k, d] of Object.entries(S.docs)) if (k.startsWith('nations/') && d && d.name === t) return t; for (const [id, u] of Object.entries(S.users)) if (u && u.name === t) return pubName(id); return t; };
const noLeaders = o => JSON.parse(JSON.stringify(o, (k, v) => k === 'leader' && (typeof v === 'string' || v === null) ? undefined : v)); // older records stored leader names: hide them, the files are untouched

// ---------- what other players may see ----------
function publicView(n) {
  return { name: n.name, color: n.color, gov: n.gov, created: n.created, cap: n.cap, hexes: n.hexes, xp: n.xp, pop: n.pop, troops: n.troops, ships: n.ships, air: n.air, tech: n.tech, train: n.train, infra: n.infra, fort: n.fort,
    approval: n.approval, stability: n.stability, aggr: n.aggr, bloc: n.bloc || null, dev: n.dev || {}, prestige: n.prestige || 0, rs: n.rs, blocT: n.blocT, tally: n.tally ? { pwins: n.tally.pwins || 0, aidV: n.tally.aidV || 0 } : undefined, medals: n.medals || null, regroup: n.regroup, lastStand: n.lastStand || 0, overlord: n.overlord || null, vassalT: n.vassalT || 0, office: n.office || 0, outposts: n.outposts || null, titles: n.titles || null, badges: n.badges || null, shield: n.shield || 0, gens: (n.gens || []).map(g => ({ name: g.name, type: g.type, stars: g.stars })), laws: n.laws || [], wonders: n.wonders || {}, proj: n.proj ? { k: n.proj.k, stage: n.proj.stage } : null, uwon: n.uwon || null, uw: n.uw ? Object.fromEntries(Object.entries(n.uw).map(([k, x]) => [k, { stage: x.stage, next: x.next }])) : null, gpdone: n.gpdone || null, gp: n.gp ? Object.fromEntries(Object.entries(n.gp).map(([k, x]) => [k, { until: x.until }])) : null, pu: n.pu || null, cos: n.cos || null, flag: n.flag || null, motto: n.motto || '', ach: n.ach || {}, nuke: n.nuke || 0, warhead: n.warhead ? (n.warhead.ready <= Date.now() ? 2 : 1) : 0, nuked: n.nuked || null, dome: n.dome ? { t: n.dome.t, ready: n.dome.ready, lvl: n.dome.lvl || 1, off: (n.cash || 0) < 0, emp: (n.empT || 0) > Date.now() ? n.empT : 0 } : null, rads: (n.rads || []).filter(r => r.until > Date.now()).map(r => ({ h: r.h, t: r.t, until: r.until })), rad: n.rad && n.rad.until > Date.now() ? { h: n.rad.h, t: n.rad.t, until: n.rad.until } : undefined, fallout: n.fallout || 0, winter: n.winter || 0, rogue: n.rogue || 0, armsEmb: n.armsEmb || 0, condemned: n.condemned || 0, ceasefire: n.ceasefire || 0, guarantee: n.guarantee || 0, inspected: n.inspected || 0, frozen: n.frozen ? { amt: n.frozen.amt, until: n.frozen.until } : null, conqN: Object.keys(n.conq || {}).length, rel: n.rel, trades: n.trades, res: { oil: n.res && n.res.oil > 0 ? 1 : 0 }, ai: n.ai ? { p: n.ai.p, boss: !!n.ai.boss, ...(n.ai.defX ? { defX: n.ai.defX } : {}), ...(n.ai.atkX ? { atkX: n.ai.atkX } : {}) } : undefined,
    gdp: n.gdp, gdpHist: (n.gdpHist || []).map(({ c, ...x }) => x) /* the hourly history holds the treasury too: other players never get it */, debt: n.debt, unemp: n.unemp, infl: n.infl, morale: n.morale, defaulted: n.defaulted, embargo: n.embargo, blockade: n.blockade || 0, blockH: n.blockH == null ? null : n.blockH, nextElection: n.nextElection, lastElection: n.lastElection,
    out: (n.out || []).filter(e => e.type === 'news' || e.type === 'battle').slice(0, 30).map(e => e.type === 'battle' ? { id: e.id, t: e.t, type: e.type, to: e.to, h: e.h, X: e.X, win: e.win, lossA: e.lossA, lossD: e.lossD, sea: e.sea, vassal: e.vassal || 0 } : e) };
}

// ---------- live stream ----------
const clients = new Set();
function write(c, event, data) { if (c.res.writableEnded || c.res.destroyed) { clients.delete(c); return; } try { (c.out || c.res).write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} }
function writeRaw(c, str) { if (c.res.writableEnded || c.res.destroyed) { clients.delete(c); return; } try { (c.out || c.res).write(str); } catch (e) {} }
function endStream(c) { try { if (c.out) c.out.end(); else c.res.end(); } catch (e) {} }
function broadcast(event, data) { if (!clients.size) return; const str = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) writeRaw(c, str); }
// ---- polls: questions the admin sends to every player; each player sees the pop-up once (answer or skip) ----
// ---- mission votes: players thumb up/down each intelligence mission; the admin sees totals under Polls ----
S.opVotes = S.opVotes || {};
const OPV = () => (S.opVotes = S.opVotes || {});
const opVotesFor = uid => { const o = {}; for (const k in OPV()) if (S.opVotes[k][uid]) o[k] = S.opVotes[k][uid]; return o; };
const opVoteTotals = () => Object.keys(WP.COVERT).map(k => { const v = Object.values(OPV()[k] || {}); return { op: k, name: WP.COVERT[k].n, up: v.filter(x => x > 0).length, down: v.filter(x => x < 0).length }; });
const pollOpen = q => q && q.active && (!q.ends || q.ends > Date.now());
const pollPublic = q => ({ id: q.id, title: q.title, intro: q.intro, questions: q.questions, ends: q.ends || 0 });
const pollFor = uid => S.polls.filter(q => pollOpen(q) && !(q.answers || {})[uid] && !(q.skips || {})[uid]).slice(0, 3).map(pollPublic);
function sendTo(uid, event, data) { for (const c of clients) if (c.uid === uid) write(c, event, data); }
const isOnline = uid => [...clients].some(c => c.uid === uid);
// serialize once per nation (one copy for its owner, one public copy for everyone else) instead of once per connected player
// a nation's owner gets its own update at once; everyone else gets other nations' updates bundled, at most one per nation every 0.7 s
// (a busy nation can change several times a second, and every copy goes to every player: on phones that was a lot of data and redrawing)
const PUBQ = new Set(); let pubT = null;
// the bulky parts of a nation (GDP history, recent news and battles, trade deals) rarely change: pages that understand it get them only when they did, and keep their previous copy otherwise
const SLIMK = ['gdpHist', 'out', 'trades'], lastBig = new Map();
function flushPub() { pubT = null; if (!clients.size) { PUBQ.clear(); return; } const ids = [...PUBQ]; PUBQ.clear();
  for (const id of ids) { const n = S.docs['nations/' + id]; const pv = n == null ? null : publicView(n); const pub = `event: doc\ndata: ${JSON.stringify({ col: 'nations', id, data: pv })}\n\n`;
    let slim = pub; if (pv) { const prev = lastBig.get(id) || {}, now = {}, keep = []; const sv = { ...pv }; for (const k of SLIMK) { now[k] = JSON.stringify(pv[k] === undefined ? null : pv[k]); if (prev[k] === now[k]) { delete sv[k]; keep.push(k); } } lastBig.set(id, now); if (keep.length) { sv._k = keep; slim = `event: doc\ndata: ${JSON.stringify({ col: 'nations', id, data: sv })}\n\n`; } } else lastBig.delete(id);
    for (const c of clients) if (!(c.uid === id && n != null)) writeRaw(c, c.slim ? slim : pub); } }
function sendNation(id, now) {
  if (!clients.size) return; const n = S.docs['nations/' + id];
  if (n != null) { let own = null; for (const c of clients) if (c.uid === id) { own = own || `event: doc\ndata: ${JSON.stringify({ col: 'nations', id, data: n })}\n\n`; writeRaw(c, own); } }
  PUBQ.add(id); if (now || n == null) { clearTimeout(pubT); flushPub(); } else if (!pubT) pubT = setTimeout(flushPub, 700);
}
function setDoc(col, id, data) { const key = col + '/' + id; if (data == null) delete S.docs[key]; else S.docs[key] = data; persist(); if (col === 'nations') sendNation(id); else broadcast('doc', { col, id, data: data == null ? null : data }); }
const playerVotes = v => Object.fromEntries(Object.entries(v || {}).filter(([u]) => !BOTS.isBot(u)));
const anonVotes = p => { const v = { ...(p.votes || {}) }; if (v[p.by] != null) { v['anon:' + p.id] = v[p.by]; delete v[p.by]; } return v; }; // the secret proposer's vote still counts, without their name
const councilView = () => ({ props: S.council.props.slice(0, 40).map(({ debts, net, ...p }) => (p.anon ? { ...p, by: null, votes: playerVotes(anonVotes(p)) } : { ...p, votes: playerVotes(p.votes) })), active: S.council.active, pacts: (S.council.pacts || []).filter(x => x.until > Date.now()), decl: (S.council.decl || []).filter(x => x.until > Date.now()) });
// the secret proposer of an anonymous resolution still has to see their own vote: they alone get a copy with their vote under their own name
const councilViewFor = uid => { const v = councilView(); S.council.props.slice(0, 40).forEach((p, i) => { if (p.anon && p.by === uid && v.props[i]) { const k = 'anon:' + p.id, x = v.props[i]; if (x.votes[k] != null) { x.votes = { ...x.votes, [uid]: x.votes[k] }; delete x.votes[k]; } x.mine = true; } }); return v; };
function councilCast() { if (!clients.size) return; const own = new Set(S.council.props.slice(0, 40).filter(p => p.anon).map(p => p.by)), pub = `event: council\ndata: ${JSON.stringify(councilView())}\n\n`; for (const c of clients) { if (own.has(c.uid)) write(c, 'council', councilViewFor(c.uid)); else writeRaw(c, pub); } }
// alliances: everyone sees names, flags, members, projects and treasuries; only members read their own message board
// one team per player: if old data ever lists someone in two teams, keep the team their nation points to
function blocRepair() { let fixed = 0; const blocs = S.blocs || {};
  for (const [id, b] of Object.entries(blocs)) b.members = (b.members || []).filter(m => { const n = S.docs['nations/' + m]; if (n && n.bloc && n.bloc !== id && blocs[n.bloc] && (blocs[n.bloc].members || []).includes(m)) { fixed++; return false; } return true; });
  if (fixed) { console.log('Removed', fixed, 'duplicate alliance memberships'); persist(); } }
// a wiretap is a poor line: the listener catches only some messages, with words missing. Which ones is fixed per listener and message, so re-reading never reveals more.
function tapHear(uid, wall, since) { const T = core.TAP, h = x => crypto.createHash('sha1').update('tap:' + since + ':' + uid + ':' + x).digest().readUInt32BE(0) / 4294967296, out = [];
  for (const m of wall) { if ((m.t || 0) < since) continue; const key = (m.t || 0) + ':' + (m.u || ''); if (h(key) >= T.hear) continue;
    const words = String(m.x || '').split(/(\s+)/); let kept = 0; const x = words.map((w, i) => { if (!w.trim()) return w; if (h(key + ':' + i) < T.drop) return '▒'.repeat(Math.min(6, Math.max(2, w.length))); kept++; return w; }).join('');
    out.push({ t: m.t, u: m.u, x, tap: 1 }); } return out; }
function blocsView(uid) { const me = S.docs['nations/' + uid], tap = me && me.tap && me.tap.until > Date.now() ? me.tap.b : null, tapSince = tap ? (me.tap.since || me.tap.until - core.TAP.h * HOUR) : 0; const out = {}; for (const [id, b] of Object.entries(S.blocs)) { const mem = (b.members || []).includes(uid); out[id] = { ...b, wall: mem ? (b.wall || []) : tap === id ? tapHear(uid, b.wall || [], tapSince) : [], /* a wiretap lets a spy read only what is said after the bug was planted, nothing else */ log: mem ? (b.log || []) : [], coSent: mem ? (b.coSent || {}) : {} }; } return out; }
const crisisView = () => S.crisis ? { ...S.crisis } : null;
const disView = () => S.dis.filter(d => Date.now() < d.until + 6 * HOUR);
function sendBlocs() { for (const c of clients) write(c, 'blocs', blocsView(c.uid)); }
function snapshot(uid) {
  const cols = {}; for (const c of COLS) cols[c] = {};
  for (const [p, d] of Object.entries(S.docs)) { const [c, id] = p.split('/'); if (!cols[c]) continue; cols[c][id] = c === 'nations' && id !== uid ? publicView(d) : d; }
  const users = {}; for (const [id, u] of Object.entries(S.users)) if (!u.banned) users[id] = id === uid ? u.name : pubName(id); // others: nation name only
  const chaosRecapV = (() => { const l = S.chaosLast; if (!l || !l.recap || Date.now() - l.end > 30 * 60e3) return null; const i = (l.rank || []).findIndex(r => r.u === uid); return { end: l.end, mins: l.mins, ...l.recap, me: i >= 0 ? { place: i + 1, gain: l.rank[i].gain } : null }; })();
  return { chaosRecap: chaosRecapV, seasonPend: (meta(uid).seasonPending || []).map(g => ({ lines: (g.lines || []).slice(0, 6), cash: g.cash || 0, xp: g.xp || 0 })).slice(-5), lastSeason: (HOF[HOF.length - 1] || {}).name || '', voteAt: meta(uid).voteT || 0, voteS: meta(uid).voteS || {}, cols, users, config: (({ boss, ...c }) => c)(effCfg()), awaySince: meta(uid).prevSeen || 0, council: councilViewFor(uid), polls: pollFor(uid), nukes: S.nukes.filter(x => Date.now() - x.t < 12 * HOUR), blocs: blocsView(uid), crisis: crisisView(), games: S.games, dis: disView(), mkt: mktView(true), duels: duelsView(), event: S.event, notes: (S.notes[uid] || []).slice(0, 60), mailUnread: (S.mail[uid] || []).filter(m => m.box === 'in' && !m.read).length, prefs: prefsOf(uid), muted: meta(uid).muted || [], vapid: PUSH.vapidPublic(S.vapid), pushOn: (S.push[uid] || []).length > 0, fallen: S.docs['nations/' + uid] ? null : (meta(uid).fallen || null), fallenList: fallenPub(), sup: SUPP ? SUPP.badges() : {}, strikes: S.strikes.filter(x => Date.now() - x.t < 20 * 60e3), ver: gameFile().etag, burn: burnList(), ntests: S.ntests.filter(x => Date.now() - (x.fired || x.t) < 3 * 60e3 && !x.missed), ntestPending: S.ntestPending, finale: FIN && !FIN.preview && Date.now() < FIN.end + 20000 ? { ...FIN, now: Date.now() } : null, finaleReplay: finaleReplayFor(uid), spyOpt: spyOptList(), opVotes: opVotesFor(uid) };
}
// a visible heartbeat every 20 seconds: browsers that hear nothing for a while know their stream has stalled and reconnect
setInterval(() => { const hb = `event: hb\ndata: ${Date.now()}\n\n`; for (const c of clients) writeRaw(c, hb); }, 20000).unref();
// the Rising Power: a loud announcement when one rises (however it rose), and a reminder every few hours while it stands
const BOSS_REMIND_H = 3;
function bossAnnounce(W, id) { const n = W.A[id]; if (!n) return; S.bossAnn = id; S.bossRem = Date.now();
  systemMessage(`⚠️ WORLD THREAT: ${n.name} has become the RISING POWER, an AI superpower armed by foreign backers. It will grow, go nuclear and attack players. ⚔️ Attacking it costs NO aggression, and a war with it is FREE: no war upkeep, no GDP or stability hit. Every nation should fight it: declare war, hit its provinces and take its capital to bring it down. The whole world wins when it falls!`);
  broadcast('announce', { text: `⚠️ ${n.name} is the Rising Power! Attacking it costs no aggression. The whole world should fight it.` }); }
function bossWatch(W) { const id = Object.keys(W.A).find(k => BOTS.isBot(k) && W.A[k].ai && W.A[k].ai.boss); if (!id) { if (S.bossAnn) S.bossAnn = null; return; }
  if (S.bossAnn !== id) return bossAnnounce(W, id);
  if (Date.now() - (S.bossRem || 0) < BOSS_REMIND_H * HOUR) return; S.bossRem = Date.now(); const n = W.A[id], prov = core.hexesOf(W, id).length, fighting = Object.keys(W.A).filter(u => !BOTS.isBot(u) && core.atWar(W, u, id)).length;
  systemMessage(`⚔️ The Rising Power ${n.name} still stands with ${prov} province${prov === 1 ? '' : 's'}. ${fighting ? `${fighting} nation${fighting === 1 ? ' is' : 's are'} at war with it.` : 'No one is fighting it yet!'} Attacking it costs NO aggression. Join the fight and bring it down together.`); }
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
  if (S.map2) { c.map2 = 1; c.tall = 1; } // the bigger map, and the build-tall bonus that came with it
  if (S.chaosTimer && S.chaosTimer.at > now && !(S.chaos && S.chaos.on)) c.chaosAt = S.chaosTimer.at; // a heads-up countdown the owner set
  if (S.chaos && S.chaos.on) { const o = S.chaos.o || {}; const sd = !!S.chaos.sd, sp = (o.speed || 10) * (sd ? 2 : 1); c.chaos = { end: S.chaos.end, speed: sp, meter: Math.round(S.chaos.meter || 0), sd: sd ? S.chaos.sd : 0, sdAt: S.chaos.end - chaosSdMs(S.chaos), lead: sd ? S.chaos.lead || null : null }; c.tm = 1 / sp; c.income *= 3; c.protectH = o.noShield || sd ? 0 : c.protectH; c.boost = { label: `💥 Chaos world: weapons unlocked, timers ${o.speed || 10}× faster. Everything resets when it ends`, end: S.chaos.end }; }
  c.overPause = S.overPause || 0;
  c.season = S.seasons && S.seasons.cur && S.seasons.cur.status === 'live' ? S.seasons.cur.id : null;
  c.noAdmin = !!S.fresh; // no province limit inside a fresh-start season world
  if (S.fresh) { c.protectH = Math.min(c.protectH || 48, 24); c.electionH = Math.min(c.electionH || 72, 48); c.lastStandH = Math.min(c.lastStandH || 24, 12); if (now - (S.fresh.t || 0) < 48 * HOUR) c.aiBoss = false; } // season: 24 h new-nation protection, no Rising Power in the first 2 days
  { const se = S.seasons && S.seasons.cur; c.fresh = S.fresh && se && se.fresh ? { name: se.name, end: se.end || 0, n: se.n } : S.fresh ? { name: 'Season', end: 0 } : null; }
  c.countdown = S.countdown && S.countdown.at + 2 * HOUR > now ? { id: S.countdown.id, text: S.countdown.text, at: S.countdown.at } : null;
  c.bossPause = (S.bossFell || 0) + bossBreatherH() * HOUR > now; // a breather after the Rising Power falls
  return c;
}
const bossBreatherH = () => { const h = +((S.config.boss || {}).breatherH); return isFinite(h) && h >= 0 ? h : 48; };
const extW = () => ({ games: S.games, dis: S.dis, mkt: S.mkt });
// FAIR SCORING: every 10 minutes each nation's score is sampled; rankings use the average of the last 12 hours (core.score reads it as n.rs)
S.scoreHist = S.scoreHist || {};
function fairSample() { try { const W = mkWorld(); if (!core.fairOn(W)) return; const now = Date.now(), cut = now - core.FAIR.avgH * HOUR;
  for (const u of Object.keys(S.scoreHist)) if (!W.A[u]) delete S.scoreHist[u];
  for (const u of Object.keys(W.A)) { const h = S.scoreHist[u] = (S.scoreHist[u] || []).filter(x => x[0] >= cut); h.push([now, core.liveScore(W, u)]); const avg = Math.round(h.reduce((a, x) => a + x[1], 0) / h.length); if (W.A[u].rs !== avg) { W.A[u].rs = avg; W.changed.add(u); } }
  commit(W); persist(); } catch (e) { logErr('Fair score sample failed: ' + e.message); } }
// note when each nation joined its current bloc (from this update on), so bloc-mates kept for a day count as alliances in the fair score
function blocSince() { try { const now = Date.now(); for (const [k, n] of Object.entries(S.docs)) { if (!k.startsWith('nations/') || !n) continue; const id = k.slice(8); if (!n.bloc) { if (n.blocT) { delete n.blocT; delete n.blocId; } continue; } if (n.blocId !== n.bloc) { n.blocId = n.bloc; n.blocT = now; try { sendNation(id); } catch (e) {} } } } catch (e) { logErr('Bloc tracking failed: ' + e.message); } }
setInterval(() => { blocSince(); fairSample(); }, 10 * 60e3).unref(); setTimeout(() => { blocSince(); fairSample(); }, 20e3).unref();
const mkWorld = () => { const W = core.world(nationsMap(), effCfg(), Date.now(), S.event, S.council, S.blocs, S.crisis, extW()); if (S.casino) { W.czJ = S.casino.jp; W.czT = S.casino.tour; W.czJ2 = S.casino.jp2; } return W; };
// how long a nuclear missile takes to reach its target on everyone's globe (the client uses the same formula), plus the camera's lead-in
function nukeFlightMs(fx) { const a = core.P[fx.from], b = core.P[fx.h]; if (!a || !b) return 4000; const r = Math.PI / 180, s2 = Math.sin((b.c[1] - a.c[1]) * r / 2) ** 2 + Math.cos(a.c[1] * r) * Math.cos(b.c[1] * r) * Math.sin((b.c[0] - a.c[0]) * r / 2) ** 2, d = 2 * Math.asin(Math.min(1, Math.sqrt(s2))); return Math.round(Math.max(26000, Math.min(48000, 26000 + d * 9000)) + 1500); }
function commit(W) {
  for (const f of W.fallen || []) {
    { const was = S.docs['nations/' + f.id]; if (was && was.ai && was.ai.boss) { S.bossFell = Date.now(); systemMessage(`🎉 The Rising Power ${f.name} has fallen to ${f.byName}! The world is safe — for now. Another power may rise in ${bossBreatherH()} hours.`); broadcast('announce', { text: `The Rising Power ${f.name} has fallen!` }); } }
    delete S.docs['nations/' + f.id];
    const rec = { t: f.t, id: f.id, name: f.name, color: f.color, by: f.by, byName: f.byName, days: Math.round(f.days * 10) / 10, rank: f.peakRank, leader: BOTS.isBot(f.id) ? null : (S.users[f.id] || {}).name || null, ai: BOTS.isBot(f.id), deadHand: f.deadHand || null };
    S.fallen.unshift(rec); S.fallen = S.fallen.slice(0, 100);
    if (!BOTS.isBot(f.id)) { meta(f.id).fallen = rec; sendTo(f.id, 'fallen', rec); addNote(f.id, 'attack', `${f.name} has fallen. ${f.byName} captured your capital. You can found a new nation at any time.`); }
    sendNation(f.id);
    broadcast('announce', { text: `${f.name} has fallen to ${f.byName}.` }); broadcast('fallenlist', fallenPub());
  }
  rebelSpawn(W);
  for (const u of W.changed) { if (W.A[u]) S.docs['nations/' + u] = W.A[u]; sendNation(u); }
  if (W.bch) { W.bch = false; persist(); sendBlocs(); }
  if (W.crch) { W.crch = false; persist(); broadcast('crisis', crisisView()); }
  if (W.gch) { W.gch = false; persist(); broadcast('games', S.games); }
  if (W.disch) { W.disch = false; persist(); broadcast('dis', disView()); }
  if (W.mkch) { const full_ = W.mkch === 2; W.mkch = 0; persist(); broadcast('mkt', mktView(full_)); }
  if (W.changed.size) persist();
  for (const nt of W.notes) addNote(nt.u, nt.kind, nt.text);
  // nuclear tests: everyone online watches it happen
  for (const fx of W.ntestFx || []) {
    S.ntestPending.push(fx); if (fx.delay) broadcast('ntestwarn', fx);
    for (const id of Object.keys(S.users)) if (id !== fx.by && S.docs['nations/' + id]) addNote(id, 'war', fx.delay ? `☢ ${fx.byName} will conduct a nuclear test in ${oceanPhrase(fx.ocean)} in ${fx.delay} minutes. Watch it live on the globe.` : `☢ ${fx.byName} is conducting a nuclear test in ${oceanPhrase(fx.ocean)} right now. Watch the globe.`);
    armTest(fx);
  }
  W.ntestFx = [];
  if ((W.strikeFx || []).length) { const now = Date.now(); for (const fx of W.strikeFx) { broadcast('strike', fx); S.strikes.unshift(fx); S.strikeLog.unshift({ t: now, by: fx.by, byName: fx.byName, to: fx.to, toName: fx.toName, kind: fx.kind, n: fx.n, hits: fx.hits, lost: fx.lost, place: fx.place, target: fx.target }); if (!fx.dirty && !fx.noburn) { const b = S.burn[fx.h]; S.burn[fx.h] = { t: now, n: Math.min(20, (b && now - b.t < BURN_MS ? b.n : 0) + 1) }; } } S.strikes = S.strikes.filter(x => now - x.t < 20 * 60e3).slice(0, 80); S.strikeLog = S.strikeLog.slice(0, 400); burnList(); }
  for (const fx of W.nukeFx || []) {
    const t = fx.intercepted ? `🛡 NUCLEAR MISSILE INTERCEPTED: ${fx.toName}'s Golden Dome destroyed the missile ${fx.byName} fired at ${fx.place}.` : `☢ NUCLEAR DETONATION: ${fx.byName} ${fx.retaliation ? 'retaliated against' : 'struck'} ${fx.toName} at ${fx.place}. Fallout is spreading.`;
    // the chat line lands after the missile's flight, which everyone is watching
    const fl = nukeFlightMs(fx); setTimeout(() => systemMessage(t), fl); broadcast('nuke', fx); S.nukes.unshift(fx); S.nukes = S.nukes.slice(0, 50); try { chaosNukeHit(fx); } catch (e) { logErr('chaosNukeHit: ' + e.message); }
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
    if (S.config.noAI) { S.freedQ = (S.freedQ || 0) + 1; S.freedLast = [...(S.freedLast || []), core.pname(b.h)].slice(-3); continue; } // all AI off: the province simply becomes free land
    const rebels = Object.values(W.A).filter(n => n.ai && n.ai.rebel).length; if (rebels >= WP.REBEL.maxNations) { S.freedQ = (S.freedQ || 0) + 1; S.freedLast = [...(S.freedLast || []), core.pname(b.h)].slice(-3); continue; }
    const id = 'ai_' + crypto.randomBytes(5).toString('hex'), from = W.A[b.from]; const name = core.foundRebel(W, id, b.h, { color: BOTS.distinctColor(W), dev: b.dev, from: b.from, fromName: b.fromName, tech: from ? from.tech : 2 });
    if (name) { W.changed.add(id); systemMessage(`🏴 ${core.pname(b.h)} has declared independence from ${b.fromName} as ${name}. Its land is up for grabs.`); }
  }
}

// AI nations: keep the configured number, retiring the weakest as real players join.
function botTarget(W) { const real = humans(W).length; const want = Math.max(0, Math.min(30, +S.config.bots || 0)); return S.config.botRetire ? Math.max(0, want - Math.floor(real / 3)) : want; }
function removeBot(W, u, why) { const n = W.A[u]; if (!n) return; delete W.A[u]; W.changed.delete(u); for (const v of Object.keys(W.A)) if (W.A[v].rel && W.A[v].rel[u]) { delete W.A[v].rel[u]; W.changed.add(v); } setDoc('nations', u, null); W.OWN = core.computeOwn(W.A); if (why) systemMessage(`${n.name} (AI) has withdrawn from the world${why === 'retire' ? ' to make room for new leaders' : ''}.`); }
function manageBots(W) {
  if (S.config.noAI) { const ai = Object.keys(W.A).filter(u => BOTS.isBot(u)); for (const u of ai) removeBot(W, u); return; } // all AI off: any AI nation that appears (breakaway, Rising Power, anything) is removed and its land freed
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
    if (S.config.noAI) throw Object.assign(new Error('All AI is turned off, so there is no Rising Power. Turn AI back on first.'), { status: 400 });
    boss = Object.keys(W.A).find(u => W.A[u].ai && W.A[u].ai.boss) || null;
    if (!boss) { if (!Object.keys(W.A).some(k => BOTS.isBot(k))) throw Object.assign(new Error('There are no AI nations to become the Rising Power.'), { status: 400 });
      S.bossFell = 0; W = mkWorld(); boss = BOTS.raiseBoss(W, W.cfg, '', true); if (!boss) throw Object.assign(new Error('Could not raise a Rising Power right now.'), { status: 400 }); commit(W); W = mkWorld(); }
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
// some world laws can only be voted on now and then, so a group can't re-pass them every time they run out (hours between votes)
const LAW_CD = { truce: 7 * 24, nonukes: 72, npt: 96 };
const LAW_WHAT = { truce: 'a world truce', nonukes: 'a nuclear weapons ban', npt: 'a non-proliferation treaty' };
if (S.council) { S.council.lastLaw = S.council.lastLaw || {}; if (S.council.lastTruce && !S.council.lastLaw.truce) S.council.lastLaw.truce = S.council.lastTruce;
  for (const k of Object.keys(LAW_CD)) if (S.council.lastLaw[k] == null) S.council.lastLaw[k] = (S.council.props || []).filter(p => p.type === k && p.status !== 'cancelled').reduce((m, p) => Math.max(m, p.t || 0), 0); }
const lawWait = k => LAW_CD[k] ? LAW_CD[k] * HOUR - (Date.now() - ((S.council.lastLaw || {})[k] || 0)) : 0;
// comeback support was retired on Nov 17: take back everything it handed out since 11:27 AM Mountain (18:27 UTC) that day, once.
// Cash comes back from the treasury first and any shortfall becomes debt; troops, stability, approval and the protection shield are taken back too.
setTimeout(() => { if (!S.nukeRogue1) { const W = mkWorld(), now = Date.now(), hit = []; for (const [id, n] of Object.entries(W.A)) if (n && !n.nukeRogue && core.rogue(W, n)) { const x = (S.nukes || []).filter(k => k.by === id && !k.retaliation && now - k.t < 7 * 864e5).sort((a, b) => b.t - a.t)[0]; if (x) { n.nukeRogue = x.t; W.changed.add(id); hit.push(n.name); } } S.nukeRogue1 = { t: now, who: hit }; if (hit.length) { commit(W); logErr('Nuclear rogue lock applied to: ' + hit.join(', ')); } persist(); } }, 2500);
setTimeout(() => { if (!S.cbkRevert1) { const cut = Date.UTC(2026, 10, 17, 18, 27), done = [];
  for (const [k, n] of Object.entries(S.docs)) { if (!k.startsWith('nations/') || !n || !n.cbk || n.cbk.revoked || !(n.cbk.t >= cut)) continue; const c = n.cbk;
    const fromCash = Math.max(0, Math.min(n.cash || 0, c.cash || 0)), owed = Math.max(0, (c.cash || 0) - fromCash); n.cash = (n.cash || 0) - fromCash; if (owed) n.debt = (n.debt || 0) + owed;
    const tr = Math.min(n.troops || 0, c.troops || 0); n.troops = (n.troops || 0) - tr; n.stability = Math.max(0, (n.stability || 0) - 15); n.approval = Math.max(0, (n.approval || 0) - 10);
    if (n.shield && n.shield <= (c.until || 0) + 1000) delete n.shield; c.revoked = Date.now();
    const msg = `Comeback support has been retired, so the help sent ${new Date(c.t).toUTCString().slice(17, 22)} UTC was taken back: ${WP.moneyS(c.cash || 0)}${owed ? ` (${WP.moneyS(owed)} of it was already spent and was added to your debt)` : ''}, ${tr.toLocaleString('en-US')} troops, 15 stability, 10 approval and the protection shield.`;
    (n.log = n.log || []).unshift({ t: Date.now(), x: msg }); n.log = n.log.slice(0, 60); const id = k.slice(8); if (S.users[id]) addNote(id, 'war', '🛡 ' + msg); done.push(`${n.name} (${WP.moneyS(c.cash || 0)})`); }
  S.cbkRevert1 = { t: Date.now(), n: done.length, who: done }; if (done.length) logErr('Comeback support taken back from: ' + done.join(', ')); for (const [k] of Object.entries(S.docs)) if (k.startsWith('nations/') && S.docs[k] && S.docs[k].cbk && S.docs[k].cbk.revoked) sendNation(k.slice(8)); persist(); } }, 2000);
function councilDaily(W) {
  if (S.config.councilAuto === false) return; const now = Date.now(); if (now - (S.council.lastDaily || 0) < 24 * HOUR) return;
  if (S.council.props.some(p => p.status === 'open' && WP.RESOLUTIONS[p.type] && WP.RESOLUTIONS[p.type].kind === 'global')) return;
  const pool = DAILY_LAWS.filter(k => !((S.council.active[k] || 0) > now) && !(lawWait(k) > 0) && !(bonusWait(k) > 0)); if (!pool.length) return; const type = pool[Math.floor(rng() * pool.length)]; if (LAW_CD[type]) (S.council.lastLaw = S.council.lastLaw || {})[type] = now;
  S.council.lastDaily = now; S.council.props.unshift({ id: rid(), by: null, auto: true, why: 'The law of the day: every nation may vote.', type, target: null, t: now, end: now + COUNCIL_H * HOUR, votes: {}, status: 'open' }); S.council.props = S.council.props.slice(0, 60);
  systemMessage(`⚖ World Council — law of the day: “${WP.RESOLUTIONS[type].n}”. ${WP.RESOLUTIONS[type].d} Vote within ${COUNCIL_H} hours on the World Council page.`); councilCast();
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
  if (type === 'lift') { if (!(M('embargo') || M('armsEmb') || M('frozen') || M('condemned') || core.rogue(W, n) || core.sanctioned(n))) return `${n.name} is not under any sanctions.`; if (core.nukeRogue(W, n)) return `${n.name} is a rogue state because it launched a nuclear strike. That status cannot be voted away; it ends on its own.`; if (nukedRecently(v, now)) return `${n.name} launched a nuclear strike less than 72 hours ago. Its sanctions cannot be lifted yet.`; }
  return null;
}
// paying off the Council: lifts sanctions, rogue status and Council measures at once, announced to the whole world. The money is simply gone.
// ---------- black market ----------
// Anyone can list food, oil, steel or goods anonymously at their own price; only nations shut out of the world market
// (rogue states, World Council trade embargoes, naval blockades) can buy. Listing and buying both carry a risk of being caught:
// the goods are seized, the nation is fined and named in World Chat. Sellers stay anonymous unless they are the one caught.
const BM = { maxListings: 5, hours: 48, maxQ: 1e6, maxPrice: 1e5, sellRisk: .04, sellRiskMax: .09, buyRisk: .06, buyRiskMax: .125, riskValue: 5e8, fine: .5, fineMin: 1e6, fineMax: 5e8 };
const bmErr = (m, st = 400) => Object.assign(new Error(m), { status: st });
const bmRisk = (base, max, value) => base + (max - base) * Math.min(1, value / BM.riskValue);
const bmFine = value => Math.round(Math.max(BM.fineMin, Math.min(BM.fineMax, value * BM.fine)));
function bmShut(W, n) { if (!n) return ''; if (core.rogue(W, n)) return 'rogue'; if ((n.embargo || 0) > W.now) return 'embargo'; if ((n.blockade || 0) > W.now) return 'blockade'; return ''; }
function bmCharge(n, amt) { const pay = Math.min(amt, Math.max(0, n.cash || 0)); core.finSync(null, n); n.cash = (n.cash || 0) - pay; core.finSync(null, n, 'council'); if (amt > pay) n.debt = (n.debt || 0) + (amt - pay); return amt > pay ? amt - pay : 0; } // a fine larger than the treasury becomes debt
function bmView(uid) {
  const W = mkWorld(), n = W.A[uid], now = Date.now(), why = bmShut(W, n);
  return { listings: S.bm.list.filter(x => x.exp > now && x.q > 0).sort((a, b) => a.price / WP.RES[a.r].p - b.price / WP.RES[b.r].p).map(x => ({ id: x.id, r: x.r, q: x.q, price: x.price, t: x.t, exp: x.exp, mine: x.seller === uid })),
    canBuy: !!why, why, prices: Object.fromEntries(Object.keys(WP.RES).map(k => [k, Math.round(WP.RES[k].p * ((W.m.price || {})[k] || 1))])), mine: S.bm.list.filter(x => x.seller === uid && x.exp > now && x.q > 0).length, rules: BM };
}
function bmCast() { broadcast('bm', { n: S.bm.list.length, t: Date.now() }); }
function bmPost(uid, b) {
  const W = mkWorld(), n = W.A[uid], now = Date.now(); if (!n) throw bmErr('Found a nation first.');
  const r = String(b.r || ''); if (!WP.RES[r]) throw bmErr('Choose food, oil, steel, goods or munitions.');
  const q = Math.floor(+b.q), price = Math.round(+b.price);
  if (!(q >= 1 && q <= BM.maxQ)) throw bmErr(`List between 1 and ${BM.maxQ.toLocaleString('en-US')} units.`);
  if (!(price >= 1 && price <= BM.maxPrice)) throw bmErr(`Set a price between $1 and $${BM.maxPrice.toLocaleString('en-US')} per unit.`);
  if ((n.res[r] || 0) < q) throw bmErr(`You only have ${Math.floor(n.res[r] || 0).toLocaleString('en-US')} ${r}.`);
  if (S.bm.list.filter(x => x.seller === uid && x.exp > now && x.q > 0).length >= BM.maxListings) throw bmErr(`You can have at most ${BM.maxListings} listings at a time.`);
  const value = q * price, risk = bmRisk(BM.sellRisk, BM.sellRiskMax, value);
  n.res[r] -= q; W.changed.add(uid); // the goods leave your stockpile either way: listed, or seized
  if (Math.random() < risk) {
    const fine = bmFine(value), owed = bmCharge(n, fine); n.aggr = Math.min(100, (n.aggr || 0) + 5);
    core.log(n, `🕶 Caught on the black market: ${q.toLocaleString('en-US')} ${r} seized and a ${WP.money(fine)} fine${owed ? ` (${WP.money(owed)} added to your debt)` : ''}.`, W);
    commit(W); persist(); systemMessage(`🚨 Customs agents caught ${n.name} trying to sell ${q.toLocaleString('en-US')} ${r} on the black market. The goods were seized and ${n.name} was fined ${WP.moneyS(fine)}.`);
    addNote(uid, 'economy', `🚨 You were caught listing ${q.toLocaleString('en-US')} ${r} on the black market. The goods were seized and you were fined ${WP.money(fine)}.`);
    return { ok: false, caught: true, msg: `Caught! Customs seized your ${q.toLocaleString('en-US')} ${r} and fined you ${WP.money(fine)}${owed ? ` (${WP.money(owed)} went on your debt)` : ''}. The world has been told.` };
  }
  const x = { id: rid(), seller: uid, r, q, price, t: now, exp: now + BM.hours * HOUR }; S.bm.list.unshift(x); S.bm.list = S.bm.list.slice(0, 400);
  commit(W); persist(); bmCast();
  return { ok: true, msg: `Listed ${q.toLocaleString('en-US')} ${r} at ${WP.money(price)} each, anonymously. It stays up for ${BM.hours} hours; unsold goods come back to you.` };
}
function bmCancel(uid, b) {
  const x = S.bm.list.find(y => y.id === String(b.id || '') && y.seller === uid); if (!x || !(x.q > 0)) throw bmErr('That listing is gone.');
  const W = mkWorld(), n = W.A[uid]; if (n) { n.res[x.r] = (n.res[x.r] || 0) + x.q; W.changed.add(uid); }
  S.bm.list = S.bm.list.filter(y => y !== x); commit(W); persist(); bmCast(); return { ok: true, msg: `Listing withdrawn: ${x.q.toLocaleString('en-US')} ${x.r} back in your stockpile.` };
}
function bmBuy(uid, b) {
  const W = mkWorld(), n = W.A[uid], now = Date.now(); if (!n) throw bmErr('Found a nation first.');
  if (!bmShut(W, n)) throw bmErr('Only nations shut out of the world market (rogue states, trade embargoes or naval blockades) deal on the black market. Use the world market on the Economy page.');
  const x = S.bm.list.find(y => y.id === String(b.id || '')); if (!x || !(x.q > 0) || x.exp <= now) throw bmErr('That listing is gone.');
  if (x.seller === uid) throw bmErr('That is your own listing.');
  if (S.fresh && sharesNetwork(uid, x.seller)) throw bmErr('You can\'t buy this listing during the season.'); // no feeding a second account through the black market
  const q = Math.min(x.q, Math.floor(+b.q || x.q)); if (!(q >= 1)) throw bmErr('Enter how many units to buy.');
  const value = q * x.price; if ((n.cash || 0) < value) throw bmErr(`That costs ${WP.money(value)}; your treasury doesn't cover it.`);
  const seller = W.A[x.seller], risk = bmRisk(BM.buyRisk, BM.buyRiskMax, value);
  x.q -= q; if (x.q <= 0) S.bm.list = S.bm.list.filter(y => y !== x);
  if (Math.random() < risk) {
    const fine = bmFine(value), owed = bmCharge(n, fine); W.changed.add(uid);
    core.log(n, `🕶 Caught buying on the black market: the ${q.toLocaleString('en-US')} ${x.r} shipment was seized and you were fined ${WP.money(fine)}.`, W);
    commit(W); persist(); bmCast(); systemMessage(`🚨 A black-market shipment of ${q.toLocaleString('en-US')} ${x.r} bound for ${n.name} was intercepted. ${n.name} was fined ${WP.moneyS(fine)}.`);
    if (seller) addNote(x.seller, 'economy', `🕶 A buyer of your black-market ${x.r} was caught: ${q.toLocaleString('en-US')} ${x.r} was seized and you were not paid. You were not identified.`);
    return { ok: false, caught: true, msg: `Intercepted! The shipment was seized and you were fined ${WP.money(fine)}${owed ? ` (${WP.money(owed)} went on your debt)` : ''}. The world has been told.` };
  }
  core.finSync(W, n); n.cash -= value; core.finSync(W, n, 'market'); n.res[x.r] = (n.res[x.r] || 0) + q; W.changed.add(uid);
  if (seller) { core.finSync(W, seller); seller.cash = (seller.cash || 0) + value; core.finSync(W, seller, 'market'); W.changed.add(x.seller); core.log(seller, `🕶 Black market: sold ${q.toLocaleString('en-US')} ${x.r} for ${WP.money(value)} to an unnamed buyer.`, W); }
  commit(W); persist(); bmCast(); if (seller) addNote(x.seller, 'economy', `🕶 Your black-market listing sold ${q.toLocaleString('en-US')} ${x.r} for ${WP.money(value)}.`);
  return { ok: true, msg: `Bought ${q.toLocaleString('en-US')} ${x.r} for ${WP.money(value)}. It slipped past customs.` };
}
setInterval(() => { // expired listings: unsold goods go back to the seller
  const now = Date.now(), old = S.bm.list.filter(x => x.exp <= now); if (!old.length) return; const W = mkWorld();
  for (const x of old) { const n = W.A[x.seller]; if (n && x.q > 0) { n.res[x.r] = (n.res[x.r] || 0) + x.q; W.changed.add(x.seller); addNote(x.seller, 'economy', `🕶 Your black-market listing of ${x.q.toLocaleString('en-US')} ${x.r} expired unsold and was returned to you.`); } }
  S.bm.list = S.bm.list.filter(x => x.exp > now); commit(W); persist(); bmCast(); }, 60e3).unref();
function councilBribe(uid) {
  const W = mkWorld(), n = W.A[uid], now = Date.now(); if (!n) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  if (!core.bribeNeeded(W, n)) throw Object.assign(new Error('Your nation is not under sanctions, rogue status or Council measures.'), { status: 400 });
  if (core.nukeRogue(W, n)) throw Object.assign(new Error(`Rogue status from a nuclear strike cannot be bought off. It lasts at least ${core.WARHEAD.rogueH} hours after the strike, then ends on its own once your aggression falls below 50.`), { status: 400 });
  if (nukedRecently(uid, now)) throw Object.assign(new Error('No amount of money will buy the Council within 72 hours of a nuclear strike.'), { status: 400 });
  const price = core.bribePrice(W, n); if ((n.cash || 0) < price) throw Object.assign(new Error(`The Council's price is ${WP.money(price)}. Your treasury doesn't cover it.`), { status: 400 });
  const wasRogue = core.rogue(W, n);
  core.finSync(null, n); n.cash -= price; n.bribes = [...core.bribeRecent(n, now), now];
  const back = n.frozen ? n.frozen.amt || 0 : 0; n.cash += back; core.finSync(null, n, 'council'); n.frozen = null; n.embargo = 0; n.armsEmb = 0; n.condemned = 0;
  if (wasRogue) { n.rogue = 0; delete n.rogueT; } n.aggr = Math.min(n.aggr || 0, 30); W.changed.add(uid);
  for (const pr of (S.council && S.council.props) || []) if (pr.status === 'open' && pr.type === 'lift' && pr.target === uid) { pr.status = 'failed'; pr.result = 'withdrawn: they paid the Council instead'; pr.end = now; } // its own petition is no longer needed
  core.news(W, uid, `💰 ${n.name} bribed the World Council to lift its ${wasRogue ? 'rogue-state status' : 'sanctions'} (${WP.moneyS(price)}).`);
  commit(W); persist();
  systemMessage(`💰 ${n.name} paid the World Council ${WP.moneyS(price)} to make its ${wasRogue ? 'rogue-state status' : 'sanctions'} disappear.`);
  return { msg: `Paid ${WP.money(price)}. ${wasRogue ? 'Your rogue status' : 'Your sanctions'} and all Council measures are lifted${back ? `, and ${WP.money(back)} in frozen assets is back in your treasury` : ''}. Your aggression is now ${Math.round(n.aggr)}.` };
}
// penalties players can vote on, and the proof a target must have given first (attacking a real player, nuclear weapons, or spies caught in the last 48 hours, or high aggression)
const PUNISH = ['sanction', 'embargo', 'armsEmb', 'freeze', 'condemn'];
const PUNISH_DAILY = [...PUNISH, 'inspect']; // penalty votes a target can face at most once a day (inspections only need a nuclear program, so they skip the aggression check)
function punishEvidence(W, v) {
  const n = W.A[v], now = Date.now(); if (!n || n.ai) return null; // AI nations are never penalised by the Council
  if ((n.aggr || 0) >= 35) return 'aggression';
  if ((n.out || []).some(e => e.type === 'battle' && e.to && e.to !== v && S.users[e.to] && !BOTS.isBot(e.to) && W.A[e.to] && now - e.t < 48 * HOUR && !((W.A[e.to].out || []).some(x => x.type === 'battle' && x.to === v && x.t < e.t && e.t - x.t < 24 * HOUR)))) return 'attacked a player'; // striking back at someone who hit you first doesn't count
  if ((n.dirtyAt && now - n.dirtyAt < 48 * HOUR) || (typeof n.nuke === 'number' && now - n.nuke < 48 * HOUR) || (S.nukes || []).some(x => x.by === v && !x.retaliation && now - (x.t || 0) < 48 * HOUR) || (S.strikeLog || []).some(x => x.by === v && S.users[x.to] && now - (x.t || 0) < 48 * HOUR)) return 'weapons';
  for (const [u, m] of Object.entries(W.A)) if (u !== v && m.cb && (m.cb[v] || 0) > now) return 'spies';
  if (core.rogue(W, n)) return 'rogue';
  return null;
}
function councilPropose(uid, b) {
  const W = mkWorld(), n = W.A[uid]; if (!n) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const type = typeof b.type === 'string' ? b.type : ''; if (!RES_KEYS.includes(type)) throw Object.assign(new Error('Unknown resolution.'), { status: 400 });
  const plea = type === 'lift' && b.target === uid; // a nation under sanctions petitioning for its own sanctions to be lifted
  if (!plea && core.rankOf(n.xp) < 2) throw Object.assign(new Error('You must be at least a Mayor to propose resolutions.'), { status: 400 });
  if (plea && Date.now() - ((S.council.plea || {})[uid] || 0) < 12 * HOUR) { const h = Math.ceil((12 * HOUR - (Date.now() - S.council.plea[uid])) / HOUR); throw Object.assign(new Error(`You can petition the Council once every 12 hours. Try again in ${h} hour${h === 1 ? '' : 's'}.`), { status: 400 }); }
  const R = WP.RESOLUTIONS[type]; let target = null;
  if (isTargeted(type)) {
    target = typeof b.target === 'string' ? b.target : ''; if (!Object.prototype.hasOwnProperty.call(W.A, target) || (target === uid && !plea)) throw Object.assign(new Error('Choose another nation as the target.'), { status: 400 });
    const why = resBlocked(W, type, target); if (why) throw Object.assign(new Error(why), { status: 400 });
    // the Council only punishes nations that did something: a group of players can't vote penalties onto a peaceful nation
    if (PENALTY_TYPES.includes(type) && (W.A[target].ai || BOTS.isBot(target))) throw Object.assign(new Error('The World Council does not vote penalties on AI nations.'), { status: 400 });
    if (PUNISH.includes(type)) { const ev = punishEvidence(W, target); if (!ev) throw Object.assign(new Error(`${W.A[target].name} hasn't attacked another player, used nuclear weapons or been caught spying recently. The Council only punishes aggression.`), { status: 400 }); }
    // a nation can face a player-proposed penalty vote at most once a day, so a group can't keep piling on the same target
    if (PUNISH_DAILY.includes(type)) { const last = S.council.props.filter(p => !p.auto && PUNISH_DAILY.includes(p.type) && p.target === target).sort((a, b) => b.t - a.t)[0]; const gap = last && last.status === 'failed' ? 48 : 24; if (last && Date.now() - last.t < gap * HOUR) { const h = Math.ceil((gap * HOUR - (Date.now() - last.t)) / HOUR); throw Object.assign(new Error(`${W.A[target].name} ${gap === 48 ? 'just survived a penalty vote, so it is protected from new ones for 2 days' : 'already faced a penalty vote today'}. Another can be proposed in ${h} hour${h === 1 ? '' : 's'}.`), { status: 400 }); } }
  }
  if (LAW_CD[type]) { const wait = lawWait(type); if (wait > 0) { const tH = Math.ceil(wait / HOUR), d = Math.floor(tH / 24), h = tH % 24, when = [d ? `${d} day${d > 1 ? 's' : ''}` : '', h ? `${h} hour${h > 1 ? 's' : ''}` : ''].filter(Boolean).join(' '), every = LAW_CD[type] % 24 === 0 ? (LAW_CD[type] === 168 ? 'once a week' : `once every ${LAW_CD[type] / 24} days`) : `once every ${LAW_CD[type]} hours`; throw Object.assign(new Error(`The World Council votes on ${LAW_WHAT[type]} only ${every}. The next one can be proposed in ${when}.`), { status: 400 }); } }
  const open = S.council.props.filter(p => p.status === 'open');
  if (open.some(p => p.by === uid)) throw Object.assign(new Error('You already have a resolution under vote.'), { status: 400 });
  if (open.filter(p => !p.auto).length >= 4) throw Object.assign(new Error('The Council agenda is full. Try again after a vote closes.'), { status: 400 });
  if (type !== 'custom' && open.some(p => p.type === type && p.target === target && (type !== 'pact' || p.scope === b.scope))) throw Object.assign(new Error('That resolution is already being voted on.'), { status: 400 });
  if (type === 'debt' && core.debtRatio(n) >= WP.DEBT_PROPOSE_MAX) throw Object.assign(new Error(`Only nations with debt under ${Math.round(WP.DEBT_PROPOSE_MAX * 100)}% of GDP can propose debt relief. Yours is ${Math.round(core.debtRatio(n) * 100)}%.`), { status: 400 }); // no voting yourself out of your own debt
  if (type === 'debt' && Date.now() - ((S.council.passed || {}).debt || 0) < 72 * HOUR) throw Object.assign(new Error(`Debt relief can only pass once every 72 hours. It can be proposed again in ${Math.ceil((72 * HOUR - (Date.now() - S.council.passed.debt)) / HOUR)} hours.`), { status: 400 });
  { const bw = bonusWait(type); if (bw > 0) { const tH = Math.ceil(bw / HOUR), d = Math.floor(tH / 24), h = tH % 24; throw Object.assign(new Error(`“${R.n}” can pass at most once every ${Math.max(72, (R.h || 24) + 48) / 24} days. It can be proposed again in ${[d ? `${d} day${d > 1 ? 's' : ''}` : '', h ? `${h} hour${h > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ')}.`), { status: 400 }); } }
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
  let fee = 0;
  if (!plea) { const cost = b.anon ? 1e7 : 1e6; fee = PENALTY_TYPES.includes(type) ? Math.max(0, Math.round((n.cash - cost) * PENALTY_FEE)) : 0; if (n.cash < cost) throw Object.assign(new Error(b.anon ? 'An anonymous resolution costs $10,000,000.' : 'Submitting a resolution costs $1,000,000.'), { status: 400 }); core.finSync(null, n); n.cash -= cost + fee; core.finSync(null, n, 'council'); W.changed.add(uid); commit(W); } // $1M, or $10M to stay anonymous
  else (S.council.plea = S.council.plea || {})[uid] = Date.now();
  const p = { id: rid(), by: uid, type, target, t: Date.now(), end: Date.now() + COUNCIL_H * HOUR, votes: { [uid]: 'y' }, status: 'open' }; if (fee) p.fee = fee;
  if (LAW_CD[type]) (S.council.lastLaw = S.council.lastLaw || {})[type] = p.t; // starts that law's cooldown
  if (b.anon && !plea) p.anon = true; // proposer stays secret: never sent to players (kept only in the saved game data)
  if (scope) p.scope = scope; if (text) { p.text = text; p.hours = hours; } if (plea) p.plea = true;
  if (type === 'debt') p.debts = Object.fromEntries(Object.entries(W.A).filter(([, x]) => (x.debt || 0) > 0).map(([u, x]) => [u, Math.round(x.debt)]));
  S.council.props.unshift(p); S.council.props = S.council.props.slice(0, 60); persist(); councilCast();
  const txt = plea ? `${n.name} petitions the World Council to lift its sanctions and welcome it back. Vote now.` : `${p.anon ? 'An anonymous nation' : n.name} proposes to the World Council: ${resLabel(type, target && W.A[target].name, p)}.`;
  systemMessage(txt); for (const u of Object.keys(S.users)) if (u !== uid) addNote(u, 'council', txt + ` Voting closes in ${COUNCIL_H} hours.`);
  return p;
}
function councilVote(uid, b) {
  if (!S.docs['nations/' + uid]) throw Object.assign(new Error('Found a nation first.'), { status: 400 });
  const p = S.council.props.find(x => x.id === b.id && x.status === 'open'); if (!p || Date.now() >= p.end) throw Object.assign(new Error('That vote has closed.'), { status: 400 });
  if (!['y', 'n'].includes(b.vote)) throw Object.assign(new Error('Vote yes or no.'), { status: 400 });
  if (!p.votes[uid]) { const twins = Object.keys(p.votes).filter(o => o !== uid && S.users[o] && sharesNetwork(uid, o)); if (twins.length) { flag(uid, `Voted on the same World Council resolution as ${twins.map(o => S.users[o].name).join(', ')}, from the same network (possible second account)`); (p.net = p.net || []).push(uid); } }
  p.votes[uid] = b.vote; { const W = mkWorld(); if (decideEarly(W, p)) { councilResolve(W); commit(W); } } persist(); councilCast(); return p;
}
// who could still vote: players active in the last 3 days who have a nation (AI nations don't vote)
function canStillVote(W, p) { const now = Date.now(); let n = 0; for (const u of Object.keys(W.A)) { if (p.votes[u] || BOTS.isBot(u)) continue; if (S.users[u] && now - ((S.meta[u] || {}).lastSeen || 0) < 72 * HOUR) n++; } return n; }
// a vote closes early once the outcome is certain: it passes when yes leads by more than the votes still out (and has at least 3), and fails when yes can no longer win
function decideEarly(W, p) {
  if (p.status !== 'open' || Date.now() >= p.end) return false;
  const pv = netVotes(p), ys = pv.filter(v => v === 'y').length, ns = pv.filter(v => v === 'n').length, left = canStillVote(W, p);
  const need = minYes(p.type), sure = p.type === 'sanction' ? ys >= need && ys * 3 >= (ys + ns + left) * 2 : ys >= need && ys > ns + left, lost = p.type === 'sanction' ? (ys + left) * 3 < (ys + left + ns) * 2 || ys + left < need : ys + left <= ns || ys + left < need;
  if (sure || lost) { p.end = Date.now(); p.early = true; return true; }
  return false;
}
// players on the same network count as one voter: only the first of them to vote counts
function netVotes(p) { const kept = []; for (const [u, v] of Object.entries(playerVotes(p.votes))) { if (kept.some(([k]) => sharesNetwork(u, k))) continue; kept.push([u, v]); } return kept.map(x => x[1]); }
function councilResolve(W) {
  const now = Date.now(); let changed = false;
  for (const p of S.council.props) { if (decideEarly(W, p)) changed = true; }
  for (const p of S.council.props) {
    if (p.status !== 'open' || now < p.end) continue;
    const pv = netVotes(p), ys = pv.filter(v => v === 'y').length, ns = pv.filter(v => v === 'n').length;
    const R = WP.RESOLUTIONS[p.type], tn = p.target && W.A[p.target];
    if (p.target && !tn) { p.status = 'failed'; changed = true; continue; }
    p.status = passes(p.type, ys, ns) ? 'passed' : 'failed'; p.result = `${ys}–${ns}${p.early ? ', decided early' : ''}`; changed = true;
    const label = resLabel(p.type, tn && tn.name, p);
    if (p.status === 'passed' && p.target && resBlocked(W, p.type, p.target)) { p.status = 'failed'; p.result += ', no longer applies'; }
    if (p.status === 'passed') {
      const until = now + (p.hours || R.h) * HOUR, extra = enactResolution(W, p, tn, until); (S.council.passed = S.council.passed || {})[p.type] = now;
      if (p.fee && p.by && W.A[p.by]) { core.finSync(W, W.A[p.by]); W.A[p.by].cash += p.fee; core.finSync(W, W.A[p.by], 'council'); W.changed.add(p.by); if (S.users[p.by]) addNote(p.by, 'council', `Your ${WP.moneyS(p.fee)} penalty deposit was refunded because the vote passed.`); }
      systemMessage(`World Council resolution PASSED (${p.result}): ${label}.${extra ? ' ' + extra : ''}`);
      if (p.target && S.users[p.target]) addNote(p.target, 'council', R.kind === 'protect' ? `The World Council passed a resolution in your favor: ${R.n}.${extra ? ' ' + extra : ''}` : `The World Council passed a resolution against you: ${R.n}.${extra ? ' ' + extra : ''}`);
    } else systemMessage(`World Council resolution failed (${p.result}): ${label}.`);
    if (S.users[p.by]) addNote(p.by, 'council', `Your resolution "${label}" ${p.status} (${p.result}).`);
  }
  for (const [k, until] of Object.entries(S.council.active)) if (until < now) { delete S.council.active[k]; changed = true; }
  for (const k of ['pacts', 'decl']) if ((S.council[k] || []).some(x => x.until < now)) { S.council[k] = S.council[k].filter(x => x.until >= now); changed = true; }
  if (changed) { persist(); councilCast(); }
}
// what a passed resolution actually does. Returns a short note for the announcement.
function enactResolution(W, p, tn, until) {
  const now = Date.now(), v = p.target, ch = x => W.changed.add(x);
  switch (p.type) {
    case 'sanction': tn.aggr = Math.max(tn.aggr || 0, 80); core.rogueCheck(W, v); ch(v); return '';
    case 'embargo': tn.embargo = Math.max(tn.embargo || 0, until); ch(v); return '';
    case 'armsEmb': tn.armsEmb = Math.max(tn.armsEmb || 0, until); ch(v); return '';
    case 'freeze': { const amt = Math.max(0, Math.floor((tn.cash || 0) * .25)); core.finSync(null, tn); tn.cash -= amt; core.finSync(null, tn, 'council'); tn.frozen = { amt: ((tn.frozen && tn.frozen.amt) || 0) + amt, until: Math.max((tn.frozen && tn.frozen.until) || 0, until) }; ch(v); return `${WP.moneyS(amt)} of ${tn.name}'s treasury is frozen for ${R_H(p)} hours.`; }
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
        if (!c && !f) continue; core.finSync(null, d); d.cash -= c; core.finSync(null, d, 'council'); d.res.food -= f; cash += c; food += f; donors++; ch(u);
        if (S.users[u]) addNote(u, 'council', `Your nation sent ${WP.moneyS(c)} and ${f} food in humanitarian aid to ${tn.name}.`);
      }
      core.finSync(null, tn); tn.cash += cash; core.finSync(null, tn, 'council'); tn.res.food = (tn.res.food || 0) + food; tn.health = Math.min(100, (tn.health || 50) + 10); tn.stability = Math.min(100, tn.stability + 6); ch(v);
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
    case 'health': { for (const [u, n] of Object.entries(W.A)) { const c = Math.max(0, Math.floor((n.cash || 0) * .005)); core.finSync(null, n); n.cash -= c; core.finSync(null, n, 'council'); ch(u); } S.council.active.health = until; return 'Every nation contributed 0.5% of its treasury.'; }
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
    if (open().some(p => p.target === u)) continue; if (n.ai || BOTS.isBot(u)) continue; // AI nations are never put to a penalty vote
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
      persist(); councilCast();
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
const SEASON_METRICS = { score: { n: 'Score gained', title: 'Grand Strategist', fmt: v => Math.round(v).toLocaleString('en-US') }, land: { n: 'Provinces gained', title: 'Conqueror', fmt: v => (v > 0 ? '+' : '') + Math.round(v) }, gdp: { n: 'GDP growth', title: 'Tycoon', fmt: v => (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%' }, wins: { n: 'Battles won', title: 'Warlord', fmt: v => String(Math.round(v)) }, relief: { n: 'Relief sent', title: 'Philanthropist', fmt: v => '$' + Math.round(v).toLocaleString('en-US') },
  // fresh-start seasons: everyone began from nothing on the same day, so the totals themselves are fair
  final: { n: 'Final score', title: 'Grand Strategist', fresh: 1, fmt: v => Math.round(v).toLocaleString('en-US') }, prov: { n: 'Provinces held', title: 'Conqueror', fresh: 1, fmt: v => String(Math.round(v)) }, econ: { n: 'Largest economy', title: 'Tycoon', fresh: 1, fmt: v => '$' + Math.round(v).toLocaleString('en-US') }, tech: { n: 'Highest tech', title: 'Innovator', fresh: 1, fmt: v => 'Tech ' + Math.floor(v) }, power: { n: 'Military power', title: 'Supreme Commander', fresh: 1, fmt: v => Math.round(v).toLocaleString('en-US') } };
const FRESH_AWARDS = ['prov', 'econ', 'tech', 'power', 'wins', 'relief'], NORMAL_AWARDS = ['score', 'land', 'gdp', 'wins', 'relief'];
S.seasons = S.seasons || { cur: null, n: HOF.length };
S.countdown = S.countdown || null;
S.bm = S.bm && Array.isArray(S.bm.list) ? S.bm : { list: [] }; // black market listings (seller ids never leave the server)
// ---------- poker: Texas Hold'em tables where nations play each other ----------
const PK = require('./poker.js');
const PK_TABLES = [['emb1', 'Embassy Table I', 5e4, 1e5, 2e6, 1e7], ['emb2', 'Embassy Table II', 5e4, 1e5, 2e6, 1e7], ['tre1', 'Treasury Table I', 5e5, 1e6, 2e7, 1e8], ['tre2', 'Treasury Table II', 5e5, 1e6, 2e7, 1e8], ['imp1', 'Imperial Table I', 5e6, 1e7, 2e8, 1e9], ['imp2', 'Imperial Table II', 5e6, 1e7, 2e8, 1e9], ['sov1', 'Sovereign Table', 2.5e7, 5e7, 1e9, 5e9]];
S.poker = S.poker && S.poker.tables ? S.poker : { tables: {}, stats: {}, rake: 0, hands: 0 };
for (const [id, name, sb, bb, mn, mx] of PK_TABLES) { const t = S.poker.tables[id]; if (!t) S.poker.tables[id] = PK.newTable(id, name, sb, bb, mn, mx); else Object.assign(t, { name, sb, bb, min: mn, max: mx }); }
const PK_WATCH = new Map(); // uid -> { t, at }: who is looking at which table, for live updates
const pkSeatOf = uid => { for (const t of Object.values(S.poker.tables)) { const i = t.seats.findIndex(s => s && s.u === uid); if (i >= 0) return { t, i }; } return null; };
const pkCard = c => c ? { v: c.v === 14 ? 1 : c.v, s: c.s } : null;
function pkView(t, uid) {
  const H = t.hand, now = Date.now(), done = H && H.done;
  const seats = t.seats.map((s, i) => { if (!s) return null; const n = S.docs['nations/' + s.u] || {}, P = H && H.p[i] && H.p[i].u === s.u ? H.p[i] : null;
    const show = P && (s.u === uid || (done && done.shown[i])); return { u: s.u, bot: !!s.bot, name: s.bot ? s.name : n.name || (S.users[s.u] ? 'New leader' : '?'), color: s.bot ? '#6b7a8c' : n.color || '#888', stack: s.stack, sitOut: !!s.sitOut, leaving: !!s.leaving,
      inHand: !!P, folded: !!(P && P.folded), allin: !!(P && P.allin), bet: P && !done ? P.bet : 0, cards: P ? (show ? P.hole.map(pkCard) : P.folded ? [] : [null, null]) : [], won: done ? done.won[i] || 0 : 0, hand: done ? done.names[i] || null : null, last: H && !done ? (H.log.filter(x => x[0] === i).slice(-1)[0] || null) : null }; });
  const me = t.seats.findIndex(s => s && s.u === uid), L = me >= 0 ? PK.legal(t, me) : null;
  return { id: t.id, name: t.name, sb: t.sb, bb: t.bb, min: t.min, max: t.max, btn: t.btn, seats, me, board: H ? H.board.map(pkCard) : [], pot: H ? PK.potTotal(H) : 0, street: H ? (done ? 'done' : H.street) : null, toAct: H && !done ? H.toAct : -1, deadline: H && !done ? H.deadline : 0, now,
    legal: L, no: H ? H.no : t.handNo, result: done ? { pot: done.pot, rake: done.rake, ranOut: !!H.ranOut } : null, next: !H || done ? t.next : 0, hist: t.hist.slice(0, 8).map(h => ({ ...h, board: h.board.map(pkCard), win: h.win.map(w => ({ ...w, name: pkName(w.u) })), shown: Object.fromEntries(Object.entries(h.shown).map(([u, c]) => [pkName(u), c.map(pkCard)])) })) };
}
function pkLobby(uid) { const mine = pkSeatOf(uid); return { tables: Object.values(S.poker.tables).map(t => ({ id: t.id, name: t.name, sb: t.sb, bb: t.bb, min: t.min, max: t.max, seated: t.seats.filter(Boolean).length, seats: PK.SEATS, playing: t.hand && !t.hand.done ? Object.keys(t.hand.p).length : 0, pot: t.hand && !t.hand.done ? PK.potTotal(t.hand) : 0 })), mine: mine ? mine.t.id : null, stats: S.poker.stats[uid] || { hands: 0, won: 0, net: 0 } }; }
const pkName = u => String(u).startsWith('house:') ? PK_HOUSE[+String(u).split(':')[2] % PK_HOUSE.length] + ' (house)' : (S.docs['nations/' + u] || {}).name || '?';
// house players: computer opponents that fill empty seats, so one player at a table always has a game. They play with the house's chips:
// what they win is gone, what they lose is paid by the house. They leave when no player is seated.
const PK_HOUSE = ['The Ambassador', 'The Banker', 'The General', 'The Envoy', 'The Admiral', 'The Senator'];
function pkHouse(t, now) { let ch = false; const idle = !t.hand || t.hand.done, bots = t.seats.filter(s => s && s.bot).length, humans = t.seats.filter(s => s && !s.bot && !s.leaving && !s.sitOut).length;
  if (idle) {
    if (!humans && bots) { for (let i = 0; i < t.seats.length; i++) if (t.seats[i] && t.seats[i].bot) { t.seats[i] = null; ch = true; } }
    else if (humans && humans + bots < 3) { const i = t.seats.findIndex(s => !s); if (i >= 0) { t.seats[i] = { u: 'house:' + t.id + ':' + i, bot: true, name: PK_HOUSE[i % PK_HOUSE.length] + ' (house)', stack: Math.min(t.max, t.min * 3), sitOut: false, missed: 0, joined: now }; ch = true; if (now >= t.next - 500) t.next = now + 2500; } }
    for (const s of t.seats) if (s && s.bot) { if (s.stack < t.bb * 15) { s.stack = Math.min(t.max, t.min * 3); ch = true; } s.sitOut = false; s.missed = 0; } }
  const H = t.hand; if (H && !H.done && H.toAct >= 0 && t.seats[H.toAct] && t.seats[H.toAct].bot) { const i = H.toAct, key = i + ':' + H.log.length + ':' + H.street;
    if (H.botK !== key) { H.botK = key; H.botAt = now + 1200 + Math.random() * 2200; }
    else if (now >= H.botAt) { try { pkBotAct(t, i, now); } catch (e) { try { PK.act(t, i, 'fold', 0, now); } catch (x) {} } ch = true; } }
  return ch; }
function pkBotAct(t, i, now) { const H = t.hand, L = PK.legal(t, i), P = H.p[i], s = t.seats[i], r = Math.random(); if (!L) return;
  const a = P.hole[0], b = P.hole[1], hi = Math.max(a.v, b.v), lo = Math.min(a.v, b.v); let st;
  if (H.board.length < 3) st = a.v === b.v ? .55 + hi / 14 * .45 : (hi + lo) / 28 * .55 + (a.s === b.s ? .08 : 0) + (hi - lo <= 2 ? .06 : 0) + (hi >= 13 ? .12 : 0);
  else { const rk = PK.best([...P.hole, ...H.board]), cat = rk[0], bd = PK.best(H.board.length >= 5 ? H.board : [...H.board, { v: 0, s: 'x' }, { v: -1, s: 'y' }].slice(0, 5))[0];
    st = [.12, .42, .68, .8, .88, .92, .96, .99, 1][cat] || .1; if (cat === bd) st -= .25; /* the board itself makes that hand: no real strength */ if (cat === 1 && hi >= 12) st += .08; if (cat === 0 && hi >= 13) st += .1; }
  const odds = L.toCall / Math.max(1, L.pot + L.toCall), raiseTo = f => Math.max(L.minTo, Math.min(L.maxTo, Math.floor((L.curBet + Math.max(t.bb, L.pot * f)) / t.sb) * t.sb));
  if (L.check) { if (L.canRaise && ((st > .7 && r < .75) || (st > .45 && r < .3) || r < .06)) return PK.act(t, i, 'raise', raiseTo(st > .7 ? .6 : .4), now); return PK.act(t, i, 'check', 0, now); }
  if (st > .86 && L.canRaise && r < .6) return PK.act(t, i, 'raise', raiseTo(.8), now);
  if (L.toCall > s.stack * .5 && st < .8) return PK.act(t, i, 'fold', 0, now);
  if (st > odds + .14 || (L.toCall <= t.bb && st > .22) || (r < .04 && L.toCall <= L.pot * .5)) return PK.act(t, i, 'call', 0, now);
  return PK.act(t, i, 'fold', 0, now); }
const pkTimers = {};
function pkPush(t) { if (pkTimers[t.id]) return; pkTimers[t.id] = setTimeout(() => { delete pkTimers[t.id]; const now = Date.now(), to = new Set(t.seats.filter(Boolean).map(s => s.u)); for (const [u, w] of PK_WATCH) if (w.t === t.id && now - w.at < 90e3) to.add(u); for (const u of to) sendTo(u, 'poker', { t: t.id, v: pkView(t, u) }); }, 40); }
// chips go back to the nation's treasury
function pkCashOut(t, i, why) { const s = t.seats[i]; if (!s) return 0; const amt = s.stack; s.stack = 0; const n = S.docs['nations/' + s.u]; if (n && amt > 0) { core.finSync(null, n); n.cash = (n.cash || 0) + amt; core.finSync(null, n, 'casino'); setDoc('nations', s.u, n); } if (why && !s.bot) addNote(s.u, 'diplo', `🃏 ${why}: ${WP.moneyS(amt)} from your chips went back to your treasury.`); return amt; }
function pkStand(t, i, why) { const s = t.seats[i]; if (!s) return; const H = t.hand, live = H && !H.done && H.p[i] && !H.p[i].folded;
  if (live && !H.p[i].allin) PK.foldOut(t, i, Date.now());
  pkCashOut(t, i, why); if (H && !H.done && H.p[i] && !H.p[i].folded) s.leaving = true; else t.seats[i] = null; }
function pkStandUser(uid, why) { const m = pkSeatOf(uid); if (m) { pkStand(m.t, m.i, why); pkPush(m.t); persist(); } }
// before the world is switched or rewound, every chip goes home and every hand stops
function pkCashAll(why) { for (const t of Object.values(S.poker.tables)) { const H = t.hand; if (H && !H.done) for (const [i, P] of Object.entries(H.p)) { const s = t.seats[i]; if (s) s.stack += P.total; } t.hand = null; for (let i = 0; i < t.seats.length; i++) if (t.seats[i]) { pkCashOut(t, i, why); t.seats[i] = null; } pkPush(t); } persist(); }
function pkStats(H) { if (!H || !H.done || H.counted) return; H.counted = true; S.poker.hands++; S.poker.rake += H.done.rake || 0; for (const [u, net] of Object.entries(H.done.net)) { if (String(u).startsWith('house:')) continue; const st = S.poker.stats[u] = S.poker.stats[u] || { hands: 0, won: 0, net: 0 }; st.hands++; if (net > 0) st.won++; st.net += net; } }
setInterval(() => { const now = Date.now();
  for (const t of Object.values(S.poker.tables)) { let ch = false;
    try { if (pkHouse(t, now)) ch = true; } catch (e) { logErr('poker house: ' + e.message); }
    try { if (PK.tick(t, now)) ch = true; } catch (e) { logErr('poker tick: ' + e.message); }
    if (t.hand && t.hand.done && !t.hand.counted) { pkStats(t.hand); ch = true; }
    if (!t.hand || t.hand.done) for (let i = 0; i < t.seats.length; i++) { const s = t.seats[i]; if (!s) continue;
      if (s.leaving) { pkCashOut(t, i, null); t.seats[i] = null; ch = true; continue; }
      if (s.bot) continue;
      if (!S.docs['nations/' + s.u]) { t.seats[i] = null; ch = true; continue; }
      if (s.sitOut) { s.outSince = s.outSince || now; if (now - s.outSince > 10 * 60e3) { pkCashOut(t, i, `You were away from ${t.name} for 10 minutes and were stood up`); t.seats[i] = null; ch = true; } } else s.outSince = 0; }
    if (ch) { pkPush(t); persist(); } }
  for (const [u, w] of PK_WATCH) if (now - w.at > 120e3) PK_WATCH.delete(u);
}, 500).unref();
async function pokerRoute(p, req, res, me) {
  const url = new URL(req.url, 'http://x'), now = Date.now();
  if (req.method === 'GET') { const tid = url.searchParams.get('t'), t = tid && Object.prototype.hasOwnProperty.call(S.poker.tables, tid) ? S.poker.tables[tid] : null; if (t) PK_WATCH.set(me.id, { t: t.id, at: now }); else PK_WATCH.delete(me.id); return send(res, 200, { lobby: pkLobby(me.id), table: t ? pkView(t, me.id) : null }); }
  if (limited('poker:' + me.id, 40, 10e3)) return send(res, 429, { error: 'Slow down a little.' });
  const b = await readBody(req, 1024), op = String(b.op || ''), tid = String(b.t || ''), t = Object.prototype.hasOwnProperty.call(S.poker.tables, tid) ? S.poker.tables[tid] : null;
  if (!t) return send(res, 404, { error: 'That table does not exist.' });
  const n = S.docs['nations/' + me.id], mine = pkSeatOf(me.id), i = mine && mine.t === t ? mine.i : -1, fail_ = (m, c = 400) => send(res, c, { error: m });
  const done = () => { pkPush(t); persist(); return send(res, 200, { lobby: pkLobby(me.id), table: pkView(t, me.id) }); };
  switch (op) {
    case 'sit': {
      if (!n) return fail_('Found a nation first.'); if (mine) return fail_(mine.t === t ? 'You are already at this table.' : `You are already sitting at ${mine.t.name}. Leave it first.`);
      if (S.users[me.id] && S.users[me.id].banned) return fail_('Your account is suspended.');
      const seat = Math.floor(+b.seat), buy = Math.floor(+b.buy); if (!(seat >= 0 && seat < PK.SEATS) || t.seats[seat]) return fail_('That seat is taken. Pick another.');
      if (!(buy >= t.min && buy <= t.max)) return fail_(`The buy-in at this table is ${WP.moneyS(t.min)} to ${WP.moneyS(t.max)}.`);
      if ((n.cash || 0) < buy) return fail_('You do not have that much in your treasury.');
      const mate = t.seats.find(s => s && sharesNetwork(me.id, s.u)); if (mate) return fail_('Someone on your network is already at this table. Friends on the same connection cannot play at the same table.');
      core.finSync(null, n); n.cash -= buy; core.finSync(null, n, 'casino'); setDoc('nations', me.id, n); t.seats[seat] = { u: me.id, stack: buy, sitOut: false, missed: 0, joined: now };
      if (!t.hand && t.next < now + 2500) t.next = now + 2500; return done(); }
    case 'act': { if (i < 0) return fail_('You are not at this table.'); try { PK.act(t, i, String(b.a), b.amt, now); t.seats[i].missed = 0; } catch (e) { return fail_(e.message); } return done(); }
    case 'leave': { if (i < 0) return fail_('You are not at this table.'); pkStand(t, i, null); return done(); }
    case 'topup': { if (i < 0) return fail_('You are not at this table.'); const s = t.seats[i], H = t.hand; if (H && !H.done && H.p[i] && !H.p[i].folded) return fail_('Add chips between hands.');
      const amt = Math.floor(+b.amt); if (!(amt > 0)) return fail_('Enter an amount.'); if (s.stack + amt > t.max) return fail_(`You can have at most ${WP.moneyS(t.max)} at this table.`); if ((n.cash || 0) < amt) return fail_('You do not have that much in your treasury.');
      core.finSync(null, n); n.cash -= amt; core.finSync(null, n, 'casino'); setDoc('nations', me.id, n); s.stack += amt; return done(); }
    case 'sitout': { if (i < 0) return fail_('You are not at this table.'); const s = t.seats[i]; if (b.on) s.sitOut = true; else { if (s.stack < t.bb) return fail_('Add chips first: you need at least the big blind.'); s.sitOut = false; s.missed = 0; s.outSince = 0; if (!t.hand && t.next < now + 2500) t.next = now + 2500; } return done(); }
    default: return fail_('Unknown poker action.');
  }
}
setTimeout(() => { try { blocRepair(); } catch (e) { console.error('blocRepair', e); } }, 0); // admin countdown banner: { id, text, at } shown to every player until 2 hours after it reaches zero
if (S.seasons.n < HOF.length) S.seasons.n = HOF.length;
function seasonVal(W, se, u, m) { const n = W.A[u]; if (!n) return 0; const b = se.base[u] || { score: 0, prov: 0, gdp: n.gdp || 0 }; const ss = n.ss && n.ss.id === se.id ? n.ss : {};
  const sc = (se.start || 0) < core.FAIR_FROM ? core.oldScore(W, u) : core.score(W, u); // a season that began under the old scoring is finished under it
  if (m === 'score') return sc - b.score; if (m === 'land') return core.hexesOf(W, u).length - b.prov; if (m === 'gdp') return b.gdp > 0 ? (n.gdp || 0) / b.gdp - 1 : 0; if (m === 'wins') return ss.wins || 0; if (m === 'relief') return ss.relief || 0;
  if (m === 'final') return sc; if (m === 'prov') return core.hexesOf(W, u).length; if (m === 'econ') return n.gdp || 0; if (m === 'tech') return n.tech || 0; if (m === 'power') return core.power(W, u); return 0; }
function seasonEligible(W, se, u) { const n = W.A[u]; if (!n) return false; if (n.ai && n.ai.boss) return false; return se.who === 'all' || !n.ai; }
function seasonTable(W, se, m, max) { m = m || se.metric; return Object.keys(W.A).filter(u => seasonEligible(W, se, u)).map(u => ({ u, v: seasonVal(W, se, u, m) })).sort((a, b) => b.v - a.v).slice(0, max || 1e9); }
function seasonView(W, se, uid) { if (!se) return null; const live = se.status === 'live', t = live ? seasonTable(W, se) : [], M = SEASON_METRICS[se.metric]; const row = (x, i) => ({ r: i + 1, name: W.A[x.u].name, color: W.A[x.u].color, ai: !!W.A[x.u].ai, v: x.v, f: M.fmt(x.v), me: x.u === uid });
  const mi = t.findIndex(x => x.u === uid);
  return { id: se.id, n: se.n, name: se.name, msg: se.msg || '', status: se.status, start: se.start, end: se.end, metric: se.metric, metricName: M.n, who: se.who, prizes: se.prizes, xp: se.xp, cats: se.cats, top: t.slice(0, 20).map(row), me: mi >= 0 ? row(t[mi], mi) : null, count: t.length }; }
function seasonBegin(W) { S.finaleLast = null; /* the replay of the last finale is only shown until the next season starts */ const se = S.seasons.cur; if (se.fresh && !S.fresh) { try { freshBegin(W, se); } catch (e) { logErr('Fresh season could not start: ' + (e.stack || e)); se.status = 'failed'; se.err = String(e.message || e); persist(true); return; } }
  se.status = 'live'; se.start = Date.now(); se.base = {};
  if (S.mkt && S.mkt.on && !se.fresh) { S.mkt.stock = null; S.mkt.hist = []; } // every season starts with a freshly primed world market
  if (S.countdown) { audit('System', 'Removed the countdown banner', 'the season has started'); S.countdown = null; } // the "starts in" banner must not keep counting once the season is on
  for (const u of Object.keys(W.A)) se.base[u] = { score: core.score(W, u), prov: core.hexesOf(W, u).length, gdp: W.A[u].gdp || 0 };
  const t = se.fresh ? `🏆 ${se.name} has begun! Everyone starts fresh in a brand-new world: found your season nation now. Your real nation is saved and comes back${se.end ? ` on ${new Date(se.end).toUTCString().slice(0, 22)} UTC` : ' when the season ends'}, with your prizes.` : `🏆 ${se.name} has begun! Nations are ranked by ${SEASON_METRICS[se.metric].n.toLowerCase()}${se.end ? ` until ${new Date(se.end).toUTCString().slice(0, 22)} UTC` : ''}.${se.prizes && se.prizes[0] ? ` The champion wins $${Math.round(se.prizes[0]).toLocaleString('en-US')}.` : ''} See Rankings for the live standings.`;
  if (se.announce) { systemMessage(t); broadcast('announce', { text: t }); }
  persist(); broadcast('config', effCfg()); }
function seasonFinish(W, by) { const se = S.seasons.cur; if (!se || se.status !== 'live') return null; if (se.fresh) return seasonFinishFresh(W, by); const M = SEASON_METRICS[se.metric], table = seasonTable(W, se), now = Date.now();
  const pick = x => { const n = W.A[x.u]; return { name: n.name, leader: n.ai ? 'AI' : '', color: n.color, flag: n.flag || null, ai: !!n.ai, value: x.v, shown: M.fmt(x.v) }; };
  const ranked = table.filter(x => x.v > 0 || se.metric === 'gdp'), top = ranked.slice(0, 10);
  try { const t3_ = top.slice(0, 3).map(x => W.A[x.u] && W.A[x.u].name).filter(Boolean); broadcast('finaleEnd', { name: se.name, top: t3_ }); if (S.finaleLast) S.finaleLast.top = t3_; } catch (e) {}
  const cats = (se.cats || []).filter(k => SEASON_METRICS[k] && k !== se.metric).map(k => { const best = seasonTable(W, se, k, 1)[0]; return best && best.v > 0 ? { k, award: SEASON_METRICS[k].title, metric: SEASON_METRICS[k].n, ...pick(best), shown: SEASON_METRICS[k].fmt(best.v), u: best.u } : null; }).filter(Boolean);
  // prizes for the top 10, permanent titles and badges, and a badge for everyone who took part
  const ord = i => ['1st', '2nd', '3rd'][i] || `${i + 1}th`, place = ['Champion', '2nd place', '3rd place'];
  const badge = (n, b) => { n.badges = [...(n.badges || []).filter(x => !(x.s === se.n && x.k === b.k && x.t === b.t)), { s: se.n, ...b }].slice(-60); };
  top.slice(0, 10).forEach((x, i) => { const n = W.A[x.u]; if (!n) return; const cash = Math.max(0, +((se.prizes || [])[i]) || 0), xp = Math.max(0, +((se.xp || [])[i]) || 0); if (cash) { core.finSync(W, n); n.cash += cash; core.finSync(W, n, 'rewards'); } if (xp) n.xp = (n.xp || 0) + xp;
    if (se.titles !== false && i < 3) n.titles = [...(n.titles || []), { s: se.n, t: `${se.name} ${place[i]}`, r: i + 1 }].slice(-30);
    badge(n, i === 0 ? { k: 'champion', ic: '🏆', t: `${se.name} Champion` } : i === 1 ? { k: 'second', ic: '🥈', t: `${se.name} 2nd place` } : i === 2 ? { k: 'third', ic: '🥉', t: `${se.name} 3rd place` } : { k: 'top10', ic: '🎖', t: `${se.name} top 10 (${ord(i)})` });
    n.log = [{ t: now, x: `🏆 ${se.name} is over: you finished ${ord(i)}!${cash ? ` Prize: $${Math.round(cash).toLocaleString('en-US')}.` : ''}${xp ? ` +${xp} XP.` : ''}${i === 0 ? ' You can now use the champion\'s gold flag frame and the champion map colours (Government page → Flag).' : ''}` }, ...(n.log || [])].slice(0, 120); W.changed.add(x.u);
    if (S.users[x.u]) addNote(x.u, 'event', `🏆 ${se.name}: you finished ${ord(i)}!${cash ? ` +$${Math.round(cash).toLocaleString('en-US')}` : ''}${xp ? ` +${xp} XP` : ''}${i === 0 ? '. Champion rewards unlocked: gold flag frame and champion map colours.' : '.'}`); });
  for (const c of cats) { const n = W.A[c.u]; if (!n) continue; if (se.titles !== false) n.titles = [...(n.titles || []), { s: se.n, t: `${c.award} of ${se.name}` }].slice(-30); badge(n, { k: 'award', ic: '🏅', t: `${c.award} of ${se.name}` });
    const aw = (se.award || {})[c.k] || {}; if (aw.cash) { core.finSync(W, n); n.cash += aw.cash; core.finSync(W, n, 'rewards'); } if (aw.xp) n.xp = (n.xp || 0) + aw.xp; if ((aw.cash || aw.xp) && S.users[c.u]) addNote(c.u, 'event', `🏅 ${c.award} of ${se.name}!${aw.cash ? ` +$${Math.round(aw.cash).toLocaleString('en-US')}` : ''}${aw.xp ? ` +${aw.xp} XP` : ''}`); W.changed.add(c.u); }
  // everyone who played during the season gets the participation badge
  let veterans = 0; for (const u of Object.keys(W.A)) { const n = W.A[u]; if (!seasonEligible(W, se, u) || n.ai || !S.users[u]) continue; if (((S.meta[u] || {}).lastSeen || 0) < se.start) continue; badge(n, { k: 'played', ic: '🎗', t: `Played ${se.name}` }); veterans++; W.changed.add(u); }
  const entry = { season: se.n, name: se.name, start: se.start, end: now, metric: se.metric, metricName: M.n, who: se.who, champion: top[0] ? pick(top[0]) : null, top: top.map((x, i) => ({ r: i + 1, ...pick(x) })), awards: cats.map(({ u, ...c }) => c), players: table.length, veterans, prizes: (se.prizes || []).slice(0, 10), recorded: now };
  try { fs.appendFileSync(HOF_FILE, JSON.stringify(entry) + '\n'); } catch (e) { logErr('Could not write the Hall of Fame: ' + e.message); }
  HOF.push(Object.freeze(entry)); S.seasons.cur = null; audit(by || 'System', 'Season ended', se.name);
  const t = top[0] ? `🏆 ${se.name} is over! Champion: ${top[0] && W.A[top[0].u].name} (${M.fmt(top[0].v)}).${top[1] ? ` 2nd: ${W.A[top[1].u].name}.` : ''}${top[2] ? ` 3rd: ${W.A[top[2].u].name}.` : ''} They're now in the Hall of Fame forever.` : `${se.name} is over. No nation qualified this time.`;
  if (se.announce) { systemMessage(t); broadcast('announce', { text: t }); }
  persist(); broadcast('config', effCfg()); return entry; }
let SW = null; const seasonW = () => { if (!SW || Date.now() - SW.t > 15e3) SW = { t: Date.now(), W: mkWorld() }; return SW.W; };
function seasonTick(W) { const se = S.seasons.cur; if (!se) return; const now = Date.now();
  if (se.status === 'scheduled' && now >= se.start) seasonBegin(W);
  else if (se.status === 'failed') return;
  else if (se.status === 'live') { for (const u of Object.keys(W.A)) if (!se.base[u]) se.base[u] = { score: core.score(W, u), prov: core.hexesOf(W, u).length, gdp: W.A[u].gdp || 0 }; // nations founded mid-season start from zero
    if (se.end && now >= se.end) seasonFinish(W); } }

// ---------- SPY MINI-GAMES ----------
// "Crack the treasury vault" and "Intercept and decode" are played, not rolled. Starting one pays the cost and starts the cooldown at once
// (so a bad game cannot be retried for free). The server keeps the answer, scores what the player sends back (0 to 1) and rolls the
// result with odds set mostly by that score. A game left unfinished counts as a score of 0 after 3 minutes.
const SPYG = new Map(); const SPY_TTL = 3 * 60e3;
const spyOptList = () => Object.keys(S.meta).filter(u => S.meta[u] && S.meta[u].prefs && S.meta[u].prefs.spygames === false);
const MG = require('./minigames.js'); // puzzle generation and scoring for the duel mini-games (seeded, so two players or a ghost get the same puzzle)
const mgSeed = () => crypto.randomInt(1, 2147483647);
const mgLvl = l => MG.LVLS.includes(l) ? l : 'medium';
function spyPuzzle(op, lvl, seed) { return MG.make(op, mgLvl(lvl), seed); }
function spyScore(g, b, t0) { return MG.score(g.op, g.secret, b, (Date.now() - (t0 || g.t0)) / 1000); }
// ---------- DUEL RATINGS, GHOSTS ----------
// Ratings: every player starts at 1000 in each game and gains or loses points in live duels and ghost duels (Elo). The same two players
// only move each other's rating three times a day. Ghosts: every honest scored run is kept (as a seed and a score), so anyone can race it later.
S.duels = S.duels && typeof S.duels === 'object' ? S.duels : {}; S.ghosts = S.ghosts && typeof S.ghosts === 'object' ? S.ghosts : {}; S.ghostSeen = S.ghostSeen && typeof S.ghostSeen === 'object' ? S.ghostSeen : {};
const duelRec = u => S.duels[u] || (S.duels[u] = { r: {}, w: {}, l: {} });
const duelR = (u, op) => (S.duels[u] && S.duels[u].r[op]) || 1000;
function duelsView() { const o = {}; for (const [u, d] of Object.entries(S.duels)) if (S.docs['nations/' + u]) o[u] = { r: d.r, w: d.w, l: d.l }; return o; }
let duelsDirty = false; setInterval(() => { if (duelsDirty) { duelsDirty = false; try { broadcast('duels', duelsView()); } catch (e) {} } }, 3000).unref();
function duelRate(a, b, op, res, K, oneSided) { // res: 1 = a won, 0 = a lost, .5 = tie. b may be a ghost owner (oneSided: only a moves)
  const ra = duelR(a, op), rb = b && S.duels[b] ? duelR(b, op) : 1000, ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const A_ = duelRec(a); A_.r[op] = Math.round(ra + K * (res - ea)); if (res === 1) A_.w[op] = (A_.w[op] || 0) + 1; else if (res === 0) A_.l[op] = (A_.l[op] || 0) + 1;
  if (!oneSided && b) { const B_ = duelRec(b); B_.r[op] = Math.round(rb + K * ((1 - res) - (1 - ea))); if (res === 0) B_.w[op] = (B_.w[op] || 0) + 1; else if (res === 1) B_.l[op] = (B_.l[op] || 0) + 1; }
  duelsDirty = true; persist(); return { before: ra, after: A_.r[op] }; }
function duelPairOk(a, b) { const day = Math.floor(Date.now() / 864e5), A_ = duelRec(a); if (!A_.d || A_.d.day !== day) A_.d = { day, p: {} }; if ((A_.d.p[b] || 0) >= 3) return false; A_.d.p[b] = (A_.d.p[b] || 0) + 1; const B_ = duelRec(b); if (!B_.d || B_.d.day !== day) B_.d = { day, p: {} }; B_.d.p[a] = (B_.d.p[a] || 0) + 1; return true; }
const ghostKey = (op, lvl) => op + ':' + lvl;
function ghostSave(u, op, lvl, seed, sc) { if (!(sc.skill >= .3) || !S.users[u] || BOTS.isBot(u)) return; const k = ghostKey(op, lvl), L = S.ghosts[k] || (S.ghosts[k] = []); if (L.some(x => x.seed === seed && x.u === u)) return; L.unshift({ seed, skill: Math.round(sc.skill * 1000) / 1000, why: String(sc.why || '').slice(0, 120), u, t: Date.now() }); S.ghosts[k] = L.slice(0, 16); const seen = S.ghostSeen[u] || (S.ghostSeen[u] = []); seen.unshift(seed); S.ghostSeen[u] = seen.slice(0, 300); }
function ghostPick(u, op, lvl) { const seen = new Set(S.ghostSeen[u] || []), L = (S.ghosts[ghostKey(op, lvl)] || []).filter(x => x.u !== u && S.docs['nations/' + x.u] && !sharesNetwork(u, x.u) && !seen.has(x.seed));
  if (L.length) { const x = L[crypto.randomInt(0, L.length)]; return { seed: x.seed, skill: x.skill, why: x.why, u: x.u, name: (S.docs['nations/' + x.u] || {}).name || 'A rival', leader: null }; }
  return { seed: mgSeed(), skill: Math.round((.42 + crypto.randomInt(0, 2600) / 10000) * 1000) / 1000, why: '', u: null, name: 'Academy instructor', leader: null, house: true }; }
const MGM = v => '$' + Math.round(v).toLocaleString('en-US');
const mgName = u => (S.docs['nations/' + u] || {}).name || 'They';
// settle one finished round. mode: 'solo' (the opponent never played), 'win' / 'lose' / 'tie' against a live opponent, 'gwin' / 'glose' / 'gtie' against a ghost.
// A friendly round moves ratings only: no fee was taken and nothing is paid.
function spyResolve(uid, g, sc, mode) {
  const W = mkWorld(), N = WP.COVERT[g.op].n, opp = g.ghost ? (g.ghost.house ? 'the Academy instructor' : `${g.ghost.name}'s ghost`) : mgName(g.v), need = core.MGAME.need; let r;
  const pay = floor => g.friendly ? { won: 0, xp: 0 } : core.mgPay(W, uid, g.op, g.prize || 0, sc.skill, floor), got = p_ => p_.won ? ` You won ${MGM(p_.won)}${p_.xp ? ` and ${p_.xp} experience` : ''}.` : '';
  if (mode === 'solo') { const p_ = pay(0); r = { ok: p_.won > 0 || (g.friendly && sc.skill >= need), won: p_.won, xp: p_.xp, msg: `${opp} did not play, so you played alone.${g.friendly ? ' It was a friendly round.' : p_.won ? got(p_) : ' You needed a score of 30 or more to win a prize.'}` }; }
  else if (mode === 'win' || mode === 'gwin') { const p_ = pay(sc.skill >= need ? .5 : 0); r = { ok: true, won: p_.won, xp: p_.xp, msg: `You beat ${opp}.${g.friendly ? ' It was a friendly round, so there is no prize.' : p_.won ? got(p_) : ' A score of 30 or more is needed to win a prize.'}` }; }
  else if (mode === 'tie' || mode === 'gtie') r = { ok: false, won: 0, xp: 0, msg: `You and ${opp} tied${g.friendly ? '.' : ', so nobody wins the prize.'}` };
  else if (mode === 'glose') r = { ok: false, won: 0, xp: 0, msg: `${opp} beat your score.${g.friendly ? '' : ' You win nothing this time.'}` };
  else { const dsk = (g.duel && g.duel.score && g.duel.score.skill) || 0; g.defWon = !g.friendly && W.A[g.v] && dsk >= need ? core.mgPay(W, g.v, g.op, core.mgPrize(W, g.v, g.op, g.lvl || 'medium'), dsk, .5) : { won: 0, xp: 0 }; r = { ok: false, won: 0, xp: 0, msg: `${opp} beat your score.${g.friendly ? '' : ' You win nothing this time.'}` }; }
  commit(W); return r; }
// SPY DUELS: a challenge goes to a player who is online; if they accept, both play the same puzzle at the same time and the better score wins.
const DUEL_ANSWER = 20e3, SPYR = new Map(), DUELBY = new Map(); const SPYPR = new Map(); // practice rounds, one per player
// a duel against a player who is online waits for them to accept: 30 seconds, then it is called off (and costs the challenger nothing)
const DUEL_WAIT = 30e3, SPYP = new Map(); // invite id -> { by, v, op, lvl, friendly, at }
const spyPubOf = g => g.pub || null;
const spyOnline = v => [...clients].some(c => c.uid === v) && S.users[v] && !BOTS.isBot(v);
function spyCallOff(id, why) { const P = SPYP.get(id); if (!P) return; SPYP.delete(id); sendTo(P.by, 'spyno', { id, msg: why }); sendTo(P.v, 'spyduelgone', { id }); }
setInterval(() => { const now = Date.now(); for (const [id, P] of SPYP) if (now - P.at > DUEL_WAIT) spyCallOff(id, `${(S.docs['nations/' + P.v] || {}).name || 'They'} did not accept within 30 seconds. The challenge was called off and cost you nothing.`); }, 2000).unref();
const duelNames = MG.DUEL_NAMES;
const mgOut = (uid, g, sc, r) => ({ ok: true, success: !!r.ok, msg: r.msg, score: Math.round(sc.skill * 100), why: sc.why, won: r.won || 0, friendly: !!g.friendly, duel: r.duel || null, rating: r.rating || null, op: g.op, lvl: g.lvl, v: g.ghost ? 'ghost' : g.v, ...MG.reveal(g.op, g.secret), own: S.docs['nations/' + uid] });
function duelSettle(uid, g) { // both scores are in (or the other player never showed up): decide and tell both sides
  const att = g.attScore, def = g.duel && g.duel.score; let r;
  ghostSave(uid, g.op, g.lvl, g.seed, att);
  if (def && g.duel.state === 'done') { const tie = Math.round(att.skill * 100) === Math.round(def.skill * 100), won = !tie && att.skill > def.skill; ghostSave(g.v, g.op, g.lvl, g.seed, def);
    r = spyResolve(uid, g, att, tie ? 'tie' : won ? 'win' : 'lose'); const rated = duelPairOk(uid, g.v), rt = rated ? duelRate(uid, g.v, g.op, tie ? .5 : won ? 1 : 0, 24) : null;
    const cn = mgName(uid), a100 = Math.round(att.skill * 100), d100 = Math.round(def.skill * 100), dw = g.defWon || { won: 0, xp: 0 }, dr = rated ? duelR(g.v, g.op) : null;
    sendTo(g.v, 'spyduelres', { win: !won && !tie, own: S.docs['nations/' + g.v], op: g.op, lvl: g.lvl, v: uid, you: d100, them: a100, rating: dr,
      msg: won ? `${cn} won the duel (their score ${a100}, yours ${d100}). It cost you nothing.` : tie ? `You tied with ${cn} (${d100} each)${g.friendly ? '.' : ', so nobody wins the prize.'}` : `You won the duel against ${cn}! Your score ${d100} beat theirs (${a100}).${g.friendly ? ' It was a friendly round.' : dw.won ? ` Prize: ${MGM(dw.won)}${dw.xp ? ` and ${dw.xp} experience` : ''}.` : ' A score of 30 or more is needed to win a prize.'}` });
    r.duel = { you: a100, them: d100, won, tie, name: mgName(g.v) }; if (rt) r.rating = rt; }
  else r = spyResolve(uid, g, att, 'solo');
  DUELBY.delete(g.id); SPYG.delete(uid); SPYR.set(uid, { id: g.id, at: Date.now(), out: mgOut(uid, g, att, r) }); }
function ghostSettle(uid, g, sc) { const gh = g.ghost, a100 = Math.round(sc.skill * 100), g100 = Math.round(gh.skill * 100), tie = a100 === g100, won = !tie && sc.skill > gh.skill;
  ghostSave(uid, g.op, g.lvl, g.seed, sc); { const seen = S.ghostSeen[uid] || (S.ghostSeen[uid] = []); if (!seen.includes(g.seed)) { seen.unshift(g.seed); S.ghostSeen[uid] = seen.slice(0, 300); } }
  const r = spyResolve(uid, g, sc, tie ? 'gtie' : won ? 'gwin' : 'glose'); r.rating = duelRate(uid, gh.u, g.op, tie ? .5 : won ? 1 : 0, 12, true);
  r.duel = { you: a100, them: g100, won, tie, name: gh.house ? 'Academy instructor' : `${gh.name}'s ghost`, ghost: true };
  if (gh.u && won === false && !tie && S.users[gh.u] && limited('ghostnote:' + gh.u, 3, 6 * HOUR) === false) addNote(gh.u, 'covert', `Your ghost beat ${mgName(uid)} at ${WP.COVERT[g.op].n} (${g100} to ${a100}).`);
  SPYG.delete(uid); return mgOut(uid, g, sc, r); }
setInterval(() => { const now = Date.now(); for (const [uid, g] of SPYG) { if (!g.attScore) continue; const d = g.duel; if (!d) continue;
    if (d.state === 'invited' && now - d.at > DUEL_ANSWER) { d.state = 'gone'; duelSettle(uid, g); } else if (d.state === 'playing' && now - d.t0 > (g.pubTime + 8) * 1000) { d.state = 'gone'; duelSettle(uid, g); } }
  for (const [u, x] of SPYR) if (now - x.at > 10 * 60e3) SPYR.delete(u); }, 1000).unref();
setInterval(() => { const now = Date.now(); for (const [uid, g] of SPYG) if (now - g.t0 > SPY_TTL + (g.pubTime || 0) * 1000) { if (g.duel && g.duel.state === 'done' && !g.attScore) { g.attScore = { skill: 0, why: 'did not finish' }; try { duelSettle(uid, g); } catch (e) {} continue; } SPYG.delete(uid); DUELBY.delete(g.id); try { addNote(uid, 'covert', 'Your duel timed out before you finished, so it ended with no prize.'); } catch (e) {} } }, 15000).unref();
async function spyRoute(p, req, res, me) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (finaleLock()) return send(res, 423, FINALE_LOCK_MSG); { const jl = hcJail(me.id); if (jl) return send(res, 423, jl); }
  const b = await readBody(req, 8192); touch(me.id, req);
  const isOp = op => MG.OPS.includes(op), busy = () => { const old = SPYG.get(me.id); return old && Date.now() - old.t0 < SPY_TTL; };
  // PRACTICE: the same puzzles, free, against nobody. Nothing is spent, nothing happens in the world, and no cooldown starts.
  if (p === '/api/spy/practice') { if (limited('spyp:' + me.id, 12, 60e3)) return send(res, 429, { error: 'Take a short break, then practice again.' });
    const op = String(b.op || ''); if (!isOp(op)) return send(res, 400, { error: 'Unknown game.' }); const lvl = mgLvl(b.lvl);
    if (!S.docs['nations/' + me.id]) return send(res, 400, { error: 'Found a nation first.' });
    const pz = spyPuzzle(op, lvl, mgSeed()), id = rid();
    SPYPR.set(me.id, { id, op, lvl, secret: pz.secret, t0: Date.now() }); return send(res, 200, { ok: true, id, game: pz.pub, practice: true }); }
  if (p === '/api/spy/practicedone') { const g = SPYPR.get(me.id); if (!g || g.id !== String(b.id || '')) return send(res, 400, { error: 'That practice round is over.' }); SPYPR.delete(me.id);
    const sc = spyScore(g, b, g.t0); return send(res, 200, { ok: true, practice: true, score: Math.round(sc.skill * 100), why: sc.why, op: g.op, lvl: g.lvl, ...MG.reveal(g.op, g.secret) }); }
  // GHOST DUEL: race another player's recorded run of the same puzzle (or the Academy instructor when there is none you haven't seen). Half the usual prize.
  if (p === '/api/spy/ghost') { if (limited('spy:' + me.id, 8, 60e3)) return send(res, 429, { error: 'Slow down.' });
    const op = String(b.op || ''); if (!isOp(op)) return send(res, 400, { error: 'Unknown game.' }); const lvl = mgLvl(b.lvl), friendly = !!b.friendly;
    if (busy()) return send(res, 400, { error: 'Finish the game you already started first.' });
    if (prefsOf(me.id).spygames === false) return send(res, 400, { error: 'You opted out of duels. Turn them back on from your Intelligence page to play.' });
    if (!S.docs['nations/' + me.id]) return send(res, 400, { error: 'Found a nation first.' });
    { const g_ = hcGate(me.id, false); if (g_) return send(res, g_.jail ? 423 : 428, g_); }
    const W = mkWorld(); let st = { prize: 0, fee: 0 }; if (!friendly) { try { st = core.mgBegin(W, me.id, op, lvl, null, true); } catch (e) { if (e.user) return send(res, 400, { error: e.message }); throw e; } commit(W); }
    const gh = ghostPick(me.id, op, lvl), pz = spyPuzzle(op, lvl, gh.seed), id = crypto.randomBytes(6).toString('hex');
    SPYG.set(me.id, { id, op, v: null, lvl, seed: gh.seed, prize: st.prize, friendly, ghost: gh, t0: Date.now(), secret: pz.secret, pubTime: pz.pub.time, pub: pz.pub }); SPYR.delete(me.id);
    return send(res, 200, { ok: true, id, game: pz.pub, ghost: { name: gh.name, leader: gh.leader, score: Math.round(gh.skill * 100), house: !!gh.house }, friendly, prize: st.prize, own: S.docs['nations/' + me.id] }); }
  if (p === '/api/spy/start') { if (limited('spy:' + me.id, 8, 60e3)) return send(res, 429, { error: 'Slow down.' });
    const op = String(b.op || ''), v = String(b.v || ''); if (!isOp(op)) return send(res, 400, { error: 'Unknown game.' }); const lvl = mgLvl(b.lvl), friendly = !!b.friendly;
    if (busy()) return send(res, 400, { error: 'Finish the game you already started first.' });
    if (prefsOf(me.id).spygames === false) return send(res, 400, { error: 'You opted out of spy duels. Turn them back on from your Intelligence page to challenge anyone.' });
    if (S.users[v] && prefsOf(v).spygames === false) return send(res, 400, { error: `${mgName(v)} has opted out of spy duels, so you cannot challenge them.` });
    if (v === me.id || !S.docs['nations/' + v] || !S.docs['nations/' + me.id]) return send(res, 400, { error: 'Choose another nation to challenge.' });
    if (!(spyOnline(v) && Date.now() - ((S.docs['online/' + v] || {}).t || 0) < 2 * 60e3)) return send(res, 400, { error: `${mgName(v)} is not online right now. You can only challenge players who were online in the last 2 minutes. Try a ghost duel instead.` });
    if (sharesNetwork(me.id, v)) return send(res, 400, { error: 'You can\'t challenge an account on the same network as yours.' });
    { const g_ = hcGate(me.id, false); if (g_) return send(res, g_.jail ? 423 : 428, g_); }
    for (const [id, P] of SPYP) if (P.by === me.id) return send(res, 400, { error: `You are already waiting for ${mgName(P.v)} to accept.` });
    for (const [, g2] of SPYG) if (g2.v === v && g2.duel && g2.duel.state !== 'gone' && Date.now() - g2.t0 < SPY_TTL) return send(res, 400, { error: `${mgName(v)} is in another duel right now. Try again in a minute.` });
    if (limited('spyinv:' + me.id + ':' + v, 4, 5 * 60e3)) return send(res, 429, { error: 'You have challenged that nation several times just now. Try again in a few minutes.' });
    const W0 = mkWorld(); if (!friendly) { try { core.mgCheck(W0, me.id, op, v, lvl); } catch (e) { if (e.user) return send(res, 400, { error: e.message }); throw e; } }
    const id = crypto.randomBytes(6).toString('hex'); SPYP.set(id, { by: me.id, v, op, lvl, friendly, at: Date.now() });
    sendTo(v, 'spyduel', { id, op, lvl, friendly, what: duelNames[op], by: mgName(me.id), byLeader: null, prize: friendly ? 0 : core.mgPrize(W0, v, op, lvl), pending: true, answer: DUEL_WAIT });
    return send(res, 200, { ok: true, pending: true, id, wait: DUEL_WAIT, name: mgName(v) }); }
  if (p === '/api/spy/finish') { const g = SPYG.get(me.id); if (!g || g.id !== String(b.id || '')) return send(res, 400, { error: 'That game is over.' });
    if (g.attScore) return send(res, 200, { ok: true, pending: true });
    const sc0 = spyScore(g, b); try { actLog(me.id, mkWorld(), { c: 'minigame', op: g.op, lvl: g.lvl, vs: g.ghost ? 'ghost' : g.v, skill: Math.round(sc0.skill * 100) }, true, sc0.why); } catch (e) {}
    if (g.ghost) return send(res, 200, ghostSettle(me.id, g, sc0));
    g.attScore = sc0; if (!g.duel || g.duel.state === 'done' || g.duel.state === 'gone') duelSettle(me.id, g); const done = SPYR.get(me.id);
    return send(res, 200, done && done.id === g.id ? done.out : { ok: true, pending: true, score: Math.round(sc0.skill * 100), why: sc0.why }); }
  if (p === '/api/spy/result') { const x = SPYR.get(me.id); if (x && x.id === String(b.id || '')) return send(res, 200, x.out); return send(res, 200, { ok: true, pending: true }); }
  // a pending duel: the challenged player accepts or declines, the challenger can cancel or check
  if (p === '/api/spy/accept' || p === '/api/spy/decline' || p === '/api/spy/cancel' || p === '/api/spy/status') { const id = String(b.id || ''), P = SPYP.get(id);
    if (p === '/api/spy/status') { if (P && P.by === me.id) return send(res, 200, { ok: true, state: 'pending', left: Math.max(0, DUEL_WAIT - (Date.now() - P.at)) }); const g = SPYG.get(me.id); if (g && g.id === id) return send(res, 200, { ok: true, state: 'go', game: spyPubOf(g), own: S.docs['nations/' + me.id] }); return send(res, 200, { ok: true, state: 'off' }); }
    if (p === '/api/spy/cancel') { if (P && P.by === me.id) spyCallOff(id, 'You called the challenge off.'); return send(res, 200, { ok: true }); }
    if (!P || P.v !== me.id || Date.now() - P.at > DUEL_WAIT) return send(res, 400, { error: 'Too late: that challenge is over.' });
    if (p === '/api/spy/decline') { spyCallOff(id, `${mgName(me.id)} declined. The challenge was called off and cost you nothing.`); return send(res, 200, { ok: true }); }
    if (SPYG.get(me.id) && Date.now() - SPYG.get(me.id).t0 < SPY_TTL) return send(res, 400, { error: 'Finish the game you already started first.' });
    SPYP.delete(id); sendTo(P.v, 'spyduelgone', { id });
    const W = mkWorld(); let st = { prize: 0 }; if (!P.friendly) { try { st = core.mgBegin(W, P.by, P.op, P.lvl, P.v); } catch (e) { const why = e && e.user ? e.message : 'Something went wrong.'; sendTo(P.by, 'spyno', { id, msg: 'Your challenge could not start: ' + why }); return send(res, 400, { error: 'The challenge was called off.' }); } commit(W); }
    const seed = mgSeed(), pz = spyPuzzle(P.op, P.lvl, seed), now = Date.now();
    const g = { id, op: P.op, v: P.v, lvl: P.lvl, seed, prize: st.prize, friendly: !!P.friendly, t0: now, secret: pz.secret, pubTime: pz.pub.time, pub: pz.pub, duel: { state: 'playing', at: now, t0: now } }; SPYG.set(P.by, g); SPYR.delete(P.by); DUELBY.set(id, P.by);
    sendTo(P.by, 'spygo', { id, game: pz.pub, own: S.docs['nations/' + P.by] });
    return send(res, 200, { ok: true, id, game: pz.pub, op: P.op, lvl: P.lvl, friendly: !!P.friendly }); }
  // the challenged player's side of a duel
  if (p === '/api/spy/defend') { const uid = DUELBY.get(String(b.id || '')), g = uid && SPYG.get(uid); if (!g || g.v !== me.id || !g.duel) return send(res, 400, { error: 'Too late: that duel is already over.' });
    if (g.duel.state !== 'playing') return send(res, 400, { error: 'Too late: that duel is already over.' }); g.duel.score = spyScore(g, b, g.duel.t0); g.duel.state = 'done'; if (g.attScore) duelSettle(uid, g);
    return send(res, 200, { ok: true, score: Math.round(g.duel.score.skill * 100), why: g.duel.score.why, ...MG.reveal(g.op, g.secret) }); }
  return send(res, 404, { error: 'Not found.' });
}

// ---------- SEASON FINALE ----------
// A purely visual show in the last minute of a season: a countdown, then every nation with a nuclear program fires missiles at random
// targets in four waves, so the world is exploding as the season ends. Nothing in the game changes (no damage, no stats, no rogue status).
// The season then finishes on the exact second instead of at the next world update, and players see a congratulations screen before
// their page switches back to the real world.
let FIN = null, finDone = null;
function finaleBuild(se, preview) {
  const W = mkWorld(), A = W.A, end = preview ? Date.now() + 60000 : se.end;
  let shooters = Object.keys(A).filter(u => A[u] && A[u].nuke && A[u].cap != null && P_OK(A[u].cap));
  if (!shooters.length) shooters = Object.keys(A).filter(u => A[u] && A[u].cap != null).sort((a, b) => core.hexesOf(W, b).length - core.hexesOf(W, a).length).slice(0, 6); // no nuclear nations: the biggest six put on the show
  const owned = Object.keys(W.OWN).map(Number), L = [];
  for (const u of shooters) [30, 24, 18, 13].forEach((w, i) => { const pool = owned.filter(h => W.OWN[h].u !== u); if (!pool.length) return; const h = pool[Math.floor(Math.random() * pool.length)];
    L.push({ id: `fin-${se.id}-${u}-${i}`, from: A[u].cap, h, by: u, to: W.OWN[h].u, at: end - w * 1000 + Math.floor(Math.random() * 3500) }); });
  let lead = null; if (preview) { try { lead = S.seasons.cur ? seasonTable(W, S.seasons.cur).slice(0, 3).map(x => W.A[x.u] && W.A[x.u].name).filter(Boolean) : null; } catch (e) {} }
  return { id: (preview ? 'preview-' : '') + se.id, name: se.name || 'Season', end, launches: L, preview: !!preview, lead };
}
// during the finale's last minute the game is frozen: no more actions, everyone just watches the season end
const finaleLock = () => { const se = S.seasons && S.seasons.cur, now = Date.now(); return !!(se && se.status === 'live' && se.end && now >= se.end - 60000); };
const FINALE_LOCK_MSG = { error: 'The season is ending. Everything is locked while the finale plays.' };
// a player who was not online for the finale sees it once, as a replay, the next time they open the game (until the next season starts)
function finaleReplayFor(uid) { const F = S.finaleLast, now = Date.now(); if (!F || !uid || F.seen[uid] || now < F.end + 20000) return null; const u = S.users[uid]; if (!u || (u.created && u.created > F.end)) return null;
  const end = now + 62000; return { id: 'replay-' + F.id, rid: F.id, name: F.name, end, now, replay: true, top: F.top || null, launches: F.launches.map(L => ({ ...L, at: end + L.rel })) }; }
function P_OK(h) { return Number.isInteger(+h) && +h >= 0 && +h < core.P.length; }
setInterval(() => { const se = S.seasons && S.seasons.cur, now = Date.now(); if (!se || se.status !== 'live' || !se.end) return;
  if ((!FIN || FIN.id !== se.id) && now >= se.end - 60000 && now < se.end) { try { FIN = finaleBuild(se, false); broadcast('finale', { ...FIN, now }); S.finaleLast = { id: FIN.id, name: FIN.name, end: FIN.end, top: null, launches: FIN.launches.map(L => ({ ...L, rel: L.at - FIN.end })), seen: Object.fromEntries([...clients].map(c => [c.uid, 1])) }; } catch (e) { logErr('Season finale could not start: ' + (e.stack || e)); } }
  if (now >= se.end && finDone !== se.id) { finDone = se.id; if (S.finaleLast && S.finaleLast.id === se.id) for (const c of clients) S.finaleLast.seen[c.uid] = 1; try { const W = mkWorld(); seasonTick(W); W.welcome = null; commit(W); } catch (e) { logErr('Season finish at the end of the finale failed: ' + (e.stack || e)); } }
}, 1000).unref();

// ---------- FRESH-START SEASONS ----------
// The real world is saved to a file and set aside; everyone founds a new nation in an empty world for the season; when it ends,
// the real world comes back exactly as it was saved and the prizes are paid into each player's real nation.
// Accounts, chat, mail, notes, the Hall of Fame, casino records and admin data are never touched.
const FRESH_FILE = path.join(DATA_DIR, 'season-realworld.json');
const FRESH_KEYS = ['council', 'blocs', 'crisis', 'crisisHist', 'games', 'gamesHist', 'dis', 'nextGames', 'nextDis', 'nextCrisis', 'event', 'nextEvent', 'lastEventKey', 'fallen', 'nukes', 'strikes', 'strikeLog', 'ntests', 'ntestPending', 'burn', 'bm', 'freedQ', 'freedLast', 'freedAt', 'bossFell', 'bossAnn', 'bossRem', 'overPause', 'overPauseSet', 'mkt'];
function freshSave(se) {
  const nations = {}; for (const [k, v] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = v;
  const meta_ = {}; for (const [u, m] of Object.entries(S.meta)) if (m && (m.fallen || m.rem)) meta_[u] = { fallen: m.fallen || null, rem: m.rem || null };
  const snap = { v: 1, map2: !!S.map2, t: Date.now(), season: se.id, name: se.name, nations, keys: Object.fromEntries(FRESH_KEYS.map(k => [k, S[k] === undefined ? null : S[k]])), meta: meta_, rh: RH };
  const txt = JSON.stringify(snap), tmp = FRESH_FILE + '.tmp';
  fs.writeFileSync(tmp, txt); fs.renameSync(tmp, FRESH_FILE);
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(path.join(BACKUP_DIR, `season-realworld-${se.id}.json`), txt); } catch (e) { logErr('Could not write the second copy of the real world: ' + e.message); }
  // read it back before anything is cleared: the real world is only set aside once its copy is proven good
  const back = JSON.parse(fs.readFileSync(FRESH_FILE, 'utf8'));
  if (!back || back.season !== se.id || Object.keys(back.nations || {}).length !== Object.keys(nations).length) throw new Error('The saved copy of the real world did not read back correctly.');
  return Object.keys(nations).length;
}
function freshClear() {
  const now = Date.now();
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/')) delete S.docs[k];
  S.council = { props: [], active: {} }; S.blocs = Object.create(null); S.crisis = null; S.crisisHist = []; S.games = null; S.gamesHist = []; S.dis = [];
  S.nextGames = now + 12 * HOUR; S.nextDis = now + 3 * HOUR; S.nextCrisis = now + 36 * HOUR; S.event = null; S.nextEvent = now + 6 * HOUR; S.lastEventKey = null;
  S.fallen = []; S.nukes = []; S.strikes = []; S.strikeLog = []; S.ntests = []; S.ntestPending = []; S.burn = {}; S.bm = { list: [] }; S.freedQ = 0; S.freedLast = []; S.freedAt = 0; S.bossFell = 0; S.overPause = 0; S.overPauseSet = 1;
  for (const m of Object.values(S.meta)) if (m) { m.fallen = null; m.rem = {}; }
  S.mkt = { on: !!(S.mkt && S.mkt.on), sup: S.mkt ? S.mkt.sup : undefined }; // a fresh world gets a freshly primed market
  RH = []; rhGz = null; try { fs.writeFileSync(RANK_FILE, '[]'); } catch (e) {}
}
// the world loop's copy of the old world must never be written back after the switch
function freshDropW(W) { if (!W) return; W.changed = new Set(); for (const k of Object.keys(W.A)) delete W.A[k]; W.OWN = {}; W.fallen = []; W.strikeFx = []; W.nukeFx = []; W.ntestFx = []; W.casinoEv = null; W.welcome = null; } // nothing from the old world (a missile, a test, a strike) may land in the new one
function freshBegin(W, se) {
  pkCashAll('A season is starting'); // chips go home to the real nations before the real world is saved
  const n = freshSave(se); freshClear(); freshDropW(W); SW = null; publicCache = null;
  S.fresh = { id: se.id, t: Date.now(), nations: n }; S.moneyLog = []; persist(true); // the check-up compares money with a day ago: a different world must not look like a 98% crash
  audit('System', 'Fresh season world started', `${se.name}: real world (${n} nations) saved to ${path.basename(FRESH_FILE)}`);
  setTimeout(() => broadcast('reload', { t: Date.now() }), 200);
}
function freshRestore(by, why) {
  try { pkCashAll(null); } catch (e) {}
  let snap = null, src = FRESH_FILE;
  try { snap = JSON.parse(fs.readFileSync(FRESH_FILE, 'utf8')); } catch (e) { const id = S.fresh && S.fresh.id; const alt = id && path.join(BACKUP_DIR, `season-realworld-${id}.json`); if (alt && fs.existsSync(alt)) { snap = JSON.parse(fs.readFileSync(alt, 'utf8')); src = alt; } }
  if (!snap || snap.v !== 1 || !snap.nations) throw Object.assign(new Error('The saved real world could not be found or read. Nothing was changed.'), { status: 500 });
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(path.join(BACKUP_DIR, `season-world-final-${snap.season}-${Date.now()}.json`), JSON.stringify(gameState())); } catch (e) {}
  const now = Date.now();
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/')) delete S.docs[k];
  const gone = Object.keys(snap.nations).filter(id => !S.users[id] && !BOTS.isBot(id)); // players who deleted their account during the season
  for (const [id, n] of Object.entries(snap.nations)) { if (gone.includes(id)) continue; n.lastTick = now; if (n.nextCard && n.nextCard < now) n.nextCard = now + 10 * 60e3; if (gone.length && n.rel) for (const g of gone) delete n.rel[g]; S.docs['nations/' + id] = n; }
  for (const k of FRESH_KEYS) S[k] = snap.keys[k] === null || snap.keys[k] === undefined ? (k === 'blocs' ? Object.create(null) : k === 'mkt' ? { on: !!(S.mkt && S.mkt.on), sup: S.mkt ? S.mkt.sup : undefined } : S[k]) : snap.keys[k];
  S.blocs = Object.assign(Object.create(null), S.blocs || {}); if (gone.length) for (const [bid, b] of Object.entries(S.blocs)) { b.members = (b.members || []).filter(m => !gone.includes(m)); if (!b.members.length) { delete S.blocs[bid]; continue; } b.co = (b.co || []).filter(m => !gone.includes(m) && b.members.includes(m)); if (gone.includes(b.leader)) { b.leader = b.co[0] || b.members[0]; b.co = b.co.filter(m => m !== b.leader); } } if (!S.council) S.council = { props: [], active: {} }; if (!S.bm || !Array.isArray(S.bm.list)) S.bm = { list: [] }; if (!S.burn) S.burn = {};
  for (const m of Object.values(S.meta)) if (m) { m.fallen = null; m.rem = {}; }
  for (const [u, x] of Object.entries(snap.meta || {})) { const m = meta(u); m.fallen = x.fallen || null; m.rem = x.rem || {}; }
  RH = Array.isArray(snap.rh) ? snap.rh : []; rhGz = null; try { fs.writeFileSync(RANK_FILE, JSON.stringify(RH)); } catch (e) {}
  S.fresh = null; SW = null; publicCache = null; S.moneyLog = []; persist(true); // the restored world is on disk before the save file is retired
  try { if (!S.map2) map2Switch('the real world came back'); else if (!snap.map2) { map2GrantAll(); persist(true); } } catch (e) { logErr('Bigger map switch failed: ' + (e.stack || e)); }
  try { blocRepair(); } catch (e) {}
  try { ntestSweep(); } catch (e) {}
  try { fs.renameSync(src, path.join(DATA_DIR, `season-realworld-restored-${snap.season}-${now}.json`)); } catch (e) {}
  audit(by || 'System', 'Real world restored', `${snap.name || 'season'}: ${Object.keys(snap.nations).length - gone.length} nations back${gone.length ? `, ${gone.length} skipped (account deleted)` : ''}${why ? ' (' + why + ')' : ''}`);
  setTimeout(() => broadcast('reload', { t: Date.now() }), 200);
  return snap;
}
// ---------- CHAOS WORLD ----------
// The admin can switch the game into a temporary "chaos" copy of the world at any time, even mid-season: the real world is saved to a
// file first (and read back to prove it's good), then everyone keeps playing their own nation with every weapon unlocked, a huge war
// chest and timers 90% faster. When the time runs out the saved real world comes back exactly as it was, and its timers are moved on
// by the length of the event so nothing ran out while it was set aside. Accounts, chat, mail, Helpdesk, donations, moderation and
// Cheat watch are never touched.
const CHAOS_FILE = path.join(DATA_DIR, 'chaos-realworld.json');
const CHAOS_KEYS = [...FRESH_KEYS, 'scoreHist', 'casino'];
const CHAOS_OPT = { army: { troops: 5e5, air: 2000, ships: 300 }, mins: [15, 30, 60, 120, 180], speed: [4, 10, 20, 30], nukes: [1, 2], nukeMax: 2, chest: { small: 5e11, big: 5e12, huge: 5e13 }, res: { small: 2e5, big: 2e6, huge: 2e7 } };
const CHAOS_XP = 12000; // the highest rank any weapon needs (Sovereign)
const chaosOn = () => !!(S.chaos && S.chaos.on);
const CHAOS_LOCK = { error: 'Chaos world is running. Anything changed in the world now would be lost when the real world comes back. End Chaos world first (Admin → Chaos world).' };
function chaosMaxEnd() { const se = S.seasons && S.seasons.cur; return se && se.status === 'live' && se.end ? se.end - 15 * 60e3 : Infinity; } // must be over well before a season's finale
// timers in the saved world are moved on by the length of the event, so a shield or a cooldown has the same time left afterwards
const CHAOS_TKEY = /^(t|until|end|ready|next|exp|at|go|since)$|T$|At$|Until$|^next|shield|regroup|blockade|Ban$|rogue|Warn$|Hit$|winter|fallout|nuked|nukeTax|iaea/;
function chaosShift(o, from, to, d, all, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return;
  for (const k of Object.keys(o)) { const v = o[k];
    if (typeof v === 'number') { if (v > from && v < to && (all || CHAOS_TKEY.test(k))) o[k] = v + d; }
    else if (v && typeof v === 'object') chaosShift(v, from, to, d, all || k === 'cd' || k === 'unrest' || k === 'gpfail' || k === 'cb', depth + 1);
  }
}
function chaosSave() {
  const nations = {}; for (const [k, v] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = v;
  const meta_ = {}; for (const [u, m] of Object.entries(S.meta)) if (m) meta_[u] = { fallen: m.fallen || null, rem: m.rem || null };
  const snap = { v: 1, map2: !!S.map2, t: Date.now(), nations, keys: Object.fromEntries(CHAOS_KEYS.map(k => [k, S[k] === undefined ? null : S[k]])), meta: meta_, rh: RH, fresh: S.fresh || null };
  const txt = JSON.stringify(snap), tmp = CHAOS_FILE + '.tmp';
  fs.writeFileSync(tmp, txt); fs.renameSync(tmp, CHAOS_FILE);
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(path.join(BACKUP_DIR, `chaos-realworld-${snap.t}.json`), txt); } catch (e) { logErr('Could not write the second copy of the world before Chaos world: ' + e.message); }
  const back = JSON.parse(fs.readFileSync(CHAOS_FILE, 'utf8'));
  if (!back || back.t !== snap.t || Object.keys(back.nations || {}).length !== Object.keys(nations).length) throw new Error('The saved copy of the world did not read back correctly. Chaos world was not started.');
  return { t: snap.t, n: Object.keys(nations).length, file: path.join(BACKUP_DIR, `chaos-realworld-${snap.t}.json`) };
}
function chaosNukes(n, k) { const now = Date.now(); if (!n.nuke) n.nuke = now - 30 * 864e5; let armed = n.warhead && (n.warhead === 2 || n.warhead.ready <= now) ? 1 : 0; const room = Math.max(0, CHAOS_OPT.nukeMax - armed - (n.whStock || 0)); k = Math.min(k, room); if (k <= 0) return; if (!armed) { n.warhead = { t: now, ready: now }; k--; } n.whStock = (n.whStock || 0) + Math.max(0, k); n.nukeBan = 0; } // never more than 2 warheads per nation in Chaos world // k more launchable warheads: one armed, the rest in the stockpile
function chaosArm(n, o) { // what every nation gets in the chaos copy
  if (o.unlock) { n.tech = Math.max(n.tech || 0, 400); n.xp = Math.max(n.xp || 0, CHAOS_XP); }
  n.cash = Math.max(n.cash || 0, CHAOS_OPT.chest[o.chest]); n.res = n.res || {}; for (const r of ['food', 'oil', 'steel', 'goods']) n.res[r] = Math.max(n.res[r] || 0, CHAOS_OPT.res[o.chest]);
  n.spies = Math.max(n.spies || 0, 200); n.cd = {}; n.regroup = 0; n.debt = 0;
  const A = CHAOS_OPT.army; n.troops = Math.max(n.troops || 0, A.troops); n.air = Math.max(n.air || 0, A.air); n.ships = Math.max(n.ships || 0, A.ships); // a minimum army, so a new nation is not left with nothing (bigger armies are kept as they are)
  if (o.nukes > 0) chaosNukes(n, o.nukes);
  if (o.noShield) n.shield = 0;
}
function chaosBegin(W, by, o) {
  if (chaosOn()) throw Object.assign(new Error('Chaos world is already running.'), { status: 400 });
  const se = S.seasons && S.seasons.cur; if (se && se.status !== 'live' && se.start && se.start < Date.now() + o.mins * 60e3 + 10 * 60e3) throw Object.assign(new Error('A season is about to start. Run Chaos world after it has started.'), { status: 400 });
  const end = Date.now() + o.mins * 60e3; if (end > chaosMaxEnd()) throw Object.assign(new Error(`The season ends at ${new Date(se.end).toLocaleString('en-US', { timeZone: 'America/Denver' })} Mountain. Chaos world must finish at least 15 minutes before that: choose a shorter time.`), { status: 400 });
  try { pkCashAll('Chaos world is starting'); } catch (e) {}
  const sv = chaosSave(); freshDropW(W);
  const start = {}; const W0 = mkWorld();
  for (const [k, n] of Object.entries(S.docs)) { if (!k.startsWith('nations/') || !n) continue; const u = k.slice(8); start[u] = { provs: core.hexesOf(W0, u).length, name: n.name }; chaosArm(n, o); }
  S.chaos = { on: true, t: sv.t, end, by, o, start, nations: sv.n, lastDrop: Date.now(), drops: 0 };
  if (S.testLab && S.testLab.on) { S.chaos.lab = true; S.testLab.on = false; try { labStop(); } catch (e) {} }
  SW = null; publicCache = null; S.moneyLog = []; persist(true);
  audit(by, 'Chaos world started', `${o.mins} min, timers ×${o.speed} faster, ${o.chest} war chest. Real world (${sv.n} nations) saved to ${path.basename(sv.file)}`);
  systemMessage(`💥 CHAOS WORLD for ${o.mins >= 60 ? (o.mins / 60) + ' hour' + (o.mins > 60 ? 's' : '') : o.mins + ' minutes'}! Every weapon is unlocked, everyone has a huge war chest and timers run ${o.speed}× faster. Nothing here is permanent: when it ends the real world comes back exactly as it was.${o.nukes ? ` Every nation starts with ${o.nukes} nuclear warhead${o.nukes > 1 ? 's' : ''}.` : ''}`);
  broadcast('config', effCfg()); setTimeout(() => broadcast('reload', { t: Date.now() }), 300);
}
function chaosStandings(W) {
  const st = S.chaos.start || {}; return Object.keys(W.A).filter(u => !W.A[u].ai && S.users[u] && !S.users[u].test).map(u => { const p = core.hexesOf(W, u).length, s = st[u]; const bty = ((S.chaos.bounty || {})[u]) || 0; return { u, name: W.A[u].name, color: W.A[u].color, provs: p, gain: p - (s ? s.provs : 0) + bty, bounty: bty, power: Math.round(core.power(W, u)), joined: !s }; })
    .sort((a, b) => b.gain - a.gain || b.power - a.power);
}
function chaosEnd(by, why) {
  if (!S.chaos || !S.chaos.on) return null;
  let snap = null; try { snap = JSON.parse(fs.readFileSync(CHAOS_FILE, 'utf8')); } catch (e) {}
  if (!snap || snap.v !== 1 || !snap.nations || snap.t !== S.chaos.t) { const alt = path.join(BACKUP_DIR, `chaos-realworld-${S.chaos.t}.json`); try { snap = JSON.parse(fs.readFileSync(alt, 'utf8')); } catch (e) { snap = null; } }
  if (!snap || !snap.nations) { logErr('Chaos world: the saved real world could not be read'); throw Object.assign(new Error('The saved real world could not be read. Nothing was changed; Chaos world keeps running. Check the backups folder.'), { status: 500 }); }
  let rank = []; try { rank = chaosStandings(mkWorld()).slice(0, 10); } catch (e) {}
  try { pkCashAll(null); } catch (e) {}
  const now = Date.now(), d = now - snap.t, t0 = snap.t;
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/')) delete S.docs[k];
  const gone = Object.keys(snap.nations).filter(id => !S.users[id] && !BOTS.isBot(id));
  for (const [id, n] of Object.entries(snap.nations)) { if (gone.includes(id)) continue; chaosShift(n, t0, t0 + 400 * 864e5, d, false); n.lastTick = now; if (gone.length && n.rel) for (const g of gone) delete n.rel[g]; S.docs['nations/' + id] = n; }
  for (const k of CHAOS_KEYS) { const v = snap.keys[k]; S[k] = v === null || v === undefined ? (k === 'blocs' ? Object.create(null) : S[k]) : v; }
  for (const k of ['council', 'crisis', 'games', 'dis', 'event', 'nukes', 'strikes', 'ntests', 'ntestPending', 'bm']) chaosShift(S[k], t0, t0 + 400 * 864e5, d, false);
  for (const k of ['nextGames', 'nextDis', 'nextCrisis', 'nextEvent', 'overPause']) if (typeof S[k] === 'number' && S[k] > t0) S[k] += d;
  S.blocs = Object.assign(Object.create(null), S.blocs || {}); chaosShift(S.blocs, t0, t0 + 400 * 864e5, d, false);
  if (gone.length) for (const [bid, b] of Object.entries(S.blocs)) { b.members = (b.members || []).filter(m => !gone.includes(m)); if (!b.members.length) { delete S.blocs[bid]; continue; } b.co = (b.co || []).filter(m => !gone.includes(m) && b.members.includes(m)); if (gone.includes(b.leader)) { b.leader = b.co[0] || b.members[0]; b.co = b.co.filter(m => m !== b.leader); } }
  if (!S.council) S.council = { props: [], active: {} }; if (!S.bm || !Array.isArray(S.bm.list)) S.bm = { list: [] }; if (!S.burn) S.burn = {};
  for (const [u, x] of Object.entries(snap.meta || {})) { const m = meta(u); m.fallen = x.fallen || null; m.rem = x.rem || {}; }
  for (const [u, m] of Object.entries(S.meta)) if (m && !(snap.meta || {})[u]) { m.fallen = null; m.rem = {}; }
  RH = Array.isArray(snap.rh) ? snap.rh : RH; rhGz = null; try { fs.writeFileSync(RANK_FILE, JSON.stringify(RH)); } catch (e) {}
  // the chaos notifications go too: the bell shows the real world again
  for (const u of Object.keys(S.notes)) S.notes[u] = (S.notes[u] || []).filter(x => !(x.t >= t0 && x.t <= now));
  const lab = S.chaos.lab, o = S.chaos.o, mins = Math.round(d / 60e3);
  const top = rank.filter(r => S.docs['nations/' + r.u] && r.gain > 0).slice(0, 3), day = new Date(t0).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Denver' });
  let recap = null; try { recap = chaosRecap(rank); } catch (e) { logErr('chaos recap: ' + e.message); }
  S.chaosLast = { t: t0, end: now, by: S.chaos.by, endBy: by || 'System', why: why || '', mins, o, rank, top: top.map(r => r.name), recap };
  // champions keep something real: a badge on their nation page, and a little prestige when at least three players took part
  { const P3 = [5, 3, 2], IC = ['💥', '🥈', '🥉'], T = ['Chaos Champion', 'Chaos runner-up', 'Chaos third place'], real = rank.filter(r => r.gain > 0).length >= 3;
    top.forEach((r, i) => { if (!S.users[r.u]) return; seasonGrant(r.u, { cash: 0, xp: 0, titles: [], badges: [{ s: 'chaos', k: 'chaos' + (i + 1), ic: IC[i], t: `${T[i]} (${day})` }], lines: [], log: `${IC[i]} ${T[i]} of the Chaos world on ${day}.` });
      const n = S.docs['nations/' + r.u]; if (n && real) n.prestige = (n.prestige || 0) + P3[i]; if (recap && recap.top[i]) recap.top[i].prize = `${IC[i]} badge${real ? ` + ${P3[i]} prestige` : ''}`; }); }
  S.chaos = null; if (lab && S.testLab) S.testLab.on = true;
  try { if (S.map2 && !snap.map2) map2GrantAll(); else if (!S.map2 && !S.fresh) map2Switch('after Chaos world'); } catch (e) { logErr('map2 after chaos: ' + e.message); }
  SW = null; publicCache = null; S.moneyLog = []; persist(true);
  try { blocRepair(); } catch (e) {} try { ntestSweep(); } catch (e) {}
  try { fs.renameSync(CHAOS_FILE, path.join(DATA_DIR, `chaos-realworld-restored-${t0}.json`)); } catch (e) {}
  for (const r of rank) if (S.users[r.u]) addNote(r.u, 'event', `💥 Chaos world is over and the real world is back. You ${r.gain > 0 ? 'gained ' + r.gain + ' province' + (r.gain === 1 ? '' : 's') : 'held on'} and finished #${rank.indexOf(r) + 1}.`);
  audit(by || 'System', 'Chaos world ended', `${mins} min${why ? ' (' + why + ')' : ''}. Real world restored: ${Object.keys(snap.nations).length - gone.length} nations. Winners: ${top.map(r => r.name).join(', ') || 'none'}`);
  systemMessage(`🌍 Chaos world is over and the real world is back exactly as it was.${top.length ? ` Winners: ${top.map((r, i) => ['🥇', '🥈', '🥉'][i] + ' ' + r.name + ' (+' + r.gain + ')').join(', ')}.` : ''}`);
  broadcast('config', effCfg()); setTimeout(() => broadcast('reload', { t: Date.now() }), 300);
  return S.chaosLast;
}
// THE PLANET FIGHTS BACK (Chaos world only): every nuclear detonation fills a fallout meter; the fuller it is, the likelier an earthquake, a volcanic eruption or a tsunami somewhere in the world.
// Nukes landing close together fill it faster. A catastrophe releases part of the pressure. Nothing here outlives the Chaos world.
const CATA = { perNuke: 12, cluster: 8, clusterKm: 1500, release: 35, onNuke: .55, ambient: .03, quakeKm: 900, quakeMax: 6, waveKm: 1300, waveMax: 8,
  n: { quake: ['🏚️', 'EARTHQUAKE'], volcano: ['🌋', 'VOLCANIC ERUPTION'], tsunami: ['🌊', 'TSUNAMI'] } };
function chaosNukeHit(fx) { const c = S.chaos; if (!c || !c.on || fx.intercepted || fx.h == null || !core.P[fx.h]) return; c.nk = c.nk || []; c.stat = c.stat || {};
  const near = c.nk.filter(x => core.kmBetween(x.h, fx.h) <= CATA.clusterKm).length; c.nk.push({ h: fx.h, t: Date.now() }); if (fx.by) { const st = c.stat[fx.by] = c.stat[fx.by] || {}; st.nk = (st.nk || 0) + 1; }
  c.meter = Math.min(100, (c.meter || 0) + CATA.perNuke + Math.min(4, near) * CATA.cluster); broadcast('cmeter', { m: Math.round(c.meter) });
  const p = c.meter / 100 * CATA.onNuke + (near >= 2 ? .25 : 0); if (rng() < p) setTimeout(() => { try { chaosCata(near >= 2 ? fx.h : null); } catch (e) { logErr('chaosCata: ' + (e.stack || e)); } }, nukeFlightMs(fx) + 9000); persist(); }
function chaosCata(nearH, forceKind) { const c = S.chaos; if (!c || !c.on) return null; const W = mkWorld(), P = core.P, owned = Object.keys(W.OWN).map(Number).filter(h => P[h]); if (!owned.length) return null;
  let pool = owned; if (nearH != null) { const nb = owned.filter(h => core.kmBetween(h, nearH) <= 2500); if (nb.length) pool = nb; } // heavy nuking of one area: the ground gives way nearby
  const kind = CATA.n[forceKind] ? forceKind : (() => { const r = rng(); return r < .4 ? 'quake' : r < .7 ? 'volcano' : 'tsunami'; })();
  let h = pool[Math.floor(rng() * pool.length)]; if (kind === 'tsunami') { const co = pool.filter(x => P[x].co); const src = co.length ? co : owned.filter(x => P[x].co); if (!src.length) return chaosCata(nearH, 'quake'); h = src[Math.floor(rng() * src.length)]; }
  if (kind === 'volcano') { const mt = pool.filter(x => P[x].m); if (mt.length && rng() < .7) h = mt[Math.floor(rng() * mt.length)]; }
  const hit = [], owners = {}, wreck = (x, lv) => { const o = W.OWN[x]; if (!o) return; const n = W.A[o.u]; if (!n) return; const was = (n.dev && n.dev[x]) || 0, to = lv === 0 ? 0 : Math.max(0, was - 1); if (was !== to) { n.dev = { ...(n.dev || {}), [x]: to }; if (!to) delete n.dev[x]; } hit.push(x); (owners[o.u] = owners[o.u] || { n: 0, lost: 0 }).n++; owners[o.u].lost += was - to; core.touch(W, o.u); };
  if (kind === 'quake') { const zone = owned.filter(x => x !== h && core.kmBetween(x, h) <= CATA.quakeKm).sort((a, b) => core.kmBetween(a, h) - core.kmBetween(b, h)).slice(0, CATA.quakeMax - 1); for (const x of [h, ...zone]) wreck(x, 1); for (const u of Object.keys(owners)) { const n = W.A[u]; n.troops = Math.round((n.troops || 0) * .97); } S.burn[h] = { t: Date.now(), n: 6 }; }
  else if (kind === 'volcano') { wreck(h, 0); for (const x of core.land(h)) if (W.OWN[x]) wreck(x, 1); S.burn[h] = { t: Date.now(), n: 20 }; }
  else { const zone = owned.filter(x => P[x].co && core.kmBetween(x, h) <= CATA.waveKm).sort((a, b) => core.kmBetween(a, h) - core.kmBetween(b, h)).slice(0, CATA.waveMax); for (const x of zone) wreck(x, 1); for (const u of Object.keys(owners)) { const n = W.A[u]; n.ships = Math.round((n.ships || 0) * .85); } }
  if (!hit.length) return null; commit(W);
  const N = CATA.n[kind], place = core.pname(h), names = Object.keys(owners).map(u => (W.A[u] || {}).name).filter(Boolean), dev = Object.values(owners).reduce((t, o) => t + o.lost, 0);
  const rec = { id: rid(), kind, h, c: P[h].c, hs: hit, place, t: Date.now(), n: hit.length, dev, names: names.slice(0, 6), meter: 0 };
  c.meter = Math.max(0, (c.meter || 0) - CATA.release); rec.meter = Math.round(c.meter); c.cata = [rec, ...(c.cata || [])].slice(0, 30); persist();
  broadcast('cata', rec); broadcast('cmeter', { m: rec.meter });
  const what = kind === 'quake' ? `${hit.length} province${hit.length > 1 ? 's' : ''} lost a development level and their armies took losses` : kind === 'volcano' ? `everything built there was wiped out and the land around it was scorched` : `${hit.length} coastal province${hit.length > 1 ? 's were' : ' was'} flooded and fleets were smashed`;
  setTimeout(() => systemMessage(`${N[0]} ${N[1]} at ${place}! The planet is fighting back against the nuclear fallout: ${what}. Hit: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' and more' : ''}.`), 2500);
  for (const [u, o] of Object.entries(owners)) if (S.users[u]) addNote(u, 'event', `${N[0]} ${N[1][0] + N[1].slice(1).toLowerCase()} at ${place}: ${o.n} of your provinces were hit${o.lost ? ` and lost ${o.lost} development level${o.lost > 1 ? 's' : ''}` : ''}${kind === 'tsunami' ? ', and 15% of your warships sank' : kind === 'quake' ? ', and 3% of your troops were lost' : ''}.`);
  return rec; }
// SUDDEN DEATH: the last minutes of a Chaos world. Shields drop, timers run twice as fast again, and the leader carries a bounty: every province taken from them counts double.
const chaosSdMs = c => Math.min(5, Math.max(2, Math.round(c.o.mins / 4))) * 60e3;
function chaosSudden(now) { const c = S.chaos; if (c.sd || now < c.end - chaosSdMs(c)) return false; c.sd = now; c.bounty = c.bounty || {};
  for (const [k, n] of Object.entries(S.docs)) if (k.startsWith('nations/') && n) n.shield = 0;
  try { chaosRetime(c.o.speed, c.o.speed * 2); } catch (e) { logErr('sudden death retime: ' + e.message); }
  const mins = Math.round(chaosSdMs(c) / 60e3); systemMessage(`💀 SUDDEN DEATH! ${mins} minutes left. Every shield is down, timers run twice as fast, and the leader has a bounty on their head: each province you take from them counts double.`); broadcast('announce', { text: `💀 Sudden death: ${mins} minutes left!` });
  persist(); broadcast('config', effCfg()); return true; }
function chaosTrack() { const c = S.chaos, W = mkWorld(); c.stat = c.stat || {}; const st = chaosStandings(W);
  for (const r of st) { const x = c.stat[r.u] = c.stat[r.u] || {}; x.lo = x.lo == null ? r.provs : Math.min(x.lo, r.provs); x.hi = Math.max(x.hi || 0, r.provs); }
  if (!c.sd) return; const lead = st[0] && st[0].gain > 0 ? st[0].u : null;
  if (c.lead && c.leadH) for (const h of c.leadH) { const o = W.OWN[h]; if (o && o.u !== c.lead && S.users[o.u] && !BOTS.isBot(o.u)) { c.bounty[o.u] = (c.bounty[o.u] || 0) + 1; addNote(o.u, 'event', `💀 Bounty! You took ${core.pname(h)} from the leader: it counts double.`); persist(); } }
  if (lead !== c.lead) { c.lead = lead; persist(); broadcast('config', effCfg()); if (lead) systemMessage(`👑 ${W.A[lead].name} leads the Chaos world and now carries the bounty. Take their land for double points!`); }
  c.leadH = lead ? core.hexesOf(W, lead) : []; }
function chaosRecap(rank) { const c = S.chaos, nm = u => (rank.find(r => r.u === u) || {}).name || ((c.start || {})[u] || {}).name || '', st = c.stat || {}, best = (f) => { let b = null; for (const [u, x] of Object.entries(st)) { const v = f(u, x); if (v > 0 && nm(u) && (!b || v > b.v)) b = { name: nm(u), v }; } return b; };
  const fin = Object.fromEntries(rank.map(r => [r.u, r.provs])), worst = (c.cata || []).slice().sort((a, b) => b.dev + b.n - (a.dev + a.n))[0];
  return { nukes: best((u, x) => x.nk || 0), land: rank[0] && rank[0].gain > 0 ? { name: rank[0].name, v: rank[0].gain } : null, comeback: best((u, x) => fin[u] != null && x.lo != null ? fin[u] - x.lo : 0), bounty: best(u => (c.bounty || {})[u] || 0),
    worst: worst ? { kind: worst.kind, place: worst.place, n: worst.n, dev: worst.dev } : null, totals: { nukes: (c.nk || []).length, cata: (c.cata || []).length, players: rank.length }, top: rank.filter(r => r.gain > 0).slice(0, 3).map(r => ({ name: r.name, color: r.color, gain: r.gain })) }; }
// every 10 minutes during Chaos world: an airdrop for every nation (and the war chest is topped up if the admin chose unlimited money)
const CHAOS_DROPS = [['💰', 'a war chest', n => { n.cash = (n.cash || 0) + CHAOS_OPT.chest[S.chaos.o.chest] * .25; }], ['⏱', 'an instant reset: every cooldown is ready now', n => { n.cd = {}; n.regroup = 0; }], ['🕵️', '100 extra agents', n => { n.spies = (n.spies || 0) + 100; }], ['🪖', '250,000 extra troops', n => { n.troops = (n.troops || 0) + 250000; }], ['✈', '2,000 extra aircraft', n => { n.air = (n.air || 0) + 2000; }], ['🚢', '300 extra warships', n => { n.ships = (n.ships || 0) + 300; }]];
// HEADS-UP COUNTDOWN: the owner announces "Chaos world starts in N minutes". Everyone sees a countdown; reminders go out near the end;
// at zero it starts by itself with the settings saved with the timer (or just announces, if the owner chose to start it by hand).
const CHAOS_WARN = [60, 30, 15, 10, 5, 1];
const czMins = m => m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minute${m === 1 ? '' : 's'}`;
function chaosTimerSet(by, mins, o, auto) { const m = Math.max(1, Math.min(24 * 60, Math.round(+mins) || 0)); S.chaosTimer = { at: Date.now() + m * 60e3, by, o, auto: !!auto, said: CHAOS_WARN.filter(x => x >= m) }; persist(); broadcast('config', effCfg());
  const t = `💥 Chaos world starts in ${czMins(m)}! Every weapon unlocked, huge war chests, fast timers. Nothing in it is permanent: the real world comes back exactly as it was.`; systemMessage(t); broadcast('announce', { text: `Chaos world starts in ${czMins(m)}` }); audit(by, 'Chaos world countdown', `${czMins(m)}${auto ? ', starts by itself' : ', manual start'}`); }
function chaosTimerClear(by, tell) { if (!S.chaosTimer) return; S.chaosTimer = null; persist(); broadcast('config', effCfg()); if (tell) { systemMessage('💥 The Chaos world countdown was called off.'); audit(by, 'Chaos world countdown', 'called off'); } }
function chaosTimerLoop() { const T = S.chaosTimer; if (!T) return; const now = Date.now(); if (S.chaos && S.chaos.on) { S.chaosTimer = null; persist(); return; }
  const left = (T.at - now) / 60e3; T.said = T.said || []; for (const w of CHAOS_WARN) if (left <= w && left > 0 && !T.said.includes(w)) { T.said.push(w); if (left > w - 1) { systemMessage(`💥 Chaos world starts in ${czMins(w)}!`); broadcast('announce', { text: `Chaos world starts in ${czMins(w)}` }); } persist(); }
  if (now < T.at) return; S.chaosTimer = null; persist(); broadcast('config', effCfg());
  if (!T.auto) { systemMessage('💥 The Chaos world countdown has finished. It starts as soon as the admin presses the button.'); return; }
  try { chaosBegin(mkWorld(), T.by, T.o); } catch (e) { systemMessage('💥 Chaos world could not start just now. The admin has been told.'); audit('System', 'Chaos world countdown', 'could not start: ' + (e.message || e)); logErr('Chaos countdown start failed: ' + (e.stack || e)); } }
setInterval(chaosTimerLoop, 2000).unref();
function chaosLoop() {
  if (!S.chaos || !S.chaos.on) return;
  const now = Date.now();
  if (now >= S.chaos.end || now >= chaosMaxEnd()) { try { chaosEnd('System', now >= S.chaos.end ? 'time ran out' : 'season ending'); } catch (e) { logErr('Chaos world could not end: ' + (e.stack || e)); } return; }
  try { chaosSudden(now); chaosTrack(); if ((S.chaos.meter || 0) > 0 && rng() < Math.pow(S.chaos.meter / 100, 2) * CATA.ambient) chaosCata(null); } catch (e) { logErr('chaos extras: ' + (e.stack || e)); }
  S.chaos.armed = S.chaos.armed || {}; for (const [k, n] of Object.entries(S.docs)) { if (!k.startsWith('nations/') || !n) continue; const u = k.slice(8); if (S.chaos.start[u] || S.chaos.armed[u]) continue; S.chaos.armed[u] = 1; chaosArm(n, S.chaos.o); sendNation(u); persist(); } // nations founded during the event get armed too
  if (now - S.chaos.lastDrop < 10 * 60e3) return;
  S.chaos.lastDrop = now; S.chaos.drops++; const o = S.chaos.o;
  for (const [k, n] of Object.entries(S.docs)) { if (!k.startsWith('nations/') || !n) continue; const u = k.slice(8);
    if (o.refill) n.cash = Math.max(n.cash || 0, CHAOS_OPT.chest[o.chest]);
    if (o.drops) { const D = CHAOS_DROPS[Math.floor(rng() * CHAOS_DROPS.length)]; D[2](n); if (S.users[u]) addNote(u, 'event', `${D[0]} Chaos airdrop: you got ${D[1]}!`); }
    sendNation(u); }
  persist();
}
setInterval(chaosLoop, 5000).unref();
// the real world is loaded and still on the old map (an upload after the season ended): switch a few seconds after start
setTimeout(() => { try { map2Switch('server start'); } catch (e) { logErr('Bigger map switch failed: ' + (e.stack || e)); } }, 4000);
function chaosRetime(oldS, newS) { const now = Date.now(), f = oldS / newS, fix = v => typeof v === 'number' && v > now ? Math.round(now + (v - now) * f) : v;
  for (const [k, n] of Object.entries(S.docs)) { if (!k.startsWith('nations/') || !n) continue;
    for (const c of Object.keys(n.cd || {})) n.cd[c] = fix(n.cd[c]); n.regroup = fix(n.regroup);
    if (n.warhead && typeof n.warhead === 'object') n.warhead.ready = fix(n.warhead.ready); if (n.dome && typeof n.dome === 'object') { n.dome.ready = fix(n.dome.ready); if (n.dome.up) n.dome.up.ready = fix(n.dome.up.ready); }
    if (n.proj) n.proj.next = fix(n.proj.next); if (n.exped) n.exped.end = fix(n.exped.end); sendNation(k.slice(8)); } }
// a supporter can start one Chaos world per purchase: 15 or 30 minutes, with the same options as the admin. Starting it is all they can do:
// they can't end it, change it or hand out anything, and the real world is saved first exactly as when the admin starts one.
const CHAOS_GAP = 60 * 60e3; // at least an hour of the real world between Chaos worlds started by players
function chaosInfo() { const c = S.chaos, l = S.chaosLast, now = Date.now(), maxEnd = chaosMaxEnd(); const next = l && l.end ? l.end + CHAOS_GAP : 0;
  return { allowed: S.config.chaosBuy !== false, on: !!(c && c.on), end: c && c.on ? c.end : 0, by: c && c.on ? c.by : null, nextAt: next > now ? next : 0, maxMins: maxEnd === Infinity ? 30 : Math.max(0, Math.floor((maxEnd - now) / 60e3)) }; }
function chaosBuy(uid, b) {
  if (S.config.chaosBuy === false) return { error: 'Starting a Chaos world is switched off by the admins right now. Your purchase is kept: try again later.' };
  if (chaosOn()) return { error: 'A Chaos world is already running. Your purchase is kept: start yours after it ends.' };
  const inf = chaosInfo(); if (inf.nextAt) return { error: `The real world needs a break between Chaos worlds. You can start yours in ${Math.ceil((inf.nextAt - Date.now()) / 60e3)} minutes. Your purchase is kept.` };
  const o = { mins: [15, 30].includes(+b.mins) ? +b.mins : 15, speed: CHAOS_OPT.speed.includes(+b.speed) ? +b.speed : 10, nukes: CHAOS_OPT.nukes.includes(+b.nukes) ? +b.nukes : 2, chest: CHAOS_OPT.chest[b.chest] ? b.chest : 'big', refill: b.refill !== false, unlock: b.unlock !== false, drops: b.drops !== false, noShield: b.noShield !== false };
  const who = S.docs['nations/' + uid] ? pubName(uid) : 'A supporter';
  try { chaosBegin(mkWorld(), who, o); } catch (e) { return { error: e.message.replace('choose a shorter time', 'choose 15 minutes, or start it after the season') + ' Your purchase is kept.' }; }
  S.chaos.donor = uid; persist(); systemMessage(`💛 ${who} started this Chaos world with a donation. Thank you!`); audit(who, 'Chaos world started by a supporter', `${o.mins} min, ×${o.speed}, ${o.nukes} nukes, ${o.chest} war chest`);
  return { ok: true, mins: o.mins, msg: `💥 Chaos world is on for ${o.mins} minutes! Everyone has been told. Thank you for supporting World Powers.` };
}
const chaosView = () => { const c = S.chaos; let st = []; if (c && c.on) try { st = chaosStandings(mkWorld()).slice(0, 15); } catch (e) {} return { on: !!(c && c.on), timer: S.chaosTimer && S.chaosTimer.at > Date.now() ? { at: S.chaosTimer.at, by: S.chaosTimer.by, auto: !!S.chaosTimer.auto, mins: S.chaosTimer.o && S.chaosTimer.o.mins } : null, t: c && c.t, end: c && c.end, by: c && c.by, o: c && c.o, nations: c && c.nations, drops: c && c.drops, nukesGiven: c && c.nukesGiven, standings: st, last: S.chaosLast || null, maxEnd: chaosMaxEnd() === Infinity ? 0 : chaosMaxEnd(), saved: fs.existsSync(CHAOS_FILE), now: Date.now(), donor: c && c.donor ? (S.users[c.donor] || {}).name || '?' : null, buyOn: S.config.chaosBuy !== false, gapLeft: chaosInfo().nextAt }; };

// a prize for a real nation: paid now if it exists, otherwise kept until the player founds one
function seasonGrant(u, g) { const d = S.docs['nations/' + u]; if (!d) { const m = meta(u); m.seasonPending = [...(m.seasonPending || []), g].slice(-20); return false; } applyGrant(d, g); return true; }
function applyGrant(n, g) { if (g.cash) { core.finSync(null, n); n.cash = (n.cash || 0) + g.cash; core.finSync(null, n, 'rewards'); } if (g.xp) n.xp = (n.xp || 0) + g.xp; for (const t of g.titles || []) n.titles = [...(n.titles || []), t].slice(-30);
  for (const b of g.badges || []) n.badges = [...(n.badges || []).filter(x => !(x.s === b.s && x.k === b.k && x.t === b.t)), b].slice(-60); if (g.log) n.log = [{ t: Date.now(), x: g.log }, ...(n.log || [])].slice(0, 120); }
function seasonPendingApply(u) { const m = S.meta[u], d = S.docs['nations/' + u]; if (!m || !d || !(m.seasonPending || []).length) return; for (const g of m.seasonPending) applyGrant(d, g); const k = m.seasonPending.length; m.seasonPending = []; addNote(u, 'event', `🏆 ${k} season reward${k > 1 ? 's were' : ' was'} waiting for your new nation and ${k > 1 ? 'have' : 'has'} been added.`); sendNation(u); persist(); }
function seasonFinishFresh(W, by) {
  { const se0 = S.seasons.cur; if (se0 && se0.grants && !S.fresh) { // a restart cut the last finish short after the real world came back: only the prizes are left to pay
    for (const [u, g] of Object.entries(se0.grants)) { const paid = seasonGrant(u, g); addNote(u, 'event', `🏆 ${se0.name}: ${g.lines.length ? 'you ' + g.lines.join('; ') : 'you took part'}.${paid ? '' : ' Found a nation to receive your rewards.'}`); }
    S.seasons.cur = null; audit(by || 'System', 'Season ended', se0.name + ' (prizes paid after a restart)'); persist(true); broadcast('config', effCfg()); return null; } }
  const se = S.seasons.cur, M = SEASON_METRICS[se.metric] || SEASON_METRICS.final, table = seasonTable(W, se), now = Date.now();
  const pick = x => { const n = W.A[x.u]; return { name: n.name, leader: n.ai ? 'AI' : '', color: n.color, flag: n.flag || null, ai: !!n.ai, value: x.v, shown: M.fmt(x.v) }; };
  const ranked = table.filter(x => x.v > 0), top = ranked.slice(0, 10);
  const cats = (se.cats || []).filter(k => SEASON_METRICS[k] && k !== se.metric).map(k => { const best = seasonTable(W, se, k, 1)[0]; return best && best.v > 0 ? { k, award: SEASON_METRICS[k].title, metric: SEASON_METRICS[k].n, ...pick(best), shown: SEASON_METRICS[k].fmt(best.v), u: best.u } : null; }).filter(Boolean);
  const ord = i => ['1st', '2nd', '3rd'][i] || `${i + 1}th`, place = ['Champion', '2nd place', '3rd place'], grants = {};
  const G = u => grants[u] = grants[u] || { cash: 0, xp: 0, titles: [], badges: [], lines: [] };
  top.forEach((x, i) => { if (W.A[x.u].ai || !S.users[x.u]) return; const g = G(x.u), cash = Math.max(0, +((se.prizes || [])[i]) || 0), xp = Math.max(0, +((se.xp || [])[i]) || 0); g.cash += cash; g.xp += xp;
    if (se.titles !== false && i < 3) g.titles.push({ s: se.n, t: `${se.name} ${place[i]}`, r: i + 1 });
    g.badges.push(i === 0 ? { s: se.n, k: 'champion', ic: '🏆', t: `${se.name} Champion` } : i === 1 ? { s: se.n, k: 'second', ic: '🥈', t: `${se.name} 2nd place` } : i === 2 ? { s: se.n, k: 'third', ic: '🥉', t: `${se.name} 3rd place` } : { s: se.n, k: 'top10', ic: '🎖', t: `${se.name} top 10 (${ord(i)})` });
    g.lines.push(`finished ${ord(i)} with ${W.A[x.u].name}${cash ? ` (+$${Math.round(cash).toLocaleString('en-US')})` : ''}${xp ? ` (+${xp} XP)` : ''}`); });
  for (const c of cats) { if (W.A[c.u].ai || !S.users[c.u]) continue; const g = G(c.u), aw = (se.award || {})[c.k] || {}; g.cash += aw.cash || 0; g.xp += aw.xp || 0; if (se.titles !== false) g.titles.push({ s: se.n, t: `${c.award} of ${se.name}` }); g.badges.push({ s: se.n, k: 'award', ic: '🏅', t: `${c.award} of ${se.name}` }); g.lines.push(`${c.award} (${c.metric}: ${c.shown})${aw.cash ? ` +$${Math.round(aw.cash).toLocaleString('en-US')}` : ''}${aw.xp ? ` +${aw.xp} XP` : ''}`); }
  // everyone who founded a season nation took part, even if it was conquered before the end
  let veterans = 0; const took = new Set([...Object.keys(se.played || {}), ...Object.keys(W.A).filter(u => !W.A[u].ai && seasonEligible(W, se, u))]); for (const u of took) { if (!S.users[u]) continue; G(u).badges.push({ s: se.n, k: 'played', ic: '🎗', t: `Played ${se.name}` }); veterans++; }
  const entry = { season: se.n, name: se.name, start: se.start, end: now, metric: se.metric, metricName: M.n, who: se.who, fresh: true, champion: top[0] ? pick(top[0]) : null, top: top.map((x, i) => ({ r: i + 1, ...pick(x) })), awards: cats.map(({ u, ...c }) => c), players: table.length, veterans, prizes: (se.prizes || []).slice(0, 10), recorded: now };
  if (!HOF.some(h => h.season === se.n && h.fresh && h.start === se.start)) { try { fs.appendFileSync(HOF_FILE, JSON.stringify(entry) + '\n'); } catch (e) { logErr('Could not write the Hall of Fame: ' + e.message); } HOF.push(Object.freeze(entry)); }
  const champ = top[0] ? W.A[top[0].u].name : null, t2 = top[1] ? W.A[top[1].u].name : null, t3 = top[2] ? W.A[top[2].u].name : null;
  try { broadcast('finaleEnd', { name: se.name, top: [champ, t2, t3].filter(Boolean) }); if (S.finaleLast) S.finaleLast.top = [champ, t2, t3].filter(Boolean); } catch (e) {}
  freshDropW(W);
  for (const [u, g] of Object.entries(grants)) { const lines = g.lines.length ? g.lines.join('; ') : 'took part'; g.log = `🏆 ${se.name} is over: you ${lines}.${g.cash || g.xp ? ' Your prizes have been added to this nation.' : ''}`; }
  se.grants = grants; // saved with the restored world, so a restart in the middle of the finish still pays exactly these prizes
  try { freshRestore(by || 'System', 'season ended'); } catch (e) { logErr('Real world restore failed at season end: ' + (e.stack || e)); se.status = 'restorefail'; persist(true); return entry; }
  // prizes go to the real nations (or wait for players who don't have one yet)
  for (const [u, g] of Object.entries(grants)) { const lines = g.lines.length ? g.lines.join('; ') : 'took part'; g.log = `🏆 ${se.name} is over: you ${lines}.${g.cash || g.xp ? ' Your prizes have been added to this nation.' : ''}`; const paid = seasonGrant(u, g); addNote(u, 'event', `🏆 ${se.name}: you ${lines}.${paid ? '' : ' Found a nation to receive your rewards.'}`); }
  S.seasons.cur = null; audit(by || 'System', 'Season ended', se.name); persist(true);
  const t = champ ? `🏆 ${se.name} is over! Champion: ${champ}.${t2 ? ` 2nd: ${t2}.` : ''}${t3 ? ` 3rd: ${t3}.` : ''} The real world is back exactly as you left it, with the prizes added. The winners are in the Hall of Fame forever.` : `${se.name} is over. The real world is back exactly as you left it.`;
  if (se.announce) { systemMessage(t); setTimeout(() => broadcast('announce', { text: t }), 2500); }
  broadcast('config', effCfg()); return entry;
}

// casino bookkeeping for the admin page: totals by game and by day, biggest wins, recent plays
S.casino = S.casino || { tot: {}, days: {}, recent: [], big: [] };
// slots extras: a shared jackpot, a weekly tournament (Monday to Monday, UTC) and per-machine results for the admin page
const czWeek = t => Math.floor(((t || Date.now()) / 864e5 + 3) / 7), czWeekEnd = wk => ((wk + 1) * 7 - 3) * 864e5;
S.casino.jp = S.casino.jp || { pot: core.CASINO.jp.seed }; S.casino.jp2 = S.casino.jp2 || { pot: core.CASINO.jp.seed }; S.casino.mach = S.casino.mach || {};
S.casino.tour = S.casino.tour || { wk: czWeek(), pool: core.CASINO.tour.seed, top: {} };
function czTourRoll() { const T = S.casino.tour, wk = czWeek(); if (T.wk === wk) return;
  const rows = Object.entries(T.top || {}).filter(([u]) => S.docs['nations/' + u] && !S.docs['nations/' + u].ai).sort((a, b) => b[1].x - a[1].x || a[1].t - b[1].t).slice(0, 3), winners = [];
  rows.forEach(([u, r], i) => { const n = S.docs['nations/' + u], prize = Math.floor((T.pool || 0) * core.CASINO.tour.split[i]); core.finSync(null, n); n.cash = (n.cash || 0) + prize; core.finSync(null, n, 'rewards');
    (n.log = n.log || []).unshift({ t: Date.now(), x: `Weekly slots tournament: place ${i + 1} with a ${r.x}× win on ${r.m}. Prize ${WP.moneyS(prize)}.` }); n.log = n.log.slice(0, 60); setDoc('nations', u, n);
    addNote(u, 'economy', `🏆 You finished ${['1st', '2nd', '3rd'][i]} in the weekly slots tournament with a ${r.x}× win on ${r.m}. Prize: ${WP.moneyS(prize)}.`); winners.push({ name: n.name, x: r.x, m: r.m, prize }); });
  if (winners.length) try { systemMessage(`🏆 Weekly slots tournament: ${winners.map((w, i) => `${['1st', '2nd', '3rd'][i]} ${w.name} (${w.x}× on ${w.m}, ${WP.moneyS(w.prize)})`).join(' · ')}. A new week has started.`); } catch (e) {}
  T.last = { wk: T.wk, pool: T.pool, winners }; T.wk = wk; T.top = {}; T.pool = core.CASINO.tour.seed + (winners.length ? 0 : Math.max(0, (T.pool || 0) - core.CASINO.tour.seed)); persist(); } // an unclaimed pool rolls over
setInterval(() => { try { czTourRoll(); } catch (e) { logErr('czTourRoll: ' + e.message); } }, 60e3).unref();
function czLive(uid) { const C_ = S.casino, T = C_.tour, J = C_.jp, J2 = C_.jp2;
  const feed = (C_.recent || []).filter(r => r.net > 0 && (r.jp || r.net >= r.bet * 5) && !BOTS.isBot(r.u)).slice(0, 12).map(r => ({ t: r.t, name: r.name, g: r.g, d: r.d, net: r.net, x: Math.round((r.net + r.bet - (r.jp || 0)) / r.bet * 10) / 10, jp: r.jp || 0 }));
  const top = Object.entries(T.top || {}).sort((a, b) => b[1].x - a[1].x || a[1].t - b[1].t).slice(0, 10).map(([u, r]) => ({ name: r.name, x: r.x, m: r.m, amt: r.amt, me: u === uid }));
  return { jp: { pot: Math.floor(J.pot || 0), last: J.last ? { name: J.last.name, amt: J.last.amt, t: J.last.t, m: J.last.m } : null }, jp2: { pot: Math.floor(J2.pot || 0), last: J2.last ? { name: J2.last.name, amt: J2.last.amt, t: J2.last.t, m: J2.last.m } : null }, feed, tour: { pool: Math.floor(T.pool || 0), ends: czWeekEnd(T.wk), top, mine: (T.top || {})[uid] ? T.top[uid].x : 0, last: T.last || null, minBet: core.CASINO.tour.minBet, split: core.CASINO.tour.split } }; }
// the finite world market (off until the owner switches it on): its stock, foreign supply rate and hourly history
S.mkt = S.mkt && typeof S.mkt === 'object' ? S.mkt : { on: false };
function mktView(full) { const M = S.mkt || {}; const v = { on: !!M.on, stock: M.stock || null, ref: M.ref || null, sup: M.sup != null ? M.sup : core.MKT.sup, primed: M.primed || 0 }; if (full) v.hist = (M.hist || []).slice(-72); return v; }
const casinoTotals = () => Object.fromEntries(Object.entries((S.casino && S.casino.tot) || {}).map(([k, x]) => [k, { plays: x.plays, wag: x.wag, net: x.net, wins: x.wins, won: x.won || 0, lost: x.lost || 0 }])); // all-time table results, sums only
function casinoRecord(W) { const C_ = S.casino; for (const e of W.casinoEv || []) { const n = W.A[e.u] || {}, day = new Date(e.t).toISOString().slice(0, 10);
  const add = (o, k) => { const x = o[k] = o[k] || { plays: 0, wag: 0, net: 0, wins: 0 }; x.plays++; x.wag += e.bet; x.net += e.net; if (e.net > 0) { x.wins++; x.won = (x.won || 0) + e.net; } else if (e.net < 0) x.lost = (x.lost || 0) - e.net; };
  add(C_.tot, e.g); add(C_.tot, 'all'); C_.days[day] = C_.days[day] || {}; add(C_.days[day], e.g); add(C_.days[day], 'all');
  const row = { t: e.t, u: e.u, name: n.name || '?', leader: '', g: e.g, bet: e.bet, net: e.net, d: e.d }; if (e.jp) row.jp = e.jp;
  if (e.g === 'slots' && e.m) { const x = C_.mach[e.m] = C_.mach[e.m] || { plays: 0, wag: 0, paid: 0, jp: 0, wins: 0, best: 0 }, back = e.bet + e.net - (e.jp || 0); x.plays++; x.wag += e.bet; x.paid += back; x.jp += e.jp || 0; if (back > 0) x.wins++; if (back / e.bet > x.best) x.best = Math.round(back / e.bet * 100) / 100; }
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
    const W = mkWorld(); const now = Date.now(); try { moneySample(W); } catch (e) {}
    for (const u of Object.keys(W.A)) { const active = BOTS.isBot(u) || now - ((S.meta[u] || {}).lastSeen || 0) < ACTIVE_WINDOW; core.tick(W, u, active, rng); }
    manageBots(W);
    for (const u of Object.keys(W.A)) if (BOTS.isBot(u)) { try { BOTS.turn(W, u, W.cfg); } catch (e) { logErr('AI nation error: ' + (e.stack || e)); } }
    try { bossWatch(W); } catch (e) { logErr('bossWatch: ' + e.message); }
    try { const mk_ = core.mktTick(W); if (mk_) W.mkch = Math.max(W.mkch || 0, mk_); } catch (e) { logErr('World market update failed: ' + (e.stack || e)); }
    pactCheck(W); councilWatch(W); botVotes(W); councilResolve(W); core.blocTick(W); crisisLoop(W); gamesLoop(W); disLoop(W); councilDaily(W); nukeAccLoop(W);
    if (!RH.length || now - RH[RH.length - 1].t >= HOUR) rankPoint(W);
    if (!chaosOn()) try { seasonTick(W); } catch (e) { logErr('Season update failed: ' + (e.stack || e)); }
    W.welcome = null; commit(W);
    // world events
    if (S.event && now >= S.event.end) endEvent();
    if (!S.event && S.config.eventsOn && now >= S.nextEvent && Object.keys(W.A).length >= 2) { const keys = Object.keys(WP.EVENTS).filter(k => k !== S.lastEventKey); startEvent(keys[Math.floor(rng() * keys.length)]); }
    readyReminders(W); smartReminders(W); runSchedule();
    if (!chaosOn()) { nightlyBackup(); fullBackup(); if (now - lastSnap >= 10 * 60e3) takeSnap(); }
  } catch (e) { logErr('World update failed: ' + (e.stack || e)); }
  health.loopMs = Number(process.hrtime.bigint() - t0) / 1e6;
}
// one time: radioactive clouds now stack, one per province hit. Rebuild the clouds of dirty bombs from the last
// 24 hours (that weren't shot down) from the strike log, so bombs dropped before this update count too
if (!S.radsBackfilled) { try { const now = Date.now(), hours = core.DIRTY.h * 36e5, byName = new Map(); for (let h = 0; h < core.P.length; h++) byName.set(core.pname(h), h);
  let k = 0; for (const x of S.strikeLog || []) { if (x.target !== 'dirty' || !(x.hits > 0) || !(now - x.t < hours)) continue; const n = S.docs['nations/' + x.to], h = byName.get(x.place); if (!n || h == null) continue;
    n.rads = (n.rads || []).filter(r => r.until > now); const old = n.rads.find(r => r.h === h); if (old) { if (old.t < x.t) { old.t = x.t; old.until = x.t + hours; old.by = x.by; } continue; }
    n.rads.push({ h, t: x.t, until: x.t + hours, by: x.by }); k++; }
  for (const n of Object.values(S.docs)) if (n && Array.isArray(n.rads)) { n.rads.sort((a, b) => a.t - b.t); n.rads = n.rads.slice(-5); if (!n.rads.length) delete n.rads; }
  S.radsBackfilled = Date.now(); if (k) { console.log(`Restored ${k} radioactive cloud(s) from recent dirty bombs.`); persist(); } } catch (e) { logErr('radsBackfill: ' + e.message); } }
setInterval(worldLoop, 30000).unref(); setTimeout(worldLoop, 1000);

// ===================== TEST LAB =====================
const labView = () => ({ on: !!S.testLab.on, paused: !!S.testLab.paused, speed: S.testLab.speed || 'normal', running: !!labW, state: LAB, testId: TEST_ID });
// A separate thread plays a COPY of the world nonstop with many kinds of simulated players, looking for crashes, broken numbers and unfair
// loopholes. It never touches the real game: it only receives a snapshot and sends reports back. The "Test" account shows as online while it runs.
const { Worker } = require('worker_threads');
const TEST_ID = 'admin-test';
S.testLab = S.testLab && typeof S.testLab === 'object' ? S.testLab : { on: true, speed: 'normal', paused: false };
let LAB = (st => st && st.coverage ? { ...st, coverage: Object.fromEntries(Object.entries(st.coverage).map(([k, v]) => [k, { ...v, why: Array.isArray(v.why) ? v.why : Object.entries(v.why || {}).sort((a, b) => b[1] - a[1]).slice(0, 3) }])) } : st)(S.testLab.state) || null, labW = null, labRestart = 0, labSaveT = 0;
function ensureTestAccount() { const u = S.users[TEST_ID]; if (!u || u.name !== 'Test' || !u.test) { S.users[TEST_ID] = { id: TEST_ID, name: 'Test', test: true, created: (u && u.created) || Date.now() }; persist(); } } // no email or password: nobody can sign in as it
const labSnap = () => { const nations = {}; for (const [k, d] of Object.entries(S.docs)) if (k.startsWith('nations/') && d && !d.ai) nations[k.slice(8)] = d; return { nations, cfg: S.config, fresh: !!S.fresh }; };
function labStart() {
  if (labW || !S.testLab.on) return;
  try {
    labW = new Worker(path.join(__dirname, 'testlab.js'), { workerData: { map2: !!S.map2, snap: labSnap(), speed: S.testLab.speed, paused: S.testLab.paused, prev: LAB }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
    labW.on('message', m => { if (m.type === 'report') { LAB = m.state; if (Date.now() - labSaveT > 120e3) { labSaveT = Date.now(); S.testLab.state = { gen: LAB.gen, stats: LAB.stats, findings: LAB.findings, coverage: Object.fromEntries(Object.entries(LAB.coverage || {}).map(([k, v]) => [k, { tries: v.tries, ok: v.ok, why: Object.fromEntries(v.why || []) }])), casino: LAB.casino, history: LAB.history }; persist(); } } else if (m.type === 'wantSnap' && labW) labW.postMessage({ type: 'snap', snap: labSnap() }); });
    labW.on('error', e => { logErr('test lab: ' + e.message); });
    labW.on('exit', code => { labW = null; if (S.testLab.on && code !== 0) { labRestart = Date.now() + 60e3; } });
  } catch (e) { labW = null; logErr('test lab start: ' + e.message); }
}
function labStop() { if (labW) { const w = labW; labW = null; w.terminate().catch(() => {}); } }
function labTick() { // keeps the Test account online while the lab runs, and restarts the lab if it ever stops
  ensureTestAccount();
  if (S.testLab.on && !labW && Date.now() > labRestart) labStart();
  const cur = S.docs['online/' + TEST_ID]; if (S.testLab.on && !S.testLab.paused) { if (!cur || Date.now() - (cur.t || 0) > 120e3) setDoc('online', TEST_ID, { t: Date.now(), test: 1 }); }
}
setTimeout(labTick, 15000); setInterval(labTick, 60e3).unref();

// a peace offer to a player who has gone inactive (not seen for a day) is signed for them after a short wait,
// so nobody stays stuck in a war against someone who is no longer playing
const PEACE_IDLE = { awayH: 24, waitH: 2 };
function peaceSweep() {
  const now = Date.now(), online = new Set([...clients].map(c => c.uid)); let changed = 0;
  for (const [key, n] of Object.entries(S.docs)) {
    if (!key.startsWith('nations/') || !n || !n.rel) continue; const u = key.slice(8);
    for (const [v, r] of Object.entries(n.rel)) {
      const o = S.docs['nations/' + v]; if (!o || !S.users[v] || BOTS.isBot(v) || online.has(v)) continue;
      const or = (o.rel && o.rel[u]) || {}, w = Math.max(r.war || 0, or.war || 0); if (!w) continue;
      const mine = r.peace || 0, theirs = or.peace || 0; if (!(mine > w) || theirs > w) continue;      // I offered, they haven't answered
      if (now - mine < PEACE_IDLE.waitH * 36e5) continue;                                           // give them a chance first
      if (now - ((S.meta[v] || {}).lastSeen || 0) < PEACE_IDLE.awayH * 36e5) continue;               // they've been around: their choice
      o.rel = o.rel || {}; o.rel[u] = { ...(o.rel[u] || {}), peace: now };
      const away = Math.floor((now - ((S.meta[v] || {}).lastSeen || 0)) / 864e5);
      (o.log = o.log || []).unshift({ t: now, x: `While you were away, peace with ${n.name} was signed on your behalf (you had been inactive ${away >= 1 ? away + ' day' + (away > 1 ? 's' : '') : 'over a day'} and they offered peace).` }); o.log = o.log.slice(0, 60);
      (n.log = n.log || []).unshift({ t: now, x: `${o.name} has been inactive, so your peace offer was accepted on their behalf. The war is over.` }); n.log = n.log.slice(0, 60);
      addNote(u, 'diplo', `${o.name} has been inactive for over a day, so your peace offer was accepted on their behalf. The war is over.`);
      addNote(v, 'diplo', `While you were away, peace with ${n.name} was signed on your behalf. The war is over.`);
      sendNation(u); sendNation(v); changed++;
    }
  }
  if (changed) persist();
}
setInterval(() => { try { peaceSweep(); } catch (e) { logErr('peaceSweep: ' + e.message); } }, 5 * 60e3).unref(); setTimeout(() => { try { peaceSweep(); } catch (e) {} }, 8000);
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
// ---------- game check-up: a wide scan for anything the admins may want to look at ----------
S.moneyLog = Array.isArray(S.moneyLog) ? S.moneyLog : [];
function moneySample(W) { const last = S.moneyLog[S.moneyLog.length - 1]; if (last && Date.now() - last.t < 55 * 60e3) return; const c = worldCash(W); S.moneyLog.push({ t: c.t, all: c.all, players: c.players }); if (S.moneyLog.length > 80) S.moneyLog.splice(0, S.moneyLog.length - 80); }
function gameAudit() {
  const W = mkWorld(), now = Date.now(), out = [], M = WP.moneyS, nm = u => (W.A[u] || {}).name || (S.users[u] || {}).name || '?';
  const add = (sev, cat, title, detail, fix, items) => out.push({ sev, cat, title, detail: detail || '', fix: fix || '', items: (items || []).slice(0, 25) });
  const seen = u => (S.meta[u] || {}).lastSeen || 0, human = Object.keys(W.A).filter(u => !W.A[u].ai && S.users[u]), active = human.filter(u => now - seen(u) < 24 * HOUR);
  const it = (u, extra) => ({ id: S.users[u] ? u : null, name: nm(u), extra });
  // --- money ---
  const cash = worldCash(W), past = S.moneyLog.find(x => now - x.t <= 26 * HOUR && now - x.t >= 22 * HOUR) || S.moneyLog[0];
  if (past && past.players > 0) { const ch = (cash.players - past.players) / past.players * 100;
    if (ch < -25) add('amber', 'Economy', `Players' money fell ${Math.round(-ch)}% since ${new Date(past.t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}`, `${M(past.players)} → ${M(cash.players)}.`, 'Usually big prestige purchases (wonder stages, cosmetics, grand projects); check the news feed. If purchases don’t explain it, look at war costs and prestige-unit upkeep below.');
    else if (ch > 60 && S.fresh) add('info', 'Economy', `Players' money rose ${Math.round(ch)}% in about a day`, `${M(past.players)} → ${M(cash.players)}. Normal in a fresh-start season: every nation started from almost nothing and is growing fast.`, '');
    else if (ch > 60) add('amber', 'Economy', `Players' money rose ${Math.round(ch)}% since ${new Date(past.t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}`, `${M(past.players)} → ${M(cash.players)}. Fast growth leads to inflation of prices players think are "cheap".`, 'Check the biggest earners below and recent gifts in the Activity log.');
    else add('ok', 'Economy', `Players' money is steady (${ch >= 0 ? '+' : ''}${Math.round(ch)}% in about a day)`, `${M(cash.players)} held by players, ${M(cash.ai)} by AI nations.`); }
  else add('info', 'Economy', 'Money trend not available yet', 'The check-up starts recording total money every hour from now on; the trend shows after a day.');
  const pc = active.map(u => [u, W.A[u].cash || 0]).sort((a, b) => b[1] - a[1]), totA = pc.reduce((a, x) => a + Math.max(0, x[1]), 0);
  if (pc.length >= 3 && totA > 0) { const share = Math.max(0, pc[0][1]) / totA; if (share > .5) add(share > .75 ? 'red' : 'amber', 'Economy', `One player holds ${Math.round(share * 100)}% of all active players' money`, `${nm(pc[0][0])} has ${M(pc[0][1])}.`, 'Not a bug by itself, but check how they earned it (casino, poker, gifts, trades) in their timeline.', [it(pc[0][0], M(pc[0][1]))]); }
  const med = pc.length ? pc[Math.floor(pc.length / 2)][1] : 0, rich = pc.filter(([u, c]) => c > 5e11 && c > med * 25);
  if (rich.length) add('info', 'Economy', `${rich.length} player${rich.length > 1 ? 's are' : ' is'} far richer than everyone else`, `More than 25 times the typical active player (${M(med)}).`, 'Worth a look in their timeline; the Prestige page gives them things to spend on.', rich.map(([u, c]) => it(u, M(c))));
  if (cash.all > 0 && cash.ai / cash.all > .7) add('info', 'Economy', `AI nations hold ${Math.round(cash.ai / cash.all * 100)}% of all money`, '', 'Normal when few players are online; AI money never reaches players unless they trade or conquer.');
  // --- players in trouble ---
  const broke = active.filter(u => (W.A[u].cash || 0) < 1e6 && (W.A[u].debt || 0) > 0); if (broke.length) add('amber', 'Players', `${broke.length} active player${broke.length > 1 ? 's are' : ' is'} broke and in debt`, 'Treasury under $1M with debt.', 'Their timeline shows why (war costs, upkeep, casino). Players → Fix problems / Give a gift can help.', broke.map(u => it(u, `${M(W.A[u].cash || 0)}, debt ${M(W.A[u].debt || 0)}`)));
  const nearDef = human.filter(u => (W.A[u].debt || 0) > (W.A[u].gdp || 1) * 1.6); if (nearDef.length) add('red', 'Players', `${nearDef.length} nation${nearDef.length > 1 ? 's are' : ' is'} close to bankruptcy`, 'Debt above 1.6× GDP; at 2× they default (−30 stability, −20 approval, GDP −15%).', 'Warn them, or lower their debt in Players → edit the nation.', nearDef.map(u => it(u, `debt ${M(W.A[u].debt)} vs GDP ${M(W.A[u].gdp || 0)}`)));
  const def = human.filter(u => W.A[u].defaulted && now - W.A[u].defaulted < 48 * HOUR); if (def.length) add('amber', 'Players', `${def.length} nation${def.length > 1 ? 's' : ''} defaulted in the last 48 hours`, '', 'Check what drove them there.', def.map(u => it(u, 'defaulted ' + Math.round((now - W.A[u].defaulted) / HOUR) + 'h ago')));
  const warDrain = human.map(u => [u, core.warCostH(W, u)]).filter(([u, c]) => c > 0 && c * 24 > Math.max(1, W.A[u].cash || 0)); if (warDrain.length) add('amber', 'Players', `${warDrain.length} player${warDrain.length > 1 ? 's are' : ' is'} being drained by war costs`, 'A day of war costs is more than their whole treasury.', 'Their war will push them into debt. Make peace, or ease the cost (Repair → Fix a nation → End all of its wars).', warDrain.map(([u, c]) => it(u, `${M(c)}/h, treasury ${M(W.A[u].cash || 0)}`)));
  const puDrain = human.map(u => [u, core.puUpkeepH(W, W.A[u])]).filter(([u, c]) => c > 0 && (W.A[u].cash || 0) < c * 6); if (puDrain.length) add('amber', 'Players', `${puDrain.length} player${puDrain.length > 1 ? 's' : ''} will lose prestige units soon`, 'Their treasury covers less than 6 hours of upkeep; units are scrapped when it runs out.', '', puDrain.map(([u, c]) => it(u, `upkeep ${M(c)}/h, treasury ${M(W.A[u].cash || 0)}`)));
  const crisis = active.filter(u => { const n = W.A[u]; return n.approval < 20 || n.stability < 15 || n.infl > 25 || n.unemp > 25; }); if (crisis.length) add('info', 'Players', `${crisis.length} active nation${crisis.length > 1 ? 's are' : ' is'} in a domestic crisis`, 'Approval under 20, stability under 15, inflation over 25% or unemployment over 25%.', 'Usually their own choices; Fix problems → raise approval and stability if something unfair caused it.', crisis.map(u => { const n = W.A[u]; return it(u, `approval ${Math.round(n.approval)}, stability ${Math.round(n.stability)}, inflation ${Math.round(n.infl)}%, unemployment ${Math.round(n.unemp)}%`); }));
  const casinoWin = human.filter(u => ((W.A[u].casino || {}).net || 0) > 2e10); if (casinoWin.length) add('amber', 'Casino', `${casinoWin.length} player${casinoWin.length > 1 ? 's have' : ' has'} won over $20B from the casino`, 'Possible with luck, but worth checking.', 'Casino tab shows every player’s plays; the Provably fair page lets you verify results.', casinoWin.map(u => it(u, '+' + M(W.A[u].casino.net))));
  const CT = casinoTotals(), hNet = Object.values(CT).reduce((a, x) => a - (x.net || 0), 0); if (Object.keys(CT).length && hNet < 0) add('amber', 'Casino', 'The house is losing money overall', `Players are ahead by ${M(-hNet)} across all games.`, 'Fine over short periods; if it lasts, look at which game in the Casino tab.');
  // --- poker ---
  let atTables = 0, stuck = [], away = 0; for (const t of Object.values(S.poker.tables)) { for (const s of t.seats) if (s) { atTables += s.stack; if (s.sitOut) away++; } if (t.hand && !t.hand.done) { atTables += PK.potTotal(t.hand); if (t.hand.deadline && now - t.hand.deadline > 120e3) stuck.push(t.name); } }
  if (S.fresh) { const se_ = S.seasons && S.seasons.cur; add('info', 'Season', `${se_ ? se_.name : 'A fresh-start season'} is running`, se_ && se_.end ? `It ends by itself on ${new Date(se_.end).toUTCString().slice(0, 22)} UTC; the real world then comes back with the prizes added.` : 'The real world is saved and set aside until it ends.', ''); const alt_ = path.join(BACKUP_DIR, `season-realworld-${S.fresh.id}.json`); if (!fs.existsSync(FRESH_FILE)) add(fs.existsSync(alt_) ? 'amber' : 'red', 'Season', fs.existsSync(alt_) ? 'The main saved copy of the real world is missing (the backup copy is fine)' : 'Both saved copies of the real world are missing', fs.existsSync(alt_) ? 'The season will still end normally using the backup copy.' : 'The real world cannot come back automatically at the end of the season.', fs.existsSync(alt_) ? '' : 'Do not end or cancel the season; ask for help first.'); else add('ok', 'Season', 'The saved real world is safe', 'Two copies are on disk.', ''); }
  if (stuck.length) add('red', 'Poker', `${stuck.length} poker hand${stuck.length > 1 ? 's look' : ' looks'} stuck`, stuck.join(', '), 'Casino tab → Cash out every table returns all chips safely.');
  if (atTables > 0) add('info', 'Poker', `${M(atTables)} in chips is at the poker tables`, `${away} player${away === 1 ? '' : 's'} sitting out.`, 'This money is not in any treasury until they leave the table.');
  // --- alliances ---
  const lostLead = Object.values(S.blocs || {}).filter(b => now - seen(b.leader) > 7 * 864e5 && (b.members || []).some(m => now - seen(m) < 3 * 864e5)); if (lostLead.length) add('amber', 'Alliances', `${lostLead.length} alliance${lostLead.length > 1 ? 's have' : ' has'} a leader who hasn’t played for a week`, 'Active members can’t start projects or use the treasury beyond co-leader limits.', 'Alliances tab → make an active member the leader.', lostLead.map(b => ({ name: `${b.name} [${b.tag}]`, extra: `leader ${nm(b.leader)} last seen ${Math.round((now - seen(b.leader)) / 864e5)}d ago` })));
  const bigBank = Object.values(S.blocs || {}).filter(b => (b.bank || 0) > 1e11 && !b.proj); if (bigBank.length) add('info', 'Alliances', `${bigBank.length} alliance${bigBank.length > 1 ? 's are' : ' is'} sitting on a big unused treasury`, '', 'Nothing to fix; their next projects will spend it.', bigBank.map(b => ({ name: b.name, extra: M(b.bank) })));
  // --- land and wars ---
  const idleLand = human.filter(u => now - seen(u) > 14 * 864e5 && core.hexesOf(W, u).length >= 20); if (idleLand.length) add('info', 'World', `${idleLand.length} inactive player${idleLand.length > 1 ? 's hold' : ' holds'} a lot of land`, 'Not seen for 2 weeks, 20+ provinces each. Their land is locked away from active players.', 'If they don’t return, Players → Reset nation frees the land.', idleLand.map(u => it(u, `${core.hexesOf(W, u).length} provinces, last seen ${Math.round((now - seen(u)) / 864e5)}d ago`)));
  const longWars = []; const sw = new Set(); for (const u of Object.keys(W.A)) for (const v of core.wars(W, u)) { const k = [u, v].sort().join('|'); if (sw.has(k)) continue; sw.add(k); const r1 = (W.A[u].rel || {})[v] || {}, r2 = (W.A[v].rel || {})[u] || {}, since = Math.max(r1.war || 0, r2.war || 0); if (now - since > 72 * HOUR) longWars.push({ name: `${nm(u)} vs ${nm(v)}`, extra: Math.round((now - since) / 864e5) + ' days' }); }
  if (longWars.length) add('info', 'World', `${longWars.length} war${longWars.length > 1 ? 's have' : ' has'} lasted more than 3 days`, 'Both sides keep paying war costs.', 'War room → Force peace if a war is stuck or one-sided.', longWars);
  const rog = Object.keys(W.A).filter(u => core.rogue(W, W.A[u])); if (rog.length) add('info', 'World', `${rog.length} rogue state${rog.length > 1 ? 's' : ''}`, '', 'War room → Clear if one is stuck that way unfairly.', rog.map(u => it(u, W.A[u].ai ? 'AI' : '')));
  const slowW = []; for (const u of human) for (const [k, x] of Object.entries(W.A[u].uw || {})) if (now - seen(u) > 2 * 864e5) slowW.push(it(u, `${(WP.UWONDERS[k] || {}).n || k}: stage ${x.stage}/4`)); if (slowW.length) add('info', 'World', 'World Wonders left half-built by inactive players', 'They don’t block anyone; others can still race and finish first.', '', slowW);
  // --- votes ---
  const vt = (S.stats[today()] || {}).votes || 0; if (active.length && vt / active.length > 10) add('amber', 'Economy', `${vt} vote bonuses claimed today (${Math.round(vt / active.length)} per active player)`, 'Each pays 1% of GDP ($1M–$25M).', 'If it’s too much money, the wait between bonuses can go from 6 to 12 hours.');
  // --- server ---
  const mem = Math.round(process.memoryUsage().rss / 1048576), errs = health.errors.filter(e => now - e.t < 864e5).length;
  if (health.saveError) add('red', 'Server', 'Saving the game is failing', health.saveError, 'Download a backup now (Game settings) and check the Railway volume.');
  if ((health.loopMs || 0) > 1500) add('amber', 'Server', `The world update takes ${Math.round(health.loopMs)} ms`, 'It runs every 30 seconds; over a few seconds players notice lag.', '');
  if (mem > 450) add('amber', 'Server', `The server is using ${mem} MB of memory`, '', 'A restart (redeploy) clears it if it keeps growing.');
  if (errs > 20) add('amber', 'Server', `${errs} server errors in the last 24 hours`, '', 'Activity log → Server errors shows them.');
  const lb = S.lastBackupT || 0; if (now - lb > 30 * HOUR) add('amber', 'Server', 'No nightly backup in over 30 hours', lb ? 'Last one ' + Math.round((now - lb) / HOUR) + ' hours ago.' : 'None recorded yet.', 'Download one manually from Game settings → Backups.');
  if (!listSnaps().length) add('amber', 'Server', 'No rollback snapshots yet', 'A snapshot is saved every 10 minutes after a restart.', '');
  let fileMB = 0; try { fileMB = fs.statSync(FILE).size / 1048576; } catch (e) {} if (fileMB > 25) add('amber', 'Server', `The save file is ${Math.round(fileMB)} MB`, 'Large saves slow every save and backup.', '');
  if (S.fresh && !fs.existsSync(FRESH_FILE)) add('red', 'Server', 'A fresh season is running but the saved real world file is missing', '', 'There is a backup copy in the backups folder; contact support before ending the season.');
  if (!out.some(x => x.cat === 'Server')) add('ok', 'Server', 'Server healthy', `Memory ${mem} MB, world update ${Math.round(health.loopMs || 0)} ms, ${errs} errors today, save file ${fileMB.toFixed(1)} MB.`);
  // --- moderation ---
  const reps = (S.reports || []).filter(r => !r.done).length, fl = (S.flags || []).filter(f => now - f.t < 864e5).length, bugs = (S.bugs || []).filter(b => !b.done && b.kind !== 'idea').length;
  if (reps) add('amber', 'Moderation', `${reps} player report${reps > 1 ? 's' : ''} waiting`, '', 'Moderation tab.'); if (fl) add('info', 'Moderation', `${fl} cheat flag${fl > 1 ? 's' : ''} in the last 24 hours`, '', 'Cheat watch tab.'); if (bugs) add('info', 'Moderation', `${bugs} open bug report${bugs > 1 ? 's' : ''}`, '', 'Bugs tab.');
  const order = { red: 0, amber: 1, info: 2, ok: 3 }; out.sort((a, b) => order[a.sev] - order[b.sev]);
  return { t: now, items: out, players: human.length, active: active.length };
}
function rankPoint(W) {
  const n = {}; for (const u of Object.keys(W.A)) n[u] = [core.score(W, u), Math.round(W.A[u].gdp || 0), Math.round(core.power(W, u)), core.hexesOf(W, u).length];
  const now = Date.now(), wc = worldCash(W); RH.push({ t: now, n, c: wc.all, cp: wc.players }); /* world money totals only: each treasury stays private */ RH = RH.filter(p => now - p.t <= 7 * 24 * HOUR); rhGz = null;
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
function gameState() { const nations = {}; for (const [k, v] of Object.entries(S.docs)) if (k.startsWith('nations/')) nations[k.slice(8)] = v; return { t: Date.now(), map2: !!S.map2, world: S.fresh ? S.fresh.id : 'real', nations, council: S.council, blocs: S.blocs, crisis: S.crisis, games: S.games, dis: S.dis, event: S.event, nextEvent: S.nextEvent, lastEventKey: S.lastEventKey, fallen: S.fallen }; }
function takeSnap(tag) {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true }); const t = Date.now(); lastSnap = t;
    const name = `snap-${t}${tag ? '-' + tag : ''}.json.gz`; fs.writeFileSync(path.join(SNAP_DIR, name), zlib.gzipSync(JSON.stringify(gameState())));
    for (const f of fs.readdirSync(SNAP_DIR)) { const m = f.match(/^snap-(\d+)/); if (m && t - +m[1] > 50 * HOUR) fs.unlinkSync(path.join(SNAP_DIR, f)); }
    return name;
  } catch (e) { logErr('Snapshot failed: ' + e.message); return null; }
}
function listSnaps() { try { return fs.readdirSync(SNAP_DIR).map(f => { const m = f.match(/^snap-(\d+)(?:-([a-z]+))?\.json\.gz$/); return m && { name: f, t: +m[1], tag: m[2] || '', size: fs.statSync(path.join(SNAP_DIR, f)).size }; }).filter(Boolean).sort((a, b) => b.t - a.t); } catch (e) { return []; } }
function rollback(name, by) {
  try { pkCashAll('The world was rolled back'); } catch (e) {}
  const snaps = listSnaps(), sn = snaps.find(x => x.name === name); if (!sn) throw Object.assign(new Error('That snapshot no longer exists.'), { status: 404 });
  const st = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, sn.name))));
  if ((st.world || 'real') !== (S.fresh ? S.fresh.id : 'real')) throw Object.assign(new Error(S.fresh ? 'That snapshot is from the real world, and a fresh-start season is running. To bring the real world back, use Seasons → Restore the real world.' : 'That snapshot is from a fresh-start season world, not the real world, so it cannot be rolled back to.'), { status: 400 });
  takeSnap('undo'); const now = Date.now();
  for (const k of Object.keys(S.docs)) if (k.startsWith('nations/')) delete S.docs[k];
  for (const [id, n] of Object.entries(st.nations)) { n.lastTick = now; if (S.map2 && !st.map2) map2Grant(n); S.docs['nations/' + id] = n; }
  S.council = st.council || { props: [], active: {} }; if (st.blocs) S.blocs = Object.assign(Object.create(null), st.blocs); if (st.crisis !== undefined) S.crisis = st.crisis; if (st.games !== undefined) S.games = st.games; if (Array.isArray(st.dis)) S.dis = st.dis; S.event = st.event || null; S.nextEvent = st.nextEvent || now + 6 * HOUR; S.lastEventKey = st.lastEventKey; S.fallen = st.fallen || [];
  persist(true); const when = new Date(sn.t).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' });
  systemMessage(`⏪ The world has been rolled back to ${when} (Mountain time) by the administrators.`);
  broadcast('reload', { t: now }); audit(by, 'Rolled back the world', null, `to ${new Date(sn.t).toISOString()} (${Math.round((now - sn.t) / 60000)} min ago)`);
  return sn;
}
let lastFull = 0;
function fullBackup() { // everything (accounts, mail, donations and the world), compressed, every 3 hours; the last 16 are kept (2 days)
  const t = Date.now(); if (t - lastFull < 3 * HOUR) return; lastFull = t;
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); const tmp = path.join(BACKUP_DIR, `full-${t}.json.gz.tmp`); fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(S))); fs.renameSync(tmp, path.join(BACKUP_DIR, `full-${t}.json.gz`)); S.lastFullT = t;
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^full-\d+\.json\.gz$/.test(f)).sort(); for (const f of files.slice(0, Math.max(0, files.length - 16))) fs.unlinkSync(path.join(BACKUP_DIR, f));
    const cz = fs.readdirSync(BACKUP_DIR).filter(f => /^chaos-realworld-\d+\.json$/.test(f)).sort(); for (const f of cz.slice(0, Math.max(0, cz.length - 10))) fs.unlinkSync(path.join(BACKUP_DIR, f)); // copies of the real world from before each Chaos world: the last 10
  } catch (e) { logErr('Full backup failed: ' + e.message); }
}
function nightlyBackup() {
  const now = new Date(); if (now.getUTCHours() < 9) return; // after ~3 AM US Mountain time
  const day = today(); if (S.lastBackup === day) return;
  try {
    fs.writeFileSync(path.join(BACKUP_DIR, `world-${day}.json`), JSON.stringify(S)); S.lastBackup = day; S.lastBackupT = Date.now(); persist();
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^world-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(BACKUP_DIR, f));
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
  if (String(b.to || '') === HD) return hdIn(me, b); // anyone can ask the Helpdesk, even guests, muted or jailed players
  if (String(b.to || '') === 'admin-test') throw Object.assign(new Error('Test is an admin test account that plays in a separate test world. It cannot receive mail.'), { status: 400 });
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
  try { pkStandUser(id, null); } catch (e) {}
  const W = mkWorld(); if (W.A[id]) { delete W.A[id]; for (const [u, n] of Object.entries(W.A)) if (n.rel && n.rel[id]) { delete n.rel[id]; W.changed.add(u); } commit(W); }
  for (const c of COLS) if (S.docs[c + '/' + id]) setDoc(c, id, null);
  for (const [t, s] of Object.entries(S.sessions)) if (s.uid === id) delete S.sessions[t];
  for (const c of clients) if (c.uid === id) endStream(c);
  for (const k of Object.keys(S.mail)) S.mail[k] = (S.mail[k] || []).filter(m => m.from !== id && m.to !== id);
  delete S.users[id]; delete S.meta[id]; delete S.actlog[id]; delete S.botsig[id]; delete S.mail[id]; delete S.notes[id]; delete S.push[id]; broadcast('user', { id, name: null }); persist();
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
// ---------- script check: signs that a program, not a person, is playing ----------
// For every action: when it happened, which one, how long after the operation became ready it was run, whether the game page was open, and whether its tab was visible.
function botRecord(uid, b, readyAt, req, cdLen) {
  const now = Date.now(), s = S.botsig[uid] = S.botsig[uid] || { a: [] };
  const vis = String(req.headers['x-wp-vis'] || '') === 'v' ? 'v' : String(req.headers['x-wp-vis'] || '') === 'h' ? 'h' : 'n';
  let live = 0; for (const c of clients) if (c.uid === uid) { live = 1; break; }
  const ch = String(req.headers['x-wp-c'] || ''), click = ch === 't' || ch === 'u' || ch === 'n' ? ch : 'x', inp = req.headers['x-wp-in'] != null ? Math.max(0, Math.min(99999, +req.headers['x-wp-in'] || 0)) : -1;
  let pt = null; { const m = String(req.headers['x-wp-p'] || '').match(/^(-?\d{1,5}),(-?\d{1,5}),(-?\d{1,4}),(\d{1,5}),([mtpk]),(\d{10,14})$/); if (m) pt = [+m[1], +m[2], +m[3], +m[4], m[5], +m[6]]; } // the click behind this action: x, y, press ms, mouse travel, pointer type, click time
  s.a.push([now, b.c === 'act' ? String(b.k).slice(0, 16) : String(b.c).slice(0, 16), readyAt > 0 && readyAt <= now ? now - readyAt : -1, vis, live, click, inp, cdLen || 0, pt]);
  const cut = now - 72 * HOUR; while (s.a.length && (s.a.length > 600 || s.a[0][0] < cut)) s.a.shift();
  if (!hcExempt(uid) && !(S.hc[uid] || {}).jail) { const why = scriptProof(s.a); if (why) autoJail(uid, why, true); } // clear signs of a script: straight to cheat jail
}
// other warnings about a player from the last 7 days (shared networks, aid between them, speed flags), for the verdict box
function netWarn(uid) { const from = Date.now() - 7 * 864e5, f = (S.flags || []).filter(x => x.uid === uid && x.t >= from); const kinds = {}; for (const x of f) { const k = /same network|second ac/i.test(x.r) ? 'Shares a network with another account' : /faster than a person|bot|script/i.test(x.r) ? 'Sent actions faster than a person can click' : /charged back/i.test(x.r) ? 'Charged back a donation' : 'Other flag'; kinds[k] = (kinds[k] || 0) + 1; } return Object.entries(kinds).map(([k, n]) => `${k} (${n}×)`); }
S.cheatReview = S.cheatReview || {};
// ANTI-CHEAT LADDER (automatic). A player whose case reaches "act" (red) is 1) warned by mail with the evidence; if the signs continue in what they do AFTER the warning,
// 2) suspended 24 hours, 3) 72 hours, 4) jailed until an admin reviews. Strikes expire after 14 days. "Not cheating" protects for 7 days. Admins are told of every step.
S.acl = S.acl || {};
const ACL = { graceH: 12, s1H: 24, s2H: 72, memD: 14, everyMin: 10 };
function aclMail(uid, subj, body) { const t = Date.now(); S.mail[uid] = [{ id: rid(), from: HD, to: uid, t, subj, body, box: 'in', read: false }, ...(S.mail[uid] || [])].slice(0, 200); try { sendTo(uid, 'mail', { unread: S.mail[uid].filter(m => m.box === 'in' && !m.read).length }); } catch (e) {} addNote(uid, 'mail', `Anti-cheat: ${subj}`); }
function aclTell(text) { for (const [id, u] of Object.entries(S.users)) if (u.admin) addNote(id, 'event', `🛡 Anti-cheat: ${text}`); }
const aclEvidence = r => [...(r.case.strong || []), ...(r.why || [])].slice(0, 6).map(x => '• ' + x).join('\n');
function aclSuspend(uid, hours, r, strike) { const h = hcState(uid), now = Date.now(), until = now + hours * HOUR, nm = nationName(uid);
  h.jail = { t: now, until, script: 1, why: `Suspended ${hours} hours automatically: kept playing with a script after a warning` }; h.pend = null; h.lock = 0; hcLog(uid, 'jailed', { why: h.jail.why });
  const n = S.docs['nations/' + uid]; if (n) { n.shield = Math.max(n.shield || 0, until); setDoc('nations', uid, n); } // nobody can attack a nation whose owner is locked out
  aclMail(uid, `Suspended for ${hours} hours`, `Our anti-cheat system found that the signs of automated play continued after your warning:\n\n${aclEvidence(r)}\n\nYour account is suspended for ${hours} hours. Your nation is protected from attack during that time and nothing has been taken.\n\n${strike >= 2 ? 'This is your second suspension. If it happens again your account will be locked until an admin reviews it.' : 'If it happens again the suspension will be 72 hours.'}\n\nIf this is a mistake, reply to the Helpdesk and an admin will look at it.`);
  try { sendTo(uid, 'jail', { msg: suspMsg(h.jail) }); } catch (e) {}
  flag(uid, `Suspended ${hours} hours automatically (strike ${strike}): script signs continued after a warning`); audit('Anti-cheat', 'Suspended player automatically', nm, `${hours} hours, strike ${strike}`);
  S.fairlog.unshift({ t: now, action: 'Anti-cheat suspended a player', target: null, detail: `${hours} hours for automated play, after a warning` }); S.fairlog = S.fairlog.slice(0, 3000);
  aclTell(`${nm} was suspended for ${hours} hours (strike ${strike}). Release them from Cheat watch if this is wrong.`); }
function aclRun() { if (S.config.acAuto === false || (S.chaos && S.chaos.on)) return; const now = Date.now(); let ch = false;
  for (const [u, a] of Object.entries(S.acl)) { a.strikes = (a.strikes || []).filter(t => now - t < ACL.memD * 864e5); if (!a.strikes.length && now - (a.warn || 0) > ACL.memD * 864e5) { delete S.acl[u]; ch = true; } }
  for (const [u, h] of Object.entries(S.hc || {})) if (h && h.jail && h.jail.until && now >= h.jail.until) hcJail(u); // finished suspensions end on their own
  const base = scriptCheck().filter(r => r.case.level === 'act' && !r.jail && !hcExempt(r.id) && !cleanPass(r.id) && S.users[r.id] && !S.users[r.id].banned);
  for (const r of base) { const uid = r.id, a = S.acl[uid]; hcJail(uid);
    if (!a || !a.warn) { S.acl[uid] = { warn: now, from: now, strikes: (a && a.strikes) || [] }; ch = true;
      aclMail(uid, 'Warning: signs of automated play', `Our anti-cheat system noticed patterns in how your account plays that look like a script, macro or auto-clicker:\n\n${aclEvidence(r)}\n\nAutomated play is not allowed: it is unfair to everyone who plays by hand. Nothing has been done to your account. If these signs continue, your account will be suspended for 24 hours automatically.\n\nIf you are not using any automation, reply to the Helpdesk and an admin will review it.`);
      flag(uid, 'Warned automatically: signs of automated play'); audit('Anti-cheat', 'Warned player automatically', nationName(uid), (r.case.strong || []).join('; ').slice(0, 300)); aclTell(`${nationName(uid)} was sent an automatic warning (${r.case.conf.toLowerCase()} evidence). Mark them "Not cheating" on Cheat watch to stop the ladder for 7 days.`); continue; }
    if (now - a.from < ACL.graceH * HOUR) continue; // give them time to read the warning and stop
    const again = scriptCheck({ [uid]: a.from }).find(x => x.id === uid); if (!again || again.case.level !== 'act') continue; // judged only on what they did since the warning or the last suspension
    const k = a.strikes.length + 1; a.strikes.push(now); a.from = now; ch = true;
    if (k >= 3) { autoJail(uid, 'kept playing with a script after a warning and two suspensions', true, true); aclMail(uid, 'Account locked for review', 'The signs of automated play continued after two suspensions. Your account is locked until an admin reviews it. Your nation is safe. You can message the Helpdesk.'); aclTell(`${nationName(uid)} was locked in cheat jail after a warning and two suspensions. It needs your review.`); }
    else aclSuspend(uid, k === 1 ? ACL.s1H : ACL.s2H, again, k); }
  if (ch) persist(); }
setInterval(() => { try { aclRun(); } catch (e) { logErr('aclRun: ' + (e.stack || e.message)); } }, ACL.everyMin * 60e3).unref(); setTimeout(() => { try { aclRun(); } catch (e) { logErr('aclRun: ' + (e.stack || e.message)); } }, 45e3).unref();
const CLEAN_H = 168; // hours (7 days) a "Not cheating" decision protects a player: green on Cheat watch, and no automatic warnings, suspensions or jail except on hard proof
const cleanPass = uid => { const r = (S.cheatReview || {})[uid]; return !!(r && r.d === 'clean' && Date.now() - r.t < CLEAN_H * HOUR); };
function scriptCheck(since) { // since: optional { uid: time } to judge a player only on what they did after that time (used after a warning)
  const now = Date.now(), from0 = now - 48 * HOUR, out = [], sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); }, med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  for (const [uid, s] of Object.entries(S.botsig)) {
    const u = S.users[uid]; if (!u) continue; const from = Math.max(from0, (since && since[uid]) || 0); const L = (s.a || []).filter(x => x[0] >= from); if (L.length < 10) continue;
    const why = []; let score = 0;
    // 1. reaction time: how soon after an operation was ready it was run (only when they were around: within 10 minutes)
    const D = L.filter(x => x[2] >= 0 && x[2] <= 10 * 60e3).map(x => x[2]), fast = D.filter(d => d < 1500).length, fp = D.length ? fast / D.length : 0;
    if (D.length >= 15) { if (fp >= .8) score += 3; else if (fp >= .5) score += 2; else if (fp >= .25) score += 1;
      if (fp >= .25) why.push(`Ran operations within 1.5 seconds of them becoming ready ${Math.round(fp * 100)}% of the time (${fast} of ${D.length}; a typical delay of ${(med(D) / 1000).toFixed(1)} s)`); }
    const quick = D.filter(d => d < 15000); if (quick.length >= 15 && sd(quick) < 400) { score += 2; why.push(`Almost exactly the same reaction time every time (${(med(quick) / 1000).toFixed(2)} s, varying by only ${Math.round(sd(quick))} ms); people vary by seconds`); }
    // 2. the same operation at a perfectly regular rhythm
    const byK = {}; for (const x of L) (byK[x[1]] = byK[x[1]] || []).push(x[0]);
    for (const [k, ts] of Object.entries(byK)) { if (ts.length < 10) continue; const iv = []; for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]); const m = iv.reduce((a, b) => a + b, 0) / iv.length; if (m > 0 && sd(iv) / m < .04) { score += 2; why.push(`Ran "${k}" ${ts.length} times at an almost perfectly even rhythm (every ${m < 60e3 ? (m / 1000).toFixed(1) + ' s' : (m / 60e3).toFixed(1) + ' min'})`); break; } }
    // 3. no game page open, or a hidden tab
    const off = L.filter(x => !x[4]).length, hid = L.filter(x => x[3] === 'h').length;
    if (off / L.length >= .3) { score += 3; why.push(`${Math.round(off / L.length * 100)}% of actions were sent with no game page open (straight to the server)`); }
    if (hid / L.length >= .3) { score += 2; why.push(`${Math.round(hid / L.length * 100)}% of actions came from a hidden browser tab (a person can't click a tab they can't see)`); }
    // 4. no sleep
    const span = L[L.length - 1][0] - L[0][0]; let gap = 0; for (let i = 1; i < L.length; i++) gap = Math.max(gap, L[i][0] - L[i - 1][0]); gap = Math.max(gap, now - L[L.length - 1][0] < HOUR ? 0 : 0);
    const hrs = new Set(L.map(x => Math.floor(x[0] / HOUR))).size;
    if (span >= 30 * HOUR && gap < 3 * HOUR) { score += 2; why.push(`No break longer than ${(gap / HOUR).toFixed(1)} hours in ${Math.round(span / HOUR)} hours of play (active in ${hrs} different hours)`); }
    // 6. no real person behind the action: no real mouse, finger or keyboard (only pages updated after this check was added send these signs)
    const H = L.filter(x => x[5] && x[5] !== 'x'), uC = H.filter(x => x[5] === 'u').length, nC = H.filter(x => x[5] === 'n' && x[4]).length, idle = H.filter(x => x[6] >= 120).length;
    if (H.length >= 10) {
      if (uC / H.length >= .2) { score += 4; why.push(`${Math.round(uC / H.length * 100)}% of actions came from buttons pressed by code, not a real mouse, finger or keyboard`); }
      if (nC / H.length >= .3) { score += 3; why.push(`${Math.round(nC / H.length * 100)}% of actions were sent by code without any button being pressed`); }
      if (idle / H.length >= .3) { score += 3; why.push(`${Math.round(idle / H.length * 100)}% of actions happened after 2+ minutes without any mouse, touch or keyboard use`); }
    }
    // 7. always on time: ran within 10 seconds of being ready nearly every time, and never slower than a short limit
    const D10 = D.filter(d => d <= 10000).length, srt = D.slice().sort((a, b) => a - b), p95 = srt.length ? srt[Math.floor(srt.length * .95)] : 0;
    if (D.length >= 30 && D10 / D.length >= .85) { score += 2; why.push(`Ran operations within 10 seconds of them becoming ready ${Math.round(D10 / D.length * 100)}% of the time (${D10} of ${D.length}); people get distracted`); }
    if (D.length >= 40 && p95 <= 15000) { score += 1; why.push(`95% of reactions were under ${Math.max(1, Math.round(p95 / 1000))} seconds over ${D.length} operations: never slow, never distracted`); }
    // 8. never missing a cycle: the same operation run every time it came ready, for hours on end
    let streak = { h: 0, k: '' };
    for (const [k, ts] of Object.entries(byK)) { const rows = L.filter(x => x[1] === k); for (let i = 0, st = 0; i < rows.length; i++) { const cd = rows[i][7] || 0; if (!cd) { st = i + 1; continue; } const nx = rows[i + 1]; if (nx && nx[0] - rows[i][0] <= cd * 1.25 + 30e3) continue; const dur = rows[i][0] - rows[st][0]; if (dur > streak.h && i - st + 1 >= 12) streak = { h: dur, k, n: i - st + 1 }; st = i + 1; } }
    if (streak.n < 12) streak = { h: 0, k: '', n: streak.n }; // a long-cooldown operation run on time two or three times in a row proves nothing
    if (streak.h >= 6 * HOUR) { score += 3; why.push(`Ran "${streak.k}" every time it was ready for ${(streak.h / HOUR).toFixed(1)} hours straight (${streak.n} times in a row)`); }
    else if (streak.h >= 3 * HOUR) { score += 2; why.push(`Ran "${streak.k}" every time it was ready for ${(streak.h / HOUR).toFixed(1)} hours straight (${streak.n} times in a row)`); }
    // 9. one long session with no real breaks
    let sess = 0, run0 = L[0][0]; for (let i = 1; i <= L.length; i++) { if (i === L.length || L[i][0] - L[i - 1][0] > 20 * 60e3) { sess = Math.max(sess, L[i - 1][0] - run0); if (i < L.length) run0 = L[i][0]; } }
    if (sess >= 8 * HOUR) { score += 1; why.push(`Played ${(sess / HOUR).toFixed(1)} hours in one go without a break of 20 minutes`); }
    // 10-12. auto-clickers press the real mouse button, so the browser trusts the click; they give themselves away by
    // clicking the exact same pixel every time, never moving the mouse between clicks, and holding the button for almost no time
    const seen = new Set(), CL = []; for (const x of L) { const q = x[8]; if (!q || q[4] === 'k' || seen.has(q[5])) continue; seen.add(q[5]); CL.push(q); } // one entry per click (Run all sends many actions from one click)
    const MC = CL.filter(q => q[4] === 'm'), spots = {}; for (const q of CL) { const k = q[0] + ',' + q[1]; spots[k] = (spots[k] || 0) + 1; }
    const top = Object.entries(spots).sort((a, b) => b[1] - a[1])[0], same = top ? top[1] / CL.length : 0;
    const still = MC.length ? MC.filter(q => q[3] === 0).length / MC.length : 0, timed = CL.filter(q => q[2] >= 0), quickP = timed.length ? timed.filter(q => q[2] <= 15).length / timed.length : 0, medP = timed.length ? med(timed.map(q => q[2])) : null;
    if (CL.length >= 12 && same >= .6) { score += 3; why.push(`${Math.round(same * 100)}% of clicks (${top[1]} of ${CL.length}) landed on exactly the same pixel; a hand is never that precise`); }
    if (MC.length >= 12 && still >= .7) { score += 2; why.push(`The mouse didn't move at all before ${Math.round(still * 100)}% of mouse clicks (${MC.filter(q => q[3] === 0).length} of ${MC.length}): the cursor stays parked while something clicks`); }
    if (timed.length >= 12 && quickP >= .6) { score += 3; why.push(`The button was held down for 15 milliseconds or less on ${Math.round(quickP * 100)}% of clicks (typical ${medP} ms); people hold a click for about 60 to 150 ms`); }
    // 13. the human check: failed it, kept tapping the wrong shape, or solved it too fast / without moving the mouse / with a click made by code
    const hs = hcSummary(uid, from); if (hs) {
      if (hs.fail) { score += Math.min(6, hs.fail * 3); why.push(`Failed the human check ${hs.fail} time${hs.fail > 1 ? 's' : ''} (three wrong shapes in a row)`); }
      else if (hs.miss >= 3) { score += 1; why.push(`Tapped the wrong shape ${hs.miss} times on human checks`); }
      const oddShare = hs.odd / Math.max(1, (hs.pass || 0) + hs.odd); hs.oddReal = hs.odd >= 2 && oddShare >= .4; // the right shape is sometimes already under the cursor (about 1 in 6), so a few odd passes among many normal ones are luck
      if (hs.oddReal) { score += 2; why.push(`Passed ${hs.odd} human checks in a way a person rarely does (instantly, without moving the mouse, or with a click made by code)`); }
      if (hs.expired >= 2) { score += 1; why.push(`Left ${hs.expired} human checks unanswered for over 10 minutes`); }
    }
    // 5. the existing speed flag
    const sf = (S.flags || []).filter(f => f.uid === uid && f.t >= from && /faster than a person/.test(f.r)).length; if (sf) { score += Math.min(2, sf); why.push(`Flagged ${sf} time${sf > 1 ? 's' : ''} for sending actions faster than a person can click`); }
    const n = S.docs['nations/' + uid];
    out.push({ id: uid, name: u.name, nation: n ? n.name : '', acts: L.length, react: D.length ? { n: D.length, fastPct: Math.round(fp * 100), med: Math.round(med(D)) } : null, offPct: Math.round(off / L.length * 100), hidPct: Math.round(hid / L.length * 100), hrs, gapH: Math.round(gap / HOUR * 10) / 10, real: H.length ? Math.round((H.length - uC - nC) / H.length * 100) : null, onTime: D.length ? Math.round(D10 / D.length * 100) : null, streakH: Math.round(streak.h / HOUR * 10) / 10, streakN: streak.n || 0, clicks: CL.length, samePct: CL.length >= 5 ? Math.round(same * 100) : null, stillPct: MC.length >= 5 ? Math.round(still * 100) : null, pressMs: timed.length >= 5 ? medP : null, net: netWarn(uid), hc: hs, jail: ((S.hc || {})[uid] || {}).jail || null, hourly: (() => { const H = new Array(48).fill(0); for (const x of L) { const i = Math.floor((x[0] - from0) / HOUR); if (i >= 0 && i < 48) H[i]++; } return H; })(), review: (S.cheatReview || {})[uid] || null, score, verdict: score >= 6 ? 'red' : score >= 3 ? 'amber' : 'ok', why });
  }
  for (const r of out) { r.case = caseFile(r); { const a = (S.acl || {})[r.id]; if (a) r.acl = { warn: a.warn || 0, strikes: (a.strikes || []).length, until: (r.jail && r.jail.until) || 0 }; }
    // you marked them "Not cheating": they stay green for 24 hours (unless locked in cheat jail), then are judged normally again
    const rv = r.review; if (rv && rv.d === 'clean' && now - rv.t < CLEAN_H * HOUR && !r.jail) { r.okUntil = rv.t + CLEAN_H * HOUR; r.verdict = 'ok'; r.case = { ...r.case, level: 'clear', tone: 'green', conf: 'None', action: `You marked them as not cheating, so they are protected for 7 days: they stay green and get no automatic warnings or suspensions (only hard proof, like a human check answered by code, can still jail them). After that they are judged normally again.` }; } }
  return out.sort((a, b) => (a.okUntil ? 1 : 0) - (b.okUntil ? 1 : 0) || b.score - a.score || b.acts - a.acts);
}
// turns one player's numbers into a decision: how worried to be, how sure, what to do, and evidence worded so it can be shown to them
function caseFile(r) {
  const strong = [], ev = [];
  const hc = r.hc || {};
  if (r.jail) strong.push('locked in cheat jail after five wrong answers in a row on the human check');
  if (hc.fail) strong.push(`failed the human check ${hc.fail} time${hc.fail > 1 ? 's' : ''}`);
  if (hc.oddReal) strong.push(`passed ${hc.odd} of ${(hc.pass || 0) + hc.odd} human checks in a way a person rarely does (instantly, with no mouse movement, or with a click made by code)`);
  if (r.samePct != null && r.samePct >= 60 && r.stillPct != null && r.stillPct >= 70) strong.push(`an auto-clicker pattern: ${r.samePct}% of clicks on the exact same pixel with the mouse not moving ${r.stillPct}% of the time`);
  else if (r.pressMs != null && r.pressMs <= 15) strong.push(`clicks held for only ${r.pressMs} ms (people hold a click 60–150 ms)`);
  if (r.real != null && r.real < 70) strong.push(`only ${r.real}% of actions came from a real click; the rest were sent by code`);
  if (r.streakH >= 6 && (r.streakN || 0) >= 20) strong.push(`ran the same operation every time it was ready for ${r.streakH} hours straight`);
  for (const w of r.why) ev.push(w);
  const n = strong.length, net = (r.net || []).length;
  let level, conf, action, tone;
  if (r.jail) { level = 'act'; conf = n >= 2 ? 'Strong' : 'Moderate'; action = n >= 2 ? 'Keep them locked. The jail plus other script signs make a strong case. Message them with the evidence, then suspend them for 72 hours or ban them for the rest of the season if they have been warned before.' : 'Open their human-check log first. If their taps were slow (a few seconds each) and the mouse moved normally, they were probably just clumsy: release them. If the answers were instant or made by code, keep them locked and message them with the evidence.'; tone = 'red'; }
  else if (r.verdict === 'red' && n >= 2) { level = 'act'; conf = 'Strong'; action = 'Suspend them for 24–72 hours and take back what they gained while scripting (resources, money). Send them the evidence below. If it happens again, ban them for the season.'; tone = 'red'; }
  else if (r.verdict === 'red') { level = 'act'; conf = 'Moderate'; action = 'Send a private warning with the evidence below and give them a chance to explain. They already get the human check twice as often. If the pattern continues over the next day, suspend them for 24 hours.'; tone = 'red'; }
  else if (r.verdict === 'amber') { level = 'watch'; conf = 'Weak'; action = 'Do not punish yet. One sign alone can be innocent (a fast player, a mouse resting on a button). Check again in 24 hours; if more signs appear, send a warning.'; tone = 'amber'; }
  else { level = 'clear'; conf = n ? 'Weak' : 'None'; action = 'No action needed: they play like a person.'; tone = 'green'; }
  if (net && level !== 'clear') action += ' They also share a network with another account: ask whether someone else in their home plays, and check whether the accounts send each other aid.';
  else if (net) { level = 'watch'; tone = 'amber'; conf = 'Weak'; action = 'No sign of a script, but they share a network with another account. Ask whether a family member or roommate plays; if the accounts trade aid, that is not allowed during a season.'; }
  return { level, tone, conf, action, strong, evidence: ev, net: r.net || [] };
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
  if ((st.world || 'real') !== (S.fresh ? S.fresh.id : 'real')) throw Object.assign(new Error(S.fresh ? 'That snapshot is from the real world; this player\'s nation right now is their season nation.' : 'That snapshot is from the season world, not the real world.'), { status: 400 });
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
// Invite rewards. The new player gets a welcome bonus. The inviter is paid in two parts: some when the friend founds a nation,
// and most of it when the friend reaches Governor, so the reward is for bringing someone who actually plays. Never paid on a shared network.
const INVITE = { welcome: 25e6, found: 10, foundMin: 10e6, rank: 3, rankX: 40, rankMin: 50e6, max: 20 };
const rankIdx = xp => { let r = 0; for (let i = 0; i < WP.RANKS.length; i++) if ((xp || 0) >= WP.RANKS[i][0]) r = i; return r; };
const invitePay = (W, inv) => { const t = W.A[inv] ? core.taxIncome(W, inv) : 0; return { found: Math.round(Math.max(INVITE.foundMin, t * INVITE.found) / 1e5) * 1e5, rank: Math.round(Math.max(INVITE.rankMin, t * INVITE.rankX) / 1e5) * 1e5 }; };
function inviteReward(W, id) {
  const u = S.users[id]; if (!u || !u.ref || u.refDone) return; u.refDone = true; const inv = u.ref, im = meta(inv);
  if (sharesNetwork(id, inv)) { flag(id, `Invited by ${(S.users[inv] || {}).name} from the same network — no invite reward given`); return; }
  if ((im.invites || 0) >= INVITE.max || !W.A[id]) return;
  core.finSync(W, W.A[id]); W.A[id].cash += INVITE.welcome; core.finSync(W, W.A[id], 'rewards'); addNote(id, 'economy', `Welcome bonus: ${WP.moneyS(INVITE.welcome)} for joining through ${S.docs['nations/' + inv] ? pubName(inv) : 'a friend'}'s invite.`);
  im.invites = (im.invites || 0) + 1; u.refPaid = true;
  if (W.A[inv]) { const amt = invitePay(W, inv).found; core.finSync(W, W.A[inv]); W.A[inv].cash += amt; core.finSync(W, W.A[inv], 'rewards'); W.changed.add(inv); addNote(inv, 'economy', `A new leader joined through your invite and founded ${W.A[id].name}. You received ${WP.moneyS(amt)}. A bigger bonus follows when they reach ${WP.RANKS[INVITE.rank][1]}.`); }
}
function inviteRank(W, id) { // second part: the invited player has reached Governor
  const u = S.users[id]; if (!u || !u.ref || !u.refPaid || u.refRank || !W.A[id] || rankIdx(W.A[id].xp) < INVITE.rank) return; u.refRank = true; const inv = u.ref;
  if (!W.A[inv] || sharesNetwork(id, inv)) return; const amt = invitePay(W, inv).rank; core.finSync(W, W.A[inv]); W.A[inv].cash += amt; core.finSync(W, W.A[inv], 'rewards'); W.changed.add(inv);
  addNote(inv, 'economy', `${W.A[id].name}, who joined through your invite, reached ${WP.RANKS[INVITE.rank][1]}. You received ${WP.moneyS(amt)}.`); persist();
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
  const online = Object.entries(S.docs).filter(([k, d]) => k.startsWith('online/') && !d.ai && !d.test && now - (d.t || 0) < 5 * 60e3).length;
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
  if (!isStaff(me)) return send(res, 403, { error: 'Admins only.' });
  if (!me.admin) { // a co-admin: only the allowed actions, never against an admin or another co-admin, and every request is logged
    const act = p.replace('/api/admin/', '').split('/')[0], b0 = req.method === 'POST' ? await readBody(req, 16 * 1024).catch(() => ({})) : null;
    req._body = b0;
    if (!COADMIN_OK.has(act)) { if (req.method !== 'GET') coLog(me, p, b0, false, 'Blocked: owner only'); return send(res, 403, { error: 'Only the owner can do that.' }); }
    const tgt = b0 && typeof b0.id === 'string' ? S.users[b0.id] : null;
    if (tgt && isStaff(tgt) && ['ban', 'unban', 'mute', 'kick', 'ipblock', 'clear-user-chat', 'cheatreview'].includes(act)) { coLog(me, p, b0, false, 'Blocked: target is an admin'); return send(res, 403, { error: 'Co-admins cannot act against admins.' }); }
    if (req.method !== 'GET') coLog(me, p, b0, true);
    if (p === '/api/admin/overview' && req.method === 'GET') { // names and moderation status only: nothing about anyone's nation
      const players = Object.entries(S.users).filter(([, u]) => !u.guest || S.docs['nations/' + u]).map(([id, u]) => { const n = S.docs['nations/' + id]; return { id, name: u.name, guest: !!u.guest, admin: !!u.admin, coadmin: !!u.coadmin, banned: !!u.banned, mutedUntil: u.mutedUntil || 0, created: u.created, lastSeen: (S.meta[id] || {}).lastSeen || 0, nation: n ? { name: n.name, color: n.color } : null }; });
      return send(res, 200, { role: 'coadmin', players, reports: S.reports.slice(0, 100), bugs: S.bugs.filter(x => x.kind !== 'idea').slice(0, 100), ideas: S.bugs.filter(x => x.kind === 'idea').slice(0, 150), flags: [], audit: [], bots: [], config: {}, health: {} }); }
    if (p === '/api/admin/player' && req.method === 'POST') { const u = b0 && typeof b0.id === 'string' ? S.users[b0.id] : null; if (!u) return send(res, 404, { error: 'Unknown player.' }); const n = S.docs['nations/' + b0.id];
      return send(res, 200, { lite: true, id: b0.id, name: u.name, admin: !!u.admin, banned: !!u.banned, mutedUntil: u.mutedUntil || 0, created: u.created, lastSeen: (S.meta[b0.id] || {}).lastSeen || 0, nation: n ? { name: n.name, color: n.color } : null }); }
  }
  if (p === '/api/admin/overview' && req.method === 'GET') return send(res, 200, { ...overview(), role: 'owner', hd: Object.values(S.helpdesk).filter(T => T.open && T.unread).length });
  if (p === '/api/admin/market') { // owner only: the finite world market
    const view = () => { const W = mkWorld(), d = core.mktDemand(W), M = S.mkt || {}, since = Date.now() - 24 * HOUR, imp = [];
      for (const [u, n] of Object.entries(W.A)) { const q = {}; for (const t of n.mbuy || []) if (t.t > since) q[t.r] = (q[t.r] || 0) + t.q; if (Object.keys(q).length) imp.push({ name: n.name, color: n.color, q, lim: Object.fromEntries(Object.keys(q).map(r => [r, core.mkLimit(W, u, r)])) }); }
      return { on: !!M.on, live: core.mkOn(W), sup: M.sup != null ? M.sup : core.MKT.sup, primed: M.primed || 0, stock: M.stock || null, ref: d.ref, use: d.c, make: d.p, del: M.del || {}, prices: core.prices(W), base: Object.fromEntries(Object.entries(core.RES || WP.RES).map(([k, v]) => [k, v.p])), hist: M.hist || [], imp: imp.sort((a, b) => Object.values(b.q).reduce((x, y) => x + y, 0) - Object.values(a.q).reduce((x, y) => x + y, 0)) }; };
    if (req.method === 'GET') return send(res, 200, view());
    const b = req._body || await readBody(req, 2048);
    if (b.op === 'on' || b.op === 'off') { const on = b.op === 'on'; if (on && !S.mkt.on) { S.mkt.on = true; S.mkt.stock = null; S.mkt.hist = []; } else if (!on) S.mkt.on = false; audit(me.name, on ? 'Switched on the limited world market' : 'Switched off the limited world market (back to unlimited)', on ? 'stock primed from the current world' : null); }
    else if (b.op === 'sup') { const v = Math.round(Number(b.v) * 100) / 100; if (!(v >= 0 && v <= 1.5)) return send(res, 400, { error: 'Supply must be between 0% and 150% of the world\'s shortfall.' }); S.mkt.sup = v; audit(me.name, 'Changed world market supply', `${Math.round(v * 100)}% of the world's shortfall`); }
    else if (b.op === 'prime') { if (!S.mkt.on) return send(res, 400, { error: 'Switch the limited market on first.' }); S.mkt.stock = null; S.mkt.hist = []; audit(me.name, 'Re-primed the world market', null); }
    else return send(res, 400, { error: 'Unknown action.' });
    { const W = mkWorld(); core.mktTick(W); } persist(true); broadcast('mkt', mktView(true)); return send(res, 200, { ok: true, view: view() });
  }
  if (p === '/api/admin/chaos') { // owner only: start or end Chaos world
    if (req.method === 'GET') return send(res, 200, chaosView());
    const b = req._body || await readBody(req, 4096);
    if (b.op === 'start') {
      const o = { mins: CHAOS_OPT.mins.includes(+b.mins) ? +b.mins : 60, speed: CHAOS_OPT.speed.includes(+b.speed) ? +b.speed : 10, nukes: CHAOS_OPT.nukes.includes(+b.nukes) ? +b.nukes : 2, chest: CHAOS_OPT.chest[b.chest] ? b.chest : 'big', refill: b.refill !== false, unlock: b.unlock !== false, drops: b.drops !== false, noShield: b.noShield !== false };
      if (b.confirm !== 'CHAOS') return send(res, 400, { error: 'Type CHAOS to confirm.' });
      try { chaosBegin(mkWorld(), me.name, o); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
      return send(res, 200, { ok: true, view: chaosView() });
    }
    if (b.op === 'timer') { if (chaosOn()) return send(res, 400, { error: 'Chaos world is already running.' }); const mins = Math.round(+b.after); if (!(mins >= 1 && mins <= 1440)) return send(res, 400, { error: 'Choose between 1 minute and 24 hours.' });
      const o = { mins: CHAOS_OPT.mins.includes(+b.mins) ? +b.mins : 60, speed: CHAOS_OPT.speed.includes(+b.speed) ? +b.speed : 10, nukes: CHAOS_OPT.nukes.includes(+b.nukes) ? +b.nukes : 2, chest: CHAOS_OPT.chest[b.chest] ? b.chest : 'big', refill: b.refill !== false, unlock: b.unlock !== false, drops: b.drops !== false, noShield: b.noShield !== false };
      if (Date.now() + mins * 60e3 + 60e3 > chaosMaxEnd()) return send(res, 400, { error: 'That is too close to the end of the season.' });
      chaosTimerSet(me.name, mins, o, b.auto !== false); return send(res, 200, { ok: true, view: chaosView() }); }
    if (b.op === 'cata') { if (!chaosOn()) return send(res, 400, { error: 'Chaos world is not running.' }); const r = chaosCata(null, String(b.kind || '')); audit(me.name, 'Chaos world', 'triggered a ' + (r ? r.kind : 'disaster (none possible)')); return send(res, 200, { ok: true, rec: r, view: chaosView() }); }
    if (b.op === 'timeroff') { chaosTimerClear(me.name, true); return send(res, 200, { ok: true, view: chaosView() }); }
    if (b.op === 'speed') { if (!chaosOn()) return send(res, 400, { error: 'Chaos world is not running.' }); const sp = +b.speed; if (!CHAOS_OPT.speed.includes(sp)) return send(res, 400, { error: 'Choose 4, 10, 20 or 30.' });
      const old = S.chaos.o.speed || 10; if (sp !== old) { chaosRetime(old, sp); S.chaos.o.speed = sp; persist(); broadcast('config', effCfg()); systemMessage(`💥 Chaos world is now ${sp}× faster!`); audit(me.name, 'Chaos world speed', `${old}× → ${sp}×`); }
      return send(res, 200, { ok: true, view: chaosView() }); }
    if (b.op === 'nukes') { if (!chaosOn()) return send(res, 400, { error: 'Chaos world is not running.' }); const k = Math.max(1, Math.min(CHAOS_OPT.nukeMax, Math.floor(+b.n) || 1));
      for (const [key, n] of Object.entries(S.docs)) { if (!key.startsWith('nations/') || !n) continue; chaosNukes(n, k); sendNation(key.slice(8)); }
      S.chaos.o.nukes = Math.min(CHAOS_OPT.nukeMax, (S.chaos.o.nukes || 0) + k); S.chaos.nukesGiven = (S.chaos.nukesGiven || 0) + k; persist(); systemMessage(`☢ Chaos world: nuclear warheads restocked (up to ${CHAOS_OPT.nukeMax} per nation)!`); audit(me.name, 'Chaos world nukes', `+${k} for every nation`);
      return send(res, 200, { ok: true, view: chaosView() }); }
    if (b.op === 'buy') { S.config.chaosBuy = !!b.on; persist(); audit(me.name, 'Chaos world purchases', b.on ? 'players can start them' : 'switched off'); return send(res, 200, { ok: true, view: chaosView() }); }
    if (b.op === 'end') { if (!chaosOn()) return send(res, 400, { error: 'Chaos world is not running.' }); try { chaosEnd(me.name, 'ended early by the admin'); } catch (e) { return send(res, e.status || 500, { error: e.message }); } return send(res, 200, { ok: true, view: chaosView() }); }
    return send(res, 400, { error: 'Unknown action.' });
  }
  if (p === '/api/admin/testlab') { // owner only: the Test lab's results and controls
    if (req.method === 'POST') { const b = await readBody(req, 2048), op = String(b.op || ''); let msg = 'Done.';
      if (op === 'on') { S.testLab.on = !!b.on; if (S.testLab.on) { labRestart = 0; labStart(); msg = 'The Test lab is running.'; } else { labStop(); setDoc('online', TEST_ID, null); msg = 'The Test lab is stopped. The Test account is offline.'; } }
      else if (op === 'pause') { S.testLab.paused = !!b.on; if (labW) labW.postMessage({ type: 'pause', on: S.testLab.paused }); if (S.testLab.paused) setDoc('online', TEST_ID, null); msg = S.testLab.paused ? 'Paused.' : 'Running again.'; }
      else if (op === 'speed' && ['slow', 'normal', 'fast'].includes(b.speed)) { S.testLab.speed = b.speed; if (labW) labW.postMessage({ type: 'speed', speed: b.speed }); msg = `Speed set to ${b.speed}.`; }
      else if (op === 'reset') { if (labW) labW.postMessage({ type: 'snap', snap: labSnap() }); msg = 'A fresh test world was started from the current real world.'; }
      else if (op === 'clear') { if (labW) labW.postMessage({ type: 'clear' }); LAB = null; delete S.testLab.state; msg = 'Results cleared.'; }
      else if (op === 'dismiss') { if (labW) labW.postMessage({ type: 'dismiss', key: String(b.key || '') }); if (LAB) LAB.findings = (LAB.findings || []).filter(f => f.key !== b.key); msg = 'Finding dismissed.'; }
      else return send(res, 400, { error: 'Unknown action.' });
      persist(); return send(res, 200, { ok: true, msg, ...labView() }); }
    return send(res, 200, labView());
  }
  if (p === '/api/admin/fullcheck' && req.method === 'GET') { // the Dashboard's "Run full check": everything the admin would want to look at, in one list (owner only; changes nothing)
    const W = mkWorld(), now = Date.now(), out = [], add = (sev, cat, title, detail) => out.push({ sev, cat, title, detail: detail || '' }), nm = u => (W.A[u] || {}).name || (S.users[u] || {}).name || '?';
    try { const rows = scriptCheck(), act = rows.filter(r => r.case.level === 'act'), watch = rows.filter(r => r.case.level === 'watch');
      if (act.length) add('red', 'Cheat watch', `${act.length} player${act.length > 1 ? 's' : ''} to act on`, act.map(r => `${r.name} (${r.nation || 'no nation'}, score ${r.score})`).join(', '));
      else add('ok', 'Cheat watch', 'Nobody needs action', watch.length ? `Keep watching: ${watch.map(r => r.name).join(', ')}` : 'Everyone active plays like a person.');
    } catch (e) { add('amber', 'Cheat watch', 'Cheat watch could not run', e.message); }
    const jailed = Object.entries(S.hc || {}).filter(([, h]) => h && h.jail).map(([u]) => nm(u)); if (jailed.length) add('amber', 'Cheat watch', `${jailed.length} account${jailed.length > 1 ? 's' : ''} locked in cheat jail`, jailed.join(', ') + '. Review and release them on the Cheat watch tab.');
    const fl = (S.flags || []).filter(f => now - f.t < 864e5); if (fl.length) add('info', 'Cheat watch', `${fl.length} cheat flag${fl.length > 1 ? 's' : ''} in the last 24 hours`, '');
    const hd = Object.entries(S.helpdesk || {}).filter(([, T]) => T.open && T.unread); add(hd.length ? 'amber' : 'ok', 'Helpdesk', hd.length ? `${hd.length} question${hd.length > 1 ? 's' : ''} waiting for your answer` : 'No Helpdesk questions waiting', hd.map(([u]) => nm(u)).join(', '));
    const reps = (S.reports || []).filter(r => !r.done), bugs = (S.bugs || []).filter(b => !b.done && b.kind !== 'idea'), ideas = (S.bugs || []).filter(b => !b.done && b.kind === 'idea');
    add(reps.length ? 'amber' : 'ok', 'Moderation', reps.length ? `${reps.length} player report${reps.length > 1 ? 's' : ''} waiting` : 'No player reports waiting', reps.slice(0, 5).map(r => `${r.byName} reported ${r.aboutName} (${r.kind})`).join('; '));
    add(bugs.length ? 'amber' : 'ok', 'Moderation', bugs.length ? `${bugs.length} open bug report${bugs.length > 1 ? 's' : ''}` : 'No open bug reports', bugs.slice(0, 5).map(b => `${b.byName}: ${String(b.text).slice(0, 90)}`).join(' · '));
    if (ideas.length) add('info', 'Moderation', `${ideas.length} new idea${ideas.length > 1 ? 's' : ''} from players`, ideas.slice(0, 5).map(b => `${b.byName}: ${String(b.text).slice(0, 90)}`).join(' · '));
    const errs = health.errors.filter(e => now - e.t < 864e5); add(errs.length ? 'amber' : 'ok', 'Server', errs.length ? `${errs.length} server error${errs.length > 1 ? 's' : ''} in the last 24 hours` : 'No server errors in the last 24 hours', errs.slice(0, 5).map(e => String(e.msg || e.m || '').slice(0, 120)).join(' · '));
    const ai = Object.keys(W.A).filter(u => BOTS.isBot(u)); if (S.config.noAI) add(ai.length ? 'red' : 'ok', 'AI', ai.length ? `${ai.length} AI nation${ai.length > 1 ? 's' : ''} exist although all AI is off` : 'All AI is off, and no AI nations exist', ai.length ? 'They should be removed within a minute. If they stay, run the check again in a minute.' : ''); else add('info', 'AI', `AI is allowed: ${ai.length} AI nation${ai.length === 1 ? '' : 's'}`, '');
    const se = S.seasons && S.seasons.cur; if (se && se.end) { if (se.end < now - 10 * 60e3) add('red', 'Season', 'The season end time has passed but the season has not finished', new Date(se.end).toLocaleString('en-US', { timeZone: 'America/Denver' }) + ' Mountain'); else add('ok', 'Season', `${se.name || 'The season'} ends ${new Date(se.end).toLocaleString('en-US', { timeZone: 'America/Denver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} Mountain`, ''); }
    if (S.crisis && !S.crisis.over && now > S.crisis.end + 15 * 60e3) add('red', 'World events', 'A world crisis is past its deadline but has not ended', 'End it from the World events tab.');
    const bad = Object.keys(W.A).filter(u => ['cash', 'gdp', 'pop', 'troops', 'tech', 'xp'].some(k => W.A[u][k] != null && !Number.isFinite(+W.A[u][k]))); if (bad.length) add('red', 'Data', `${bad.length} nation${bad.length > 1 ? 's have' : ' has'} broken numbers`, bad.map(nm).join(', ') + '. Run Repair → Health check → Fix everything found.');
    const lb = S.lastBackupT || 0; add(now - lb < 30 * HOUR ? 'ok' : 'amber', 'Server', now - lb < 30 * HOUR ? `Last nightly backup ${Math.round((now - lb) / HOUR)} hours ago` : 'No nightly backup in over 30 hours', '');
    return send(res, 200, { items: out, emails: Object.values(S.users).map(u => String(u.email || '').toLowerCase()).filter(e => e.includes('@')), t: now });
  }
  if (p === '/api/admin/helpdesk') { // owner only (not in COADMIN_OK); nothing here is audit-logged, so it never shows on /fair
    if (req.method === 'GET') return send(res, 200, { list: hdView() });
    const b = await readBody(req, 12 * 1024), id = String(b.id || ''), T = S.helpdesk[id];
    if (!T) return send(res, 404, { error: 'That conversation no longer exists.' });
    let msg = 'Done.';
    if (b.op === 'reply') {
      const body = String(b.body || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 5000); if (!body) return send(res, 400, { error: 'Write an answer.' });
      const t = Date.now(), last = [...T.msgs].reverse().find(m => m.from === 'player'), subj = last ? (/^re:/i.test(last.subj) ? last.subj : 'Re: ' + last.subj).slice(0, 80) : 'Helpdesk';
      T.msgs = [...T.msgs, { id: rid(), t, from: 'staff', by: me.name, subj, body }].slice(-100); T.unread = false; T.last = t; if (b.close) T.open = false;
      if (S.users[id]) { S.mail[id] = [{ id: rid(), from: HD, to: id, t, subj, body, box: 'in', read: false }, ...(S.mail[id] || [])].slice(0, 200); sendTo(id, 'mail', { unread: S.mail[id].filter(m => m.box === 'in' && !m.read).length }); addNote(id, 'mail', `❓ The Helpdesk answered your question: ${subj}`, '/play#mail'); msg = 'Answer sent to their mail.'; }
      else msg = 'Saved, but this player has deleted their account, so nobody will receive it.';
    } else if (b.op === 'seen') T.unread = false;
    else if (b.op === 'close') { T.open = false; T.unread = false; msg = 'Marked as resolved.'; }
    else if (b.op === 'reopen') { T.open = true; msg = 'Reopened.'; }
    else if (b.op === 'delete') { delete S.helpdesk[id]; msg = 'Conversation deleted.'; }
    else return send(res, 400, { error: 'Unknown action.' });
    persist(); return send(res, 200, { ok: true, msg, list: hdView() });
  }
  if (p === '/api/admin/coadmins') { // the owner adds or removes co-admins and reads everything they have done
    if (!me.admin) return send(res, 403, { error: 'Only the owner can do that.' });
    if (req.method === 'POST') { const b = (req._body || await readBody(req, 2048)), q = String(b.who || '').trim().toLowerCase();
      let id = typeof b.id === 'string' && S.users[b.id] ? b.id : null; if (!id && q) id = Object.keys(S.users).find(k => (S.users[k].name || '').toLowerCase() === q || (S.users[k].email || '').toLowerCase() === q) || null;
      if (!id) return send(res, 404, { error: 'No player with that leader name or email.' }); const u = S.users[id];
      if (u.admin) return send(res, 400, { error: `${u.name} is already a full admin.` }); if (u.banned) return send(res, 400, { error: `${u.name} is banned.` });
      u.coadmin = !!b.on; audit(me.name, b.on ? 'Added a co-admin' : 'Removed a co-admin', u.name); persist();
      for (const c of [...clients]) if (c.uid === id) endStream(c); // their page reloads with (or without) the admin link
      if (b.on) addNote(id, 'admin', 'You are now a co-admin of World Powers. Open the admin page from the menu (More → Admin page). Everything you do there is recorded.');
    }
    return send(res, 200, { list: Object.entries(S.users).filter(([, u]) => u.coadmin && !u.admin).map(([id, u]) => ({ id, name: u.name, last: (S.meta[id] || {}).lastSeen || 0, acts: S.coLog.filter(x => x.id === id).length })), log: S.coLog.slice(0, 500), allowed: [...COADMIN_OK] });
  }
  if (p === '/api/admin/supporters') { // donations, claims and the PayPal check log
    if (req.method === 'GET') return send(res, 200, SUPP.adminView());
    const sb = (req._body || await readBody(req, 4096)), r = SUPP.adminAct(sb, me.name); if (r.error) return send(res, 400, r);
    audit(me.name, 'Supporters', sb.op, sb.op === 'cfg' ? 'PayPal settings' : String(sb.u || sb.id || sb.txn || '').slice(0, 60)); return send(res, 200, { ...r, view: SUPP.adminView() });
  }
  if (p === '/api/admin/viewas' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || ''; const u = Object.prototype.hasOwnProperty.call(S.users, id) ? S.users[id] : null; if (!u) return send(res, 404, { error: 'Unknown player.' });
    audit(me.name, 'Viewed the game as', u.name); return send(res, 200, { snap: snapshot(id), me: pub({ id, ...u }) });
  }
  const bi = p.match(/^\/api\/admin\/bug-img\/([a-z0-9]{8,40})$/);
  if (bi && req.method === 'GET') { const f = path.join(BUG_DIR, bi[1] + '.jpg'); if (!fs.existsSync(f)) return send(res, 404, { error: 'Not found.' }); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }); return fs.createReadStream(f).pipe(res); }
  if (p === '/api/admin/boss-now' && req.method === 'POST') { // raise the Rising Power right away (skips the 48-hour breather after one falls)
    const W0 = mkWorld(), ids = Object.keys(W0.A), cur = ids.find(k => BOTS.isBot(k) && W0.A[k].ai && W0.A[k].ai.boss);
    if (cur) return send(res, 400, { error: `${W0.A[cur].name} is already the Rising Power.` });
    if (S.config.noAI) return send(res, 400, { error: 'All AI is turned off. Turn AI back on (Game settings) first.' }); 
    if (!ids.some(k => BOTS.isBot(k))) { const Ws = mkWorld(), sp = BOTS.spawn(Ws); if (!sp) return send(res, 400, { error: 'There are no AI nations to raise, and there is no land to start a new one.' }); Ws.welcome = null; commit(Ws); } // no AI left: start one, then raise it
    if (!ids.some(k => !BOTS.isBot(k))) return send(res, 400, { error: 'There are no player nations yet.' });
    S.bossFell = 0;
    const W = mkWorld(), b = BOTS.raiseBoss(W, W.cfg, '', true); if (!b) return send(res, 400, { error: 'Could not raise a Rising Power right now.' });
    commit(W); persist(); bossAnnounce(W, b);
    audit(me.name, 'Raised the Rising Power', W.A[b].name); return send(res, 200, { ok: true, name: W.A[b].name });
  }
  if (p === '/api/admin/casino' && req.method === 'GET') { // Admin page → Casino
    const W = mkWorld(), players = Object.entries(W.A).filter(([u, n]) => n.casino && n.casino.played).map(([u, n]) => ({ name: n.name, leader: (S.users[u] || {}).name || '', ai: !!n.ai, played: n.casino.played, wagered: n.casino.wagered, net: n.casino.net, best: n.casino.best || 0, cash: Math.round(n.cash || 0) }));
    return send(res, 200, { ...S.casino, players, limits: { min: WP.CASINO ? WP.CASINO.min : 1e4, max: WP.CASINO ? WP.CASINO.maxAbs : 1e9 } });
  }
  if (p === '/api/admin/season' && req.method === 'POST' && chaosOn()) return send(res, 423, CHAOS_LOCK);
  if (p === '/api/admin/season' && req.method === 'POST') { // Admin page → Seasons. The Hall of Fame itself has no edit or delete operation.
    const b = (req._body || await readBody(req, 16384)), op = String(b.op || ''), W = mkWorld(), clean = x => String(x == null ? '' : x).replace(/[\u0000-\u001f<>]/g, ' ').trim();
    if (op === 'list') return send(res, 200, { countdown: S.countdown, cur: seasonView(W, S.seasons.cur, null), curRaw: S.seasons.cur ? { ...S.seasons.cur, base: undefined, played: undefined } : null, next: S.seasons.n + 1, hof: HOF, metrics: Object.fromEntries(Object.entries(SEASON_METRICS).map(([k, v]) => [k, { n: v.n, title: v.title, fresh: !!v.fresh }])), awards: { fresh: FRESH_AWARDS, normal: NORMAL_AWARDS }, freshActive: S.fresh || null, freshFile: fs.existsSync(FRESH_FILE) });
    if (op === 'create') {
      if (S.seasons.cur) return send(res, 400, { error: 'A season is already scheduled or running. End or cancel it first.' });
      const fresh = !!b.fresh; if (fresh && S.fresh) return send(res, 400, { error: 'A fresh season world is still active. Restore the real world first.' }); if (fresh && !(+b.days > 0)) return send(res, 400, { error: 'A fresh-start season needs an end date (number of days), so the real world comes back on time.' });
      const metric = fresh ? 'final' : SEASON_METRICS[b.metric] && !SEASON_METRICS[b.metric].fresh ? b.metric : 'score', days = +b.days, startAt = b.startAt ? +new Date(b.startAt) : 0, start = startAt && startAt > Date.now() ? startAt : Date.now();
      if (b.startAt && !Number.isFinite(startAt)) return send(res, 400, { error: 'That start time is not a valid date.' });
      const n = S.seasons.n + 1, name = clean(b.name).slice(0, 60) || `Season ${n}`, num_ = v => Math.max(0, Math.min(1e12, Math.round(+v || 0)));
      const se = { id: crypto.randomBytes(5).toString('hex'), n, name, msg: clean(b.msg).slice(0, 300), metric, who: b.who === 'all' ? 'all' : 'players', start, end: days > 0 ? start + Math.min(365, days) * 864e5 : 0, prizes: (Array.isArray(b.prizes) ? b.prizes : []).slice(0, 10).map(num_), xp: (Array.isArray(b.xp) ? b.xp : []).slice(0, 10).map(v => Math.min(1e6, num_(v))), cats: (Array.isArray(b.cats) ? b.cats : []).filter(k => (fresh ? FRESH_AWARDS : NORMAL_AWARDS).includes(k)).slice(0, 6), fresh, award: Object.fromEntries(Object.entries(b.award && typeof b.award === 'object' ? b.award : {}).filter(([k]) => (fresh ? FRESH_AWARDS : NORMAL_AWARDS).includes(k)).map(([k, v]) => [k, { cash: num_((v || {}).cash), xp: Math.min(1e6, num_((v || {}).xp)) }])), titles: b.titles !== false, announce: b.announce !== false, status: 'scheduled', base: {}, by: me.name, created: Date.now() };
      S.seasons.cur = se; S.seasons.n = n; audit(me.name, start > Date.now() + 5000 ? 'Scheduled a season' : 'Started a season', name);
      if (start <= Date.now() + 5000) { seasonBegin(W); if (se.status === 'failed') { const err = se.err; S.seasons.cur = null; S.seasons.n = n - 1; persist(true); return send(res, 500, { error: 'The season could not start: ' + err + ' The real world was not changed.' }); } } else { persist(); if (se.announce) { const t = fresh ? `🏆 ${name} starts ${new Date(start).toUTCString().slice(0, 22)} UTC. Everyone starts fresh in a brand-new world, and your real nation will be saved and returned with your prizes.` : `🏆 ${name} starts ${new Date(start).toUTCString().slice(0, 22)} UTC. Nations will be ranked by ${SEASON_METRICS[metric].n.toLowerCase()}.`; systemMessage(t); broadcast('announce', { text: t }); } }
      return send(res, 200, { ok: true });
    }
    if (op === 'countdown') { // the countdown banner players see at the top of every page
      if (b.off) { S.countdown = null; persist(); broadcast('config', effCfg()); audit(me.name, 'Removed the countdown banner', ''); return send(res, 200, { ok: true }); }
      if (b.remind) { const c = S.countdown; if (!c || c.at + 2 * HOUR <= Date.now()) return send(res, 400, { error: 'There is no countdown banner to remind people about.' }); c.id = crypto.randomBytes(4).toString('hex'); c.reminded = Date.now(); persist(); broadcast('config', effCfg()); audit(me.name, 'Reminded everyone about the countdown', c.text); return send(res, 200, { ok: true, countdown: c }); } // a new id brings the banner back for everyone who closed it
      const text = clean(b.text).slice(0, 120) || 'The next season starts in', at = Math.round(+b.at);
      if (!Number.isFinite(at) || at <= Date.now() + 30e3) return send(res, 400, { error: 'Pick a time in the future for the countdown to end.' });
      if (at > Date.now() + 365 * 864e5) return send(res, 400, { error: 'The countdown can run for at most a year.' });
      S.countdown = { id: crypto.randomBytes(4).toString('hex'), text, at, by: me.name, t: Date.now() }; persist(); broadcast('config', effCfg());
      audit(me.name, 'Set the countdown banner', `${text} · ${new Date(at).toUTCString().slice(0, 22)} UTC`); return send(res, 200, { ok: true, countdown: S.countdown });
    }
    if (op === 'restore') { // emergency: bring the real world back now, without prizes
      if (b.confirm !== 'RESTORE') return send(res, 400, { error: 'Type RESTORE to confirm.' });
      if (!S.fresh && !fs.existsSync(FRESH_FILE)) return send(res, 400, { error: 'There is no saved real world waiting to be restored.' });
      const se0 = S.seasons.cur; freshDropW(W);
      try { freshRestore(me.name, 'emergency restore'); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
      if (se0 && se0.fresh && se0.grants) { for (const [u, g] of Object.entries(se0.grants)) { const paid = seasonGrant(u, g); addNote(u, 'event', `🏆 ${se0.name}: ${g.lines.length ? 'you ' + g.lines.join('; ') : 'you took part'}.${paid ? '' : ' Found a nation to receive your rewards.'}`); } S.seasons.cur = null; audit(me.name, 'Season ended', se0.name + ' (prizes paid after a manual restore)'); persist(true); } // the season had already finished and was recorded: pay its prizes
      else if (se0 && se0.fresh) { S.seasons.cur = null; if (se0.n === S.seasons.n) S.seasons.n = Math.max(HOF.length, se0.n - 1); persist(true); }
      systemMessage('🌍 The real world has been restored by the administrators. Everything is back as it was when the season began.'); broadcast('config', effCfg()); return send(res, 200, { ok: true });
    }
    const se = S.seasons.cur; if (!se) return send(res, 404, { error: 'There is no season right now.' });
    if (op === 'end') { if (se.status !== 'live') return send(res, 400, { error: 'This season has not started yet. Cancel it instead.' }); const e = seasonFinish(W, me.name); commit(W); return send(res, 200, { ok: true, entry: e }); }
    if (op === 'cancel') { if (se.fresh && S.fresh) { freshDropW(W); try { freshRestore(me.name, 'season cancelled'); } catch (e) { return send(res, e.status || 500, { error: e.message }); } }
      S.seasons.cur = null; if (se.n === S.seasons.n) S.seasons.n = Math.max(HOF.length, se.n - 1); persist(); broadcast('config', effCfg()); audit(me.name, 'Cancelled a season (nothing recorded)', se.name); if (se.announce && b.announce !== false) systemMessage(`${se.name} has been cancelled.`); return send(res, 200, { ok: true }); }
    if (op === 'extend') { const d = +b.days; if (!(d > 0) || !se.end) return send(res, 400, { error: 'Only seasons with an end date can be extended.' }); se.end += Math.min(90, d) * 864e5; persist(); audit(me.name, 'Extended a season', `${se.name} by ${d} days`); if (se.announce) systemMessage(`⏳ ${se.name} has been extended. It now ends ${new Date(se.end).toUTCString().slice(0, 22)} UTC.`); return send(res, 200, { ok: true }); }
    if (op === 'rename') { const nm = clean(b.name).slice(0, 60); if (!nm) return send(res, 400, { error: 'Give the season a name.' }); const old = se.name; se.name = nm; if (b.msg != null) se.msg = clean(b.msg).slice(0, 300);
      // fix the name in the announcements already posted in chat too
      let fixed = 0; if (old && old !== nm) { const doc = S.docs['chat/_system']; if (doc && Array.isArray(doc.m)) { doc.m = doc.m.map(x => { if (x && typeof x.x === 'string' && x.x.includes(old)) { fixed++; return { ...x, x: x.x.split(old).join(nm) }; } return x; }); if (fixed) setDoc('chat', '_system', doc); } }
      persist(); broadcast('config', effCfg()); audit(me.name, 'Renamed the season', `${old} → ${nm}`); return send(res, 200, { ok: true, fixed }); }
    return send(res, 400, { error: 'Unknown operation.' });
  }
  if (p === '/api/admin/poll' && req.method === 'POST') { // Admin page → Polls: questions sent to every player
    const b = (req._body || await readBody(req, 32768)), op = String(b.op || ''), clean = x => String(x == null ? '' : x).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim();
    const find = () => S.polls.find(x => x.id === b.id);
    if (op === 'list') return send(res, 200, { opVotes: opVoteTotals(), polls: S.polls, players: Object.keys(S.users).filter(id => !S.users[id].banned && S.docs['nations/' + id]).length });
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
    const b = (req._body || await readBody(req, 8192)), op = String(b.op || '');
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
    const b = (req._body || await readBody(req, 4096)), op = String(b.op || '');
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
    const b = (req._body || await readBody(req, 4096)), op = String(b.op || '');
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
      const was = JSON.stringify(S.config.boss || {}); S.config.boss = bs; if (b.auto != null) S.config.aiBoss = !!b.auto && !S.config.noAI; persist();
      audit(me.name, 'Changed Rising Power settings', `${was} → ${JSON.stringify(bs)}${b.auto != null ? ` · auto spawn ${S.config.aiBoss ? 'on' : 'off'}` : ''}`); return send(res, 200, { ok: true });
    }
    if (op === 'raise') {
      if (id) return send(res, 400, { error: `${W.A[id].name} is already the Rising Power. Retire it first.` });
      const want = typeof b.pick === 'string' && BOTS.isBot(b.pick) && W.A[b.pick] ? b.pick : '';
      if (!Object.keys(W.A).some(k => BOTS.isBot(k))) return send(res, 400, { error: 'There are no AI nations to raise. Turn AI nations on first.' });
      if (!Object.keys(W.A).some(k => !BOTS.isBot(k))) return send(res, 400, { error: 'There are no player nations yet.' });
      if (S.config.noAI) return send(res, 400, { error: 'All AI is turned off. Turn AI back on (Game settings) first.' }); 
      S.bossFell = 0;
      const W2 = mkWorld(), nb = BOTS.raiseBoss(W2, W2.cfg, want, true); if (!nb) return send(res, 400, { error: 'Could not raise a Rising Power right now.' });
      commit(W2); persist(); bossAnnounce(W2, nb);
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
    const b = (req._body || await readBody(req, 1024)), A_ = S.docs['nations/' + b.a], B_ = S.docs['nations/' + b.b];
    if (typeof b.a !== 'string' || typeof b.b !== 'string' || b.a === b.b || !A_ || !B_ || !Object.prototype.hasOwnProperty.call(S.docs, 'nations/' + b.a) || !Object.prototype.hasOwnProperty.call(S.docs, 'nations/' + b.b)) return send(res, 400, { error: 'Pick two nations.' });
    const t = Date.now(); for (const [x, y] of [[A_, b.b], [B_, b.a]]) { x.rel = x.rel || {}; x.rel[y] = { ...(x.rel[y] || {}), peace: t }; }
    setDoc('nations', b.a, A_); setDoc('nations', b.b, B_); systemMessage(`🕊 The administrators have imposed peace between ${A_.name} and ${B_.name}.`);
    audit(me.name, 'Forced peace', `${A_.name} ↔ ${B_.name}`); return send(res, 200, { ok: true });
  }
  // ---------- admin fix-it tools: repair one nation, an alliance, the whole world; compensate players ----------
  if (p === '/api/admin/fix' && req.method === 'POST') { // Players → a nation → Fix problems (also works on AI nations)
    const b = (req._body || await readBody(req, 2048)), id = String(b.id || ''), key = 'nations/' + id; if (!Object.prototype.hasOwnProperty.call(S.docs, key) || !S.docs[key]) return send(res, 404, { error: 'Unknown nation.' });
    const n = S.docs[key], ops = Array.isArray(b.ops) ? b.ops.map(String) : [], done = [], t = Date.now();
    if (ops.includes('rogue')) { const was = Math.round(n.aggr || 0); n.rogue = 0; n.rogueT = 0; n.aggr = 0; done.push(`rogue status cleared, aggression ${was} → 0`); }
    if (ops.includes('sanctions')) { n.embargo = 0; n.armsEmb = 0; if ((n.aggr || 0) >= 50) n.aggr = 40; done.push('sanctions, embargo and arms embargo lifted'); }
    if (ops.includes('wars')) { let k = 0; n.rel = n.rel || {}; for (const [v, r] of Object.entries(n.rel)) { const o = S.docs['nations/' + v]; const or = o && o.rel && o.rel[id] || {}; const w = Math.max((r && r.war) || 0, or.war || 0); if (!w) continue; if ((r.peace || 0) > w && (or.peace || 0) > w) continue; n.rel[v] = { ...r, peace: t }; if (o) { o.rel = o.rel || {}; o.rel[id] = { ...or, peace: t }; setDoc('nations', v, o); } k++; } done.push(`${k} war${k === 1 ? '' : 's'} ended`); }
    if (ops.includes('nuke')) { n.nuked = null; n.fallout = 0; n.winter = 0; n.rad = null; delete n.rads; done.push('nuclear damage, fallout, winter and radiation cleared'); }
    if (ops.includes('shield')) { const h = Math.max(1, Math.min(168, Math.round(+b.hours || 24))); n.shield = Math.max(n.shield || 0, t + h * HOUR); done.push(`protected from attack for ${h} hours`); }
    if (ops.includes('cooldowns')) { n.cd = {}; done.push('cooldowns reset'); }
    if (ops.includes('unrest')) { n.approval = Math.max(n.approval || 0, 60); n.stability = Math.max(n.stability || 0, 60); done.push('approval and stability raised to at least 60'); }
    if (!done.length) return send(res, 400, { error: 'Choose at least one fix.' });
    setDoc('nations', id, n); audit(me.name, 'Fixed nation', n.name, done.join('; '));
    if (b.tell && S.users[id]) addNote(id, 'diplo', `🛠 The administrators fixed a problem with your nation: ${done.join(', ')}.`);
    return send(res, 200, { ok: true, done });
  }
  if (p === '/api/admin/blocs' && req.method === 'GET') { // Alliances tab
    const nm = id => (S.docs['nations/' + id] || {}).name || (S.users[id] || {}).name || '?';
    return send(res, 200, { blocs: Object.values(S.blocs || {}).map(b => ({ id: b.id, name: b.name, tag: b.tag, leader: b.leader, co: (b.co || []).filter(m => (b.members || []).includes(m)), members: (b.members || []).map(m => ({ id: m, name: nm(m), seen: (S.meta[m] || {}).lastSeen || 0 })), bank: b.bank || 0, done: Object.keys(b.done || {}).length, proj: b.proj ? { k: b.proj.k, stage: b.proj.stage } : null, open: !!b.open, created: b.created || 0, log: (b.log || []).slice(0, 15) })) });
  }
  if (p === '/api/admin/bloc' && req.method === 'POST') {
    const b = (req._body || await readBody(req, 2048)), bl = Object.prototype.hasOwnProperty.call(S.blocs || {}, String(b.bid)) ? S.blocs[String(b.bid)] : null; if (!bl) return send(res, 404, { error: 'That alliance no longer exists.' });
    const v = String(b.v || ''), nm = id => (S.docs['nations/' + id] || {}).name || '?', blog = x => { bl.log = [{ t: Date.now(), x }, ...(bl.log || [])].slice(0, 30); }, mem = () => (bl.members || []).includes(v);
    let msg = '';
    switch (String(b.op)) {
      case 'leader': if (!mem()) return send(res, 400, { error: 'Choose a member.' }); bl.leader = v; bl.co = (bl.co || []).filter(m => m !== v); blog(`The administrators made ${nm(v)} the leader.`); addNote(v, 'diplo', `You are now the leader of ${bl.name}.`); msg = `${nm(v)} now leads ${bl.name}`; break;
      case 'co': { if (!mem() || v === bl.leader) return send(res, 400, { error: 'Choose a member who is not the leader.' }); const co = (bl.co || []).filter(m => bl.members.includes(m)); if (b.on === false) { bl.co = co.filter(m => m !== v); blog(`The administrators removed ${nm(v)} as co-leader.`); msg = `${nm(v)} is no longer a co-leader`; } else { if (co.includes(v)) return send(res, 400, { error: 'Already a co-leader.' }); if (co.length >= 2) return send(res, 400, { error: 'An alliance can have 2 co-leaders. Remove one first.' }); co.push(v); bl.co = co; blog(`The administrators made ${nm(v)} a co-leader.`); addNote(v, 'diplo', `⭐ You are now a co-leader of ${bl.name}.`); msg = `${nm(v)} is now a co-leader`; } break; }
      case 'rename': { const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 28), tag = String(b.tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); if (name.length < 3) return send(res, 400, { error: 'Names need at least 3 characters.' }); if (tag.length < 2) return send(res, 400, { error: 'The tag needs 2 to 4 letters or numbers.' }); if (Object.values(S.blocs).some(x => x !== bl && (x.name.toLowerCase() === name.toLowerCase() || x.tag === tag))) return send(res, 400, { error: 'Another alliance already uses that name or tag.' }); msg = `renamed ${bl.name} [${bl.tag}] → ${name} [${tag}]`; bl.name = name; bl.tag = tag; blog('The administrators renamed the alliance.'); break; }
      case 'kick': { if (!mem()) return send(res, 400, { error: 'Not a member.' }); bl.members = bl.members.filter(m => m !== v); bl.co = (bl.co || []).filter(m => m !== v); const n = S.docs['nations/' + v]; if (n) { n.bloc = null; setDoc('nations', v, n); } addNote(v, 'diplo', `The administrators removed you from the alliance ${bl.name}.`); blog(`The administrators removed ${nm(v)}.`);
        if (!bl.members.length) { delete S.blocs[bl.id]; msg = `removed ${nm(v)}; the alliance was empty and was closed`; break; }
        if (bl.leader === v) { bl.leader = bl.co[0] || bl.members[0]; bl.co = bl.co.filter(m => m !== bl.leader); blog(`${nm(bl.leader)} is the new leader.`); addNote(bl.leader, 'diplo', `You are now the leader of ${bl.name}.`); }
        msg = `removed ${nm(v)} from ${bl.name}`; break; }
      case 'bank': { const amt = Math.round(+b.amt); if (!isFinite(amt) || Math.abs(amt) > 1e13) return send(res, 400, { error: 'Enter an amount (use a minus sign to take money out).' }); const was = bl.bank || 0; bl.bank = Math.max(0, was + amt); blog(`The administrators ${amt >= 0 ? 'added' : 'removed'} ${WP.moneyS(Math.abs(bl.bank - was))} ${amt >= 0 ? 'to' : 'from'} the treasury.`); msg = `treasury ${WP.moneyS(was)} → ${WP.moneyS(bl.bank)}`; break; }
      case 'project': { if (!bl.proj) return send(res, 400, { error: 'No project is being built.' }); bl.proj.next = 0; blog('The administrators finished the current building stage.'); msg = 'current project stage finished early'; break; }
      case 'disband': { if (String(b.confirm) !== 'DISBAND') return send(res, 400, { error: 'Type DISBAND to confirm.' }); const ref = String(b.refund) === 'members' ? 'members' : 'none', each = ref === 'members' && bl.members.length ? Math.floor((bl.bank || 0) / bl.members.length) : 0;
        for (const m of bl.members) { const n = S.docs['nations/' + m]; if (n) { n.bloc = null; if (each) n.cash = (n.cash || 0) + each; setDoc('nations', m, n); } addNote(m, 'diplo', `The administrators disbanded the alliance ${bl.name}${each ? `; you received ${WP.moneyS(each)} from its treasury` : ''}.`); }
        delete S.blocs[bl.id]; msg = `disbanded ${bl.name}${each ? `, ${WP.moneyS(each)} to each member` : ''}`; break; }
      default: return send(res, 400, { error: 'Unknown alliance action.' });
    }
    persist(); sendBlocs(); audit(me.name, 'Alliance: ' + msg, bl.name); return send(res, 200, { ok: true, msg });
  }
  if (p === '/api/admin/give' && req.method === 'POST') { // compensation, to one player or every player
    const b = (req._body || await readBody(req, 4096)), cash = Math.round(+b.cash || 0), xp = Math.round(+b.xp || 0), res_ = {}, note = String(b.note || '').trim().slice(0, 300);
    for (const r of ['food', 'oil', 'steel', 'goods', 'mun']) { const v = Math.round(+((b.res || {})[r]) || 0); if (v) res_[r] = v; }
    if (!(cash > 0) && !(xp > 0) && !Object.values(res_).some(v => v > 0)) return send(res, 400, { error: 'Enter something to give.' });
    if (cash < 0 || xp < 0 || Object.values(res_).some(v => v < 0)) return send(res, 400, { error: 'Amounts must be positive. To take something away, edit the nation instead.' });
    if (cash > 1e12 || xp > 1e6 || Object.values(res_).some(v => v > 1e9)) return send(res, 400, { error: 'That is more than the safety limit ($1T cash, 1M XP, 1B of a resource per player).' });
    let ids; if (b.to === 'all') ids = Object.keys(S.users).filter(id => !S.users[id].banned && S.docs['nations/' + id]); else { const id = String(b.to || ''); if (!S.users[id] || !S.docs['nations/' + id]) return send(res, 404, { error: 'That player has no nation.' }); ids = [id]; }
    const parts = [cash ? WP.moneyS(cash) : '', ...Object.entries(res_).map(([r, v]) => `${WP.num(v)} ${r === 'mun' ? 'munitions' : r}`), xp ? `${WP.num(xp)} XP` : ''].filter(Boolean).join(', ');
    for (const id of ids) { const n = S.docs['nations/' + id]; core.finSync(null, n); n.cash = (n.cash || 0) + cash; core.finSync(null, n, 'rewards'); n.xp = (n.xp || 0) + xp; n.res = n.res || {}; for (const [r, v] of Object.entries(res_)) n.res[r] = (n.res[r] || 0) + v; setDoc('nations', id, n); addNote(id, 'diplo', `🎁 Gift from the administrators: ${parts}.${note ? ' ' + note : ''}`); }
    audit(me.name, b.to === 'all' ? `Gave every player (${ids.length})` : 'Gave a player', b.to === 'all' ? null : (S.users[ids[0]] || {}).name, parts + (note ? ` — “${note}”` : ''));
    if (b.to === 'all' && b.announce) systemMessage(`🎁 Every leader received ${parts} from the administrators.${note ? ' ' + note : ''}`);
    return send(res, 200, { ok: true, n: ids.length, parts });
  }
  if (p === '/api/admin/cleanup' && req.method === 'POST') { // World → Repair tools
    const b = (req._body || await readBody(req, 1024)), op = String(b.op || ''), t = Date.now(), all = Object.entries(S.docs).filter(([k, d]) => k.startsWith('nations/') && d); let msg = '';
    if (op === 'wars') { let k = 0; const touched = new Set(); for (const [key, n] of all) { const id = key.slice(8); for (const [v, r] of Object.entries(n.rel || {})) { const o = S.docs['nations/' + v]; const or = (o && o.rel && o.rel[id]) || {}; const w = Math.max((r && r.war) || 0, or.war || 0); if (!w || ((r.peace || 0) > w && (or.peace || 0) > w)) continue; n.rel[v] = { ...r, peace: t }; touched.add(id); if (o) { o.rel = o.rel || {}; o.rel[id] = { ...or, peace: t }; touched.add(v); } k++; } } for (const id of touched) setDoc('nations', id, S.docs['nations/' + id]); systemMessage('🕊 The administrators have ended every war. The world is at peace.'); msg = `ended every war (${k})`; }
    else if (op === 'nukes') { let k = 0; for (const [key, n] of all) if (n.nuked || n.fallout || n.winter || n.rad || n.rads) { n.nuked = null; n.fallout = 0; n.winter = 0; n.rad = null; delete n.rads; setDoc('nations', key.slice(8), n); k++; } S.nukes = []; msg = `cleared nuclear effects on ${k} nations`; }
    else if (op === 'rogue') { let k = 0; for (const [key, n] of all) if ((n.rogue || 0) > t || (n.aggr || 0) >= 50) { n.rogue = 0; n.rogueT = 0; n.aggr = Math.min(n.aggr || 0, 20); setDoc('nations', key.slice(8), n); k++; } msg = `cleared rogue and sanctioned status on ${k} nations`; }
    else if (op === 'bm') { let k = 0, back = 0; for (const x of S.bm.list) { if (x.exp > t && x.q > 0) { const n = S.docs['nations/' + x.seller]; if (n) { n.res = n.res || {}; n.res[x.r] = (n.res[x.r] || 0) + x.q; setDoc('nations', x.seller, n); back++; } k++; } } S.bm.list = []; bmCast(); msg = `cleared ${k} black-market listings (goods returned to ${back} sellers)`; }
    else if (op === 'audit') { try { return send(res, 200, { ok: true, audit: gameAudit() }); } catch (e) { logErr('audit: ' + e.message); return send(res, 500, { error: 'The check-up failed: ' + e.message }); } }
    else if (op === 'health' || op === 'healthfix') {
      const fix = op === 'healthfix', found = [], numF = ['cash', 'pop', 'troops', 'ships', 'air', 'spies', 'xp', 'tech', 'infra', 'fort', 'approval', 'stability', 'aggr', 'debt', 'unemp', 'infl', 'tax', 'gdp'];
      for (const [key, n] of all) { const id = key.slice(8); let ch = false;
        for (const f of numF) if ((n[f] == null && ['cash', 'pop', 'xp'].includes(f)) || (n[f] != null && (typeof n[f] !== 'number' || !Number.isFinite(n[f])) && !(typeof n[f] === 'string' && n[f].trim() !== '' && Number.isFinite(+n[f])))) { found.push(`${n.name}: ${f} is broken (${n[f]})`); if (fix) { n[f] = f === 'approval' || f === 'stability' ? 50 : f === 'tax' ? 20 : 0; ch = true; } }
        for (const r of Object.keys(n.res || {})) if (!Number.isFinite(+n.res[r]) || n.res[r] < 0) { found.push(`${n.name}: ${r} is ${n.res[r]}`); if (fix) { n.res[r] = Math.max(0, +n.res[r] || 0); ch = true; } }
        for (const f of ['approval', 'stability']) if (Number.isFinite(+n[f]) && (n[f] < 0 || n[f] > 100)) { found.push(`${n.name}: ${f} out of range (${Math.round(n[f])})`); if (fix) { n[f] = Math.max(0, Math.min(100, n[f])); ch = true; } }
        if (n.bloc && !(S.blocs[n.bloc] && (S.blocs[n.bloc].members || []).includes(id))) { found.push(`${n.name}: points at an alliance it is not in`); if (fix) { n.bloc = null; ch = true; } }
        for (const gk of ['vp', 'craps']) if (n[gk] && n[gk].t && t - n[gk].t > 6 * HOUR) { found.push(`${n.name}: ${gk === 'vp' ? 'video poker' : 'craps'} round stuck for hours`); if (fix) { n.cash = (n.cash || 0) + (n[gk].bet || 0) + (n[gk].odds || 0); n[gk] = null; ch = true; } }
        if (n.bj && n.bj.t && t - n.bj.t > 6 * HOUR) { found.push(`${n.name}: blackjack hand stuck for hours`); if (fix) { n.cash = (n.cash || 0) + (n.bj.bet || 0); n.bj = null; ch = true; } }
        for (const v of Object.keys(n.rel || {})) if (!S.docs['nations/' + v]) { if (fix) { delete n.rel[v]; ch = true; } }
        for (const f of ['troops', 'ships', 'air', 'spies']) if (Number.isFinite(+n[f]) && n[f] < 0) { found.push(`${n.name}: negative ${f} (${Math.round(n[f])})`); if (fix) { n[f] = 0; ch = true; } }
        if (Number.isFinite(+n.cash) && Math.abs(n.cash) > 1e15) found.push(`${n.name}: an impossible treasury (${WP.moneyS(n.cash)}); check how it got there before fixing it by hand`);
        for (const [k, ct] of Object.entries(n.cd || {})) if (typeof ct === 'number' && ct - Date.now() > 30 * 864e5) { found.push(`${n.name}: a cooldown (${k}) set more than 30 days ahead`); if (fix) { n.cd[k] = Date.now(); ch = true; } }
        if ((n.shield || 0) - Date.now() > 8 * 864e5) { found.push(`${n.name}: an attack shield longer than a week`); if (fix) { n.shield = Date.now() + 24 * HOUR; ch = true; } }
        if (n.uw) for (const k of Object.keys(n.uw)) if (!WP.UWONDERS[k]) { found.push(`${n.name}: building an unknown wonder (${k})`); if (fix) { delete n.uw[k]; ch = true; } }
        if (ch) setDoc('nations', id, n); }
      for (const t of Object.values(S.poker.tables)) for (let i = 0; i < t.seats.length; i++) { const st = t.seats[i]; if (st && !S.docs['nations/' + st.u]) { found.push(`${t.name}: a seat belongs to a nation that no longer exists`); if (fix) t.seats[i] = null; } }
      for (const bl of Object.values(S.blocs || {})) { const live = (bl.members || []).filter(m => S.docs['nations/' + m]); if (live.length !== (bl.members || []).length) { found.push(`${bl.name}: lists ${bl.members.length - live.length} nation(s) that no longer exist`); if (fix) bl.members = live; }
        for (const m of live) { const n = S.docs['nations/' + m]; if (n.bloc !== bl.id) { found.push(`${bl.name}: ${n.name} is a member but its nation points elsewhere`); if (fix) { const other = n.bloc && S.blocs[n.bloc] && S.blocs[n.bloc].members.includes(m); if (other) bl.members = bl.members.filter(x => x !== m); else { n.bloc = bl.id; setDoc('nations', m, n); } } } }
        if (fix && !bl.members.length) { delete S.blocs[bl.id]; continue; }
        if (!bl.members.includes(bl.leader)) { found.push(`${bl.name}: its leader is not a member`); if (fix) bl.leader = (bl.co || []).find(m => bl.members.includes(m)) || bl.members[0]; }
        if ((bl.co || []).some(m => !bl.members.includes(m) || m === bl.leader)) { found.push(`${bl.name}: stale co-leader entries`); if (fix) bl.co = bl.co.filter(m => bl.members.includes(m) && m !== bl.leader); }
        if (!Number.isFinite(+bl.bank) || bl.bank < 0) { found.push(`${bl.name}: treasury is ${bl.bank}`); if (fix) bl.bank = Math.max(0, +bl.bank || 0); } }
      if (fix) { persist(); sendBlocs(); try { blocRepair(); } catch (e) {} audit(me.name, 'World health check: fixed', null, found.length ? found.slice(0, 40).join('; ') : 'nothing to fix'); }
      return send(res, 200, { ok: true, found, fixed: fix });
    }
    else return send(res, 400, { error: 'Unknown repair.' });
    persist(); audit(me.name, 'World repair: ' + msg); return send(res, 200, { ok: true, msg });
  }
  if (p === '/api/admin/poker') { // Casino tab → Poker
    if (req.method === 'POST') { const b = (req._body || await readBody(req, 256)); if (b.op === 'cashout') { pkCashAll('The administrators closed the poker tables for a moment'); audit(me.name, 'Poker: cashed out every table'); return send(res, 200, { ok: true }); } return send(res, 400, { error: 'Unknown action.' }); }
    const nm = u => (S.docs['nations/' + u] || {}).name || (S.users[u] || {}).name || '?';
    return send(res, 200, { rake: S.poker.rake, hands: S.poker.hands, tables: Object.values(S.poker.tables).map(t => ({ id: t.id, name: t.name, sb: t.sb, bb: t.bb, seats: t.seats.map(x => x ? { name: nm(x.u), stack: x.stack, sitOut: !!x.sitOut } : null), live: !!(t.hand && !t.hand.done), pot: t.hand ? PK.potTotal(t.hand) : 0, hist: t.hist.slice(0, 5).map(h => ({ t: h.t, pot: h.pot, rake: h.rake, win: h.win.map(w => ({ name: nm(w.u), amt: w.amt, hand: w.hand })) })) })),
      top: Object.entries(S.poker.stats).map(([u, x]) => ({ name: nm(u), ...x })).sort((a, b) => b.net - a.net).slice(0, 10) });
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
  const b = req._body || await readBody(req, 16 * 1024);
  const u = typeof b.id === 'string' && Object.prototype.hasOwnProperty.call(S.users, b.id) ? S.users[b.id] : null;
  const target = u ? u.name : null;
  switch (p) {
    case '/api/admin/player': {
      if (!u) return send(res, 404, { error: 'Unknown player.' });
      return send(res, 200, { id: b.id, name: u.name, email: me.admin ? u.email : undefined, admin: !!u.admin, banned: !!u.banned, mutedUntil: u.mutedUntil || 0, created: u.created, meta: S.meta[b.id] || {}, nation: S.docs['nations/' + b.id] || null, flags: S.flags.filter(f => f.uid === b.id).slice(0, 100), reports: S.reports.filter(r => r.about === b.id).slice(0, 50) });
    }
    case '/api/admin/nation': { if (chaosOn() && req.method === 'POST') return send(res, 423, CHAOS_LOCK);
      const n = S.docs['nations/' + b.id]; if (!u || !n) return send(res, 404, { error: 'That player has no nation.' });
      const changes = [], pt = b.patch || {};
      for (const k of NUM_FIELDS) if (pt[k] != null && pt[k] !== '' && isFinite(+pt[k])) { const v = +pt[k]; if (v !== n[k]) { changes.push(`${k}: ${Math.round((n[k] || 0) * 100) / 100} → ${v}`); n[k] = v; } }
      if (pt.res && typeof pt.res === 'object') { n.res = n.res || {}; for (const r of ['food', 'oil', 'steel', 'goods', 'mun']) if (pt.res[r] != null && pt.res[r] !== '' && isFinite(+pt.res[r])) { const v = +pt.res[r]; if (v !== n.res[r]) { changes.push(`${r}: ${Math.round(n.res[r])} → ${v}`); n.res[r] = v; } } }
      if (typeof pt.name === 'string' && pt.name.trim() && pt.name.trim() !== n.name) { changes.push(`name: ${n.name} → ${pt.name.trim().slice(0, 28)}`); n.name = pt.name.trim().slice(0, 28); }
      n.approval = Math.max(0, Math.min(100, n.approval)); n.stability = Math.max(0, Math.min(100, n.stability)); n.tax = Math.max(5, Math.min(50, Math.round(n.tax)));
      if (b.resetCooldowns) { n.cd = {}; changes.push('cooldowns reset'); }
      setDoc('nations', b.id, n); audit(me.name, 'Edited nation', target, changes.join('; ') || 'no changes');
      return send(res, 200, { ok: true });
    }
    case '/api/admin/reset-nation': { if (chaosOn() && req.method === 'POST') return send(res, 423, CHAOS_LOCK); try { pkStandUser(b.id, null); } catch (e) {} if (!u) return send(res, 404, { error: 'Unknown player.' }); setDoc('nations', b.id, null); audit(me.name, 'Reset nation', target); return send(res, 200, { ok: true }); }
    case '/api/admin/ipbans': { // the block list, and (with an id) one player's networks with who else uses each
      const others = ip => Object.entries(S.meta).filter(([k, m]) => m && (m.ips || []).some(x => ipNorm(x) === ipNorm(ip)) && S.users[k]).map(([k]) => ({ id: k, name: S.users[k].name, banned: !!S.users[k].banned }));
      const list = S.ipBans.map(x => ({ ...x, accounts: x.ip.endsWith('*') ? Object.entries(S.meta).filter(([k, m]) => m && S.users[k] && (m.ips || []).some(y => ipMatch(y, x.ip))).map(([k]) => S.users[k].name) : others(x.ip).map(o => o.name) }));
      const mine = u ? ((S.meta[b.id] || {}).ips || []).map(ip => ({ ip, blocked: ipBlocked(ip), others: others(ip).filter(o => o.id !== b.id) })) : null;
      return send(res, 200, { list, mine, myIp: ipOf(req) }); }
    case '/api/admin/ipblock': {
      const ips = (Array.isArray(b.ips) ? b.ips : [b.ip]).map(x => ipNorm(x)).filter(Boolean).slice(0, 20); if (!ips.length) return send(res, 400, { error: 'Type an address.' });
      for (const ip of ips) if (!/^[0-9a-f:.]{2,45}\*?$/.test(ip) || ip === '*') return send(res, 400, { error: `"${ip}" is not an address. Use something like 203.0.113.7, or 203.0.113.* for a whole range.` });
      const mine = ipOf(req); if (ips.some(ip => ipMatch(mine, ip))) return send(res, 400, { error: 'That would block your own network. (Admins are never locked out, but this is probably a mistake.)' });
      let n = 0; for (const ip of ips) if (!S.ipBans.some(x => x.ip === ip)) { S.ipBans.unshift({ ip, note: String(b.note || '').slice(0, 120), by: me.name, t: Date.now(), who: u ? u.name : null }); n++; }
      S.ipBans = S.ipBans.slice(0, 500);
      for (const c of [...clients]) if (c.ip && ipBlocked(c.ip) && !(S.users[c.uid] || {}).admin) endStream(c); // anyone on a blocked network is disconnected now
      persist(); audit(me.name, 'Blocked network', `${ips.join(', ')}${u ? ' (' + u.name + ')' : ''}${b.note ? ' — ' + String(b.note).slice(0, 80) : ''}`); return send(res, 200, { ok: true, added: n }); }
    case '/api/admin/ipunblock': { const ip = ipNorm(b.ip); const before = S.ipBans.length; S.ipBans = S.ipBans.filter(x => x.ip !== ip); if (S.ipBans.length === before) return send(res, 404, { error: 'That address is not blocked.' }); persist(); audit(me.name, 'Unblocked network', ip); return send(res, 200, { ok: true }); }
    case '/api/admin/ban': case '/api/admin/unban': {
      if (p === '/api/admin/ban') try { pkStandUser(b.id, null); } catch (e) {}
      if (!u || b.id === me.id) return send(res, 400, { error: 'Unknown player.' });
      if (p.endsWith('/ban')) {
        u.banned = true; for (const [t, s] of Object.entries(S.sessions)) if (s.uid === b.id) delete S.sessions[t];
        for (const c of COLS) if (S.docs[c + '/' + b.id]) setDoc(c, b.id, null);
        for (const c of clients) if (c.uid === b.id) endStream(c);
        broadcast('user', { id: b.id, name: null }); audit(me.name, 'Banned player', target);
      } else { u.banned = false; broadcast('user', { id: b.id, name: pubName(b.id) }); audit(me.name, 'Unbanned player', target); }
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
      for (const c of clients) if (c.uid === b.id) endStream(c); persist(); audit(me.name, 'Kicked (signed out)', target); return send(res, 200, { ok: true });
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
    case '/api/admin/noai': { // master switch: every AI nation off (and removed), or back on
      const on = !!b.on; S.config.noAI = on; let gone = 0;
      if (on) { S.config.bots = 0; S.config.aiBoss = false; const W = mkWorld(); const ai = Object.keys(W.A).filter(u => BOTS.isBot(u)); for (const u of ai) removeBot(W, u); gone = ai.length; if (S.crisis && S.crisis.key === 'boss' && !S.crisis.over) S.crisis.over = true; commit(W); if (gone) systemMessage(`🤖 All AI nations have been removed from the world${gone > 1 ? ` (${gone})` : ''}. Their land is free to settle.`); }
      audit(me.name, on ? 'Turned all AI off' : 'Turned AI back on', on ? `${gone} AI nation${gone === 1 ? '' : 's'} removed` : 'Set AI nations and the Rising Power in Game settings'); persist(); broadcast('config', effCfg());
      return send(res, 200, { ok: true, gone, msg: on ? `All AI is off.${gone ? ` ${gone} AI nation${gone === 1 ? ' was' : 's were'} removed and their land is free.` : ''} New ones will not appear, including breakaway free states.` : 'AI is allowed again. Set how many AI nations you want and the Rising Power in Game settings.' });
    }
    case '/api/admin/config': {
      const c = b.config || {}, nc = { ...S.config };
      for (const k of ['cd', 'income', 'xp']) if (c[k] != null && isFinite(+c[k])) nc[k] = Math.max(0.1, Math.min(10, +c[k]));
      if (c.protectH != null && isFinite(+c.protectH)) nc.protectH = Math.max(0, Math.min(720, +c.protectH));
      if (c.electionH != null && isFinite(+c.electionH)) nc.electionH = Math.max(6, Math.min(720, +c.electionH));
      for (const k of ['war', 'signups', 'botRetire', 'eventsOn', 'conquest', 'weakRule', 'nukeTest', 'councilAuto', 'aiBoss', 'supply', 'acAuto']) if (c[k] != null) nc[k] = !!c[k];
      if (c.lastStandH != null && isFinite(+c.lastStandH)) nc.lastStandH = Math.max(0, Math.min(168, +c.lastStandH));
      if (c.motd != null) nc.motd = String(c.motd).slice(0, 1000);
      if (c.donateUrl != null) { const d = String(c.donateUrl).trim(); if (d && !/^https:\/\/[^\s"'<>]+$/i.test(d)) return send(res, 400, { error: 'The donation link must start with https://' }); nc.donateUrl = d || WP.DEFCFG.donateUrl; }
      if (c.bots != null && isFinite(+c.bots)) nc.bots = Math.max(0, Math.min(30, Math.round(+c.bots)));
      if (S.config.noAI) { nc.bots = 0; nc.aiBoss = false; } // the all-AI-off switch wins until it is turned back off
      if (['yes', 'retaliate', 'no'].includes(c.botWar)) nc.botWar = c.botWar;
      const diff = Object.keys(nc).filter(k => nc[k] !== S.config[k]).map(k => `${k}: ${S.config[k]} → ${nc[k]}`).join('; ');
      S.config = nc; persist(); broadcast('config', effCfg()); audit(me.name, 'Changed game settings', null, diff || 'no changes');
      return send(res, 200, { ok: true, config: nc });
    }
    case '/api/admin/announce': { const t = String(b.text || '').trim(); if (!t) return send(res, 400, { error: 'Type a message.' }); systemMessage(t); broadcast('announce', { text: t }); for (const id of Object.keys(S.users)) addNote(id, 'event', 'Announcement: ' + t.slice(0, 200)); audit(me.name, 'Announcement', null, t); return send(res, 200, { ok: true }); }
    case '/api/admin/finale-preview': { const se = (S.seasons && S.seasons.cur) || { id: 'preview', name: 'Season' }; const f = finaleBuild(se, true); return send(res, 200, { ok: true, finale: { ...f, now: Date.now() } }); }
    case '/api/admin/clear-chat': { for (const k of Object.keys(S.docs)) if (k.startsWith('chat/')) setDoc('chat', k.slice(5), null); audit(me.name, 'Cleared chat'); return send(res, 200, { ok: true }); }
    case '/api/admin/event-start': { const k = String(b.key || ''); if (!WP.EVENTS[k]) return send(res, 400, { error: 'Unknown event.' }); if (S.event) endEvent(true); startEvent(k); audit(me.name, 'Started world event', WP.EVENTS[k].n); return send(res, 200, { ok: true }); }
    case '/api/admin/event-end': { if (S.event) { const n = WP.EVENTS[S.event.key].n; endEvent(); audit(me.name, 'Ended world event', n); } return send(res, 200, { ok: true }); }
    case '/api/admin/council-cancel': { const pr = S.council.props.find(x => x.id === b.prop && x.status === 'open'); if (pr) { pr.status = 'cancelled'; if (pr.fee && pr.by && S.docs['nations/' + pr.by]) { S.docs['nations/' + pr.by].cash += pr.fee; sendNation(pr.by); addNote(pr.by, 'council', `An admin cancelled your vote, so your ${WP.moneyS(pr.fee)} penalty deposit was refunded.`); } persist(); councilCast(); audit(me.name, 'Cancelled council vote', WP.RESOLUTIONS[pr.type].n); } return send(res, 200, { ok: true }); }
    case '/api/admin/setrogue': { // make a nation a rogue state until a set time (e.g. to restore status that ended early because of a bug)
      const id = String(b.id || ''), W = mkWorld(), n = W.A[id], now = Date.now(), until = Math.round(+b.until); if (!n) return send(res, 404, { error: 'That nation was not found.' });
      if (!isFinite(until) || until < now + 60e3 || until > now + 7 * 864e5) return send(res, 400, { error: 'Pick an end time between now and 7 days from now.' });
      const was = core.rogue(W, n); n.rogue = until; n.rogueT = now; if (b.nuke) n.nukeRogue = n.nukeRogue && was ? n.nukeRogue : now; else delete n.nukeRogue; W.changed.add(id);
      const hrs = Math.round((until - now) / 36e5 * 10) / 10;
      if (!was) core.news(W, id, `☠ ${n.name} is a rogue state again${b.nuke ? ' (from its nuclear strike)' : ''}. Attacking it adds no aggression.`);
      commit(W); if (!n.ai) addNote(id, 'war', `☠ Your nation's rogue status was set to last about ${hrs} more hours${b.nuke ? ', because of your nuclear strike (it cannot be bought off or voted away)' : ''}. ${String(b.why || '').slice(0, 200)}`.trim());
      audit(me.name, 'Set rogue status', n.name, `${hrs} hours${b.nuke ? ', nuclear (cannot be bought off)' : ''}`); persist(); return send(res, 200, { ok: true, until, hrs });
    }
    case '/api/admin/hcrelease': { const h = (S.hc || {})[String(b.id || '')]; if (!h || !h.jail) return send(res, 400, { error: 'That player is not in jail.' }); const was = h.jail; delete h.jail; h.streak = 0; h.pend = null; h.lock = 0; h.pendHits = 0; if (S.botsig && S.botsig[String(b.id)]) S.botsig[String(b.id)].a = []; /* a fresh start: the actions that led to the jail don't count again */ hcLog(b.id, 'released', { by: me.name }); addNote(b.id, 'war', '✅ The review is done and your account has been released. Thanks for your patience.'); persist(); return send(res, 200, { ok: true, was }); }
    case '/api/admin/hcset': { S.config.humanCheck = !!b.on; if (!b.on) for (const h of Object.values(S.hc || {})) { h.pend = null; h.lock = 0; } persist(); return send(res, 200, { ok: true, on: !!b.on }); } // turn the human check on or off (turning it off clears any open checks)
    case '/api/admin/scriptcheck': return send(res, 200, { rows: scriptCheck(), hcEvents: Object.entries(S.hc || {}).flatMap(([uid, h]) => (h.log || []).filter(x => Date.now() - x.t < 72 * HOUR).map(x => ({ ...x, uid, name: (S.users[uid] || {}).name || '?' }))).sort((a, b) => b.t - a.t).slice(0, 150), hcOn: !(S.config && S.config.humanCheck === false), jailed: Object.entries(S.hc || {}).filter(([, h]) => h && h.jail).map(([uid, h]) => ({ uid, name: (S.users[uid] || {}).name || '?', nation: ((S.docs['nations/' + uid]) || {}).name || '', t: h.jail.t, why: h.jail.why })), t: Date.now() });
    case '/api/admin/cheatreview': { // your decision on a player after reviewing the evidence (only admins see it)
      if (!u) return send(res, 404, { error: 'Unknown player.' }); const d = ['cheat', 'clean', 'watch'].includes(b.d) ? b.d : null;
      if (!d) delete S.cheatReview[b.id]; else S.cheatReview[b.id] = { d, t: Date.now(), by: me.name, note: String(b.note || '').replace(/\s+/g, ' ').slice(0, 300) };
      if (d === 'clean') { delete S.acl[b.id]; const h = (S.hc || {})[b.id]; if (h && h.jail && h.jail.until) { delete h.jail; h.streak = 0; h.pend = null; hcLog(b.id, 'released', { why: 'marked not cheating' }); addNote(b.id, 'war', '✅ An admin reviewed your account and lifted the suspension. You can play again.'); } }
      audit(me.name, 'Cheat review', target, d ? { cheat: 'Cheating', clean: 'Not cheating', watch: 'Keep watching' }[d] : 'Cleared'); persist(); return send(res, 200, { ok: true, rows: scriptCheck(), t: Date.now() });
    }
    case '/api/admin/timeline': { if (!u) return send(res, 404, { error: 'Unknown player.' }); return send(res, 200, timeline(b.id)); }
    case '/api/admin/restore-nation': { if (chaosOn() && req.method === 'POST') return send(res, 423, CHAOS_LOCK);
      if (!u) return send(res, 404, { error: 'Unknown player.' }); if (b.confirm !== 'RESTORE') return send(res, 400, { error: 'Type RESTORE to confirm.' });
      try { return send(res, 200, { ok: true, ...restoreNation(b.id, String(b.snap || ''), me.name) }); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    case '/api/admin/rollback': { if (chaosOn() && req.method === 'POST') return send(res, 423, CHAOS_LOCK);
      if (b.confirm !== 'ROLLBACK') return send(res, 400, { error: 'Type ROLLBACK to confirm.' });
      let name = String(b.snap || ''); const snaps = listSnaps();
      if (!name && b.minutes) { const target = Date.now() - Math.max(1, +b.minutes) * 60e3; const sn = snaps.find(x => x.t <= target && x.tag !== 'undo'); if (!sn) return send(res, 400, { error: 'No snapshot that old yet — they are kept for 26 hours, starting from when this update went live.' }); name = sn.name; }
      try { const sn = rollback(name, me.name); return send(res, 200, { ok: true, t: sn.t }); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    case '/api/admin/wipe-world': { if (chaosOn() && req.method === 'POST') return send(res, 423, CHAOS_LOCK);
      if (b.confirm === 'WIPE') try { pkCashAll(null); } catch (e) {}
      if (b.confirm !== 'WIPE') return send(res, 400, { error: 'Type WIPE to confirm.' });
      const backup = path.join(BACKUP_DIR, `backup-before-wipe-${Date.now()}.json`); fs.writeFileSync(backup, JSON.stringify(S)); S.burn = {}; S.strikes = [];
      for (const k of Object.keys(S.docs)) { const [c, id] = k.split('/'); if (COLS.includes(c)) setDoc(c, id, null); }
      S.flags = []; S.council = { props: [], active: {} }; S.blocs = Object.create(null); S.crisis = null; S.games = null; S.dis = []; S.event = null; RH = []; rhGz = null; try { fs.unlinkSync(RANK_FILE); } catch (e) {} councilCast(); broadcast('event', null);
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
      if (S.config.noAI) return send(res, 400, { error: 'All AI is turned off. Turn AI back on (Game settings) first.' }); 
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
  const online = Object.entries(S.docs).filter(([k, d]) => k.startsWith('online/') && !d.ai && !d.test && now - (d.t || 0) < 30 * 60e3).length;
  const newsl = []; for (const n of Object.values(W.A)) for (const e of n.out || []) if (e.type === 'news') newsl.push({ t: e.t, x: e.x });
  newsl.sort((a, b) => b.t - a.t);
  const v = { nations: ids.length, players: humans(W).length, online, provinces: core.P.length, scenarios: SCENARIOS.length,
    top: ids.slice(0, 5).map(u => ({ name: W.A[u].name, color: W.A[u].color, rank: core.rankName(W.A[u]), provinces: core.hexesOf(W, u).length, ai: !!W.A[u].ai })),
    news: newsl.filter(x => !/^A new nation has been founded/.test(x.x)).slice(0, 6), event: S.event && S.event.end > now ? { n: WP.EVENTS[S.event.key].n, d: WP.EVENTS[S.event.key].d } : null };
  publicCache = { t: Date.now(), v }; return v;
}

// ---------- routes ----------
// supporter rewards (verified PayPal donations); the IPN address is built from this site's own address
const siteUrl = req => process.env.SITE_URL ? String(process.env.SITE_URL).replace(/\/+$/, '') : ((isHttps(req) ? 'https' : 'http') + '://' + (/^[a-z0-9.-]+(:\d+)?$/i.test(req.headers.host || '') ? req.headers.host : 'worldpowersgame.com'));
SUPP = makeSupporters({ S, send, readBody, persist, setDoc, sendTo, broadcast, addNote, flag, logErr, MOD, WP, siteUrl, chaosBuy, chaosInfo });
async function handle(req, res) {
  let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { return notFound(req, res); }
  const minute = Math.floor(Date.now() / 60000); health.reqs.set(minute, (health.reqs.get(minute) || 0) + 1);
  if (S.ipBans.length && ipBlocked(ipOf(req))) { let adm = null; try { adm = auth(req); } catch (e) {} if (!(adm && adm.admin)) { // an admin is never locked out by a block on their own network
    if (p.startsWith('/api/')) return send(res, 403, { error: 'Access from your network has been blocked by the administrators.' });
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(BLOCK_PAGE); } }
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(req, res, auth(req) ? gameFile() : LANDING);
    if (req.method === 'GET' && p === '/donate/paypal') { const d = /^https:\/\/[^\s"'<>]+$/i.test(S.config.donateUrl || '') ? S.config.donateUrl : WP.DEFCFG.donateUrl; res.writeHead(302, { Location: d, 'Cache-Control': 'no-store' }); return res.end(); } // the plain donation link (paypal.me)
    if (req.method === 'GET' && p === '/play') return serveStatic(req, res, gameFile());
    if (req.method === 'GET' && p === '/tutorial.mp4' && TUTV) return serveVideo(req, res);
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
      return send(res, 200, { fingerprint: FINGERPRINT, files: CODE, live: START, releases: S.releases.slice(0, 50), log: S.fairlog.slice(0, 500).map(e => e.target ? { ...e, target: privTarget(e.target) } : e), logTotal: S.fairlog.length,
        settings: Object.fromEntries(keys.map(k => [k, c[k]])), defaults: Object.fromEntries(keys.map(k => [k, WP.DEFCFG[k]])), boost: c.boost || null, council: S.council.active, event: S.event, finance: S.finance.slice(0, 500),
        world: { nations: Object.keys(S.docs).filter(k => k.startsWith('nations/')).length, players: Object.keys(S.users).length } }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/sitemap.xml') { // the pages search engines may read: the front page, the FAQ and every nation's public page
      const base = (process.env.SITE_URL || 'https://worldpowersgame.com').replace(/\/$/, ''), day = new Date().toISOString().slice(0, 10), urls = ['/', '/faq'], seen = new Set();
      for (const [k, n] of Object.entries(S.docs)) if (k.startsWith('nations/') && n && n.name) { const sl = slugify(n.name); if (sl && !seen.has(sl)) { seen.add(sl); urls.push('/n/' + sl); } }
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.slice(0, 5000).map(u => `<url><loc>${escH(base + u)}</loc><lastmod>${day}</lastmod></url>`).join('\n') + '\n</urlset>\n';
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' }); return res.end(xml); }
    if (req.method === 'GET' && p === '/api/public/stats') return send(res, 200, publicStats(), { 'Cache-Control': 'public, max-age=30' });
    if (req.method === 'GET' && p === '/api/public/hof') { let cur = null; try { const se = S.seasons.cur; if (se) { const v = seasonView(seasonW(), se, null); cur = { ...v, top: v.top.slice(0, 10) }; } } catch (e) { } return send(res, 200, { hof: noLeaders(HOF), cur }, { 'Cache-Control': 'public, max-age=30' }); } // public: anyone can see the Hall of Fame
    if (req.method === 'GET' && p === S.adminPath) { const me = auth(req); if (!isStaff(me)) return notFound(req, res); return serveStatic(req, res, ADMIN_HTML); }
    if (req.method === 'GET' && p.startsWith('/n/')) return await nationPage(req, res, p.slice(3));
    if (!p.startsWith('/api/')) return notFound(req, res);
    if (p === '/api/paypal/ipn' && req.method === 'POST') { if (limited('ipn:' + ipOf(req), 30, 60e3) || limited('ipn:all', 300, 60 * 60e3)) return send(res, 429, { error: 'Slow down.' }); return SUPP.ipn(req, res); } // each message is checked with PayPal, so floods are capped // PayPal posts here (form-encoded, from PayPal's servers)
    if (p === '/api/donate/go' && req.method === 'GET') { const who = auth(req); if (!who) { res.writeHead(302, { Location: '/donate/paypal', 'Cache-Control': 'no-store' }); return res.end(); } await SUPP.handle(req, res, p, who); return; }

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
      const token = newSession(id); broadcast('user', { id, name: pubName(id) });
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
      const token = newSession(id); broadcast('user', { id, name: pubName(id) });
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
    if (p === '/api/dev' || p.startsWith('/api/dev/')) { try { const b = req.method === 'POST' ? await readBody(req, 6 * 1024) : null; if (b) touch(me.id, req); return send(res, 200, devHandle(me, p, req.method, b || {}, new URL(req.url, 'http://x').searchParams)); } catch (e) { return send(res, e.status || 400, { error: e.message || 'Something went wrong.' }); } }
    if (chaosOn() && ['/api/supporter/chest', '/api/supporter/rush', '/api/supporter/instant'].includes(p) && req.method === 'POST') return send(res, 423, { error: 'Supporter perks are paused during Chaos world so you don\'t lose them when the real world comes back. Claim them as soon as it ends.' });
    if (p === '/api/supporter' || p.startsWith('/api/supporter/')) { if (p !== '/api/supporter' && limited('sup:' + me.id, 20, 60e3)) return send(res, 429, { error: 'Slow down.' }); touch(me.id, req); if (await SUPP.handle(req, res, p, me)) return; }
    // Crash: checking on a running round and cashing out. Kept apart from ordinary game actions so a human check or the action limit can never get between a player and the cash-out button.
    if (p === '/api/casino/crash' && req.method === 'POST') {
      if (limited('crash:' + me.id, 60, 10e3)) return send(res, 429, { error: 'Slow down.' });
      const b = await readBody(req, 256), a = b.a === 'cash' ? 'cash' : 'peek'; { const jl = hcJail(me.id); if (jl) return send(res, 423, jl); }
      const W = mkWorld(); if (!W.A[me.id] || !W.A[me.id].crash) return send(res, 200, { casino: { g: 'crash', alive: false, none: true }, me: S.docs['nations/' + me.id] || null });
      const fair = fairOf(me.id); W.fairNonce = fair.nonce; W.fairHash = sha256(fair.seed); W.fairAt = nz => fairRng({ seed: fair.seed, client: fair.client, nonce: nz });
      let r; try { r = core.exec(W, me.id, { c: 'casino', g: 'crash', a }, Math.random); } catch (e) { if (e.user) return send(res, 400, { error: e.message }); throw e; }
      if (W.casinoEv) casinoRecord(W); commit(W); if (a === 'cash' || !r.casino.alive) touch(me.id, req);
      return send(res, 200, { ok: true, msg: r.msg, casino: r.casino.alive ? r.casino : { ...r.casino, tot: casinoTotals() }, me: r.casino.alive ? undefined : S.docs['nations/' + me.id] || null });
    }
    if (p === '/api/casino/fair') { const f = fairOf(me.id);
      if (req.method === 'GET') return send(res, 200, fairView(f));
      const b = await readBody(req, 1024);
      if (b.op === 'client') { const c = String(b.client || '').trim(); if (!/^[A-Za-z0-9_-]{1,64}$/.test(c)) return send(res, 400, { error: 'Use 1 to 64 letters, numbers, dashes or underscores.' }); const n = S.docs['nations/' + me.id]; if (n && (n.bj || n.vp || n.craps || n.crash)) return send(res, 400, { error: 'Finish the round you are playing first.' });
        if (f.nonce > (f.from || 0)) { f.prev = [{ seed: f.seed, hash: sha256(f.seed), client: f.client, from: f.from || 0, to: f.nonce - 1, t: Date.now() }, ...(f.prev || [])].slice(0, 50); f.seed = crypto.randomBytes(32).toString('hex'); f.from = f.nonce; } // a new client seed always starts a new server seed, so every revealed period checks out
        f.client = c; persist(); return send(res, 200, fairView(f)); }
      if (b.op === 'rotate') { const n = S.docs['nations/' + me.id]; if (n && (n.bj || n.vp || n.craps || n.crash)) return send(res, 400, { error: 'Finish the round you are playing first.' });
        f.prev = [{ seed: f.seed, hash: sha256(f.seed), client: f.client, from: f.from || 0, to: f.nonce - 1, t: Date.now() }, ...(f.prev || [])].slice(0, 50); f.seed = crypto.randomBytes(32).toString('hex'); f.from = f.nonce; persist(); return send(res, 200, fairView(f)); }
      return send(res, 400, { error: 'Unknown operation.' }); }
    if (p.startsWith('/api/spy/')) return spyRoute(p, req, res, me);
    if (p === '/api/finale/seen' && req.method === 'POST') { const b = await readBody(req, 512); if (S.finaleLast && 'replay-' + S.finaleLast.id === String(b.id || '')) { S.finaleLast.seen[me.id] = 1; persist(); } return send(res, 200, { ok: true }); }
    if (p === '/api/poker' && req.method === 'POST' && finaleLock()) return send(res, 423, FINALE_LOCK_MSG);
    if (p === '/api/poker') return pokerRoute(p, req, res, me);
    if (p === '/api/casino/totals' && req.method === 'GET') return send(res, 200, { tot: casinoTotals() });
    if (p === '/api/casino/live' && req.method === 'GET') return send(res, 200, czLive(me.id));
    if (p === '/api/routeq' && req.method === 'GET') { const W = mkWorld(), q = {}; if (W.A[me.id]) for (const v of Object.keys(W.A)) if (v !== me.id && core.routeOk(W, me.id, v)) q[v] = { pay: core.routePay(W, me.id, v), cost: core.routeCost(W, me.id, v) }; return send(res, 200, { q, t: Date.now() }); } // exact trade route quotes for your allies (partners' tax rates are private, so the browser can't work them out)
    if (p === '/api/season' && req.method === 'GET') return send(res, 200, { cur: seasonView(seasonW(), S.seasons.cur, me.id), hof: noLeaders(HOF) });
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
      Object.assign(u, { email, name, ...hashPw(pw) }); delete u.guest; persist(); broadcast('user', { id: me.id, name: pubName(me.id) });
      return send(res, 200, { ok: true, me: pub({ id: me.id, ...u }) });
    }
    if (p === '/api/invite' && req.method === 'GET') {
      const code = inviteCode(me.id), joined = Object.values(S.users).filter(u => u.ref === me.id).length, rewarded = (meta(me.id).invites || 0);
      const W_ = mkWorld(); return send(res, 200, { code, joined, rewarded, max: INVITE.max, welcome: INVITE.welcome, pay: invitePay(W_, me.id), rank: WP.RANKS[INVITE.rank][1] });
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
        for (const c of clients) if (c.uid === me.id) endStream(c);
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
      // the live stream is gzip-compressed when the page asks for it (?z=1): game updates are repetitive JSON and shrink to a fraction. Every message is flushed at once.
      const zip = new URL(req.url, 'http://x').searchParams.get('z') === '1' && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...(zip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
      let out = null; if (zip) { out = zlib.createGzip({ level: 6, memLevel: 6, windowBits: 14, flush: zlib.constants.Z_SYNC_FLUSH }); out.on('error', () => {}); out.pipe(res); }
      const c = { res, out, uid: me.id, ip: ipOf(req), slim: new URL(req.url, 'http://x').searchParams.get('k') === '1' };
      (out || res).write('retry: 3000\n\n'); write(c, 'init', snapshot(me.id));
      const mine = [...clients].filter(x => x.uid === me.id); if (mine.length >= 6) { endStream(mine[0]); clients.delete(mine[0]); }
      clients.add(c); const bye = () => { clients.delete(c); if (out) try { out.destroy(); } catch (e) {} }; res.on('error', bye); req.on('close', bye);
      return;
    }

    // Every game action goes through here. The server validates it and applies it.
    if (p === '/api/cmd' && req.method === 'POST' && finaleLock()) return send(res, 423, FINALE_LOCK_MSG);
    if (p === '/api/cmd' && req.method === 'POST') {
      if (limited('cmd:' + me.id, 30, 10e3)) { flag(me.id, 'Sending game actions faster than a person can click (possible bot/script)'); return send(res, 429, { error: 'Slow down.' }); }
      const b = await readBody(req, 8 * 1024);
      touch(me.id, req); health.cmds++; stat('cmds');
      { const jl = hcJail(me.id); if (jl) return send(res, 423, jl); }
      if (b && b.c) { const g = hcGate(me.id, b.c === 'act'); if (g) return send(res, g.jail ? 423 : 428, g); } // now and then, a quick human check before an operation (any kind)
      const W = mkWorld();
      if ((S.fresh || core.fairOn(W)) && ['aid', 'offer'].includes(b.c) && typeof b.v === 'string' && b.v !== me.id && sharesNetwork(me.id, b.v)) return send(res, 400, { error: S.fresh ? 'During the season you can\'t send aid or trade offers to an account on the same network as yours.' : 'You can\'t send aid or trade offers to an account on the same network as yours.' });
      if ((S.fresh || core.fairOn(W)) && b.c === 'relief') { const d = (S.dis || []).find(x => x.id === String(b.id)); if (d && d.u !== me.id && sharesNetwork(me.id, d.u)) return send(res, 400, { error: (S.fresh ? 'During the season you can\'t' : 'You can\'t') + ' send relief to an account on the same network as yours.' }); }
      if (b.c === 'aid' && typeof b.v === 'string' && sharesNetwork(me.id, b.v)) flag(me.id, `Sent aid to ${(S.users[b.v] || {}).name || 'a player'}, who uses the same network (possible second account)`);
      if (b.c === 'found' && typeof b.name === 'string' && MOD.isProfane(b.name)) return send(res, 400, { error: 'Please choose a different name for your nation.' });
      if ((b.c === 'found' || b.c === 'movecap') && typeof b.name === 'string' && SUPP.reservedBy(b.name, me.id)) return send(res, 400, { error: 'That nation name is reserved by a World Powers supporter. Please choose another.' });
      if (b.c === 'flag' && typeof b.motto === 'string' && MOD.isProfane(b.motto)) return send(res, 400, { error: 'Please choose a different motto.' });
      if (b.c === 'bloc' && ['name', 'tag', 'motto', 'text'].some(k => typeof b[k] === 'string' && MOD.isProfane(b[k]))) return send(res, 400, { error: 'Please choose different wording.' });
      if (b.c === 'movecap' && typeof b.name === 'string' && MOD.isProfane(b.name)) return send(res, 400, { error: 'Please choose a different name for your nation.' });
      if (b.c === 'offer' && b.v && S.users[b.v] && sharesNetwork(me.id, b.v)) flag(me.id, `Sent a trade offer to ${(S.users[b.v] || {}).name || 'a player'}, who uses the same network (possible second account)`);
      let r;
      let fair = null, useRng = rng; if (b.c === 'casino') { fair = fairOf(me.id); W.fairNonce = fair.nonce; W.fairHash = sha256(fair.seed); W.fairAt = nz => fairRng({ seed: fair.seed, client: fair.client, nonce: nz }); useRng = fairRng(fair); }
      const readyAt = b.c === 'act' && W.A[me.id] ? +((W.A[me.id].cd || {})[String(b.k)] || 0) : 0;
      try { r = core.exec(W, me.id, b, useRng); }
      catch (e) { if (e.user) { actLog(me.id, W, b, false, e.message); return send(res, 400, { error: e.message }); } throw e; }
      if (fair) { if (r.casino) r.casino.fair = { nonce: fair.nonce, hash: W.fairHash }; fair.nonce++; }
      if (b.c === 'dip' && b.kind === 'peace' && typeof b.v === 'string' && S.users[b.v] && !BOTS.isBot(b.v) && r.msg !== undefined && core.atWar(W, me.id, b.v)) { const seen = (S.meta[b.v] || {}).lastSeen || 0, on = [...clients].some(c => c.uid === b.v); if (!on && Date.now() - seen >= PEACE_IDLE.awayH * 36e5) r.msg = `Peace offered. They haven't played for over a day, so if they don't answer within ${PEACE_IDLE.waitH} hours, peace is signed for them automatically.`; }
      actLog(me.id, W, b, true, r.msg); try { botRecord(me.id, b, readyAt, req, b.c === 'act' && W.A[me.id] ? Math.max(0, +((W.A[me.id].cd || {})[String(b.k)] || 0) - Date.now()) : 0); } catch (e) {} pactCheck(W); if (W.crch || (b.c === 'attack' && S.crisis)) crisisCheck(W);
      if (b.c === 'found') { stat('nations'); if (!S.fresh) inviteReward(W, me.id); else if (S.seasons.cur && S.seasons.cur.fresh) { const pl = S.seasons.cur.played = S.seasons.cur.played || {}; pl[me.id] = 1; } }
      if (!S.fresh && !chaosOn() && me.ref && !me.refRank) inviteRank(W, me.id);
      const pendFound = b.c === 'found' && !S.fresh && S.meta[me.id] && (S.meta[me.id].seasonPending || []).length;
      if (W.casinoEv) casinoRecord(W);
      commit(W); if (pendFound) seasonPendingApply(me.id);
      // your own nation comes back with the answer, so the screen updates the moment the action is done (no waiting on the live stream)
      const fell = b.c === 'attack' ? (W.fallen || []).find(f => f.by === me.id && !BOTS.isBot(f.id)) : null; /* a player's capital fell: the attacker may leave them a last message */
      return send(res, 200, { ok: true, fell: fell ? { id: fell.id, t: fell.t, name: fell.name, mins: LASTWORDS_MIN } : undefined, msg: r.msg, battle: r.battle, promoted: W.promoted || null, selHex: W.selHex != null ? W.selHex : null, covert: r.ok, casino: r.casino ? { ...r.casino, tot: casinoTotals() } : undefined, me: S.docs['nations/' + me.id] || null });
    }

    // ---- last words: the conqueror of a player's capital may leave one short message on that player's fall screen ----
    if (p === '/api/lastwords' && req.method === 'POST') {
      if (limited('lastwords:' + me.id, 10, 10 * 60e3)) return send(res, 429, { error: 'Slow down.' });
      const b = await readBody(req, 2048); touch(me.id, req);
      const rec = S.fallen.find(f => f.id === String(b.id || '') && f.t === +b.t && f.by === me.id && !f.ai);
      if (!rec) return send(res, 400, { error: 'You can only leave a last message for a nation whose capital you captured.' });
      if (Date.now() - rec.t > LASTWORDS_MIN * 60e3) return send(res, 400, { error: `Last messages can only be sent in the first ${LASTWORDS_MIN} minutes after the capital falls.` });
      if (rec.msg) return send(res, 400, { error: 'You already left a last message for this nation.' });
      const text = String(b.text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LASTWORDS_MAX);
      if (!text) return send(res, 400, { error: 'Write a message first.' });
      if (MOD.isProfane(text)) return send(res, 400, { error: 'Please choose different wording.' });
      rec.msg = text; const m = S.meta[rec.id]; if (m && m.fallen && m.fallen.t === rec.t) m.fallen.msg = text;
      sendTo(rec.id, 'lastwords', { t: rec.t, msg: text });
      addNote(rec.id, 'attack', `${rec.byName} left a last message on the fall of ${rec.name}: “${text}”`);
      persist(); return send(res, 200, { ok: true });
    }

    // ---- mail ----
    if (p === '/api/mail' && req.method === 'GET') return send(res, 200, { mail: (S.mail[me.id] || []).map(m => ({ ...m, fromName: nationName(m.from), toName: nationName(m.to), fromLeader: m.from === HD ? 'Game staff' : m.from === me.id ? me.name : nationName(m.from), toLeader: m.to === HD ? 'Game staff' : m.to === me.id ? me.name : nationName(m.to) })) });
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
    if (p === '/api/opvote' && req.method === 'POST') { // thumbs up/down on an intelligence mission (send the same vote again to take it back)
      const b = await readBody(req, 512), op = String(b.op || ''), v = b.v > 0 ? 1 : b.v < 0 ? -1 : 0;
      if (!WP.COVERT[op] || !Object.prototype.hasOwnProperty.call(WP.COVERT, op)) return send(res, 400, { error: 'Unknown mission.' });
      if (S.users[me.id] && S.users[me.id].test) return send(res, 400, { error: 'Test accounts do not vote.' });
      const m = OPV()[op] = OPV()[op] || {}; if (v) m[me.id] = v; else delete m[me.id]; persist();
      return send(res, 200, { ok: true, opVotes: opVotesFor(me.id) });
    }
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
      const b = await readBody(req, 2048); const pr = prefsOf(me.id); for (const k of NOTE_KINDS) if (typeof b[k] === 'boolean') pr[k] = b[k];
      // spy mini-games: a player may opt out (nobody can use the vault, cipher or sniper on them, and they cannot use them either). Once a day, so it cannot be flipped to dodge an attack.
      if (typeof b.spygames === 'boolean' && b.spygames !== pr.spygames) { const m = meta(me.id); if (limited('spyopt:' + me.id, 6, 60e3)) return send(res, 429, { error: 'Slow down a little.', prefs: pr }); if (SPYG.has(me.id)) return send(res, 400, { error: 'Finish your spy operation first.', prefs: pr }); pr.spygames = b.spygames; m.spyOptT = Date.now(); setTimeout(() => broadcast('spyopt', spyOptList()), 0); }
      meta(me.id).prefs = pr; persist(); return send(res, 200, { ok: true, prefs: pr });
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
      const b = await readBody(req, 4096); const about = String(b.id || ''); if (!S.users[about]) return send(res, 400, { error: 'Unknown player.' }); if (S.users[about].test) return send(res, 400, { error: 'Test is an admin test account, not a real player.' });
      S.reports.unshift({ id: rid(), t: Date.now(), by: me.id, byName: me.name, about, aboutName: S.users[about].name, kind: ['chat', 'mail', 'name', 'other'].includes(b.kind) ? b.kind : 'other', text: String(b.text || '').slice(0, 500), reason: String(b.reason || '').slice(0, 300), done: false });
      S.reports = S.reports.slice(0, 500); persist(); return send(res, 200, { ok: true });
    }
    // ---- World Council ----
    if ((p.startsWith('/api/bm/') || p.startsWith('/api/council/') || p === '/api/mail/send') && req.method === 'POST' && hcJail(me.id)) return send(res, 423, hcJail(me.id));
    if ((p.startsWith('/api/bm/') || p.startsWith('/api/council/')) && req.method === 'POST' && finaleLock()) return send(res, 423, FINALE_LOCK_MSG);
    if (p === '/api/jail' && req.method === 'GET') return send(res, 200, { jail: hcJail(me.id) });
    if (p === '/api/hc' && req.method === 'POST') { if (limited('hc:' + me.id, 20, 60e3)) return send(res, 429, { error: 'Slow down.' }); const b = await readBody(req, 512); touch(me.id, req); return send(res, 200, hcAnswer(me.id, b || {})); }
    if (p === '/api/council/propose' && req.method === 'POST') { const b = await readBody(req, 2048); touch(me.id, req); councilPropose(me.id, b); return send(res, 200, { ok: true }); }
    // daily thank-you for voting for the game: once every 24 hours per account, 1% of GDP ($1M to $25M). The vote itself can't be checked, so the daily limit keeps it fair.
    if (p === '/api/vote-bonus' && req.method === 'POST') { // every voting site pays its own bonus whenever its button is lit (6 hours after the last claim on that site)
      touch(me.id, req); const n = S.docs['nations/' + me.id]; if (!n) return send(res, 400, { error: 'Found a nation first, then vote to get your bonus.' });
      const bb = await readBody(req, 256), site = VOTE_SITES[bb.site] ? String(bb.site) : 'gt', m = meta(me.id), now = Date.now(); m.voteS = m.voteS || {};
      if (!m.voteS.gt && m.voteT && !bb.site) m.voteS.gt = m.voteT; // an old page that does not say which site: count it as Gametoor
      const wait = (m.voteS[site] || 0) + VOTE_GAP - now;
      if (wait > 0) return send(res, 200, { ok: false, site, voteS: m.voteS, next: m.voteS[site] + VOTE_GAP, msg: `Thanks for voting! Your ${VOTE_SITES[site]} bonus is ready again in ${Math.floor(wait / HOUR)}h ${Math.floor(wait % HOUR / 60e3)}m.` });
      const amt = voteBonus(n); core.finSync(null, n); n.cash = (n.cash || 0) + amt; core.finSync(null, n, 'rewards'); m.voteS[site] = now; m.voteT = now; (n.log = n.log || []).unshift({ t: now, x: `Thank you for voting for World Powers on ${VOTE_SITES[site]}: +${WP.moneyS(amt)} bonus.` }); n.log = n.log.slice(0, 60);
      setDoc('nations', me.id, n); stat('votes'); persist(); return send(res, 200, { ok: true, amt, site, voteS: m.voteS, next: now + VOTE_GAP, msg: `Thanks for voting on ${VOTE_SITES[site]}! +${WP.moneyS(amt)} has been added to your treasury.` });
    }
    if (p === '/api/bm' && req.method === 'GET') return send(res, 200, bmView(me.id));
    if (p.startsWith('/api/bm/') && req.method === 'POST') { if (limited('bm:' + me.id, 12, 60e3)) return send(res, 429, { error: 'Slow down: the black market is watching.' }); const b = await readBody(req, 1024); touch(me.id, req);
      const fn = { '/api/bm/post': bmPost, '/api/bm/cancel': bmCancel, '/api/bm/buy': bmBuy }[p]; if (!fn) return send(res, 404, { error: 'Not found.' }); return send(res, 200, fn(me.id, b)); }
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
            for (const [uid2, u2] of Object.entries(S.users)) { const nn2 = (S.docs['nations/' + uid2] || {}).name; if (k >= 3 || uid2 === me.id || u2.banned || !nn2) continue; if (low.includes('@' + nn2.toLowerCase()) && !((meta(uid2).muted || []).includes(me.id))) { k++; addNote(uid2, 'mention', `${nationName(me.id)} mentioned you in chat: “${nm.x.slice(0, 90)}”`); } } }
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
