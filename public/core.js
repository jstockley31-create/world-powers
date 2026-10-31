// World Powers — game rules. The SERVER runs every change; browsers only use this file to display numbers.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.WPCore = factory(); })(this, function () {
'use strict';
const MIN = 60e3, HOUR = 36e5, TICK = 10 * MIN;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const RES = { food: { n: 'Food', p: 50 }, oil: { n: 'Oil', p: 120 }, steel: { n: 'Steel', p: 100 }, goods: { n: 'Goods', p: 200 } };
const TYPE = { F: { n: 'Farmland', p: { food: 30 } }, O: { n: 'Oil fields', p: { oil: 15, food: 5 } }, M: { n: 'Mining region', p: { steel: 15, food: 5 } }, I: { n: 'Industrial region', p: { goods: 12, food: 5 } }, P: { n: 'Plains', p: { food: 15 }, cash: 1 } };
const CAPP = { food: 25, goods: 10, oil: 5, steel: 5 };
const RANKS = [[0, 'Chieftain'], [100, 'Elder'], [300, 'Mayor'], [700, 'Governor'], [1500, 'Senator'], [3000, 'Prime Minister'], [6000, 'President'], [12000, 'Sovereign'], [25000, 'Emperor'], [50000, 'Supreme Leader'], [100000, 'World Power']];
const GOV = {
  dem: { n: 'Democracy', ap: 6, st: 0, inc: 1.05, mil: 1, res: 1.15, d: '+5% tax revenue and faster research. Approval bonus. Wars cost twice the approval.' },
  mon: { n: 'Monarchy', ap: 0, st: 12, inc: 1, mil: 1.05, res: 1, d: 'Highly stable. Small military bonus.' },
  dic: { n: 'Dictatorship', ap: -8, st: 6, inc: .95, mil: 1.15, res: .9, d: '+15% army strength; war barely dents approval. Lower approval and income.' },
  com: { n: 'Communist State', ap: -3, st: 6, inc: 1, mil: 1.05, res: 1, cheap: .75, d: 'Recruiting and construction cost 25% less. Lower approval.' }
};
const COLORS = ['#c8553d', '#3f88c5', '#44af69', '#d4a64a', '#8e6fd8', '#e07a9c', '#2ab7a9', '#e88d3f', '#6c8ead', '#b5c44a', '#a23b72', '#5b6ee1', '#d65f5f', '#4f9d8f', '#c69c6d', '#7fb3d5'];
const ACTS = [
  { k: 'tax', s: 'Taxes', n: 'Collect Taxes', i: 'coins', cd: 3, xp: 5 },
  { k: 'prod', s: 'Production', n: 'Boost Production', i: 'factory', cd: 5, xp: 6 },
  { k: 'recruit', s: 'Recruit', n: 'Recruit Troops', i: 'recruit', cd: 4, xp: 5 },
  { k: 'expand', s: 'Expand', n: 'Expand Borders', i: 'expand', cd: 10, xp: 20 },
  { k: 'research', s: 'Research', n: 'Fund Research', i: 'flask', cd: 15, xp: 15 },
  { k: 'drill', s: 'Exercises', n: 'Military Exercises', i: 'target', cd: 8, xp: 8 },
  { k: 'infra', s: 'Infrastructure', n: 'Build Infrastructure', i: 'build', cd: 20, xp: 15 },
  { k: 'fort', s: 'Fortify', n: 'Fortify Borders', i: 'fort', cd: 30, xp: 15 },
  { k: 'rally', s: 'Address', n: 'Address the Nation', i: 'mega', cd: 15, xp: 5 },
  { k: 'daily', s: 'Aid', n: 'International Aid', i: 'gift', cd: 1440, xp: 50 }
];
const DEFCFG = { cd: 1, income: 1, xp: 1, protectH: 48, war: true, signups: true, motd: '' };
const EFFKEYS = ['tr', 'ap', 'st', 'pop', 'troops', 'tech', 'food', 'oil', 'steel', 'goods', 'infra', 'fort', 'train', 'aggr'];

