// World Powers — Test lab worker.
// Runs in its own thread with its OWN copy of the world. It never touches the real game: the main server only sends it a
// snapshot and receives reports back. Simulated players of different kinds play nonstop, try every command (including
// garbage input), and every action is checked for crashes, broken numbers, skipped cooldowns, money from nothing,
// casino games that pay out more than they take, and strategies that beat everyone else unfairly.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const WP = require(path.join(__dirname, 'public', 'core.js'));
const C = WP.Core(require(path.join(__dirname, workerData.map2 ? 'prov2-lite.json' : 'prov-lite.json')), require(path.join(__dirname, 'public', 'scenarios.js')));
const MIN = 60e3, HOUR = 36e5, DAY = 24 * HOUR, STEP = 3 * MIN, GEN_DAYS = 7;
const R = Math.random, pick = a => a[Math.floor(R() * a.length)], deep = o => JSON.parse(JSON.stringify(o));
const SPEED = { slow: 1000, normal: 200, fast: 40 };

let snap = workerData.snap, speed = workerData.speed || 'normal', paused = !!workerData.paused;
let A, B, now, t0Gen, ctl, base, gen = (workerData.prev && workerData.prev.gen) || 0, lastCd, cas, taxLog, arb;
const prev = workerData.prev || {};
const stats = Object.assign({ rounds: 0, cmds: 0, ok: 0, refused: 0, crashes: 0, simHours: 0, gens: 0, invariant: 0, startedAt: Date.now() }, prev.stats || {}, { startedAt: (prev.stats && prev.stats.startedAt) || Date.now() });
const findings = new Map((prev.findings || []).filter(f => !(f.key === 'gamblerrich' && /far richer/.test(f.title)) && !(/^outrun:/.test(f.key) && /outgrew everyone/.test(f.title))).map(f => [f.key, f])); // two old checks gave false alarms: they are dropped
const coverage = Object.fromEntries(Object.entries(prev.coverage || {}).map(([k, v]) => [k, { tries: v.tries || 0, ok: v.ok || 0, why: Array.isArray(v.why) ? Object.fromEntries(v.why.filter(w => Array.isArray(w))) : { ...(v.why || {}) } }])); // saved results may hold the reasons as a list or an object
const casinoAll = Object.assign({}, prev.casino || {});
let history = (prev.history || []).slice(-20), strat = {}, stepMs = 0, lastReport = 0, recent = [];

const ARCH = {
  grinder: 'Grinder: runs every operation the moment it is ready',
  taxer: 'Tax tinkerer: tries every tax trick to out-earn a normal rate',
  warmonger: 'Warmonger: declares wars, invades, strikes and uses heavy weapons',
  nuker: 'Nuker: domes, nuclear tests, warheads and launches',
  trader: 'Trader: buys and sells on the market looking for free money',
  gambler: 'Gambler: plays every casino game to check the house edge',
  diplomat: 'Diplomat: aid, offers, alliances, missions and relief',
  spy: 'Spy: every covert operation against every rival',
  banker: 'Banker: borrows, repays and tries to dodge debt',
  builder: 'Builder: develops land, wonders, projects, laws and cosmetics',
  fuzzer: 'Fuzzer: sends broken and impossible input to every command',
  vet_war: 'Veteran warmonger: takes over a copy of a top nation',
  vet_nuke: 'Veteran nuker: takes over a copy of a top nation',
  vet_trade: 'Veteran economist: takes over a copy of a top nation'
};

function find(sev, cat, key, title, detail, fix) {
  const f = findings.get(key);
  if (f) { f.count++; f.last = Date.now(); if (detail) f.detail = String(detail).slice(0, 600); return; }
  findings.set(key, { key, sev, cat, title: String(title).slice(0, 200), detail: String(detail || '').slice(0, 600), fix: fix || '', count: 1, first: Date.now(), last: Date.now(), gen });
  recent.unshift({ t: Date.now(), sev, title: String(title).slice(0, 160) }); recent = recent.slice(0, 40);
}

