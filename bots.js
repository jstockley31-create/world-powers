// World Powers — computer-controlled (AI) nations. They play by exactly the same rules as people:
// every action goes through the same game engine, with the same timers, costs and protections.
'use strict';
const NAMES = ['Kingdom of Varn', 'Republic of Kestria', 'Federation of Orlesia', 'Commonwealth of Halvard', 'Union of Seravia', 'Sultanate of Qadira', 'Duchy of Montrevel', 'Empire of Taurin',
  'Free State of Elmora', 'Confederation of Ashgard', 'Principality of Lorvane', 'Republic of Novaterra', 'Grand Duchy of Velmar', 'Dominion of Caldera', 'United Provinces of Brenn', 'Kingdom of Sardova',
  'Republic of Istara', 'Federation of Cordia', 'Emirate of Zahran', 'Commonwealth of Wexmoor', 'Republic of Talmyra', 'Kingdom of Eskavar', 'Union of Pallas', 'Free Republic of Aldmere',
  'Empire of Corvanth', 'Republic of Meridia', 'Kingdom of Thessaly Nova', 'Federation of Rhodan', 'Principality of Avenor', 'Republic of Galdor'];
const PERS = {
  merchant: { n: 'Merchant', gov: 'dem', war: .0003, trade: .9, ally: .6, peace: .2, build: ['research', 'infra', 'expand'], sell: true },
  expansionist: { n: 'Expansionist', gov: 'mon', war: .002, trade: .5, ally: .5, peace: .08, build: ['expand', 'recruit', 'infra', 'research'] },
  warlord: { n: 'Warlord', gov: 'dic', war: .006, trade: .3, ally: .35, peace: .03, build: ['recruit', 'drill', 'expand', 'fort'] },
  isolationist: { n: 'Isolationist', gov: 'com', war: .0001, trade: .35, ally: .25, peace: .3, build: ['fort', 'infra', 'research', 'expand'] }
};
const PKEYS = Object.keys(PERS);