const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
function UserError(msg) { const e = new Error(msg); e.user = true; return e; }
const fail = msg => { throw UserError(msg); };
const num = v => Math.round(v).toLocaleString('en-US');
const money = v => (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');

function Core(PD, CARDS) {
  const P = PD.p, CN = PD.countries;
  CARDS = CARDS || [];
  const nbrs = h => (P[h] ? P[h].j : []);
  const pname = h => { const p = P[h]; if (!p) return 'Unknown'; return p.n === CN[p.ci] ? p.n : `${p.n}, ${CN[p.ci]}`; };

  function computeOwn(A) {
    const best = {};
    for (const [u, n] of Object.entries(A)) for (const [h, ts] of Object.entries(n.hexes || {})) { if (!P[h]) continue; if (!best[h] || ts > best[h].ts) best[h] = { u, ts }; }
    const caps = Object.entries(A).sort((a, b) => a[1].created - b[1].created);
    for (const [u, n] of caps) if (P[n.cap] && !(best[n.cap] && best[n.cap].cap)) best[n.cap] = { u, ts: 0, cap: true };
    return best;
  }
  function world(A, cfg, now) { const W = { A, cfg: { ...DEFCFG, ...(cfg || {}) }, now: now || Date.now(), changed: new Set(), news: [] }; W.OWN = computeOwn(A); return W; }
  const owner = (W, h) => W.OWN[h] && W.OWN[h].u;
  const hexesOf = (W, u) => Object.keys(W.OWN).filter(h => W.OWN[h].u === u).map(Number);
  const rankOf = xp => { let i = 0; for (let j = 0; j < RANKS.length; j++) if ((xp || 0) >= RANKS[j][0]) i = j; return i; };
  const rankName = n => RANKS[rankOf(n.xp)][1];
  const maxHex = n => 3 + rankOf(n.xp) * 4;
  const R = (W, a, b) => (W.A[a] && W.A[a].rel && W.A[a].rel[b]) || {};
  function atWar(W, a, b) { const x = R(W, a, b), y = R(W, b, a); const w = Math.max(x.war || 0, y.war || 0); if (!w) return false; return !((x.peace || 0) > w && (y.peace || 0) > w); }
  const warSince = (W, a, b) => Math.max(R(W, a, b).war || 0, R(W, b, a).war || 0);
  function pact(W, a, b, k) { const x = R(W, a, b), y = R(W, b, a); return (x[k] || 0) > (x['un' + k] || 0) && (y[k] || 0) > (y['un' + k] || 0) && !atWar(W, a, b); }
  function offered(W, a, b, k) { const x = R(W, a, b), y = R(W, b, a); return (x[k] || 0) > (x['un' + k] || 0) && !((y[k] || 0) > (y['un' + k] || 0)); }
  const others = (W, u) => Object.keys(W.A).filter(v => v !== u);
  const wars = (W, u) => others(W, u).filter(v => atWar(W, u, v));
  const allies = (W, u) => others(W, u).filter(v => pact(W, u, v, 'ally'));
  const traders = (W, u) => others(W, u).filter(v => pact(W, u, v, 'trade'));
  const sanctioned = n => (n.aggr || 0) >= 50;
  const oilF = n => ((n.res && n.res.oil) || 0) > 0 ? 1 : .6;
  const cheap = n => GOV[n.gov].cheap || 1;
  const power = (W, u) => { const n = W.A[u]; return n.troops * (1 + n.tech * .05) * (1 + n.train * .02) * oilF(n) * GOV[n.gov].mil; };
  const score = (W, u) => { const n = W.A[u]; return Math.round(hexesOf(W, u).length * 100 + n.troops * .4 + n.tech * 60 + (n.xp || 0) * .1 + n.pop / 2000); };
  function taxIncome(W, u) { const n = W.A[u], g = GOV[n.gov]; const trade = 1 + Math.min(5, traders(W, u).length) * .05 * (sanctioned(n) ? 0 : 1); return n.pop / 1000 * n.tax * 12 * (0.5 + n.approval / 100) * g.inc * trade * (1 + rankOf(n.xp) * .1) * (1 + n.infra * .03) * W.cfg.income; }
  function production(W, u) { const n = W.A[u]; const p = { food: 0, oil: 0, steel: 0, goods: 0 }; for (const h of hexesOf(W, u)) { if (h == n.cap) { for (const k in CAPP) p[k] += CAPP[k]; continue; } const t = TYPE[P[h].t]; for (const k in t.p) p[k] += t.p[k]; } const m = (1 + rankOf(n.xp) * .1) * (1 + n.infra * .05) * W.cfg.income; for (const k in p) p[k] = Math.round(p[k] * m); return p; }
  const consumption = n => ({ food: Math.round(n.pop / 1000 * .25), oil: Math.round(n.troops / 100 * .5 + n.infra * .5), steel: 0, goods: Math.round(n.pop / 1000 * .05) });
  const popCap = (W, u) => hexesOf(W, u).length * 150000 * (1 + W.A[u].infra * .05);
  function prices(W) { const p = {}, since = W.now - 6 * HOUR, net = { food: 0, oil: 0, steel: 0, goods: 0 }; for (const n of Object.values(W.A)) for (const t of n.trades || []) if (t.t > since && net[t.r] != null) net[t.r] += t.q; for (const k in RES) p[k] = Math.round(RES[k].p * clamp(Math.exp(net[k] / 4000), .4, 3)); return p; }
  function spreads(W, u) { const n = W.A[u]; const sp = sanctioned(n) ? .3 : 0, tb = Math.min(5, traders(W, u).length) * .03 * (sanctioned(n) ? 0 : 1); return { buy: 1.08 + sp - tb, sell: .92 - sp + tb }; }
  const recruitBatch = n => Math.max(20, Math.round(40 + n.pop * .0012));
  const expandCost = (W, u) => Math.round(8e4 * Math.pow(Math.max(1, hexesOf(W, u).length), 1.35));
  const researchCost = n => Math.round(5e4 * (n.tech + 1) * (GOV[n.gov].res > 1 ? .85 : 1));
  const maxTrain = n => 10 + rankOf(n.xp) * 5;
  const infraCost = n => Math.round(6e4 * (n.infra + 1) * cheap(n));
  const fortCost = n => Math.round(1e5 * (n.fort + 1) * cheap(n));
  const rallyCost = n => Math.round(2e4 + n.pop * .05);
  const dailyGrant = n => 2e5 * (1 + rankOf(n.xp) * .5);
  const left = (W, n, k) => Math.max(0, ((n.cd && n.cd[k]) || 0) - W.now);
  function expandTargets(W, u) { const t = new Set(); for (const h of hexesOf(W, u)) for (const k of nbrs(h)) if (!W.OWN[k]) t.add(k); return [...t]; }
  function startOk(W, h) { if (!P[h] || W.OWN[h]) return false; const seen = new Set([h]); let fr = [h]; for (let d = 0; d < 2; d++) { const nx = []; for (const x of fr) for (const k of nbrs(x)) if (!seen.has(k)) { seen.add(k); nx.push(k); } fr = nx; } for (const k of seen) if (W.OWN[k]) return false; return true; }
  function hexAge(W, h) { const o = W.OWN[h]; if (!o) return 0; const ts = o.cap ? W.A[o.u].created : o.ts; return (W.now - ts) / (24 * HOUR); }
  const fmtT = ms => { const s = Math.ceil(ms / 1e3); if (s >= 3600) return Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm'; return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function canAttack(W, u, h) {
    const me = W.A[u]; if (!me) return 'Found a nation first.'; if (!W.cfg.war) return 'Warfare is currently disabled by the administrators.';
    const v = owner(W, h); if (!v || v === u) return 'Not a foreign province.'; const n = W.A[v];
    if (W.OWN[h].cap) return 'Capitals cannot be captured.';
    if (!nbrs(h).some(k => owner(W, k) === u)) return 'Only provinces bordering your territory can be invaded.';
    if (rankOf(me.xp) < 2) return 'You must reach the rank of Mayor to wage war.';
    if (!atWar(W, u, v)) return `You are not at war with ${n.name}. Declare war from Diplomacy.`;
    if (W.now - warSince(W, u, v) < 10 * MIN) return `Forces are mobilizing — ready in ${fmtT(10 * MIN - (W.now - warSince(W, u, v)))}.`;
    const theyHitMe = (n.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR);
    if (!theyHitMe && W.now - n.created < W.cfg.protectH * HOUR && !(n.out || []).some(e => e.type === 'battle')) return `${n.name} is under new-nation protection.`;
    if (!theyHitMe && score(W, v) < score(W, u) * .4) return `${n.name} is far weaker than you. Attacking them is not permitted.`;
    if (left(W, me, 'attack')) return `Your army is regrouping: ${fmtT(left(W, me, 'attack'))}.`;
    return null;
  }
  function defense(W, h, attacker) { const v = owner(W, h), n = W.A[v]; let t = n.troops * .5; for (const a of allies(W, v)) if (a !== attacker) t += W.A[a].troops * .1; return t * (1 + n.tech * .05) * (1 + n.train * .02) * (1 + n.fort * .1) * (1 + rankOf(n.xp) * .08) * (1 + Math.min(.5, hexAge(W, h) * .05)) * oilF(n) * GOV[n.gov].mil * ((n.regroup || 0) > W.now ? .75 : 1); }
  const atkMult = n => (1 + n.tech * .05) * (1 + n.train * .02) * oilF(n) * GOV[n.gov].mil;
  const atkCost = x => ({ cash: x * 25, oil: Math.ceil(x / 10), food: Math.ceil(x / 20) });

  // ---------- decisions: situational conditions ----------
  const COND = {
    war: (W, u) => wars(W, u).length > 0, peace: (W, u) => !wars(W, u).length,
    dem: (W, u, n) => n.gov === 'dem', dic: (W, u, n) => n.gov === 'dic', mon: (W, u, n) => n.gov === 'mon', com: (W, u, n) => n.gov === 'com', notdem: (W, u, n) => n.gov !== 'dem',
    lowAp: (W, u, n) => n.approval < 40, highAp: (W, u, n) => n.approval > 70, lowSt: (W, u, n) => n.stability < 40, highTax: (W, u, n) => n.tax > 30, lowTax: (W, u, n) => n.tax < 15,
    rich: (W, u, n) => n.cash > 5e6, poor: (W, u, n) => n.cash < 3e5, big: (W, u) => hexesOf(W, u).length >= 6, small: (W, u) => hexesOf(W, u).length <= 3,
    army: (W, u, n) => n.troops > 1500, sanctioned: (W, u, n) => sanctioned(n), allied: (W, u) => allies(W, u).length > 0, trader: (W, u) => traders(W, u).length > 0,
    lowFood: (W, u, n) => n.res.food < 150, oilRich: (W, u, n) => n.res.oil > 600, tech: (W, u, n) => n.tech >= 5, rank3: (W, u, n) => rankOf(n.xp) >= 3, neighbors: (W, u) => hexesOf(W, u).some(h => nbrs(h).some(k => owner(W, k) && owner(W, k) !== u))
  };
  const condOk = (W, u, c) => !c || c.split(' ').every(k => COND[k] ? COND[k](W, u, W.A[u]) : true);

  // ---------- mutation helpers (server only) ----------
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function log(n, t, W) { n.log = [{ t: W ? W.now : Date.now(), x: t }, ...(n.log || [])].slice(0, 50); }
  function pushOut(W, u, e) { const n = W.A[u]; e.id = rid(); e.t = W.now; n.out = [e, ...(n.out || [])].slice(0, 80); }
  function news(W, u, t) { pushOut(W, u, { type: 'news', x: t }); log(W.A[u], t, W); W.news.push(t); }
  function gainXP(W, u, x) { const n = W.A[u]; const b = rankOf(n.xp); n.xp = (n.xp || 0) + Math.round(x * W.cfg.xp); const a = rankOf(n.xp); if (a > b) { news(W, u, `${n.name} has risen to the rank of ${RANKS[a][1]}.`); W.promoted = RANKS[a][1]; } }
  const touch = (W, ...us) => us.forEach(u => W.changed.add(u));
  function setRel(n, v, k, t) { n.rel = n.rel || {}; n.rel[v] = { ...(n.rel[v] || {}), [k]: t }; }

  function normalize(n) { for (const k of ['cards', 'log', 'out', 'trades', 'seen']) if (!Array.isArray(n[k])) n[k] = []; for (const k of ['cd', 'hexes', 'rel', 'cnt']) if (!n[k] || typeof n[k] !== 'object') n[k] = {}; n.res = { food: 0, oil: 0, steel: 0, goods: 0, ...(n.res || {}) }; return n; }

  function found(W, u, o, rng) {
    if (W.A[u]) fail('You already lead a nation.');
    const name = String(o.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 28 || !/^[\p{L}\p{N} .,'&()-]+$/u.test(name)) fail('Choose a name of 2–28 letters, numbers and basic punctuation.');
    if (Object.values(W.A).some(n => n.name.toLowerCase() === name.toLowerCase())) fail('That name is already in use.');
    const color = COLORS.includes(o.color) ? o.color : COLORS[0];
    if (typeof o.name !== 'string') fail('Choose a name for your nation.');
    const gov = has(GOV, o.gov) ? o.gov : 'dem';
    const h = Number(o.hex); if (!Number.isInteger(h) || !startOk(W, h)) fail('Select an unclaimed province at least two provinces away from any nation.');
    const now = W.now;
    W.A[u] = { v: 3, name, color, gov, created: now, cap: h, hexes: {}, xp: 0, cash: 1e6, pop: 1e5, troops: 300, tech: 0, train: 0, infra: 0, fort: 0, tax: 20, approval: 60, stability: 60, aggr: 0, res: { food: 400, oil: 150, steel: 150, goods: 80 }, cd: {}, cnt: {}, lastTick: now, nextCard: now + 5 * MIN, cards: [], seen: [], log: [], out: [], rel: {}, trades: [], exp: 0, imp: 0 };
    W.OWN = computeOwn(W.A);
    news(W, u, `A new nation has been founded: ${name}, in ${pname(h)}.`); touch(W, u);
    W.welcome = `Welcome ${name}, a new nation founded in ${pname(h)}.`;
    return { msg: 'Your nation has been founded.' };
  }

  function act(W, u, k, arg, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const a = ACTS.find(x => x.k === k); if (!a) fail('Unknown operation.'); if (!n.cd || typeof n.cd !== 'object') n.cd = {};
    if (left(W, n, k)) fail(`${a.n} is available in ${fmtT(left(W, n, k))}.`);
    let msg = '';
    if (k === 'tax') { const v = taxIncome(W, u); n.cash += v; if (n.tax > 20) n.approval = clamp(n.approval - (n.tax - 20) * .1, 0, 100); msg = `Collected ${money(v)} in taxes.`; }
    else if (k === 'prod') { const p = production(W, u); for (const r in p) n.res[r] += p[r] * 2; msg = 'Production boosted: ' + Object.entries(p).filter(e => e[1]).map(([r, v]) => `+${v * 2} ${r}`).join(', ') + '.'; }
    else if (k === 'recruit') { const b = recruitBatch(n), c = b * 150 * cheap(n), s = Math.ceil(b / 10); if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); if (n.troops + b > n.pop * .05) fail('Your population cannot support more soldiers (limit: 5% of population).'); n.cash -= c; n.res.steel -= s; n.troops += b; n.approval = clamp(n.approval - .3, 0, 100); msg = `${num(b)} soldiers enlisted.`; }
    else if (k === 'expand') {
      if (hexesOf(W, u).length >= maxHex(n)) fail(`Reach the next rank to hold more than ${maxHex(n)} provinces.`);
      const c = expandCost(W, u); if (n.cash < c || n.res.food < 40) fail(`Requires ${money(c)} and 40 food.`);
      const ts = expandTargets(W, u); if (!ts.length) fail('No unclaimed land borders your nation.');
      let h = (arg != null && ts.includes(Number(arg))) ? Number(arg) : null;
      if (arg != null && h == null) fail('That province cannot be settled.');
      if (h == null) { const pref = ts.filter(x => P[x].t !== 'P'); const pool = pref.length ? pref : ts; h = pool[Math.floor(rng() * pool.length)]; }
      n.cash -= c; n.res.food -= 40; n.hexes[h] = W.now; W.OWN[h] = { u, ts: W.now }; msg = `Settled ${pname(h)} (${TYPE[P[h].t].n.toLowerCase()}).`; W.selHex = h;
    }
    else if (k === 'research') { const c = researchCost(n), g = 10 + n.tech * 5; if (n.cash < c || n.res.goods < g) fail(`Requires ${money(c)} and ${g} goods.`); n.cash -= c; n.res.goods -= g; n.tech++; msg = `Tech level ${n.tech} reached.`; }
    else if (k === 'drill') { if (n.train >= maxTrain(n)) fail('Training is at the cap for your rank.'); const o = 10 + n.train * 2; if (n.res.oil < o) fail(`Requires ${o} oil.`); n.res.oil -= o; n.train++; msg = `Training raised to ${n.train}.`; }
    else if (k === 'infra') { const c = infraCost(n), s = 20 + n.infra * 10; if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); n.cash -= c; n.res.steel -= s; n.infra++; msg = `Infrastructure level ${n.infra}.`; }
    else if (k === 'fort') { const c = fortCost(n), s = 30 + n.fort * 15; if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); n.cash -= c; n.res.steel -= s; n.fort++; msg = `Fortifications level ${n.fort}.`; }
    else if (k === 'rally') { const c = rallyCost(n); if (n.cash < c) fail(`Requires ${money(c)}.`); n.cash -= c; n.approval = clamp(n.approval + 6, 0, 100); msg = 'Your address was well received. Approval rose.'; }
    else if (k === 'daily') { const v = dailyGrant(n); n.cash += v; n.res.food += 100; n.res.oil += 60; n.res.steel += 60; n.res.goods += 30; msg = `Received a ${money(v)} grant and supplies.`; }
    n.cd[k] = W.now + a.cd * MIN * W.cfg.cd; n.cnt[k] = (n.cnt[k] || 0) + 1; gainXP(W, u, a.xp); log(n, msg, W); touch(W, u);
    return { msg };
  }

  function effTr(W, u, v) { return v * taxIncome(W, u); }
  function applyEff(W, u, e, rng) {
    const n = W.A[u];
    if (e.risk != null) { const ok = rng() < e.risk; applyEff(W, u, ok ? e.ok : e.bad, rng); return ok; }
    for (const [k, v] of Object.entries(e)) {
      if (k === 'tr') n.cash += effTr(W, u, v);
      else if (k === 'ap') n.approval = clamp(n.approval + v, 0, 100);
      else if (k === 'st') n.stability = clamp(n.stability + v, 0, 100);
      else if (k === 'pop') n.pop = Math.max(1000, n.pop * (1 + v / 100));
      else if (k === 'troops') n.troops = Math.max(0, Math.min(n.pop * .05, n.troops + v));
      else if (k === 'tech' || k === 'infra' || k === 'fort') n[k] = Math.max(0, n[k] + v);
      else if (k === 'train') n.train = clamp(n.train + v, 0, maxTrain(n));
      else if (k === 'aggr') n.aggr = clamp((n.aggr || 0) + v, 0, 100);
      else if (RES[k]) n.res[k] = Math.max(0, n.res[k] + v);
    }
    return true;
  }
  function addCard(W, u, rng) {
    const n = W.A[u]; const used = new Set([...n.cards.map(c => c.i), ...(n.seen || [])]);
    let pool = CARDS.map((c, i) => i).filter(i => !used.has(i) && condOk(W, u, CARDS[i].c));
    if (!pool.length) pool = CARDS.map((c, i) => i).filter(i => !n.cards.some(c => c.i === i) && condOk(W, u, CARDS[i].c));
    if (!pool.length) return;
    // situational cards are more likely when they apply
    const weighted = []; for (const i of pool) { weighted.push(i); if (CARDS[i].c) weighted.push(i, i); }
    const i = weighted[Math.floor(rng() * weighted.length)];
    n.cards.push({ id: rid(), i }); n.seen = [i, ...(n.seen || [])].slice(0, 60);
  }
  function decide(W, u, id, o, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const c = n.cards.find(x => x.id === id); if (!c) fail('That decision is no longer pending.');
    const card = CARDS[c.i], oi = Number(o); if (!card || !Number.isInteger(oi) || oi < 0 || oi >= card.o.length) fail('Invalid choice.'); const opt = card.o[oi];
    const ok = applyEff(W, u, opt[1], rng); n.cards = n.cards.filter(x => x.id !== id); n.cnt.decide = (n.cnt.decide || 0) + 1; gainXP(W, u, 10);
    const msg = `${card.t}: ${opt[0]}${opt[1].risk != null ? (ok ? ' — it succeeded.' : ' — it backfired.') : '.'}`; log(n, msg, W); touch(W, u);
    return { msg };
  }

  function attack(W, u, h, X, rng) {
    const me = W.A[u]; h = Number(h); if (!Number.isInteger(h) || !P[h]) fail('Unknown province.'); const why = canAttack(W, u, h); if (why) fail(why);
    X = Math.floor(+X); if (!(X >= 10) || X > me.troops) fail('Commit at least 10 troops, and no more than you have.');
    const c = atkCost(X); if (me.cash < c.cash || me.res.oil < c.oil || me.res.food < c.food) fail(`This operation requires ${money(c.cash)}, ${c.oil} oil and ${c.food} food.`);
    const v = owner(W, h), d = W.A[v];
    const atk = X * atkMult(me) * (.85 + rng() * .3), def = defense(W, h, u) * (.9 + rng() * .2); const win = atk > def, ra = def / (atk + def);
    const lossA = Math.min(X, Math.round(X * ra * .6)), lossD = Math.min(d.troops, Math.round(d.troops * .5 * (1 - ra) * .5));
    me.cash -= c.cash; me.res.oil -= c.oil; me.res.food -= c.food; me.troops -= lossA; me.cd.attack = W.now + 15 * MIN; me.regroup = W.now + 30 * MIN; me.aggr = Math.min(100, (me.aggr || 0) + 25);
    me.approval = clamp(me.approval - (me.gov === 'dem' ? 6 : me.gov === 'dic' ? 1 : 3), 0, 100); me.stability = clamp(me.stability - 2, 0, 100);
    d.troops = Math.max(0, d.troops - lossD);
    let loot = 0;
    if (win) { loot = Math.round(Math.max(0, Math.min(d.cash * .05, X * 60))); me.cash += loot; d.cash -= loot; delete d.hexes[h]; me.hexes[h] = W.now; W.OWN[h] = { u, ts: W.now }; d.approval = clamp(d.approval - 4, 0, 100); d.stability = clamp(d.stability - 3, 0, 100); gainXP(W, u, 40); }
    else gainXP(W, u, 5);
    pushOut(W, u, { type: 'battle', to: v, h, X, win, lossA, lossD, loot });
    log(d, win ? `${me.name} defeated your forces in ${pname(h)}. Losses: ${num(lossD)} troops${loot ? ', ' + money(loot) : ''} and the province.` : `Your forces repelled an attack by ${me.name} in ${pname(h)}. Losses: ${num(lossD)} troops.`, W);
    news(W, u, win ? `${me.name} captured ${pname(h)} from ${d.name}.` : `${d.name} repelled an invasion of ${pname(h)} by ${me.name}.`);
    touch(W, u, v);
    return { msg: win ? 'Victory.' : 'Defeat.', battle: { win, h, X, atk: Math.round(atk), def: Math.round(def), lossA, lossD, loot, sanctioned: sanctioned(me) } };
  }

  function dip(W, u, kind, v) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them || v === u) fail('Unknown nation.');
    const t = W.now;
    if (kind === 'war') {
      if (!W.cfg.war) fail('Warfare is currently disabled by the administrators.');
      if (rankOf(me.xp) < 2) fail('You must reach the rank of Mayor to declare war.');
      if (atWar(W, u, v)) fail('You are already at war.');
      setRel(me, v, 'war', t); setRel(me, v, 'unally', t); setRel(me, v, 'untrade', t);
      news(W, u, `${me.name} has declared war on ${them.name}.`); log(them, `${me.name} has declared war on you.`, W);
    } else if (kind === 'peace') {
      if (!atWar(W, u, v)) fail('You are not at war with them.');
      setRel(me, v, 'peace', t);
      if (!atWar(W, u, v)) news(W, u, `${me.name} and ${them.name} signed a peace treaty.`); else { log(me, `Peace offered to ${them.name}.`, W); log(them, `${me.name} is offering peace.`, W); }
    } else if (kind === 'ally') {
      if (atWar(W, u, v)) fail('Make peace first.');
      setRel(me, v, 'ally', t);
      if (pact(W, u, v, 'ally')) news(W, u, `${me.name} and ${them.name} formed an alliance.`); else { log(me, `Alliance proposed to ${them.name}.`, W); log(them, `${me.name} proposes an alliance.`, W); }
    } else if (kind === 'unally') { setRel(me, v, 'unally', t); news(W, u, `${me.name} ended its alliance with ${them.name}.`); }
    else if (kind === 'trade') {
      if (atWar(W, u, v)) fail('Make peace first.');
      if (sanctioned(me)) fail('No nation will sign trade agreements with you while you are under sanctions.');
      if (traders(W, u).length >= 5 && !pact(W, u, v, 'trade')) fail('You can hold at most 5 trade agreements.');
      setRel(me, v, 'trade', t);
      if (pact(W, u, v, 'trade')) news(W, u, `${me.name} and ${them.name} signed a trade agreement.`); else { log(me, `Trade agreement proposed to ${them.name}.`, W); log(them, `${me.name} proposes a trade agreement.`, W); }
    } else if (kind === 'untrade') { setRel(me, v, 'untrade', t); log(me, `Trade agreement with ${them.name} cancelled.`, W); log(them, `${me.name} cancelled your trade agreement.`, W); }
    else fail('Unknown action.');
    touch(W, u, v); return { msg: 'Done.' };
  }

  function aid(W, u, v, amt) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them || v === u) fail('Unknown nation.');
    const a = { cash: Math.max(0, Math.floor(Number(amt.cash) || 0)) }; for (const r in RES) a[r] = Math.max(0, Math.floor(Number(amt[r]) || 0));
    if (a.cash > 1e13 || Object.keys(RES).some(r => a[r] > 1e9)) fail('Amount too large.');
    if (!a.cash && !Object.keys(RES).some(r => a[r])) fail('Enter an amount.');
    if (a.cash > me.cash) fail('Insufficient funds.'); for (const r in RES) if (a[r] > me.res[r]) fail('Not enough ' + r + '.');
    me.cash -= a.cash; them.cash += a.cash; for (const r in RES) { me.res[r] -= a[r]; them.res[r] += a[r]; }
    const txt = [a.cash ? money(a.cash) : '', ...Object.keys(RES).filter(r => a[r]).map(r => `${num(a[r])} ${r}`)].filter(Boolean).join(', ');
    pushOut(W, u, { type: 'aid', to: v, ...a }); log(them, `${me.name} sent you aid: ${txt}.`, W); news(W, u, `${me.name} sent aid to ${them.name}.`); gainXP(W, u, 5);
    touch(W, u, v); return { msg: `Aid sent: ${txt}.`, amount: a };
  }

  function market(W, u, r, q, buy) {
    const me = W.A[u]; if (!me) fail('Found a nation first.'); if (!has(RES, r)) fail('Unknown commodity.');
    q = Math.floor(+q); if (!(q > 0) || q > 1e6) fail('Enter a valid quantity.');
    const p = prices(W)[r], s = spreads(W, u); let msg;
    if (buy) { const cost = Math.round(p * s.buy * q); if (cost > me.cash) fail(`That order costs ${money(cost)}.`); me.cash -= cost; me.res[r] += q; me.imp = (me.imp || 0) + cost; me.trades = [{ t: W.now, r, q }, ...(me.trades || [])].slice(0, 40); msg = `Imported ${num(q)} ${r} for ${money(cost)}.`; }
    else { if (q > me.res[r]) fail('You do not have that much.'); const got = Math.round(p * s.sell * q); me.cash += got; me.res[r] -= q; me.exp = (me.exp || 0) + got; me.trades = [{ t: W.now, r, q: -q }, ...(me.trades || [])].slice(0, 40); msg = `Exported ${num(q)} ${r} for ${money(got)}.`; }
    log(me, msg, W); gainXP(W, u, 2); touch(W, u); return { msg };
  }

  function setTax(W, u, t) { const n = W.A[u]; if (!n) fail('Found a nation first.'); t = Math.round(+t); if (!(t >= 5 && t <= 50)) fail('Tax must be between 5% and 50%.'); n.tax = t; touch(W, u); return { msg: `Tax rate set to ${t}%.` }; }
  function setGov(W, u, g) { const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!has(GOV, g)) fail('Unknown government.'); if (g === n.gov) fail('That is already your government.'); if (left(W, n, 'gov')) fail(`Your government can change again in ${fmtT(left(W, n, 'gov'))}.`); n.gov = g; n.stability = clamp(n.stability - 25, 0, 100); n.approval = clamp(n.approval - 10, 0, 100); n.cd.gov = W.now + 6 * HOUR; news(W, u, `${n.name} is now a ${GOV[g].n}.`); touch(W, u); return { msg: `You now govern a ${GOV[g].n}.` }; }

  function tickOnce(W, u, rng) {
    const n = W.A[u], hs = hexesOf(W, u), p = production(W, u), c = consumption(n), g = GOV[n.gov], w = wars(W, u).length;
    for (const r in p) n.res[r] += p[r] - c[r];
    n.cash += hs.filter(h => P[h].t === 'P' && h != n.cap).length * 2000 * W.cfg.income; n.cash -= n.troops * 8;
    const short = []; for (const r in n.res) if (n.res[r] < 0) { short.push(r); n.res[r] = 0; }
    const foodShort = short.includes('food'), goodsShort = short.includes('goods');
    if (foodShort) n.pop *= .985; else if (n.approval > 35) n.pop = Math.min(Math.max(n.pop, popCap(W, u)), n.pop * 1.012);
    if (n.cash < 0) n.troops = Math.floor(n.troops * .98);
    const apT = 55 - (n.tax - 20) * 1.2 + g.ap - w * (n.gov === 'dem' ? 10 : n.gov === 'dic' ? 3 : 6) - (foodShort ? 15 : 0) - (goodsShort ? 8 : 0) - (sanctioned(n) ? 6 : 0) + Math.min(5, traders(W, u).length) * 1.5;
    n.approval = clamp(n.approval + (apT - n.approval) * .1, 0, 100);
    const stT = 30 + n.approval * .5 + g.st + n.fort - w * 5 - (n.aggr || 0) * .1; n.stability = clamp(n.stability + (stT - n.stability) * .08, 0, 100);
    n.aggr = Math.max(0, (n.aggr || 0) - 1);
    if (n.stability < 25 && rng() < .05) { const lst = Object.keys(n.hexes).map(Number).filter(h => h != n.cap && owner(W, h) === u); if (lst.length) { const h = lst[Math.floor(rng() * lst.length)]; delete n.hexes[h]; delete W.OWN[h]; news(W, u, `Separatists in ${pname(h)} declared independence from ${n.name}.`); } }
    if (n.stability < 12 && n.approval < 20 && rng() < .06) { const ks = Object.keys(GOV).filter(k => k !== n.gov); n.gov = ks[Math.floor(rng() * ks.length)]; n.cash *= .7; n.troops = Math.floor(n.troops * .85); n.stability = 45; n.approval = 50; news(W, u, `Revolution in ${n.name}. The new regime is a ${GOV[n.gov].n}.`); }
  }
  // Runs on the server about once a minute for every nation.
  function tick(W, u, active, rng) {
    const n = W.A[u]; let changed = false;
    const k = Math.floor((W.now - n.lastTick) / TICK);
    if (k > 0) { if (active) for (let i = 0; i < Math.min(k, 12); i++) tickOnce(W, u, rng); n.lastTick += k * TICK; changed = true; }
    if (W.now - n.nextCard > 3 * HOUR) n.nextCard = W.now - 3 * HOUR;
    while (W.now >= n.nextCard) { if (n.cards.length < 3 && active) addCard(W, u, rng); n.nextCard += 40 * MIN; changed = true; }
    for (const h of Object.keys(n.hexes)) if (owner(W, h) !== u) { delete n.hexes[h]; changed = true; }
    if (changed) touch(W, u);
    return changed;
  }

  function exec(W, u, cmd, rng) {
    const c = cmd || {};
    switch (c.c) {
      case 'found': return found(W, u, c, rng);
      case 'act': return act(W, u, String(c.k), c.arg, rng);
      case 'decide': return decide(W, u, String(c.id), c.o, rng);
      case 'attack': return attack(W, u, c.h, c.x, rng);
      case 'dip': return dip(W, u, String(c.kind), String(c.v));
      case 'aid': return aid(W, u, String(c.v), c.amt || {});
      case 'market': return market(W, u, String(c.r), c.q, !!c.buy);
      case 'tax': return setTax(W, u, c.t);
      case 'gov': return setGov(W, u, String(c.g));
      case 'hideguide': { const n = W.A[u]; if (n) { n.hideGuide = true; touch(W, u); } return { msg: '' }; }
      default: fail('Unknown command.');
    }
  }

  return { P, CN, nbrs, pname, world, computeOwn, owner, hexesOf, rankOf, rankName, maxHex, R, atWar, warSince, pact, offered, others, wars, allies, traders, sanctioned, oilF, cheap, power, score, taxIncome, production, consumption, popCap, prices, spreads, recruitBatch, expandCost, researchCost, maxTrain, infraCost, fortCost, rallyCost, dailyGrant, left, expandTargets, startOk, hexAge, canAttack, defense, atkMult, atkCost, condOk, normalize, exec, tick, fmtT, CARDS };
}
return { Core, MIN, HOUR, TICK, RES, TYPE, CAPP, RANKS, GOV, COLORS, ACTS, DEFCFG, EFFKEYS, money, num, clamp };
});