// ---------- the fake world ----------
function newGen() {
  gen++; stats.gens++; A = {}; B = {}; now = Date.now(); t0Gen = now; ctl = {}; base = {}; lastCd = {}; cas = {}; taxLog = {}; arb = { trades: 0, profit: 0, worst: 0 };
  for (const [id, n] of Object.entries(snap.nations || {})) if (n && !n.ai) A[id] = C.normalize(deep(n));
  const cfg = cfgNow(); let W = C.world(A, cfg, now, null, null, B);
  // veterans take over copies of the top nations; everyone else starts a brand-new nation
  const top = Object.keys(A).filter(u => C.hexesOf(W, u).length).sort((a, b) => C.score(W, b) - C.score(W, a));
  [['vet_war', top[0]], ['vet_nuke', top[1]], ['vet_trade', top[2]]].forEach(([k, u]) => { if (u) { ctl[u] = k; A[u].name = 'Test ' + k.replace('vet_', 'Veteran ') + ' (' + A[u].name + ')'; } });
  let i = 0;
  for (const k of Object.keys(ARCH)) {
    if (k.startsWith('vet_')) continue;
    const id = 'tst_' + k; W = C.world(A, cfg, now, null, null, B);
    const spots = C.P.map((p, h) => h).filter(h => C.startOk(W, h)); if (!spots.length) { find('amber', 'Joining', 'nojoin', 'A new player could not find anywhere to start', 'startOk returned no province in the test world.'); continue; }
    try { C.exec(W, id, { c: 'found', name: ('Test ' + k[0].toUpperCase() + k.slice(1)).slice(0, 28), color: WP.COLORS[i++ % WP.COLORS.length], gov: pick(Object.keys(WP.GOV)), hex: pick(spots) }, R); ctl[id] = k; A[id] = W.A[id]; }
    catch (e) { if (!e.user) crash('found', e); }
  }
  W = C.world(A, cfg, now, null, null, B); for (const u of Object.keys(ctl)) base[u] = snapN(W, u);
  strat = {};
}
const cfgNow = () => ({ ...(snap.cfg || {}), noAdmin: !!snap.fresh });
const snapN = (W, u) => { const n = W.A[u]; if (!n) return null; return { score: C.score(W, u), gdp: n.gdp || 0, cash: n.cash || 0, prov: C.hexesOf(W, u).length, tech: n.tech || 0, xp: n.xp || 0, rev: n.rev || 0, debt: n.debt || 0 }; };