module.exports = function makeBots(core, WP, rng) {
  const HOUR = WP.HOUR;
  const pick = a => a[Math.floor(rng() * a.length)];
  const isBot = u => u.startsWith('ai_');
  const tryExec = (W, u, c) => { try { return core.exec(W, u, c, rng); } catch (e) { if (!e.user) throw e; return null; } };

  const hsl = (h, sat, l) => { const f = n => { const k = (n + h / 30) % 12, a = sat * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); }; return '#' + f(0) + f(8) + f(4); };
  const hueOf = hex => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null; const v = parseInt(m[1], 16), r = (v >> 16 & 255) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return null; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  // pick the hue furthest from every color already on the map, so nations are easy to tell apart
  function distinctColor(W) { const used = Object.values(W.A).map(n => hueOf(n.color)).filter(h => h != null); let best = 0, bd = -1; for (let h = 0; h < 360; h += 5) { let d = 180; for (const u of used) { const x = Math.abs(h - u); d = Math.min(d, Math.min(x, 360 - x)); } if (d > bd) { bd = d; best = h; } } const lum = [.5, .58, .44][used.length % 3]; return hsl(best, .58, lum); }

  function spawn(W) {
    const used = new Set(Object.values(W.A).map(n => n.name));
    const name = NAMES.find(n => !used.has(n)) || ('Republic of ' + Math.random().toString(36).slice(2, 7).toUpperCase());
    // pick a start far from everyone, spread across the globe
    const caps = Object.values(W.A).map(n => core.P[n.cap] && core.P[n.cap].c).filter(Boolean);
    let best = null, bestD = -1;
    for (let i = 0; i < 400; i++) { const h = Math.floor(rng() * core.P.length); if (!core.startOk(W, h) || core.P[h].j.length < 2) continue; const c = core.P[h].c; let d = 9; for (const q of caps) d = Math.min(d, dist(c, q)); if (d > bestD) { bestD = d; best = h; } }
    if (best == null) return null;
    const p = pick(PKEYS), u = 'ai_' + Math.random().toString(36).slice(2, 10);
    const r = tryExec(W, u, { c: 'found', name, gov: PERS[p].gov, hex: best, color: WP.COLORS[0] });
    if (!r) return null;
    const n = W.A[u];
    n.ai = { p }; n.color = distinctColor(W);
    // a head start so the world looks lived-in: some experience and a few provinces
    n.created = W.now - (3 + rng() * 4) * 24 * HOUR;
    n.xp = Math.round(150 + rng() * 650); n.tech = Math.floor(rng() * 4); n.infra = Math.floor(rng() * 3); n.fort = p === 'isolationist' ? 2 : Math.floor(rng() * 2);
    n.troops = Math.round(400 + rng() * 500); n.pop = 1.3e5 + rng() * 1e5;
    const extra = 1 + Math.floor(rng() * 4); const t0 = n.created;
    for (let i = 0; i < extra; i++) { const ts = core.expandTargets(W, u); if (!ts.length) break; const h = pick(ts); n.hexes[h] = t0 + i * 3600e3; W.OWN[h] = { u, ts: t0 + i * 3600e3 }; }
    n.out = (n.out || []).filter(e => e.type !== 'news'); n.log = [];
    W.changed.add(u); W.welcome = null;
    return u;
  }
  function dist(a, b) { const r = Math.PI / 180; const s = Math.sin((b[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin((b[0] - a[0]) * r / 2) ** 2; return 2 * Math.asin(Math.min(1, Math.sqrt(s))); }

  // choose the decision option a sensible leader of this personality would pick
  function chooseOption(W, u, card) {
    const n = W.A[u], P_ = n.ai.p; let best = 0, bv = -1e9;
    card.o.forEach((o, i) => {
      const e = o[1].risk != null ? o[1].ok : o[1]; const risk = o[1].risk != null ? o[1].risk : 1;
      let v = 0;
      for (const [k, x] of Object.entries(e)) {
        if (k === 'tr') v += x * (n.cash < 5e5 ? 3 : 1);
        else if (k === 'ap' || k === 'st') v += x * (n[k === 'ap' ? 'approval' : 'stability'] < 45 ? 1.6 : 1);
        else if (k === 'tech') v += x * (P_ === 'merchant' ? 5 : 3);
        else if (k === 'troops') v += x * (P_ === 'warlord' ? .06 : .02);
        else if (k === 'pop') v += x * 1.5;
        else if (k === 'aggr') v -= x * .2;
        else v += x * .02;
      }
      v = v * risk - (1 - risk) * 6 + rng() * 3;
      if (v > bv) { bv = v; best = i; }
    });
    return best;
  }

  function turn(W, u, cfg) {
    const n = W.A[u]; if (!n || !n.ai) return;
    const per = PERS[n.ai.p] || PERS.merchant; W.now = Date.now();
    // AI nations act at the pace of a dedicated human player, not every instant, and take a long break each day
    const hourUTC = new Date(W.now).getUTCHours(); n.ai.sleep = n.ai.sleep != null ? n.ai.sleep : Math.floor(rng() * 24);
    if ((hourUTC - n.ai.sleep + 24) % 24 < 9) return;
    if (rng() > .085) return;
    // 1) decisions
    if (n.cards.length && rng() < .5) { const c = n.cards[0]; const card = core.CARDS[c.i]; if (card) return tryExec(W, u, { c: 'decide', id: c.id, o: chooseOption(W, u, card) }); }
    // 2) basic income
    for (const k of ['daily', 'tax', 'prod']) if (!core.left(W, n, k)) return tryExec(W, u, { c: 'act', k });
    // 3) keep supplies healthy via the market
    const cons = core.consumption(n), prod = core.production(W, u);
    for (const r of ['food', 'oil', 'steel', 'goods']) { const need = (cons[r] - prod[r]) * 6 + 60; if (n.res[r] < need && n.cash > 4e5) { const q = Math.round(Math.max(60, need - n.res[r] + 60)); if (tryExec(W, u, { c: 'market', r, q, buy: true })) return; } }
    if (per.sell || rng() < .3) for (const r of ['food', 'oil', 'steel', 'goods']) if (n.res[r] > 900) { if (tryExec(W, u, { c: 'market', r, q: Math.round(n.res[r] * .4), buy: false })) return; }
    // 4) diplomacy
    const others = core.others(W, u);
    for (const v of others) {
      if (core.offered(W, v, u, 'trade') && rng() < per.trade * .5) return tryExec(W, u, { c: 'dip', kind: 'trade', v });
      if (core.offered(W, v, u, 'ally') && rng() < per.ally * .4) return tryExec(W, u, { c: 'dip', kind: 'ally', v });
      if (core.atWar(W, u, v) && (core.R(W, v, u).peace || 0) > core.warSince(W, u, v) && rng() < per.peace) return tryExec(W, u, { c: 'dip', kind: 'peace', v });
    }
    const myWars = core.wars(W, u);
    for (const v of myWars) if (W.now - core.warSince(W, u, v) > 3 * HOUR && rng() < per.peace * .3) return tryExec(W, u, { c: 'dip', kind: 'peace', v });
    if (rng() < .02 * per.trade && core.traders(W, u).length < 3) { const cand = others.filter(v => !core.atWar(W, u, v) && !core.pact(W, u, v, 'trade') && !core.offered(W, u, v, 'trade')); if (cand.length) return tryExec(W, u, { c: 'dip', kind: 'trade', v: pick(cand) }); }
    // 5) war: only against bordering nations of similar strength, within all the usual protections
    if (cfg.war && cfg.botWar !== 'no') {
      const front = []; for (const h of core.hexesOf(W, u)) for (const k of core.nbrs(h)) { const v = core.owner(W, k); if (v && v !== u) front.push([k, v]); }
      if (myWars.length) {
        if (rng() < .6) for (const [h, v] of front) { if (!myWars.includes(v) || core.canAttack(W, u, h)) continue; const X = Math.floor(n.troops * .7); if (X < 50) break; if (X * core.atkMult(n) > core.defense(W, h, u) * (.9 + rng() * .25)) return tryExec(W, u, { c: 'attack', h, x: X }); }
      } else if (core.rankOf(n.xp) >= 2 && rng() < per.war) {
        const mine = core.score(W, u);
        const targets = [...new Set(front.map(f => f[1]))].filter(v => {
          const t = W.A[v]; if (core.pact(W, u, v, 'ally')) return false;
          const s = core.score(W, v); if (s < mine * .45 || s > mine * 1.25) return false;
          if (!isBot(v)) { if (cfg.botWar === 'retaliate') { const hit = (t.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR) || (core.R(W, v, u).war || 0) > W.now - 24 * HOUR; if (!hit) return false; } if (W.now - t.created < cfg.protectH * HOUR) return false; }
          return true;
        });
        if (targets.length) return tryExec(W, u, { c: 'dip', kind: 'war', v: pick(targets) });
      }
    }
    // 6) development according to personality
    if (n.approval < 45 && !core.left(W, n, 'rally')) return tryExec(W, u, { c: 'act', k: 'rally' });
    for (const k of per.build) if (!core.left(W, n, k) && n.cash > 2.5e5) { const r = tryExec(W, u, { c: 'act', k }); if (r) return r; }
    for (const k of ['research', 'infra', 'recruit', 'drill', 'fort', 'expand']) if (!core.left(W, n, k) && n.cash > 6e5 && rng() < .4) { const r = tryExec(W, u, { c: 'act', k }); if (r) return r; }
    if (n.tax !== 22) tryExec(W, u, { c: 'tax', t: 22 });
  }

  return { spawn, turn, isBot, PERS };
};
