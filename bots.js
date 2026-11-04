// World Powers — computer-controlled (AI) nations. They play by exactly the same rules as people:
// every action goes through the same game engine, with the same timers, costs and protections.
'use strict';
const NAMES = ['Kingdom of Varn', 'Republic of Kestria', 'Federation of Orlesia', 'Commonwealth of Halvard', 'Union of Seravia', 'Sultanate of Qadira', 'Duchy of Montrevel', 'Empire of Taurin',
  'Free State of Elmora', 'Confederation of Ashgard', 'Principality of Lorvane', 'Republic of Novaterra', 'Grand Duchy of Velmar', 'Dominion of Caldera', 'United Provinces of Brenn', 'Kingdom of Sardova',
  'Republic of Istara', 'Federation of Cordia', 'Emirate of Zahran', 'Commonwealth of Wexmoor', 'Republic of Talmyra', 'Kingdom of Eskavar', 'Union of Pallas', 'Free Republic of Aldmere',
  'Empire of Corvanth', 'Republic of Meridia', 'Kingdom of Thessaly Nova', 'Federation of Rhodan', 'Principality of Avenor', 'Republic of Galdor'];
const PERS = {
  merchant: { n: 'Merchant', gov: 'dem', war: .0008, trade: .9, ally: .6, peace: .2, build: ['research', 'infra', 'expand', 'navy'], sell: true, budget: { spend: 16, mil: 20, health: 25, edu: 30, infra: 25 } },
  expansionist: { n: 'Expansionist', gov: 'mon', war: .005, trade: .5, ally: .5, peace: .08, build: ['expand', 'recruit', 'navy', 'infra', 'research'], budget: { spend: 17, mil: 35, health: 20, edu: 20, infra: 25 } },
  warlord: { n: 'Warlord', gov: 'dic', war: .015, trade: .3, ally: .35, peace: .03, build: ['recruit', 'air', 'drill', 'navy', 'expand', 'spies'], budget: { spend: 20, mil: 50, health: 15, edu: 15, infra: 20 } },
  isolationist: { n: 'Isolationist', gov: 'com', war: .0003, trade: .35, ally: .25, peace: .3, build: ['fort', 'infra', 'research', 'spies', 'expand'], budget: { spend: 15, mil: 35, health: 25, edu: 20, infra: 20 } }
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
    n.ai = { p }; n.color = distinctColor(W); n.budget = { ...PERS[p].budget };
    // a head start so the world looks lived-in: some experience and a few provinces
    n.created = W.now - (3 + rng() * 4) * 24 * HOUR;
    n.xp = Math.round(150 + rng() * 650); n.tech = Math.floor(rng() * 4); n.infra = Math.floor(rng() * 3); n.fort = p === 'isolationist' ? 2 : Math.floor(rng() * 2);
    n.troops = Math.round(400 + rng() * 500); n.pop = 1.3e5 + rng() * 1e5; n.ships = core.hasCoast(W, u) || core.isCoastal(n.cap) ? Math.floor(2 + rng() * 6) : 0; n.air = n.tech >= 2 ? Math.floor(rng() * 8) : 0; n.spies = Math.floor(rng() * 5);
    const extra = 1 + Math.floor(rng() * 4); const t0 = n.created;
    for (let i = 0; i < extra; i++) { const ts = core.expandTargets(W, u); if (!ts.length) break; const h = pick(ts); n.hexes[h] = t0 + i * 3600e3; W.OWN[h] = { u, ts: t0 + i * 3600e3 }; }
    n.gdp = core.gdpTarget(W, u); n.gdpHist = [{ t: W.now, v: Math.round(n.gdp) }]; if (n.gov === 'dem') n.nextElection = W.now + (12 + rng() * 60) * HOUR;
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

  // ---------- peace: AI nations judge each offer on how the war is going, answer within minutes, and say why ----------
  const PEACE_BASE = { warlord: -.35, expansionist: -.15, merchant: .15, isolationist: .25 };
  function warState(W, u, v) {
    const n = W.A[u], t = W.A[v], day = W.now - 24 * HOUR;
    const lost = (t.out || []).filter(e => e.type === 'battle' && e.to === u && e.win && e.t > day).length;
    const won = (n.out || []).filter(e => e.type === 'battle' && e.to === v && e.win && e.t > day).length;
    const ratio = core.score(W, v) / Math.max(1, core.score(W, u)), hours = (W.now - core.warSince(W, u, v)) / HOUR;
    let will = (PEACE_BASE[n.ai.p] ?? 0) + .25 * lost - .2 * won + (ratio > 1.3 ? .35 : ratio > 1 ? .15 : ratio < .6 ? -.25 : 0) + Math.min(.3, hours / 24 * .3)
      + (n.approval < 35 ? .2 : 0) + (n.stability < 30 ? .15 : 0) + (n.troops < 200 ? .3 : 0);
    const reason = won > lost ? 'they believe they are winning' : ratio < .8 ? 'they see themselves as the stronger power' : n.ai.p === 'warlord' ? 'their generals want to fight on' : 'they are not ready to make peace yet';
    return { will, reason, hours };
  }
  function handlePeace(W, u) {
    const n = W.A[u]; n.ai.pa = n.ai.pa || {};
    for (const v of core.wars(W, u)) {
      if (!W.A[v]) continue;
      const since = core.warSince(W, u, v), theirs = core.R(W, v, u).peace || 0, mine = core.R(W, u, v).peace || 0;
      const st = warState(W, u, v);
      if (theirs > since) {
        const prev = n.ai.pa[v];
        if (prev && prev.offer === theirs && W.now - prev.t < 2 * HOUR) continue; // already answered; think again in 2 hours
        if (rng() > .35) continue; // a short, human-like pause before answering
        if (st.will > .25) { tryExec(W, u, { c: 'dip', kind: 'peace', v }); delete n.ai.pa[v]; return true; }
        if (!prev || prev.offer !== theirs) core.note(W, v, 'diplo', `${n.name} rejected your peace offer — ${st.reason}. They may reconsider if the war turns against them.`);
        n.ai.pa[v] = { offer: theirs, t: W.now }; W.changed.add(u);
      } else if (mine <= since && st.hours > 1 && st.will > .5 && rng() < .2) { tryExec(W, u, { c: 'dip', kind: 'peace', v }); return true; } // losing: ask for peace themselves
    }
    return false;
  }
  // pick the best reachable province of an enemy (preferring nations that hit us in the last day) and attack it if the odds are good
  function farStrike(W, u, enemies) {
    const n = W.A[u]; let best = null;
    const hitUs = v => (W.A[v].out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR);
    for (const v of [...enemies].sort((a, b) => hitUs(b) - hitUs(a)).slice(0, 3)) {
      const hs = core.hexesOf(W, v); for (let i = hs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [hs[i], hs[j]] = [hs[j], hs[i]]; }
      for (const h of hs.slice(0, 12)) {
        if (core.canAttack(W, u, h)) continue;
        const pl = core.attackPlan(W, u, h, Math.floor(n.troops * .8), Math.floor((n.air || 0) * .8)); if (!pl || pl.X < 50) continue;
        if (n.cash < pl.cost.cash * 1.5 || n.res.oil < pl.cost.oil + 20 || n.res.food < pl.cost.food + 20) continue;
        const score = pl.chance + (hitUs(v) ? .1 : 0) - (W.A[v].cap == h ? .1 : 0);
        if (pl.chance >= .55 && (!best || score > best.score)) best = { h, pl, score };
      }
    }
    return best ? tryExec(W, u, { c: 'attack', h: best.h, x: best.pl.X, air: best.pl.AIR }) : null;
  }
  // ---------- the Rising Power: one AI superpower that keeps pace with the strongest player, goes nuclear and must be stopped together ----------
  const humans = W => Object.keys(W.A).filter(v => !isBot(v));
  function pickBoss(W, cfg) {
    const bots = Object.keys(W.A).filter(isBot); if (!cfg.aiBoss || !bots.length || !humans(W).length || (cfg.bossPause && !bots.some(b => W.A[b].ai.boss))) { if (cfg.bossPause) return null; for (const b of bots) if (W.A[b].ai.boss) { W.A[b].ai.boss = false; core.touch(W, b); } return null; }
    const cur = bots.find(b => W.A[b].ai.boss); if (cur) return cur;
    const b = bots.sort((a, c) => (['warlord', 'expansionist'].includes(W.A[c].ai.p) - ['warlord', 'expansionist'].includes(W.A[a].ai.p)) || core.score(W, c) - core.score(W, a))[0];
    W.A[b].ai.boss = true; core.touch(W, b);
    core.news(W, b, `⚠ ${W.A[b].name} is rising as a superpower. Foreign arms dealers are pouring money and weapons into its military.`);
    for (const h of humans(W)) core.note(W, h, 'war', `⚠ ${W.A[b].name} has become the Rising Power: an AI superpower that will grow with the strongest nations, build nuclear weapons and attack players. Stopping it will take the world working together.`);
    return b;
  }
  function bossAssist(W, u) {
    // runs every world tick (30 s): every rate below is per tick, sized for about an hour of real time (120 ticks)
    const n = W.A[u], H = humans(W).map(v => W.A[v]).filter(Boolean); if (!H.length) return;
    const top = k => Math.max(...H.map(h => h[k] || 0)), topPow = Math.max(...humans(W).map(v => core.power(W, v))), now = W.now;
    const pow = core.power(W, u), behind = pow < topPow * .9;
    // the world united: 3 or more nations at war with it and its foreign backers pull out completely
    const coalition = core.wars(W, u).filter(v => !isBot(v)).length + core.wars(W, u).filter(v => isBot(v)).length * .5;
    const isolated = coalition >= 3;
    if (isolated && !n.ai.isolated) { n.ai.isolated = now; core.news(W, u, `🌍 ${core.wars(W, u).length} nations have united against ${n.name}. Its foreign backers are pulling out: no more money or weapons will reach it.`); }
    if (!isolated && n.ai.isolated && coalition < 2) n.ai.isolated = 0;
    // damage sticks: no rebuilding for 2 hours after it is attacked or struck
    const lastHit = Math.max(0, ...Object.values(n.hitBy || {}));
    const hurt = now - lastHit < 2 * 3600e3;
    const saving = (!n.nuke && n.cash < core.NUKE.cash * 1.2) || (n.nuke && !n.warhead && n.cash < core.WARHEAD.cash * 1.2);
    if (!isolated && (behind || saving)) n.cash += Math.max(6e4, top('gdp') * .0001); // about $7M+ an hour while it is behind or saving for its nuclear program
    if (!isolated) for (const r of ['food', 'oil', 'steel', 'goods']) if ((n.res[r] || 0) < 5000) n.res[r] = (n.res[r] || 0) + 10;
    if (!isolated && !hurt && behind) { // rebuild toward 90% of the strongest player, a few percent an hour
      if (rng() < .5) n.air = (n.air || 0) + Math.max(1, Math.ceil((n.air || 0) * .0005));
      if (n.troops < core.troopCap(n)) n.troops = Math.min(core.troopCap(n), n.troops + Math.max(5, Math.ceil(n.troops * .0003)));
    }
    if (n.pop < top('pop') * .6 && !isolated) n.pop *= 1.0005;
    // never a sky full of planes: at most 1.5x the biggest player air force; anything above that drains away within about an hour
    const airCap = Math.max(300, top('air') * 1.5);
    if ((n.air || 0) > airCap) n.air = Math.max(airCap, Math.floor(n.air - Math.max(1, (n.air - airCap) * .02)));
    // overstretched or isolated: its forces wear down
    if (pow > topPow * 1.15) { n.air = Math.floor((n.air || 0) * .998); n.troops = Math.floor(n.troops * .998); n.ships = Math.floor((n.ships || 0) * .999); }
    if (isolated) { n.air = Math.floor((n.air || 0) * .9995); n.troops = Math.floor(n.troops * .9995); }
    // fortifications: at most 2 levels above the best-fortified player
    const fortCap = Math.min(12, top('fort') + 2);
    if ((n.fort || 0) > fortCap && rng() < 1 / 240) n.fort = n.fort - 1;
    else if (!isolated && rng() < 1 / 720 && (n.fort || 0) < fortCap) n.fort = (n.fort || 0) + 1;
    if (!isolated && rng() < 1 / 200 && (n.tech || 0) < Math.max(core.WARHEAD.tech, top('tech'))) n.tech = (n.tech || 0) + 1;
    if (!isolated && (n.xp || 0) < Math.max(WP.RANKS[core.WARHEAD.rank][0], top('xp') * .9)) n.xp = (n.xp || 0) + 4;
    if (!isolated) { n.approval = Math.max(n.approval, 55); n.stability = Math.max(n.stability, 60); }
    core.touch(W, u);
  }
  function bossMove(W, u, cfg) {
    const n = W.A[u], H = humans(W);
    // nuclear ambitions
    if (!n.nuke && rng() < .4) { const r = tryExec(W, u, { c: 'nuke' }); if (r) return r; }
    if (n.nuke && !n.warhead && !core.canWarhead(W, u) && rng() < .4) { const r = tryExec(W, u, { c: 'warhead' }); if (r) return r; }
    const foes = core.wars(W, u).filter(v => !isBot(v));
    // the launch: only against a player it has been at war with for 6+ hours
    if (core.warheadReady(W, n) && rng() < .05) { const tg = foes.filter(v => W.now - core.warSince(W, u, v) > 6 * HOUR && !core.canLaunch(W, u, v)).sort((a, b) => core.score(W, b) - core.score(W, a))[0]; if (tg) { const r = tryExec(W, u, { c: 'launch', v: tg }); if (r) return r; } }
    // war on the strongest players it can reach (one or two wars at a time)
    if (cfg.war && cfg.botWar === 'yes' && foes.length < 2 && rng() < .03 && core.rankOf(n.xp) >= 2) {
      const t = H.filter(v => !core.atWar(W, u, v) && W.now - W.A[v].created > cfg.protectH * HOUR && core.hexesOf(W, v).some(h => core.attackPlan(W, u, h))).sort((a, b) => core.score(W, b) - core.score(W, a));
      if (t.length) return tryExec(W, u, { c: 'dip', kind: 'war', v: t[Math.floor(rng() * Math.min(2, t.length))] });
    }
    if (foes.length && rng() < .5) { const r = farStrike(W, u, foes); if (r) return r; }
    if (foes.length && (n.air || 0) >= 10 && rng() < .3) { const v = foes[Math.floor(rng() * foes.length)]; if (!core.canStrike(W, u, v)) { const r = tryExec(W, u, { c: 'strike', v, kind: 'air', target: rng() < .6 ? 'mil' : 'infra', n: Math.floor(n.air * .6) }); if (r) return r; } }
    return null;
  }
  function turn(W, u, cfg) {
    const n = W.A[u]; if (!n || !n.ai) return;
    const per = PERS[n.ai.p] || PERS.merchant; W.now = Date.now();
    const boss = pickBoss(W, cfg) === u; if (boss) bossAssist(W, u);
    // AI nations act at the pace of a dedicated human player, not every instant, and take a long break each day
    if (core.wars(W, u).length && handlePeace(W, u)) return;
    const hourUTC = new Date(W.now).getUTCHours(); n.ai.sleep = n.ai.sleep != null ? n.ai.sleep : Math.floor(rng() * 24);
    if ((hourUTC - n.ai.sleep + 24) % 24 < (boss ? 4 : 9)) return;
    if (rng() > (boss ? .18 : core.wars(W, u).length ? .14 : .085)) return;
    if (boss) { const r = bossMove(W, u, cfg); if (r) return r; }
    // 1) decisions
    if (n.cards.length && rng() < .5) { const c = n.cards[0]; const card = core.getCard(c.i); if (card) return tryExec(W, u, { c: 'decide', id: c.id, o: chooseOption(W, u, card) }); }
    // finances: borrow when broke, repay when flush, campaign before elections
    if (n.cash < 1e5 && core.maxBorrow(n) > 3e5 && !core.left(W, n, 'bonds')) { n.cd.bonds = W.now + 2 * HOUR; return tryExec(W, u, { c: 'bonds', amt: Math.round(Math.min(core.maxBorrow(n), n.gdp * .1)) }); }
    if (n.debt > 0 && n.cash > 4e6) return tryExec(W, u, { c: 'bonds', amt: Math.round(Math.min(n.debt, n.cash * .4)), repay: true });
    if (n.gov === 'dem' && n.nextElection && n.nextElection - W.now < 24 * HOUR && !core.left(W, n, 'campaign') && (n.campaign || 0) < 12 && n.cash > 4e5) return tryExec(W, u, { c: 'act', k: 'campaign' });
    // walk away from partners the World Council condemned or sanctioned (warlords care least)
    { const bad = v => { const t = W.A[v]; return !!t && (core.rogue(W, t) || core.sanctioned(t) || (t.condemned || 0) > W.now); };
      for (const v of core.others(W, u)) if (bad(v)) {
        if (core.pact(W, u, v, 'trade') && rng() < (n.ai.p === 'warlord' ? .1 : .35)) return tryExec(W, u, { c: 'dip', kind: 'untrade', v });
        if (core.pact(W, u, v, 'ally') && rng() < (n.ai.p === 'warlord' ? .03 : .15)) return tryExec(W, u, { c: 'dip', kind: 'unally', v });
      } }
    // a flag of its own, laws that fit its personality, and answers to direct trade offers
    if (!n.flag) { const h = [...u].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7), P_ = WP.FLAG_COLORS, L = WP.FLAG_LAYOUTS, E = WP.FLAG_EMBLEMS;
      return tryExec(W, u, { c: 'flag', flag: { l: L[h % L.length], c: [P_[h % 9], P_[(h >> 4) % P_.length], P_[(h >> 8) % P_.length]], e: E[(h >> 12) % E.length] }, motto: ({ warlord: 'Strength above all', expansionist: 'Ever onward', merchant: 'Prosperity through trade', isolationist: 'Our land, our way' })[n.ai.p] || '' }); }
    if ((n.offIn || []).length && rng() < .4) { const o = n.offIn[0], pr = core.prices(W), val = b => Object.entries(b || {}).reduce((t, [k, v]) => t + (k === 'cash' ? v : v * (pr[k] || 0)), 0);
      const fair = val(o.give) >= val(o.want) * 1.05, can = Object.entries(o.want).every(([k, v]) => (k === 'cash' ? n.cash - 3e5 : (n.res[k] || 0) - 200) >= v);
      return tryExec(W, u, { c: fair && can ? 'offerok' : 'offerno', id: o.id }); }
    { const want = { warlord: ['conscription', 'martialLaw'], expansionist: ['conscription', 'freeMarket'], merchant: ['freeMarket', 'education'], isolationist: ['censorship', 'healthcare'] }[n.ai.p] || [];
      const next = want.find(k => !(n.laws || []).includes(k)); if (next && !core.left(W, n, 'law') && (n.laws || []).length < core.lawSlots(n) && n.cash > core.lawCost(n) * 3 && rng() < .05) return tryExec(W, u, { c: 'law', k: next, on: true }); }
    if (core.rankOf(n.xp) >= 2 && n.ai.p !== 'warlord') { const pr = n.proj;
      if (pr && pr.next <= W.now && n.cash > WP.WONDERS[pr.k].cost.cash * 2 && rng() < .3) { const r = tryExec(W, u, { c: 'wonder', k: pr.k }); if (r) return r; }
      else if (!pr && rng() < .004) { const free = Object.keys(WP.WONDERS).filter(k => !core.wonderHolder(W, k) && n.cash > WP.WONDERS[k].cost.cash * 4); if (free.length) { const r = tryExec(W, u, { c: 'wonder', k: pick(free) }); if (r) return r; } } }
    // 2) basic income
    if (!core.left(W, n, 'daily')) return tryExec(W, u, { c: 'act', k: 'daily' });
    for (const k of ['tax', 'prod']) if (!core.left(W, n, k) && (n.cash < 5e5 || rng() < .45)) return tryExec(W, u, { c: 'act', k });
    // 3) keep supplies healthy via the market
    const cons = core.consumption(n), prod = core.production(W, u);
    for (const r of ['food', 'oil', 'steel', 'goods']) { const need = (cons[r] - prod[r]) * 6 + 60; if (n.res[r] < need && n.cash > 4e5) { const q = Math.round(Math.max(60, need - n.res[r] + 60)); if (tryExec(W, u, { c: 'market', r, q, buy: true })) return; } }
    if (per.sell || rng() < .3) for (const r of ['food', 'oil', 'steel', 'goods']) if (n.res[r] > 900) { if (tryExec(W, u, { c: 'market', r, q: Math.round(n.res[r] * .4), buy: false })) return; }
    // 4) diplomacy
    const others = core.others(W, u);
    const shunned = v => { const t = W.A[v]; return !!t && (core.rogue(W, t) || core.sanctioned(t) || (t.condemned || 0) > W.now); };
    for (const v of others) {
      if (shunned(v)) continue; // no new deals with nations the world has punished
      if (core.offered(W, v, u, 'trade') && rng() < per.trade * .5) return tryExec(W, u, { c: 'dip', kind: 'trade', v });
      if (core.offered(W, v, u, 'ally') && rng() < per.ally * .4) return tryExec(W, u, { c: 'dip', kind: 'ally', v });
    }
    const myWars = core.wars(W, u);
    if (rng() < .02 * per.trade && core.traders(W, u).length < 3) { const cand = others.filter(v => !shunned(v) && !core.atWar(W, u, v) && !core.pact(W, u, v, 'trade') && !core.pact(W, u, v, 'ally') && !core.offered(W, u, v, 'trade')); if (cand.length) return tryExec(W, u, { c: 'dip', kind: 'trade', v: pick(cand) }); }
    // 5) war: only against bordering nations of similar strength, within all the usual protections
    if (cfg.war && cfg.botWar !== 'no') {
      const front = []; for (const h of core.hexesOf(W, u)) for (const k of core.nbrs(h)) { const v = core.owner(W, k); if (v && v !== u) front.push([k, v]); }
      if (myWars.length) {
        if (rng() < .6) for (const [h, v] of front) { if (!myWars.includes(v) || core.canAttack(W, u, h)) continue; const rt = core.route(W, u, h); let X = Math.floor(n.troops * .7); if (rt === 'sea') X = Math.min(X, n.ships * 100); if (X < 50) continue; const AIR = Math.floor(n.air * .7); if ((X + AIR * 20) * core.atkMult(n) * (rt === 'sea' ? .8 : 1) > core.defense(W, h, u) * (.9 + rng() * .25) && (rt !== 'sea' || n.ships * 25 > core.navalDefense(W, h))) return tryExec(W, u, { c: 'attack', h, x: X, air: AIR }); }
        // no border to fight on (or nothing worth hitting there): use the war planner like a player would — by sea, overseas or a long march
        if (rng() < .35) { const r = farStrike(W, u, myWars); if (r) return r; }
        // hit back at whoever attacked us in the last day: missiles if we have the tech, otherwise the air force
        const attackers = myWars.filter(v => core.rogue(W, W.A[v]) || (W.A[v].out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR));
        if (attackers.length && rng() < .3) { const v = pick(attackers);
          if (!core.canStrike(W, u, v)) {
            if ((n.tech || 0) >= core.MISSILE.tech && n.cash > core.MISSILE.cash * 4) { const r = tryExec(W, u, { c: 'strike', v, kind: 'missile', target: rng() < .5 ? 'mil' : 'infra', n: Math.min(3, Math.floor(n.cash / core.MISSILE.cash / 2)) }); if (r) return r; }
            if ((n.air || 0) >= 10) { const r = tryExec(W, u, { c: 'strike', v, kind: 'air', target: 'mil', n: Math.floor(n.air * .6) }); if (r) return r; } } }
      }
      // the world turns on rogue states: AI nations declare war on them from anywhere they can reach
      if (core.rankOf(n.xp) >= 2 && rng() < ({ warlord: .015, expansionist: .008, merchant: .002, isolationist: .001 }[n.ai.p] || .002)) {
        const mine = core.score(W, u);
        const rogues = others.filter(v => { const t = W.A[v]; if (!core.rogue(W, t) || core.atWar(W, u, v) || core.pact(W, u, v, 'ally')) return false;
          const s = core.score(W, v); if (s < mine * .35 || s > mine * 2) return false; if (!isBot(v) && W.now - t.created < cfg.protectH * HOUR) return false;
          if (!isBot(v) && cfg.botWar === 'retaliate' && !(t.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR)) return false;
          return core.hexesOf(W, v).some(h => core.attackPlan(W, u, h)); });
        if (rogues.length) return tryExec(W, u, { c: 'dip', kind: 'war', v: pick(rogues) });
      }
      if (myWars.length) { /* already fighting */ } else if (core.rankOf(n.xp) >= 2 && rng() < per.war) {
        const mine = core.score(W, u);
        const border = new Set(front.map(f => f[1]));
        // anyone we border, plus real players we can reach by sea, overseas or a long march (AI nations hunt players more than each other)
        const pool = [...new Set([...border, ...others.filter(v => !isBot(v) && W.A[v] && core.hexesOf(W, v).some(h => core.attackPlan(W, u, h)))])];
        const targets = pool.filter(v => {
          const t = W.A[v]; if (core.pact(W, u, v, 'ally')) return false;
          if (isBot(v)) { const s = core.score(W, v); if (s < mine * .4 || s > mine * 1.4) return false; }
          else { const pw = core.power(W, v), my = core.power(W, u); if (pw > my * 1.3 || pw < my * .25) return false; } // a player whose army we can match
          if (!isBot(v) && core.wars(W, v).filter(isBot).length >= 2) return false; // no pile-ons: a player already fighting two AI nations is left alone
          if (!isBot(v)) { if (cfg.botWar === 'retaliate') { const hit = (t.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR) || (core.R(W, v, u).war || 0) > W.now - 24 * HOUR; if (!hit) return false; } if (W.now - t.created < cfg.protectH * HOUR) return false; }
          return true;
        });
        if (targets.length) { const weighted = targets.flatMap(v => isBot(v) ? [v] : [v, v, v]); return tryExec(W, u, { c: 'dip', kind: 'war', v: pick(weighted) }); }
      }
    }
    // warlords sometimes bomb their enemies' armies from the air
    if (myWars.length && (n.air || 0) >= 10 && rng() < ({ warlord: .18, expansionist: .1, merchant: .05, isolationist: .03 }[n.ai.p] || .05)) { const v = pick(myWars); if (!core.canStrike(W, u, v)) { const r = tryExec(W, u, { c: 'strike', v, kind: 'air', target: 'mil', n: Math.floor(n.air * .6) }); if (r) return r; } }
    // covert operations against enemies (warlords and isolationists mostly)
    if (myWars.length && n.spies >= 2 && !core.left(W, n, 'covert') && rng() < (n.ai.p === 'warlord' ? .25 : .08)) { const v = pick(myWars); const op = W.A[v].tech > n.tech && n.spies >= 3 ? 'steal' : pick(['sabotage', 'unrest']); const r = tryExec(W, u, { c: 'covert', op, v }); if (r) return r; }
    // 6) development according to personality
    if (n.approval < 45 && !core.left(W, n, 'rally')) return tryExec(W, u, { c: 'act', k: 'rally' });
    for (const k of per.build) if (!core.left(W, n, k) && n.cash > 2.5e5) { const r = tryExec(W, u, { c: 'act', k }); if (r) return r; }
    for (const k of ['research', 'infra', 'recruit', 'drill', 'fort', 'expand', 'air', 'navy']) if (!core.left(W, n, k) && n.cash > 6e5 && rng() < .4) { const r = tryExec(W, u, { c: 'act', k }); if (r) return r; }
    if (n.tax !== 22) tryExec(W, u, { c: 'tax', t: 22 });
  }

  return { spawn, turn, isBot, PERS };
};