// ---------- running commands and checking them ----------
function crash(c, e) { stats.crashes++; find('red', 'Crash', 'crash:' + c + ':' + String(e && e.message).slice(0, 80), `The engine crashed on the "${c}" command`, `${e && e.message}\n${String(e && e.stack || '').split('\n').slice(1, 4).join(' | ')}`, 'A command must fail with a message, never crash. Send this to support.'); }
const NOINCOME = new Set(['tax', 'budget', 'law', 'gov', 'color', 'flag', 'autofire', 'autobuy', 'dip', 'offer', 'offercancel', 'offerno', 'outpostrm', 'hideguide', 'release', 'freevassal', 'independence', 'cosmetic', 'wonder', 'uwonder', 'grand', 'develop', 'movecap', 'dome', 'domeup', 'nuke', 'warhead', 'ntest', 'mun', 'disarm', 'outpost', 'office']);
function run(W, u, cmd, tag) {
  stats.cmds++; const c = tag === 'fuzz' ? 'fuzz:' + String(cmd.c).slice(0, 20) : cmd.c + (cmd.c === 'act' ? ':' + cmd.k : cmd.c === 'heavy' ? ':' + cmd.k : cmd.c === 'casino' ? ':' + cmd.g : cmd.c === 'covert' ? ':' + cmd.op : '');
  const cv = coverage[c] || (coverage[c] = { tries: 0, ok: 0, why: {} }); cv.tries++;
  const n = W.A[u], cash0 = n ? n.cash : 0, fuzz = tag === 'fuzz', ach0 = n ? Object.keys(n.ach || {}).length : 0, rk0 = n ? C.rankOf(n.xp) : 0, ms0 = n && n.mis ? JSON.stringify((n.mis.list || []).map(m => m.claimed)) + n.mis.bonus : '';
  let r;
  try { r = C.exec(W, u, cmd, R); }
  catch (e) { if (e && e.user) { stats.refused++; const w = String(e.message).replace(/[0-9][0-9,.:]*/g, '#').slice(0, 90); cv.why[w] = (cv.why[w] || 0) + 1; if (Object.keys(cv.why).length > 12) { const k = Object.keys(cv.why).sort((a, b) => cv.why[a] - cv.why[b])[0]; delete cv.why[k]; } return null; } crash(c, e); return null; }
  stats.ok++; cv.ok++;
  const n2 = W.A[u], rewarded = n2 && (Object.keys(n2.ach || {}).length !== ach0 || C.rankOf(n2.xp) !== rk0 || (n2.mis ? JSON.stringify((n2.mis.list || []).map(m => m.claimed)) + n2.mis.bonus : '') !== ms0); // achievements, promotions and mission rewards pay cash legitimately
  if (n2 && !rewarded && NOINCOME.has(cmd.c) && n2.cash > cash0 + 1 && !(cmd.c === 'disarm')) find('red', 'Money', 'free:' + c, `"${c}" gave money it should not`, `${n2.name} gained ${WP.money(n2.cash - cash0)} from ${JSON.stringify(cmd).slice(0, 160)}`, 'This command should never add money.');
  if (fuzz && n2 && !rewarded && n2.cash > cash0 + 1 && cmd.c !== 'act' && cmd.c !== 'casino' && cmd.c !== 'market' && cmd.c !== 'bonds' && cmd.c !== 'mission' && cmd.c !== 'decide' && cmd.c !== 'crisis') find('amber', 'Money', 'fuzzcash:' + c, `Broken input to "${c}" was accepted and added money`, JSON.stringify(cmd).slice(0, 200), 'Check the input validation on this command.');
  if (cmd.c === 'act') { const a = WP.ACTS.find(x => x.k === cmd.k); const key = u + ':' + cmd.k, cd = a && a.cd ? a.cd * MIN * (cfgNow().cd || 1) : 0; if (cd && lastCd[key] && now - lastCd[key] < cd * .45) find('red', 'Cooldowns', 'cd:' + cmd.k, `"${cmd.k}" ran again before its cooldown ended`, `${(W.A[u] || {}).name}: ${Math.round((now - lastCd[key]) / 1000)} s apart, cooldown ${Math.round(cd / 1000)} s.`, 'Cooldowns must hold.'); lastCd[key] = now; }
  return r || {};
}
const NUMF = ['cash', 'pop', 'troops', 'ships', 'air', 'spies', 'xp', 'tech', 'infra', 'fort', 'approval', 'stability', 'aggr', 'debt', 'unemp', 'infl', 'tax', 'gdp', 'morale', 'health', 'edu'];
function invariants(W, why) {
  for (const [u, n] of Object.entries(W.A)) {
    if (!ctl[u]) continue;
    for (const k of NUMF) if (n[k] != null && !Number.isFinite(+n[k])) { stats.invariant++; find('red', 'Data', 'nan:' + k, `A nation's ${k} became an impossible number`, `${n.name}: ${k} = ${n[k]} after ${why}`, 'Repair → Health check fixes existing data; the cause needs a code fix.'); n[k] = 0; }
    for (const k of ['troops', 'ships', 'air', 'spies', 'debt', 'pop']) if ((n[k] || 0) < -0.5) { stats.invariant++; find('red', 'Data', 'neg:' + k, `A nation's ${k} went negative`, `${n.name}: ${k} = ${Math.round(n[k])} after ${why}`, ''); n[k] = 0; }
    for (const [r, v] of Object.entries(n.res || {})) if (!Number.isFinite(v) || v < -0.5) { stats.invariant++; find('red', 'Data', 'res:' + r, `A nation's ${r} went negative or broke`, `${n.name}: ${r} = ${v} after ${why}`, ''); n.res[r] = 0; }
    for (const k of ['approval', 'stability']) if (n[k] < -0.01 || n[k] > 100.01) { stats.invariant++; find('amber', 'Data', 'range:' + k, `${k} went outside 0–100`, `${n.name}: ${k} = ${n[k]} after ${why}`, ''); }
    if (n.tax < 5 || n.tax > 50) { stats.invariant++; find('amber', 'Data', 'range:tax', 'A tax rate went outside 5–50%', `${n.name}: ${n.tax}% after ${why}`, ''); }
    if (C.hexesOf(W, u).length && W.OWN[n.cap] && W.OWN[n.cap].u !== u) { stats.invariant++; find('red', 'Data', 'cap', "A nation's capital belongs to someone else", `${n.name} after ${why}`, ''); }
  }
}

// ---------- the players ----------
const others = (W, u) => Object.keys(W.A).filter(v => v !== u && C.hexesOf(W, v).length);
const testers = (W, u) => Object.keys(ctl).filter(v => v !== u && W.A[v] && C.hexesOf(W, v).length);
const CMP = new Set(['grinder', 'taxer', 'banker', 'builder', 'diplomat', 'trader']); // compared with each other: kept out of the fighting
const foes = (W, u) => testers(W, u).filter(v => !CMP.has(ctl[v])).concat(others(W, u).filter(v => !ctl[v]));
const mine = (W, u) => C.hexesOf(W, u).map(Number);
function basics(W, u) { // what every sensible player does
  const n = W.A[u]; if (!n) return;
  for (const c of (n.cards || []).slice(0, 2)) { const card = C.getCard(c.i); if (card) run(W, u, { c: 'decide', id: c.id, o: Math.floor(R() * card.o.length) }); }
  const ms = C.missionsFor(W, u); (ms.list || []).forEach((m, i) => { if (m.done && !m.claimed) run(W, u, { c: 'mission', i }); });
  if ((n.cash || 0) < 0 && (n.debt || 0) < (n.gdp || 1)) run(W, u, { c: 'bonds', amt: Math.abs(n.cash) * 1.5 + 1e6 });
}
function ops(W, u, keys) { for (const k of keys) { const t = C.expandTargets(W, u); run(W, u, { c: 'act', k, arg: k === 'expand' && t.length ? pick(t) : undefined }); } }
const ALL_OPS = WP.ACTS.map(a => a.k);
function warOn(W, u) { const ws = C.wars(W, u).filter(v => !CMP.has(ctl[v])); if (ws.length) return pick(ws); const t = foes(W, u); const v = pick(t); if (v) run(W, u, { c: 'dip', kind: 'war', v }); return C.wars(W, u)[0]; }
function attackAll(W, u, v, tries) {
  const hs = C.hexesOf(W, v).map(Number).sort(() => R() - .5).slice(0, 12);
  let done = 0; for (const h of hs) { if (done >= tries) break; if (C.canAttack(W, u, h)) continue; const me = W.A[u]; let x = Math.floor((me.troops || 0) * (.2 + R() * .6)), p = null;
    for (let k = 0; k < 8 && x >= 10; k++) { p = C.attackPlan(W, u, h, x, 0); if (p && p.cost && p.cost.cash <= me.cash && p.cost.oil <= (me.res.oil || 0) && p.cost.food <= (me.res.food || 0)) break; x = Math.floor(x / 2); p = null; } // send what it can actually supply
    if (!p || x < 10) continue; run(W, u, { c: 'attack', h, x: p.X || x, air: 0 }); done++; }
}
const BRAINS = {
  grinder(W, u) { ops(W, u, ALL_OPS); basics(W, u); },
  taxer(W, u) { const n = W.A[u], g = gen % 4, mode = ['spike', 'max', 'low', 'step'][g]; taxMode = mode;
    if (mode === 'spike') { run(W, u, { c: 'tax', t: 50 }); ops(W, u, ['tax']); run(W, u, { c: 'tax', t: 5 }); }
    else if (mode === 'max') { run(W, u, { c: 'tax', t: 50 }); ops(W, u, ['tax']); }
    else if (mode === 'low') { run(W, u, { c: 'tax', t: 5 }); ops(W, u, ['tax']); }
    else { run(W, u, { c: 'tax', t: Math.max(5, 30 - Math.floor((now - t0Gen) / (15 * MIN)) % 26) }); ops(W, u, ['tax']); }
    ops(W, u, ALL_OPS.filter(k => k !== 'tax')); basics(W, u); },
  warmonger(W, u) { ops(W, u, ['recruit', 'navy', 'air', 'research', 'fort', 'drill', 'tax', 'prod', 'expand']); const v = warOn(W, u); if (v) { attackAll(W, u, v, 3); for (const kind of ['missile', 'air']) run(W, u, { c: 'strike', v, kind, target: pick(['mil', 'stock', 'infra']), n: kind === 'missile' ? C.maxMissiles(W.A[u]) : Math.floor((W.A[u].air || 0) * .5) }); for (const k of Object.keys(C.HEAVY)) run(W, u, { c: 'heavy', v, k }); run(W, u, { c: 'dirty', v }); } if (R() < .02) { const ws = C.wars(W, u); if (ws.length) run(W, u, { c: 'dip', kind: 'peace', v: pick(ws) }); } run(W, u, { c: 'mun', q: 200 + Math.floor(R() * 800) }); basics(W, u); },
  nuker(W, u) { ops(W, u, ['research', 'tax', 'prod', 'infra', 'expand', 'recruit']); for (const c of ['dome', 'domeup', 'nuke', 'warhead']) run(W, u, { c }); run(W, u, { c: 'ntest', delay: 0 }); run(W, u, { c: 'autofire', on: R() < .5 }); const v = warOn(W, u); if (v && W.A[u].warhead && W.A[v]) run(W, u, { c: 'launch', v, h: W.A[v].cap }); if (R() < .005) run(W, u, { c: 'disarm' }); basics(W, u); },
  trader(W, u) { ops(W, u, ['tax', 'prod', 'research', 'expand', 'infra']); const n = W.A[u];
    for (const r of Object.keys(WP.RES)) { const q = 50 + Math.floor(R() * 5000), c0 = n.cash, a0 = Object.keys(n.ach || {}).length, x0 = n.xp; const b = run(W, u, { c: 'market', r, q, buy: true }); if (b) { const s = run(W, u, { c: 'market', r, q, buy: false }); if (s && Object.keys(n.ach || {}).length === a0 && C.rankOf(n.xp) === C.rankOf(x0)) { const net = n.cash - c0; arb.trades++; arb.profit += net; arb.worst = Math.max(arb.worst, net); if (net > 1) find('red', 'Market', 'arb:' + r, 'Buying and selling straight back makes money', `${r}: +${WP.money(net)} on ${q} units.`, 'The spread must always cost something.'); } } }
    if (R() < .05) run(W, u, { c: 'autobuy', r: pick(Object.keys(WP.RES)), on: true, q: 1000, below: 1e6 }); const t = pick(testers(W, u)); if (t && R() < .1) run(W, u, { c: 'offer', v: t, give: { cash: 1e6 }, want: { food: 100 } }); basics(W, u); },
  gambler(W, u) { ops(W, u, ['tax', 'prod', 'daily']); const n = W.A[u], bet = Math.max(1e4, Math.min(1e7, Math.floor((n.cash || 0) * .01)));
    const g = pick(['roulette', 'roulette', 'slots', 'dice', 'bj']), c0 = n.cash; let r;
    if (g === 'roulette') r = run(W, u, { c: 'casino', g, bet, pick: pick(['red', 'black', 'odd', 'even', 'low', 'high', String(Math.floor(R() * 37))]) });
    else if (g === 'dice') r = run(W, u, { c: 'casino', g, bet, pick: pick(['low', 'high', 'seven']) });
    else if (g === 'slots') r = run(W, u, { c: 'casino', g, bet });
    else { r = run(W, u, { c: 'casino', g: 'bj', a: 'deal', bet }); if (n.bj && n.bj.p.length === 2 && Math.min(10, n.bj.p[0].v) === Math.min(10, n.bj.p[1].v)) r = run(W, u, { c: 'casino', g: 'bj', a: 'split' }); for (let i = 0; i < 10 && n.bj; i++) { const pv = n.bj ? C.bjVal(n.bj.p) : 0; r = run(W, u, { c: 'casino', g: 'bj', a: pv < 17 ? 'hit' : 'stand' }); } if (n.bj) run(W, u, { c: 'casino', g: 'bj', a: 'stand' }); }
    if (r !== null) { const net = n.cash - c0; const s = cas[g] || (cas[g] = { bets: 0, wagered: 0, net: 0 }); s.bets++; s.wagered += bet; s.net += net; const a = casinoAll[g] || (casinoAll[g] = { bets: 0, wagered: 0, net: 0 }); a.bets++; a.wagered += bet; a.net += net; }
    basics(W, u); },
  diplomat(W, u) { ops(W, u, ALL_OPS); const t = testers(W, u), v = pick(t); if (v) { run(W, u, { c: 'aid', v, amt: { cash: R() < .5 ? 1 : 2e7, food: 1 } }); run(W, u, { c: 'dip', kind: pick(['trade', 'ally', 'pact']), v }); }
    const n = W.A[u]; if (!n.bloc) run(W, u, { c: 'bloc', op: 'create', name: 'Test Alliance ' + gen, tag: 'TST' }); else { for (const w of t.slice(0, 3)) run(W, u, { c: 'bloc', op: 'invite', v: w }); run(W, u, { c: 'bloc', op: 'give', amt: 1e6 }); run(W, u, { c: 'bloc', op: 'proj', k: pick(Object.keys(WP.BPROJ || { market: 1 })) }); }
    for (const w of t) { const o = W.A[w]; if (o && (o.offIn || []).length) run(W, w, { c: 'offerok', id: o.offIn[0].id || o.offIn[0] }); }
    basics(W, u); },
  spy(W, u) { ops(W, u, ['spies', 'tax', 'prod', 'research', 'expand']); const v = pick(foes(W, u)); if (v) for (const op of Object.keys(WP.COVERT)) run(W, u, { c: 'covert', op, v }); basics(W, u); },
  banker(W, u) { ops(W, u, ['tax', 'prod', 'expand', 'research']); const n = W.A[u]; if (R() < .5) run(W, u, { c: 'bonds', amt: (n.gdp || 1e6) * (.5 + R()) }); else run(W, u, { c: 'bonds', amt: (n.debt || 0) * R() + 1, repay: true }); run(W, u, { c: 'bonds', amt: -5e9 }); run(W, u, { c: 'bonds', amt: 1e30, repay: true }); basics(W, u); },
  builder(W, u) { ops(W, u, ALL_OPS); const hs = mine(W, u);
    if (hs.length) { run(W, u, { c: 'develop', h: pick(hs) }); if (R() < .05) run(W, u, { c: 'outpost', h: pick(hs) }); if (R() < .01 && hs.length > 3) run(W, u, { c: 'movecap', h: pick(hs), name: W.A[u].name }); }
    for (const k of Object.keys(WP.WONDERS)) run(W, u, { c: 'wonder', k }); for (const k of Object.keys(WP.UWONDERS)) run(W, u, { c: 'uwonder', k }); for (const k of Object.keys(WP.GRAND)) run(W, u, { c: 'grand', k }); for (const k of Object.keys(WP.PUNITS)) run(W, u, { c: 'pu', k });
    for (const k of Object.keys(WP.EXPEDS)) run(W, u, { c: 'exped', k }); if (R() < .05) run(W, u, { c: 'law', k: pick(Object.keys(WP.LAWS)), on: R() < .7 }); if (R() < .01) run(W, u, { c: 'gov', g: pick(Object.keys(WP.GOV)) });
    if (R() < .02) { const sl = pick(Object.keys(WP.COSMETICS)); run(W, u, { c: 'cosmetic', slot: sl, k: pick(Object.keys(WP.COSMETICS[sl].items || {})) }); } run(W, u, { c: 'office' }); run(W, u, { c: 'budget', b: { spend: 20 + Math.floor(R() * 20), mil: 10, health: 30, edu: 30, infra: 30 } }); basics(W, u); },
  fuzzer(W, u) { const junk = () => pick([-1, 0, 1e308, -1e308, NaN, 'abc', null, undefined, {}, [], '9'.repeat(400), 3.7, -0.0001, true, Infinity, '__proto__', 'constructor', 961, 99999, u, pick(Object.keys(W.A))]);
    const cmds = ['act', 'decide', 'attack', 'strike', 'nuke', 'ntest', 'warhead', 'law', 'wonder', 'exped', 'mission', 'offer', 'release', 'offerok', 'offerno', 'offercancel', 'flag', 'dirty', 'heavy', 'office', 'independence', 'freevassal', 'color', 'launch', 'autofire', 'dome', 'mun', 'dip', 'aid', 'market', 'autobuy', 'tax', 'budget', 'bonds', 'gov', 'covert', 'casino', 'outpost', 'outpostrm', 'bloc', 'uwonder', 'grand', 'pu', 'cosmetic', 'crisis', 'develop', 'movecap', 'disarm', 'domeup', 'games', 'relief', 'nonsense'];
    for (let i = 0; i < 6; i++) { const c = pick(cmds), cmd = { c }; for (const k of ['k', 'id', 'o', 'h', 'x', 'air', 'v', 'kind', 'target', 'n', 'delay', 'on', 'abandon', 'i', 'give', 'want', 'flag', 'motto', 'color', 'q', 'r', 'buy', 't', 'b', 'amt', 'repay', 'g', 'op', 'bet', 'pick', 'a', 'slot', 'name', 'sell', 'cat', 'below']) if (R() < .5) cmd[k] = junk(); run(W, u, cmd, 'fuzz'); }
    ops(W, u, ['tax', 'prod']); basics(W, u); },
  vet_war(W, u) { BRAINS.warmonger(W, u); }, vet_nuke(W, u) { BRAINS.nuker(W, u); }, vet_trade(W, u) { BRAINS.trader(W, u); BRAINS.builder(W, u); }
};

// ---------- one step of simulated time ----------
function step() {
  const t = Date.now(); now += STEP; stats.rounds++;
  const cfg = cfgNow(); const W = C.world(A, cfg, now, null, null, B);
  for (const u of Object.keys(ctl)) { const n = W.A[u]; if (!n || !C.hexesOf(W, u).length) continue; try { BRAINS[ctl[u]](W, u); } catch (e) { crash('player:' + ctl[u], e); } }
  for (const u of Object.keys(W.A)) { try { C.tick(W, u, !!ctl[u], R); } catch (e) { crash('tick', e); } }
  invariants(W, 'a world update');
  for (const u of Object.keys(W.A)) A[u] = W.A[u]; for (const u of Object.keys(A)) if (!W.A[u]) delete A[u];
  if (stats.rounds % 20 === 0) { stats.simHours = Math.round(stats.simHours + 1); hourly(W); }
  if (now - t0Gen >= GEN_DAYS * DAY) endGen(W);
  stepMs = stepMs * .9 + (Date.now() - t) * .1;
}
function hourly(W) {
  for (const u of Object.keys(ctl)) { const n = W.A[u], b = base[u], s = snapN(W, u); const k = ctl[u];
    strat[k] = { kind: k, desc: ARCH[k], name: n ? n.name : '(fell)', alive: !!(n && s && s.prov), score: s ? Math.round(s.score) : 0, gdp: s ? Math.round(s.gdp) : 0, cash: s ? Math.round(s.cash) : 0, debt: s ? Math.round(s.debt) : 0, prov: s ? s.prov : 0, tech: s ? s.tech : 0, xp: s ? Math.round(s.xp) : 0, rank: n ? C.rankName(n) : '', growth: b && s && b.score > 0 ? Math.round(s.score / b.score * 10) / 10 : null, taxMode: k === 'taxer' ? taxMode : undefined };
    if (n) { const tl = taxLog[k] || (taxLog[k] = []); tl.push({ rev: n.rev || 0, gdp: n.gdp || 1 }); if (tl.length > 48) tl.shift(); } }
}
function endGen(W) {
  // fairness checks over a whole simulated week
  const fresh = Object.values(strat).filter(s => !s.kind.startsWith('vet_') && s.kind !== 'fuzzer'), med = arr => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const mScore = med(fresh.map(s => s.score));
  // compare with normal play (the grinder does every ordinary action), not with the median: weak test players like the gambler drag the median down
  const gS = strat.grinder && strat.grinder.alive ? strat.grinder.score : 0;
  for (const s of fresh) if (gS > 0 && s.score > gS * 1.6 && !['grinder', 'builder', 'diplomat'].includes(s.kind)) find('amber', 'Fairness', 'outrun:' + s.kind, `The ${s.kind} strategy beat normal play by a wide margin in a test week`, `${s.name}: score ${s.score.toLocaleString()} vs ${gS.toLocaleString()} for normal play (×${(s.score / gS).toFixed(1)}).`, 'Look at what this player type does for a loophole.');
  const g = strat.grinder, tx = strat.taxer; const ratio = k => { const l = taxLog[k] || []; return l.length ? l.reduce((a, x) => a + x.rev / x.gdp, 0) / l.length : 0; };
  // a tax trick only counts if the whole nation comes out ahead: more score and more money (net of debt) than the steady 20% player, who plays the same way otherwise
  const nw = s => (s.cash || 0) - (s.debt || 0);
  if (g && tx && g.alive && tx.alive && gS > 0) { const sc = tx.score / g.score, mo = nw(tx) - nw(g); if (sc > 1.15 && mo > 0) find('red', 'Fairness', 'tax:' + taxMode, `The "${taxMode}" tax trick beats a steady 20% rate`, `Score ${tx.score.toLocaleString()} vs ${g.score.toLocaleString()} (×${sc.toFixed(2)}), money net of debt ${WP.money(nw(tx))} vs ${WP.money(nw(g))}. Tax revenue per GDP ${(ratio('taxer') * 100).toFixed(0)}% vs ${(ratio('grinder') * 100).toFixed(0)}%.`, 'Tax tricks should never beat a steady rate.'); else find('ok', 'Fairness', 'taxok:' + taxMode, `The "${taxMode}" tax trick does not beat a steady rate`, `Score ×${sc.toFixed(2)} of normal play; money net of debt ${WP.money(nw(tx))} vs ${WP.money(nw(g))}.`, ''); }
  if (strat.banker && gS > 0 && strat.banker.alive && strat.banker.score > gS * 1.5) find('amber', 'Fairness', 'banker', 'Living on debt beat normal play in a test week', `Banker score ${strat.banker.score.toLocaleString()} vs normal play ${gS.toLocaleString()}.`, 'Check whether borrowing is too cheap.');
  { const cw = Object.values(cas).reduce((a, c) => a + c.wagered, 0), cn = Object.values(cas).reduce((a, c) => a + c.net, 0), cb = Object.values(cas).reduce((a, c) => a + c.bets, 0); if (cb >= 2000 && cw > 0 && cn / cw > .05) find('amber', 'Casino', 'gamblerrich', 'The casino paid the gambler more than 5% over what it bet in a test week', `${cb.toLocaleString()} bets, ${WP.money(cw)} wagered, ${WP.money(cn)} won.`, 'Usually luck over one week. If it shows up week after week, the casino needs a closer look.'); }
  for (const [k, c] of Object.entries(casinoAll)) if (c.bets >= 20000) { const rtp = 1 + c.net / c.wagered; if (rtp > 1.0) find('red', 'Casino', 'rtp:' + k, `${k} pays out more than it takes`, `Over ${c.bets.toLocaleString()} bets players got back ${(rtp * 100).toFixed(1)}% of what they bet.`, 'A casino game must keep a house edge.'); }
  history.push({ gen, t: Date.now(), days: GEN_DAYS, strat: Object.values(strat).map(s => ({ kind: s.kind, score: s.score, alive: s.alive })), crashes: stats.crashes });
  history = history.slice(-20); parentPort.postMessage({ type: 'wantSnap' }); pendingGen = Date.now();
}
let pendingGen = 0, taxMode = 'spike';

function report(force) {
  if (!force && Date.now() - lastReport < 5000) return; lastReport = Date.now();
  const cov = {}; for (const [k, v] of Object.entries(coverage)) cov[k] = { tries: v.tries, ok: v.ok, why: Object.entries(v.why).sort((a, b) => b[1] - a[1]).slice(0, 3) };
  const fl = [...findings.values()].sort((a, b) => ({ red: 0, amber: 1, info: 2, ok: 3 })[a.sev] - ({ red: 0, amber: 1, info: 2, ok: 3 })[b.sev] || b.last - a.last).slice(0, 200);
  parentPort.postMessage({ type: 'report', state: { gen, speed, paused, stepMs: Math.round(stepMs), simNow: now, genStart: t0Gen, genDays: GEN_DAYS, stats, strat: Object.values(strat), casino: casinoAll, cas, coverage: cov, findings: fl, recent, history, arb } });
}
parentPort.on('message', m => {
  if (m.type === 'speed' && SPEED[m.speed]) speed = m.speed;
  else if (m.type === 'pause') paused = !!m.on;
  else if (m.type === 'snap') { snap = m.snap; pendingGen = 0; newGen(); }
  else if (m.type === 'clear') { findings.clear(); for (const k of Object.keys(coverage)) delete coverage[k]; for (const k of Object.keys(casinoAll)) delete casinoAll[k]; history = []; recent = []; Object.assign(stats, { rounds: 0, cmds: 0, ok: 0, refused: 0, crashes: 0, simHours: 0, gens: 0, invariant: 0, startedAt: Date.now() }); }
  else if (m.type === 'dismiss') findings.delete(m.key);
  else if (m.type === 'reset') { pendingGen = 0; newGen(); }
  report(true);
});
newGen();
(function loop() {
  if (!paused && !(pendingGen && Date.now() - pendingGen < 10000)) { if (pendingGen) { pendingGen = 0; newGen(); } try { step(); } catch (e) { crash('step', e); } }
  report(); const wait = Math.max(SPEED[speed] || 200, stepMs); setTimeout(loop, paused ? 1000 : wait); // never more than half of one processor core
})();
