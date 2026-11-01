// World Powers — game rules. The SERVER runs every change; browsers only use this file to display numbers.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.WPCore = factory(); })(this, function () {
'use strict';
const MIN = 60e3, HOUR = 36e5, TICK = 10 * MIN, TICKS_PER_YEAR = 144; // one game year = one real day
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const RES = { food: { n: 'Food', p: 50 }, oil: { n: 'Oil', p: 120 }, steel: { n: 'Steel', p: 100 }, goods: { n: 'Goods', p: 200 } };
const TYPE = {
  F: { n: 'Farmland', p: { food: 30 } }, O: { n: 'Oil fields', p: { oil: 15, food: 5 } }, M: { n: 'Mining region', p: { steel: 15, food: 5 } },
  I: { n: 'Industrial region', p: { goods: 12, food: 5 } }, P: { n: 'Plains', p: { food: 15 }, cash: 1 }, D: { n: 'Desert', p: { food: 4 }, cash: 1 }
};
const CAPP = { food: 25, goods: 10, oil: 5, steel: 5 };
const RANKS = [[0, 'Chieftain'], [100, 'Elder'], [300, 'Mayor'], [700, 'Governor'], [1500, 'Senator'], [3000, 'Prime Minister'], [6000, 'President'], [12000, 'Sovereign'], [25000, 'Emperor'], [50000, 'Supreme Leader'], [100000, 'World Power']];
const GOV = {
  dem: { n: 'Democracy', ap: 6, st: 0, inc: 1.05, mil: 1, res: 1.15, d: '+5% tax revenue and faster research. Approval bonus. Elections every 3 days. Wars cost twice the approval.' },
  mon: { n: 'Monarchy', ap: 0, st: 12, inc: 1, mil: 1.05, res: 1, d: 'Highly stable. Small military bonus. No elections.' },
  dic: { n: 'Dictatorship', ap: -8, st: 6, inc: .95, mil: 1.15, res: .9, d: '+15% military strength; war barely dents approval. Lower approval and income. No elections.' },
  com: { n: 'Communist State', ap: -3, st: 6, inc: 1, mil: 1.05, res: 1, cheap: .75, d: 'Recruiting and construction cost 25% less. Lower approval. No elections.' }
};
const COLORS = ['#c8553d', '#3f88c5', '#44af69', '#d4a64a', '#8e6fd8', '#e07a9c', '#2ab7a9', '#e88d3f', '#6c8ead', '#b5c44a', '#a23b72', '#5b6ee1', '#d65f5f', '#4f9d8f', '#c69c6d', '#7fb3d5'];
const ACTS = [
  { k: 'tax', s: 'Taxes', n: 'Collect Taxes', i: 'coins', cd: 3, xp: 5 },
  { k: 'prod', s: 'Production', n: 'Boost Production', i: 'factory', cd: 5, xp: 6 },
  { k: 'recruit', s: 'Army', n: 'Recruit Troops', i: 'recruit', cd: 4, xp: 5 },
  { k: 'navy', s: 'Navy', n: 'Build Warships', i: 'ship', cd: 8, xp: 8 },
  { k: 'air', s: 'Air Force', n: 'Build Aircraft', i: 'plane', cd: 8, xp: 8 },
  { k: 'expand', s: 'Expand', n: 'Expand Borders', i: 'expand', cd: 10, xp: 20 },
  { k: 'research', s: 'Research', n: 'Fund Research', i: 'flask', cd: 15, xp: 15 },
  { k: 'drill', s: 'Exercises', n: 'Military Exercises', i: 'target', cd: 8, xp: 8 },
  { k: 'infra', s: 'Infrastructure', n: 'Build Infrastructure', i: 'build', cd: 20, xp: 15 },
  { k: 'fort', s: 'Fortify', n: 'Fortify Borders', i: 'fort', cd: 30, xp: 15 },
  { k: 'spies', s: 'Spies', n: 'Train Agents', i: 'eye', cd: 15, xp: 8 },
  { k: 'rally', s: 'Address', n: 'Address the Nation', i: 'mega', cd: 15, xp: 5 },
  { k: 'campaign', s: 'Campaign', n: 'Election Campaign', i: 'vote', cd: 30, xp: 5, dem: true },
  { k: 'daily', s: 'Aid', n: 'International Aid', i: 'gift', cd: 1440, xp: 50 }
];
const DEFCFG = { cd: 1, income: 1, xp: 1, protectH: 48, war: true, signups: true, motd: '', bots: 12, botWar: 'yes', botRetire: true, electionH: 72, eventsOn: true, conquest: true, lastStandH: 24, weakRule: false, nukeTest: false };
// Chain events: a crisis that unfolds over several decisions. An option's third element names the next step.
const CHAINS = {
  strike1: { t: 'General strike', d: 'The national federation of unions has called a general strike over wages and rising prices. Ports and factories are shutting down.', o: [['Open wage negotiations', { tr: -1, ap: 3 }, 'strike2a'], ['Declare the strike illegal', { st: -4, ap: -6 }, 'strike2b'], ['Wait it out', { gdp: -1, ap: -2 }, 'strike2c']] },
  strike2a: { t: 'Union raises its demands', d: 'Talks are going well, but union leaders now also want a pension guarantee before anyone returns to work.', o: [['Agree to the pension guarantee', { tr: -2, ap: 5, st: 3 }], ['Hold firm on wages only', { ap: -2 }, 'strike3'], ['Ask an independent mediator', { tr: -.5, st: 2, ap: 2 }]] },
  strike2b: { t: 'Clashes at the ports', d: 'Police and strikers clashed overnight at the main port. Footage of the violence is everywhere.', o: [['Deploy the army to restore order', { st: 3, ap: -8, troops: -40 }], ['Withdraw police and reopen talks', { ap: 2, st: -3 }, 'strike2a'], ['Arrest the strike leaders', { st: -6, ap: -5, aggr: 3 }, 'strike3']] },
  strike2c: { t: 'The strike drags on', d: 'Three weeks in, shelves are emptying and exporters are losing contracts abroad.', o: [['Make a generous offer', { tr: -2.5, ap: 4, st: 4 }], ['Bring in replacement workers', { gdp: 1, ap: -6, st: -4 }, 'strike3'], ['Keep waiting', { gdp: -2, food: -150, ap: -3 }]] },
  strike3: { t: 'Nationwide shutdown', d: 'Other sectors have joined in solidarity. The country has nearly ground to a halt.', o: [['Concede to every demand', { tr: -3, ap: 6, st: 5, infl: 1 }], ['Call early elections', { ap: 3, st: -5 }], ['Impose a state of emergency', { st: -8, ap: -10, aggr: 5 }]] },
  scandal1: { t: 'Corruption allegations', d: 'Investigative journalists allege that your finance minister accepted bribes from a construction company.', o: [['Dismiss the minister immediately', { st: -2, ap: 2 }], ['Defend the minister publicly', { ap: -4 }, 'scandal2a'], ['Order an independent inquiry', { tr: -.5 }, 'scandal2b']] },
  scandal2a: { t: 'More evidence emerges', d: 'Leaked bank records appear to show payments to the minister — and to two of your other officials.', o: [['Fire all three', { st: -4, ap: 3 }], ['Call the leaks a smear campaign', { ap: -7, st: -3 }, 'scandal3'], ['Resign the finance portfolio yourself', { ap: 1, st: -2 }]] },
  scandal2b: { t: 'Inquiry report', d: 'The inquiry finds the minister guilty, but clears the rest of the government. Opposition parties say it was a whitewash.', o: [['Publish the full report', { ap: 4, st: 2 }], ['Publish a summary only', { ap: -2 }], ['Pass anti-corruption laws', { tr: -1, ap: 5, gdp: .5 }]] },
  scandal3: { t: 'Mass protests', d: 'Tens of thousands march against corruption in the capital, demanding your resignation.', o: [['Reshuffle the whole cabinet', { st: -3, ap: 4 }], ['Disperse the protests', { st: -6, ap: -8, aggr: 4 }], ['Promise a referendum on reform', { ap: 6, st: -2 }]] },
  chip1: { t: 'Microchip breakthrough', d: 'A domestic startup has designed a chip far ahead of anything else on the market. It needs money to scale up.', o: [['Fund a national chip program', { tr: -2 }, 'chip2a'], ['Let private investors handle it', { gdp: .5 }, 'chip2b'], ['Sell the design abroad', { tr: 3, tech: -1 }]] },
  chip2a: { t: 'The first factory', d: 'The state-backed factory is ready, but it needs rare materials and skilled engineers.', o: [['Import engineers and materials', { tr: -1.5, steel: -60 }, 'chip3'], ['Train local engineers instead', { edu: 4, tr: -1 }, 'chip3'], ['Scale back the program', { tr: 1, ap: -2 }]] },
  chip2b: { t: 'Foreign takeover bid', d: 'A foreign conglomerate offers to buy the startup outright, with a huge payout to its founders.', o: [['Allow the sale', { tr: 1.5, gdp: -.5 }], ['Block it on security grounds', { st: 2, aggr: 2 }, 'chip3'], ['Take a government stake', { tr: -1 }, 'chip3']] },
  chip3: { t: 'Chips go global', d: 'The chips are a hit. Orders pour in from around the world.', o: [['Invest profits in research', { tech: 1, edu: 3 }], ['Cut taxes with the windfall', { ap: 5, tr: 1 }], ['Build export capacity', { gdp: 2, goods: 120, unemp: -1 }]] },
  drought1: { t: 'Severe drought', d: 'The rainy season has failed. Farmers warn of a poor harvest and reservoirs are falling fast.', o: [['Buy emergency food imports', { tr: -1.5, food: 250 }, 'drought2a'], ['Ration water nationwide', { ap: -4, food: 80 }, 'drought2b'], ['Do nothing and hope for rain', { food: -150 }, 'drought2c']] },
  drought2a: { t: 'Import prices soar', d: 'Other nations are buying too. Grain prices on world markets have doubled.', o: [['Keep buying', { tr: -2, food: 200, ap: 2 }], ['Build desalination plants', { tr: -2.5, infra: 1, health: 2 }], ['Subsidise drought-resistant crops', { tr: -1, gdp: .5 }]] },
  drought2b: { t: 'Farmers protest', d: 'Farmers block highways with tractors, saying rationing is ruining them.', o: [['Compensate farmers', { tr: -1.5, ap: 4 }], ['Exempt agriculture from rationing', { food: 120, ap: -2, health: -2 }], ['Clear the roads', { st: -4, ap: -5 }]] },
  drought2c: { t: 'Famine warnings', d: 'Aid agencies warn of famine in rural regions. Food prices are climbing quickly.', o: [['Emergency aid program', { tr: -3, food: 300, ap: 3 }], ['Ask the world for help', { food: 200, st: -2 }], ['Blame the previous government', { ap: -6, st: -4, pop: -1 }]] },
  refugee1: { t: 'Refugees at the border', d: 'A civil war abroad has sent tens of thousands of refugees to your border, asking for shelter.', o: [['Open the border', { pop: 2, ap: -3, tr: -1 }, 'refugee2a'], ['Build camps at the border', { tr: -1.5, st: 1 }, 'refugee2b'], ['Close the border', { ap: 2, aggr: 3 }]] },
  refugee2a: { t: 'Integration challenges', d: 'Newcomers need housing, jobs and language classes. Some towns are struggling.', o: [['Fund an integration program', { tr: -1.5, unemp: -1, ap: 3 }], ['Fast-track work permits', { gdp: 1, unemp: 1, ap: -2 }], ['Leave it to local towns', { st: -3, ap: -2 }]] },
  refugee2b: { t: 'Camp conditions', d: 'Reports describe overcrowding and disease in the border camps. Aid groups are calling for action.', o: [['Improve the camps', { tr: -1.5, health: 2, ap: 2 }], ['Resettle refugees across the country', { pop: 1.5, ap: -3 }, 'refugee2a'], ['Restrict press access', { st: -2, ap: -5 }]] }
};
const CHAIN_STARTS = ['strike1', 'scandal1', 'chip1', 'drought1', 'refugee1'];
// Generals: earned in victory, lost in defeat
const GEN_FIRST = ['Alexei', 'Maren', 'Tomas', 'Ilse', 'Rafael', 'Noor', 'Kenji', 'Elena', 'Viktor', 'Amara', 'Dario', 'Sven', 'Lucia', 'Omar', 'Hana', 'Felix', 'Ines', 'Bram', 'Yara', 'Casimir', 'Petra', 'Malik', 'Astrid', 'Jonah'];
const GEN_LAST = ['Varga', 'Holm', 'Okafor', 'Brandt', 'Castell', 'Rourke', 'Sato', 'Lindqvist', 'Marek', 'Duarte', 'Haddad', 'Novak', 'Ferreira', 'Kowal', 'Abara', 'Strand', 'Morel', 'Tanaka', 'Ilic', 'Rayne', 'Vasquez', 'Achterberg'];
const GEN_TYPES = { attack: { n: 'Field marshal', d: '+4% attack strength per star' }, defense: { n: 'Defense commander', d: '+4% defense in every province per star' }, logistics: { n: 'Quartermaster general', d: 'Distant attacks: 10% smaller penalty and cost per star' } };
const NUKE = { tech: 12, rank: 4, cash: 25e6, steel: 1500, oil: 1500, goods: 500, upkeep: 1e5 };
// a launchable warhead: only for nations that already hold a deterrent, and very expensive
const WARHEAD = { tech: 15, rank: 6, cash: 75e6, steel: 3000, oil: 3000, goods: 2000, buildH: 12, holdH: 24, cdD: 7, km: 1600, nukedH: 48, falloutH: 24, winterH: 24 };
const EFFKEYS = ['tr', 'ap', 'st', 'pop', 'troops', 'tech', 'food', 'oil', 'steel', 'goods', 'infra', 'fort', 'train', 'aggr', 'gdp', 'unemp', 'infl', 'health', 'edu', 'debt', 'ships', 'air', 'spies', 'morale'];
const DEFBUDGET = { spend: 15, mil: 30, health: 25, edu: 25, infra: 20 };
const COVERT = {
  steal: { n: 'Steal technology', spies: 3, cost: 150000, d: 'Copy research from a more advanced nation (+1 tech level).' },
  sabotage: { n: 'Sabotage industry', spies: 2, cost: 100000, d: 'Destroy part of their stockpiles and damage infrastructure.' },
  unrest: { n: 'Incite unrest', spies: 2, cost: 100000, d: 'Fund protests: their stability −10 and approval −5.' },
  rig: { n: 'Interfere in election', spies: 3, cost: 200000, d: 'Swing their next election against the government (democracies only). Target yourself to swing your own election in your favour.' }
};
const RESOLUTIONS = {
  sanction: { n: 'Impose sanctions', target: true, d: 'The target nation is declared a rogue state for at least 24 hours: full trade embargo, trade agreements cancelled, allies walk away, and the world may attack it freely.' },
  embargo: { n: 'Trade embargo', target: true, d: 'For 24 hours the target cannot trade on the world market and its trade agreements are suspended.' },
  condemn: { n: 'Formal condemnation', target: true, d: 'A public rebuke: the target loses 8 approval and 5 stability.' },
  climate: { n: 'Climate accord', d: 'For 24 hours oil output falls 15% worldwide, and every nation gains 3 approval.' },
  arms: { n: 'Arms reduction treaty', d: 'For 24 hours military upkeep is 20% cheaper, but invasions cost 50% more.' },
  freetrade: { n: 'Free trade pact', d: 'For 24 hours market spreads shrink: imports are cheaper and exports pay more for everyone.' },
  peacekeeping: { n: 'Peacekeeping mandate', d: 'For 24 hours armies need 30 minutes to mobilize after a declaration of war, and every invasion adds 40 aggression.' }
};
const EVENTS = {
  recession: { n: 'Global Recession', d: 'Financial markets have crashed worldwide. Economies everywhere are contracting.', h: 8, mod: { gdp: .9, tax: .85, unemp: 3 },
    card: { t: 'Respond to the global recession', d: 'Factories are closing and unemployment is rising across the world. How will your government respond?', o: [['Large stimulus package', { tr: -3, unemp: -3, debt: 3 }], ['Cut taxes temporarily', { tr: -1.5, ap: 4, unemp: -1 }], ['Austerity — balance the budget', { tr: 2, unemp: 2, ap: -5 }]] } },
  pandemic: { n: 'Global Pandemic', d: 'A new virus is spreading across every continent. Nations with strong health systems will fare best.', h: 8, mod: { pandemic: 1, gdp: .95 },
    card: { t: 'The pandemic reaches your borders', d: 'Cases are rising quickly. Hospitals are preparing for a surge.', o: [['Strict lockdown', { pop: -.5, gdp: -4, ap: -3, health: 5 }], ['Emergency health funding', { tr: -2.5, health: 12, ap: 3 }], ['Keep everything open', { pop: -3, ap: -6 }]] } },
  oil: { n: 'Oil Crisis', d: 'A supply shock has sent oil prices soaring. Oil producers profit; importers suffer.', h: 8, mod: { price: { oil: 2.2 }, infl: 3 },
    card: { t: 'Oil prices are soaring', d: 'Fuel is suddenly very expensive. Transport and industry are under pressure.', o: [['Release strategic reserves', { oil: -80, ap: 4 }], ['Subsidize fuel', { tr: -2, ap: 3, infl: 1 }], ['Ration fuel', { ap: -4, oil: 60 }]] } },
  boom: { n: 'Commodity Boom', d: 'Global demand for steel and manufactured goods is surging.', h: 8, mod: { price: { steel: 1.8, goods: 1.4 }, gdp: 1.05 },
    card: { t: 'A commodity boom', d: 'Prices for steel and goods are surging worldwide.', o: [['Expand mining and factories', { tr: -1.5, steel: 80, goods: 40 }], ['Tax windfall profits', { tr: 2.5 }], ['Let the market run', { gdp: 2 }]] } },
  tech: { n: 'Technology Revolution', d: 'A breakthrough in computing is transforming economies. Research is cheaper for everyone.', h: 8, mod: { research: .6, gdp: 1.03 },
    card: { t: 'The technology revolution', d: 'New technology could transform your economy — if you invest.', o: [['National digital program', { tr: -2.5, tech: 1, edu: 4 }], ['Retrain affected workers', { tr: -1.5, unemp: -2 }], ['Wait and see', {}]] } },
  harvest: { n: 'Global Crop Failure', d: 'Droughts and blight have hit harvests worldwide. Food prices have doubled.', h: 8, mod: { price: { food: 2 }, food: .7, infl: 2 },
    card: { t: 'Food shortages', d: 'Global harvests have failed and food prices have doubled.', o: [['Import food at any cost', { tr: -2, food: 120 }], ['Ration food', { ap: -5, food: 40 }], ['Price controls', { ap: 3, infl: -1, food: -40 }]] } },
  finance: { n: 'Financial Crisis', d: 'Banks are failing and borrowing costs have spiked worldwide.', h: 8, mod: { rate: 4, infl: 2, gdp: .95 },
    card: { t: 'Banks are failing', d: 'Credit has frozen. Your largest banks need help.', o: [['Bail out the banks', { tr: -2.5, debt: 2, st: 3 }], ['Nationalize failing banks', { tr: -1, st: -2, gdp: -1 }], ['Let them fail', { unemp: 3, ap: -4 }]] } },
  peace: { n: 'Era of Peace', d: 'A wave of diplomacy is sweeping the world. Aggression fades faster and trade flourishes.', h: 8, mod: { aggr: 3, gdp: 1.03 },
    card: { t: 'A peace movement sweeps the world', d: 'Citizens everywhere are demanding disarmament and cooperation.', o: [['Cut the military budget', { troops: -100, tr: 2, ap: 4 }], ['Host a peace conference', { tr: -1, aggr: -20, ap: 2 }], ['Stay prepared', { st: 2 }]] } }
};

function UserError(msg) { const e = new Error(msg); e.user = true; return e; }
const fail = msg => { throw UserError(msg); };
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const num = v => Math.round(v).toLocaleString('en-US');
const money = v => (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
const moneyS = v => { const a = Math.abs(v), s = v < 0 ? '−$' : '$'; return a >= 1e12 ? s + (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? s + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? s + (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? s + (a / 1e3).toFixed(0) + 'K' : s + Math.round(a); };

function Core(PD, CARDS) {
  const P = PD.p, CN = PD.countries;
  CARDS = CARDS || [];
  const land = h => (P[h] ? P[h].j : []);
  const sea = h => (P[h] && P[h].s) || [];
  const nbrs = h => land(h).concat(sea(h));
  const pname = h => { const p = P[h]; if (!p) return 'Unknown'; return p.n === CN[p.ci] ? p.n : `${p.n}, ${CN[p.ci]}`; };
  const getCard = i => (typeof i === 'string' && i.startsWith('ev:')) ? (EVENTS[i.slice(3)] || {}).card : (typeof i === 'string' && i.startsWith('ch:')) ? CHAINS[i.slice(3)] : CARDS[i];

  function computeOwn(A) {
    const best = {};
    for (const [u, n] of Object.entries(A)) for (const [h, ts] of Object.entries(n.hexes || {})) { if (!P[h]) continue; if (!best[h] || ts > best[h].ts) best[h] = { u, ts }; }
    const caps = Object.entries(A).sort((a, b) => a[1].created - b[1].created);
    for (const [u, n] of caps) if (P[n.cap] && !(best[n.cap] && best[n.cap].cap)) best[n.cap] = { u, ts: 0, cap: true };
    return best;
  }
  // global modifiers from the active world event and passed council resolutions
  function mods(ev, council, now) {
    const m = { gdp: 1, tax: 1, unemp: 0, infl: 0, rate: 0, price: {}, food: 1, oil: 1, research: 1, upkeep: 1, atkCost: 1, aggrDecay: 1, mobilize: 10, aggrPerAttack: 25, spread: 0, pandemic: 0, apBonus: 0 };
    if (ev && ev.key && EVENTS[ev.key] && now < ev.end) { const e = EVENTS[ev.key].mod; for (const [k, v] of Object.entries(e)) { if (k === 'price') Object.assign(m.price, v); else if (k === 'aggr') m.aggrDecay = v; else if (k === 'unemp' || k === 'infl' || k === 'rate' || k === 'pandemic') m[k] += v; else m[k] *= v; } }
    const act = (council && council.active) || {};
    const on = k => act[k] && act[k] > now;
    if (on('climate')) { m.oil *= .85; m.apBonus += 3; }
    if (on('arms')) { m.upkeep *= .8; m.atkCost *= 1.5; }
    if (on('freetrade')) m.spread = .05;
    if (on('peacekeeping')) { m.mobilize = 30; m.aggrPerAttack = 40; }
    return m;
  }
  function world(A, cfg, now, ev, council) { now = now || Date.now(); const W = { A, cfg: { ...DEFCFG, ...(cfg || {}) }, now, ev: ev || null, council: council || null, changed: new Set(), news: [], notes: [], fallen: [] }; W.m = mods(ev, council, now); W.OWN = computeOwn(A); return W; }
  const owner = (W, h) => W.OWN[h] && W.OWN[h].u;
  const hexesOf = (W, u) => Object.keys(W.OWN).filter(h => W.OWN[h].u === u).map(Number);
  const rankOf = xp => { let i = 0; for (let j = 0; j < RANKS.length; j++) if ((xp || 0) >= RANKS[j][0]) i = j; return i; };
  const rankName = n => RANKS[rankOf(n.xp)][1];
  const maxHex = n => 3 + rankOf(n.xp) * 4;
  const R = (W, a, b) => (W.A[a] && W.A[a].rel && W.A[a].rel[b]) || {};
  function atWar(W, a, b) { const x = R(W, a, b), y = R(W, b, a); const w = Math.max(x.war || 0, y.war || 0); if (!w) return false; return !((x.peace || 0) > w && (y.peace || 0) > w); }
  const warSince = (W, a, b) => Math.max(R(W, a, b).war || 0, R(W, b, a).war || 0);
  // a cancellation by either side ends the deal, and both sides must agree again afterwards
  function pact(W, a, b, k) { if (k === 'trade' && (rogue(W, W.A[a]) || rogue(W, W.A[b]))) return false; const x = R(W, a, b), y = R(W, b, a), un = Math.max(x['un' + k] || 0, y['un' + k] || 0); return (x[k] || 0) > un && (y[k] || 0) > un && !atWar(W, a, b); }
  function offered(W, a, b, k) { const x = R(W, a, b), y = R(W, b, a), un = Math.max(x['un' + k] || 0, y['un' + k] || 0); return (x[k] || 0) > un && !((y[k] || 0) > un); }
  const others = (W, u) => Object.keys(W.A).filter(v => v !== u);
  const wars = (W, u) => others(W, u).filter(v => atWar(W, u, v));
  const allies = (W, u) => others(W, u).filter(v => pact(W, u, v, 'ally'));
  const embargoed = (W, n) => (n.embargo || 0) > W.now;
  const traders = (W, u) => embargoed(W, W.A[u]) ? [] : others(W, u).filter(v => pact(W, u, v, 'trade') && !embargoed(W, W.A[v]));
  const sanctioned = n => (n.aggr || 0) >= 50;
  // rogue state ("the North Korea treatment"): 75+ aggression brings a full embargo and isolation for at least 24 hours
  const ROGUE_AT = 75;
  const rogue = (W, n) => !!n && (n.rogue || 0) > (W ? W.now : Date.now());
  const oilF = n => ((n.res && n.res.oil) || 0) > 0 ? 1 : .6;
  const cheap = n => GOV[n.gov].cheap || 1;
  const moraleF = n => .75 + (n.morale == null ? 70 : n.morale) / 400;
  // diminishing returns: the first levels count fully, later ones less and less (stops one nation running away with the world)
  const soft = (x, s) => s * Math.log(1 + Math.max(0, x || 0) / s);
  const techF = n => (1 + soft(n.tech, 10) * .05) * (1 + n.train * .02);
  const power = (W, u) => { const n = W.A[u]; return ((n.troops || 0) + (n.ships || 0) * 25 + (n.air || 0) * 20) * techF(n) * oilF(n) * GOV[n.gov].mil * moraleF(n); };
  const score = (W, u) => { const n = W.A[u]; return Math.round(hexesOf(W, u).length * 100 + (n.troops || 0) * .4 + (n.ships || 0) * 8 + (n.air || 0) * 6 + soft(n.tech, 10) * 60 + (n.xp || 0) * .1 + n.pop / 2000 + (n.gdp || 0) / 5e5); };
  const isCoastal = h => !!(P[h] && P[h].co);
  const hasCoast = (W, u) => hexesOf(W, u).some(isCoastal);

  // ---------- economy ----------
  const budget = n => ({ ...DEFBUDGET, ...(n.budget || {}) });
  const debtRatio = n => (n.debt || 0) / Math.max(1, n.gdp || 1);
  function rating(W, n) { if ((n.defaulted || 0) > W.now - 48 * HOUR) return 'D'; const r = debtRatio(n); return r < .3 ? 'AAA' : r < .6 ? 'AA' : r < .9 ? 'A' : r < 1.2 ? 'BBB' : r < 1.5 ? 'BB' : r < 2 ? 'B' : 'CCC'; }
  function interestRate(W, n) { return 3 + Math.max(0, debtRatio(n) - .4) * 12 + ((n.defaulted || 0) > W.now - 48 * HOUR ? 10 : 0) + W.m.rate; }
  // nuclear effects: ground zero (taxes stop), fallout zone, worldwide nuclear winter
  const nuked = (W, n) => !!(n && n.nuked && n.nuked.until > W.now);
  const nukeF = (W, n, zero, fall, winter) => nuked(W, n) ? zero : (n.fallout || 0) > W.now ? fall : (n.winter || 0) > W.now ? winter : 1;
  function gdpTarget(W, u) {
    const n = W.A[u], b = budget(n);
    const pc = 187.5 * (1 + soft(n.tech, 10) * .04) * (1 + soft(n.infra, 10) * .05) * (.7 + (n.edu == null ? 50 : n.edu) / 100 * .6) * (.85 + (n.health == null ? 50 : n.health) / 100 * .3)
      * (1 + Math.min(5, traders(W, u).length) * .03) * (1 - (n.unemp == null ? 6 : n.unemp) / 100) * (.8 + n.stability / 500) * (1 - Math.max(0, (n.infl || 0) - 5) / 100)
      * (sanctioned(n) ? .85 : 1) * (rogue(W, n) ? .85 : 1) * nukeF(W, n, .6, .85, .95) * Math.pow(.96, wars(W, u).length) * ((n.defaulted || 0) > W.now - 48 * HOUR ? .85 : 1) * (.92 + (n.iq == null ? 50 : n.iq) / 100 * .16) * W.m.gdp;
    return n.pop * pc;
  }
  // development aid: nations far behind the world leader earn up to +50% tax revenue, shrinking as they catch up
  function devAid(W, u) {
    if (!W._top || W._top.t !== W.now || W._top.n !== Object.keys(W.A).length) { let t = 0; for (const x of Object.keys(W.A)) t = Math.max(t, score(W, x)); W._top = { t: W.now, n: Object.keys(W.A).length, v: t }; }
    const top = W._top.v, me = score(W, u); if (!top || me >= top * .3 || rogue(W, W.A[u])) return 0;
    return Math.round(.5 * (1 - me / (top * .3)) * 100) / 100;
  }
  function taxIncome(W, u) { const n = W.A[u], g = GOV[n.gov]; const trade = 1 + Math.min(5, traders(W, u).length) * .05 * (sanctioned(n) ? 0 : 1); return (n.gdp || gdpTarget(W, u)) * n.tax / 100 / 150 * (0.5 + n.approval / 100) * g.inc * trade * (1 + rankOf(n.xp) * .1) * W.cfg.income * W.m.tax * (1 + devAid(W, u)) * (rogue(W, n) ? .8 : 1) * nukeF(W, n, 0, .5, .85); }
  const spendPerTick = n => (n.gdp || 0) * budget(n).spend / 100 / TICKS_PER_YEAR;
  const upkeep = (W, n) => ((n.troops || 0) * 8 + (n.ships || 0) * 120 + (n.air || 0) * 150 + (n.nuke ? NUKE.upkeep : 0)) * W.m.upkeep;
  function production(W, u) {
    const n = W.A[u]; const p = { food: 0, oil: 0, steel: 0, goods: 0 };
    for (const h of hexesOf(W, u)) {
      const pr = P[h];
      if (h == n.cap) { for (const k in CAPP) p[k] += CAPP[k]; } else { const t = TYPE[pr.t] || TYPE.P; for (const k in t.p) p[k] += t.p[k]; }
      if (pr.r) p.food += 5; if (pr.m) p.steel += 4; if (pr.co) p.goods += 3;
    }
    const m = (1 + rankOf(n.xp) * .1) * (1 + soft(n.infra, 10) * .05) * W.cfg.income;
    for (const k in p) p[k] = Math.round(p[k] * m * (k === 'food' ? W.m.food : k === 'oil' ? W.m.oil : 1));
    return p;
  }
  const consumption = n => ({ food: Math.round(n.pop / 1000 * .25), oil: Math.round((n.troops || 0) / 100 * .5 + (n.ships || 0) * .5 + (n.air || 0) * .4 + n.infra * .5), steel: 0, goods: Math.round(n.pop / 1000 * .05) });
  const popCap = (W, u) => hexesOf(W, u).length * 150000 * (1 + soft(W.A[u].infra, 10) * .05);
  function prices(W) { const p = {}, since = W.now - 6 * HOUR, net = { food: 0, oil: 0, steel: 0, goods: 0 }; for (const n of Object.values(W.A)) for (const t of n.trades || []) if (t.t > since && net[t.r] != null) net[t.r] += t.q; for (const k in RES) p[k] = Math.round(RES[k].p * clamp(Math.exp(net[k] / 4000), .4, 3) * (W.m.price[k] || 1)); return p; }
  function spreads(W, u) { const n = W.A[u]; const sp = sanctioned(n) ? .3 : 0, tb = Math.min(5, traders(W, u).length) * .03 * (sanctioned(n) ? 0 : 1); const inf = Math.max(0, (n.infl || 0) - 3) / 200; return { buy: 1.08 + sp - tb - W.m.spread + inf, sell: .92 - sp + tb + W.m.spread }; }
  const maxBorrow = n => Math.max(0, (n.gdp || 0) * 1.2 - (n.debt || 0));

  // ---------- costs ----------
  const troopCap = n => Math.floor((n.pop || 0) * .04);
  const recruitBatch = n => Math.max(20, Math.round(40 + soft(n.pop * .0012, 600))); // bigger nations recruit more, with diminishing returns
  const navyBatch = n => 2 + Math.floor(rankOf(n.xp) / 2);
  const airBatch = n => 3 + Math.floor(rankOf(n.xp) / 2);
  const spyCap = n => 5 + rankOf(n.xp) * 3;
  const expandCost = (W, u) => Math.round(8e4 * Math.pow(Math.max(1, hexesOf(W, u).length), 1.35));
  const topTech = W => { let t = 0; for (const x of Object.values(W.A)) t = Math.max(t, x.tech || 0); return t; };
  const catchUp = (W, n) => { if (rogue(W, n)) return 1.5; const top = topTech(W); return n.tech < top ? .5 + .5 * (n.tech + 1) / (top + 1) : 1; }; // rogue states face a technology blockade // known technology is cheaper to copy
  const researchCost = (W, n) => Math.round(5e4 * Math.pow(n.tech + 1, 1.6) * (GOV[n.gov].res > 1 ? .85 : 1) * W.m.research * catchUp(W, n));
  const maxTrain = n => 10 + rankOf(n.xp) * 5;
  const infraCost = n => Math.round(6e4 * Math.pow(n.infra + 1, 1.5) * cheap(n));
  const fortCost = n => Math.round(1e5 * Math.pow(n.fort + 1, 1.5) * cheap(n));
  const rallyCost = n => Math.round(2e4 + n.pop * .05);
  const campaignCost = n => Math.round(5e4 + n.pop * .1);
  const streakMult = c => c % 7 === 0 ? 2.5 : 1 + .15 * (Math.min(c, 6) - 1); // grows to ×1.75, with a ×2.5 bonus every 7th day
  const dailyGrant = n => 2e5 * (1 + rankOf(n.xp) * .5);
  const left = (W, n, k) => Math.max(0, ((n.cd && n.cd[k]) || 0) - W.now);

  // ---------- territory ----------
  function expandTargets(W, u) { const n = W.A[u], ships = (n && n.ships) || 0; const t = new Set(); for (const h of hexesOf(W, u)) { for (const k of land(h)) if (!W.OWN[k]) t.add(k); if (ships > 0 && isCoastal(h)) for (const k of sea(h)) if (!W.OWN[k]) t.add(k); } return [...t]; }
  function startOk(W, h) { if (!P[h] || W.OWN[h]) return false; const seen = new Set([h]); let fr = [h]; for (let d = 0; d < 2; d++) { const nx = []; for (const x of fr) for (const k of nbrs(x)) if (!seen.has(k)) { seen.add(k); nx.push(k); } fr = nx; } for (const k of seen) if (W.OWN[k]) return false; return true; }
  function hexAge(W, h) { const o = W.OWN[h]; if (!o) return 0; const ts = o.cap ? W.A[o.u].created : o.ts; return (W.now - ts) / (24 * HOUR); }
  // ---------- reach: any enemy province can be attacked; distance makes it weaker and costlier ----------
  // landmasses: provinces joined by land borders. Same landmass = the army can march there; another one = it must go by ship.
  const COMP = (() => { const c = new Array(P.length).fill(-1); let id = 0; for (let i = 0; i < P.length; i++) { if (c[i] >= 0) continue; const st = [i]; c[i] = id; while (st.length) { const x = st.pop(); for (const y of land(x)) if (c[y] < 0) { c[y] = id; st.push(y); } } id++; } return c; })();
  const kmBetween = (a, b) => { const r = Math.PI / 180, A = P[a].c, B = P[b].c; const s2 = Math.sin((B[1] - A[1]) * r / 2) ** 2 + Math.cos(A[1] * r) * Math.cos(B[1] * r) * Math.sin((B[0] - A[0]) * r / 2) ** 2; return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s2))); };
  function reach(W, u, h) {
    const mine = hexesOf(W, u); if (!mine.length) return null;
    if (land(h).some(k => owner(W, k) === u)) return { rt: 'land', km: 0 };
    if (sea(h).some(k => owner(W, k) === u && isCoastal(k))) return { rt: 'sea', km: 0 };
    let km = Infinity, same = false; for (const k of mine) { km = Math.min(km, kmBetween(k, h)); if (COMP[k] === COMP[h]) same = true; }
    return { rt: same ? 'march' : 'ocean', km: Math.round(km) };
  }
  function route(W, u, h) { const r = reach(W, u, h); return r ? r.rt : null; }
  // strength and cost by route: borders fight at full strength; distant fronts lose up to 45% and cost more to supply
  const distF = km => Math.max(.55, 1 - km / 12000);
  const logiCut = n => { const g = n && bestGen(n, 'logistics'); return g ? 1 - g.stars * .1 : 1; };
  const routeMult = (r, n) => r.rt === 'land' ? 1 : r.rt === 'sea' ? .8 : 1 - (1 - (r.rt === 'march' ? distF(r.km) : .8 * distF(r.km))) * logiCut(n);
  const routeCostX = (r, n) => r.rt === 'land' || r.rt === 'sea' ? 1 : 1 + r.km / 2500 * logiCut(n);
  const PER_SHIP = { sea: 100, ocean: 75 };
  const fmtT = ms => { const s = Math.ceil(ms / 1e3); if (s >= 3600) return Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm'; return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function canAttack(W, u, h) {
    const me = W.A[u]; if (!me) return 'Found a nation first.'; if (!W.cfg.war) return 'Warfare is currently disabled by the administrators.';
    const v = owner(W, h); if (!v || v === u) return 'Not a foreign province.'; const n = W.A[v];
    if (rankOf(me.xp) < 2) return `You must reach the rank of Mayor (300 XP) to wage war. You have ${num(me.xp)} XP.`;
    if (!atWar(W, u, v)) return `You are not at war with ${n.name}. Declare war first.`;
    const mob = W.m.mobilize * MIN; if (W.now - warSince(W, u, v) < mob) return `Forces are mobilizing — ready in ${fmtT(mob - (W.now - warSince(W, u, v)))}.`;
    const theyHitMe = (n.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR);
    // AI nations get none of the protections meant for real players
    if (!theyHitMe && !n.ai && W.now - n.created < W.cfg.protectH * HOUR && !(n.out || []).some(e => e.type === 'battle')) return `${n.name} is under new-nation protection.`;
    const fairWar = (R(W, u, v).fair || 0) === 1;
    if (W.cfg.weakRule && !theyHitMe && !fairWar && !n.ai && score(W, v) < score(W, u) * .4) return `${n.name} is far weaker than you. Attacking them is not permitted.`;
    if (W.OWN[h].cap) {
      if (!W.cfg.conquest) return 'Capitals cannot be captured.';
      if (n.nuke) return `${n.name} has a nuclear deterrent. Its capital cannot be besieged.`;
      if (Object.keys(n.hexes || {}).length > 1) return `The capital can only be besieged once ${n.name} has lost all its other provinces.`;
      // the defender always gets a warning period: from losing its last other province, or from the declaration of war (none for AI)
      const start = n.ai ? 1 : n.lastStand || warSince(W, u, v);
      const ls = start + (W.cfg.lastStandH ?? 24) * HOUR;
      if (W.now < ls) return `${n.name} is making its last stand. The capital can be besieged in ${fmtT(ls - W.now)}.`;
    }
    const r = reach(W, u, h); if (!r) return 'Found a nation first.';
    if (r.rt === 'sea' && !(me.ships > 0)) return 'This province is across the sea. Build warships to carry your troops.';
    if (r.rt === 'ocean' && !hasCoast(W, u)) return 'This province is overseas. You need a coastal province and warships to reach it.';
    if (r.rt === 'ocean' && (me.ships || 0) < 5) return `This province is overseas. You need at least 5 warships to carry an invasion (75 troops each). You have ${me.ships || 0}.`;
    if (left(W, me, 'attack')) return `Your forces are regrouping: ${fmtT(left(W, me, 'attack'))}.`;
    return null;
  }
  // everything a player needs to judge an attack, computed the same way the battle is
  function attackPlan(W, u, h, X, AIR) {
    const me = W.A[u], v = owner(W, h), d = v && W.A[v]; if (!me || !d) return null;
    const r = reach(W, u, h); if (!r) return null;
    const SEA = r.rt === 'sea' || r.rt === 'ocean', perShip = PER_SHIP[r.rt] || 0;
    const maxX = Math.max(0, SEA ? Math.min(me.troops, (me.ships || 0) * perShip) : me.troops);
    X = X == null ? Math.floor(maxX * .8) : Math.max(0, Math.min(maxX, Math.floor(X))); AIR = AIR == null ? Math.floor((me.air || 0) * .8) : Math.max(0, Math.min(me.air || 0, Math.floor(AIR)));
    const mult = routeMult(r, me), cx = routeCostX(r, me), base = atkCost(W, X);
    const cost = { cash: Math.round(base.cash * cx), oil: Math.ceil(base.oil * cx) + AIR * 2, food: Math.ceil(base.food * cx) };
    const atk = (X + AIR * 20) * atkMult(me) * mult * (rogue(W, d) ? 1.15 : 1), def = defense(W, h, u);
    // chance: average over the battle's random spread (attack ±15%, defense ±10%), times the chance of winning at sea first
    const grid = (a, b, sa, sb) => { let w = 0; for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) if (a * (1 - sa + 2 * sa * (i + .5) / 20) > b * (1 - sb + 2 * sb * (j + .5) / 20)) w++; return w / 400; };
    let chance = def > 0 ? grid(atk, def, .15, .1) : 1;
    if (SEA && d.ships > 0) chance *= grid((me.ships || 0) * 25 * techF(me), navalDefense(W, h), .15, .1);
    return { rt: r.rt, km: r.km, mult, costX: cx, X, AIR, maxX, perShip, cost, atk: Math.round(atk), def: Math.round(def), chance, regroupMin: r.rt === 'ocean' ? 60 : r.rt === 'march' ? 45 : 30 };
  }
  const terrainF = (h, rt) => (P[h].m ? 1.25 : 1) * (P[h].r && rt === 'land' ? 1.15 : 1);
  function defense(W, h, attacker) {
    const v = owner(W, h), n = W.A[v]; let t = (n.troops || 0) * .5 + (n.air || 0) * .5 * 20; for (const a of allies(W, v)) if (a !== attacker) t += (W.A[a].troops || 0) * .1;
    const rt = attacker ? route(W, attacker, h) : 'land';
    return t * techF(n) * (1 + soft(n.fort, 8) * .1) * (1 + rankOf(n.xp) * .08) * (1 + Math.min(.5, hexAge(W, h) * .05)) * oilF(n) * GOV[n.gov].mil * moraleF(n) * terrainF(h, rt) * ((n.regroup || 0) > W.now ? .75 : 1) * (W.OWN[h] && W.OWN[h].cap ? 1.5 : 1) * genF(n, 'defense');
  }
  const navalDefense = (W, h) => { const v = owner(W, h), n = W.A[v]; return (n.ships || 0) * 25 * techF(n) * 1.2; };
  const bestGen = (n, type) => (n.gens || []).filter(g => g.type === type).reduce((b, g) => !b || g.stars > b.stars ? g : b, null);
  const genF = (n, type) => { const g = bestGen(n, type); return g ? 1 + g.stars * .04 : 1; };
  const atkMult = n => techF(n) * oilF(n) * GOV[n.gov].mil * moraleF(n) * genF(n, 'attack');
  function newGeneral(W, u, rng) {
    const n = W.A[u]; n.gens = n.gens || []; if (n.gens.length >= 3) return null;
    const r = rng(), type = r < .4 ? 'attack' : r < .7 ? 'defense' : 'logistics';
    const g = { id: rid(), name: GEN_FIRST[Math.floor(rng() * GEN_FIRST.length)] + ' ' + GEN_LAST[Math.floor(rng() * GEN_LAST.length)], type, stars: 1, wins: 0, t: W.now };
    n.gens.push(g); return g;
  }
  const atkCost = (W, x) => ({ cash: Math.round(x * 25 * W.m.atkCost), oil: Math.ceil(x / 10), food: Math.ceil(x / 20) });

  // ---------- decisions: situational conditions ----------
  const COND = {
    war: (W, u) => wars(W, u).length > 0, peace: (W, u) => !wars(W, u).length,
    dem: (W, u, n) => n.gov === 'dem', dic: (W, u, n) => n.gov === 'dic', mon: (W, u, n) => n.gov === 'mon', com: (W, u, n) => n.gov === 'com', notdem: (W, u, n) => n.gov !== 'dem',
    lowAp: (W, u, n) => n.approval < 40, highAp: (W, u, n) => n.approval > 70, lowSt: (W, u, n) => n.stability < 40, highTax: (W, u, n) => n.tax > 30, lowTax: (W, u, n) => n.tax < 15,
    rich: (W, u, n) => n.cash > 5e6, poor: (W, u, n) => n.cash < 3e5 || debtRatio(n) > 1, big: (W, u) => hexesOf(W, u).length >= 6, small: (W, u) => hexesOf(W, u).length <= 3,
    army: (W, u, n) => n.troops > 1500, sanctioned: (W, u, n) => sanctioned(n), allied: (W, u) => allies(W, u).length > 0, trader: (W, u) => traders(W, u).length > 0,
    lowFood: (W, u, n) => n.res.food < 150, oilRich: (W, u, n) => n.res.oil > 600, tech: (W, u, n) => n.tech >= 5, rank3: (W, u, n) => rankOf(n.xp) >= 3,
    neighbors: (W, u) => hexesOf(W, u).some(h => nbrs(h).some(k => owner(W, k) && owner(W, k) !== u))
  };
  const condOk = (W, u, c) => !c || c.split(' ').every(k => COND[k] ? COND[k](W, u, W.A[u]) : true);

  // ---------- mutation helpers (server only) ----------
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function log(n, t, W) { n.log = [{ t: W ? W.now : Date.now(), x: t }, ...(n.log || [])].slice(0, 60); }
  function pushOut(W, u, e) { const n = W.A[u]; e.id = rid(); e.t = W.now; n.out = [e, ...(n.out || [])].slice(0, 80); }
  function news(W, u, t) { pushOut(W, u, { type: 'news', x: t }); log(W.A[u], t, W); W.news.push(t); }
  const note = (W, u, kind, text) => { if (W.A[u]) W.notes.push({ u, kind, text }); };
  function gainXP(W, u, x) { const n = W.A[u]; const b = rankOf(n.xp); n.xp = (n.xp || 0) + Math.round(x * W.cfg.xp); const a = rankOf(n.xp); if (a > b) { news(W, u, `${n.name} has risen to the rank of ${RANKS[a][1]}.`); W.promoted = RANKS[a][1]; note(W, u, 'rank', `You have been promoted to ${RANKS[a][1]}.`); } }
  const touch = (W, ...us) => us.forEach(u => W.changed.add(u));
  // a nation is conquered: remove it and every reference to it; the server deletes the document and tells the player
  function fallNation(W, v, info) {
    const d = W.A[v]; if (!d) return;
    delete W.A[v]; W.changed.delete(v);
    for (const [u, n] of Object.entries(W.A)) if (n.rel && n.rel[v]) { delete n.rel[v]; W.changed.add(u); }
    W.OWN = computeOwn(W.A); W.fallen.push({ id: v, t: W.now, ...info });
  }
  function setRel(n, v, k, t) { n.rel = n.rel || {}; n.rel[v] = { ...(n.rel[v] || {}), [k]: t }; }

  function normalize(n) {
    for (const k of ['cards', 'log', 'out', 'trades', 'seen', 'gdpHist']) if (!Array.isArray(n[k])) n[k] = [];
    for (const k of ['cd', 'hexes', 'rel', 'cnt']) if (!n[k] || typeof n[k] !== 'object') n[k] = {};
    for (const k of ['fort', 'train', 'infra', 'tech']) if (!Number.isFinite(n[k])) n[k] = 0;
    n.res = { food: 0, oil: 0, steel: 0, goods: 0, ...(n.res || {}) }; n.budget = budget(n);
    for (const [k, v] of [['ships', 0], ['air', 0], ['spies', 0], ['debt', 0], ['unemp', 6], ['infl', 2], ['health', 50], ['edu', 50], ['iq', 50], ['morale', 70]]) if (typeof n[k] !== 'number' || !isFinite(n[k])) n[k] = v;
    return n;
  }

  function found(W, u, o) {
    if (W.A[u]) fail('You already lead a nation.');
    if (typeof o.name !== 'string') fail('Choose a name for your nation.');
    const name = o.name.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 28 || !/^[\p{L}\p{N} .,'&()-]+$/u.test(name)) fail('Choose a name of 2–28 letters, numbers and basic punctuation.');
    if (Object.values(W.A).some(n => n.name.toLowerCase() === name.toLowerCase())) fail('That name is already in use.');
    const color = COLORS.includes(o.color) ? o.color : COLORS[0];
    const gov = has(GOV, o.gov) ? o.gov : 'dem';
    const h = Number(o.hex); if (!Number.isInteger(h) || !startOk(W, h)) fail('Select an unclaimed province at least two provinces away from any nation.');
    const now = W.now;
    const n = W.A[u] = normalize({ v: 4, name, color, gov, created: now, cap: h, hexes: {}, xp: 0, cash: 1e6, pop: 1e5, troops: 300, ships: isCoastal(h) ? 2 : 0, air: 0, spies: 0, tech: 0, train: 0, infra: 0, fort: 0, tax: 20, approval: 60, stability: 60, aggr: 0,
      res: { food: 400, oil: 150, steel: 150, goods: 80 }, cd: {}, cnt: {}, lastTick: now, nextCard: now + 5 * MIN, cards: [], seen: [], log: [], out: [], rel: {}, trades: [], exp: 0, imp: 0,
      budget: { ...DEFBUDGET }, debt: 0, unemp: 6, infl: 2, health: 50, edu: 50, iq: 50, morale: 70, nextElection: gov === 'dem' ? now + W.cfg.electionH * HOUR : 0 });
    W.OWN = computeOwn(W.A); n.gdp = gdpTarget(W, u); n.gdpHist = [{ t: now, v: n.gdp }];
    news(W, u, `A new nation has been founded: ${name}, in ${pname(h)}.`); touch(W, u);
    W.welcome = `Welcome ${name}, a new nation founded in ${pname(h)}.`;
    return { msg: 'Your nation has been founded.' };
  }

  function act(W, u, k, arg, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const a = ACTS.find(x => x.k === k); if (!a) fail('Unknown operation.');
    if (left(W, n, k)) fail(`${a.n} is available in ${fmtT(left(W, n, k))}.`);
    let msg = '';
    if (k === 'tax') { const v = taxIncome(W, u); n.cash += v; n.rev = (n.rev || 0) + v; if (n.tax > 20) n.approval = clamp(n.approval - (n.tax - 20) * .1, 0, 100); msg = `Collected ${money(v)} in taxes.`; }
    else if (k === 'prod') { const p = production(W, u); for (const r in p) n.res[r] += p[r] * 2; msg = 'Production boosted: ' + Object.entries(p).filter(e => e[1]).map(([r, v]) => `+${v * 2} ${r}`).join(', ') + '.'; }
    else if (k === 'recruit') { const b = recruitBatch(n), c = b * 150 * cheap(n), s = Math.ceil(b / 10); if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); if (n.troops + b > troopCap(n)) fail(`Your population cannot support more soldiers (limit: 4% of population, ${num(troopCap(n))}).`); n.cash -= c; n.res.steel -= s; n.troops += b; n.approval = clamp(n.approval - .3, 0, 100); msg = `${num(b)} soldiers enlisted.`; }
    else if (k === 'navy') { if (!hasCoast(W, u)) fail('You need a coastal province to build warships.'); const b = navyBatch(n), c = Math.round(b * 6e4 * cheap(n)), s = b * 30, o = b * 10; if (n.cash < c || n.res.steel < s || n.res.oil < o) fail(`Requires ${money(c)}, ${s} steel and ${o} oil.`); n.cash -= c; n.res.steel -= s; n.res.oil -= o; n.ships += b; msg = `${b} warships commissioned.`; }
    else if (k === 'air') { if (n.tech < 2) fail('Reach tech level 2 to build aircraft.'); const b = airBatch(n), c = Math.round(b * 4.5e4 * cheap(n)), g = b * 15, s = b * 10, o = b * 10; if (n.cash < c || n.res.goods < g || n.res.steel < s || n.res.oil < o) fail(`Requires ${money(c)}, ${g} goods, ${s} steel and ${o} oil.`); n.cash -= c; n.res.goods -= g; n.res.steel -= s; n.res.oil -= o; n.air += b; msg = `${b} aircraft delivered.`; }
    else if (k === 'expand') {
      if (hexesOf(W, u).length >= maxHex(n)) fail(`Reach the next rank to hold more than ${maxHex(n)} provinces.`);
      const c = expandCost(W, u); if (n.cash < c || n.res.food < 40) fail(`Requires ${money(c)} and 40 food.`);
      const ts = expandTargets(W, u); if (!ts.length) fail(n.ships ? 'No unclaimed land borders your nation.' : 'No unclaimed land borders your nation by land. Build warships to settle across the sea.');
      let h = (arg != null && ts.includes(Number(arg))) ? Number(arg) : null;
      if (arg != null && h == null) fail('That province cannot be settled.');
      if (h == null) { const pref = ts.filter(x => !['P', 'D'].includes(P[x].t)); const pool = pref.length ? pref : ts; h = pool[Math.floor(rng() * pool.length)]; }
      n.cash -= c; n.res.food -= 40; n.hexes[h] = W.now; n.lastStand = 0; W.OWN[h] = { u, ts: W.now }; msg = `Settled ${pname(h)} (${(TYPE[P[h].t] || TYPE.P).n.toLowerCase()}).`; W.selHex = h;
    }
    else if (k === 'research') { const c = researchCost(W, n), g = 10 + n.tech * 5; if (n.cash < c || n.res.goods < g) fail(`Requires ${money(c)} and ${g} goods.`); n.cash -= c; n.res.goods -= g; n.tech++; msg = `Tech level ${n.tech} reached.`; }
    else if (k === 'drill') { if (n.train >= maxTrain(n)) fail('Training is at the cap for your rank.'); const o = 10 + n.train * 2; if (n.res.oil < o) fail(`Requires ${o} oil.`); n.res.oil -= o; n.train++; n.morale = clamp(n.morale + 3, 0, 100); msg = `Training raised to ${n.train}.`; }
    else if (k === 'infra') { const c = infraCost(n), s = 20 + n.infra * 10; if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); n.cash -= c; n.res.steel -= s; n.infra++; msg = `Infrastructure level ${n.infra}.`; }
    else if (k === 'fort') { const c = fortCost(n), s = 30 + n.fort * 15; if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); n.cash -= c; n.res.steel -= s; n.fort++; msg = `Fortifications level ${n.fort}.`; }
    else if (k === 'spies') { if (n.spies >= spyCap(n)) fail(`Your intelligence agency is at capacity (${spyCap(n)} agents for your rank).`); const c = 8e4; if (n.cash < c) fail(`Requires ${money(c)}.`); n.cash -= c; n.spies = Math.min(spyCap(n), n.spies + 2); msg = `Two agents completed training. You now have ${n.spies}.`; }
    else if (k === 'rally') { const c = rallyCost(n); if (n.cash < c) fail(`Requires ${money(c)}.`); n.cash -= c; n.approval = clamp(n.approval + 6, 0, 100); msg = 'Your address was well received. Approval rose.'; }
    else if (k === 'campaign') { if (n.gov !== 'dem') fail('Only democracies hold elections.'); if (!n.nextElection || n.nextElection - W.now > 24 * HOUR) fail('Campaigning opens 24 hours before the election.'); if ((n.campaign || 0) >= 12) fail('Your campaign is already at full strength.'); const c = campaignCost(n); if (n.cash < c) fail(`Requires ${money(c)}.`); n.cash -= c; n.campaign = (n.campaign || 0) + 3; msg = `Campaign rallies held across the country. Projected vote +3% (total +${n.campaign}%).`; }
    else if (k === 'daily') { const st = n.streak && W.now - n.streak.t < 48 * HOUR ? n.streak.c + 1 : 1; n.streak = { c: st, t: W.now }; const sm = streakMult(st); const v = Math.round(dailyGrant(n) * sm); n.cash += v; if (st % 7 === 0) gainXP(W, u, 100); n.res.food += 100; n.res.oil += 60; n.res.steel += 60; n.res.goods += 30; msg = `Received a ${money(v)} grant and supplies.${st > 1 ? ` Day ${st} streak: ×${sm.toFixed(2)}${st % 7 === 0 ? ' — weekly bonus!' : '.'}` : ''}`; }
    n.cd[k] = W.now + a.cd * MIN * W.cfg.cd; n.cnt[k] = (n.cnt[k] || 0) + 1; gainXP(W, u, a.xp); log(n, msg, W); touch(W, u);
    return { msg };
  }

  function applyEff(W, u, e, rng) {
    const n = W.A[u];
    if (e.risk != null) { const ok = rng() < e.risk; applyEff(W, u, ok ? e.ok : e.bad, rng); return ok; }
    for (const [k, v] of Object.entries(e)) {
      if (k === 'tr') n.cash += v * taxIncome(W, u);
      else if (k === 'debt') { const amt = v * taxIncome(W, u); n.debt += amt; n.cash += amt; }
      else if (k === 'ap') n.approval = clamp(n.approval + v, 0, 100);
      else if (k === 'st') n.stability = clamp(n.stability + v, 0, 100);
      else if (k === 'pop') n.pop = Math.max(1000, n.pop * (1 + v / 100));
      else if (k === 'gdp') n.gdp = Math.max(1e5, n.gdp * (1 + v / 100));
      else if (k === 'troops') n.troops = Math.max(0, Math.min(troopCap(n), n.troops + v));
      else if (k === 'ships' || k === 'air' || k === 'spies') n[k] = Math.max(0, n[k] + v);
      else if (k === 'tech' || k === 'infra' || k === 'fort') n[k] = Math.max(0, n[k] + v);
      else if (k === 'train') n.train = clamp(n.train + v, 0, maxTrain(n));
      else if (k === 'aggr') { n.aggr = clamp((n.aggr || 0) + v, 0, 100); rogueCheck(W, u); }
      else if (k === 'unemp') n.unemp = clamp(n.unemp + v, 1, 40);
      else if (k === 'infl') n.infl = clamp(n.infl + v, -2, 80);
      else if (k === 'health' || k === 'edu' || k === 'morale') n[k] = clamp(n[k] + v, 0, 100);
      else if (has(RES, k)) n.res[k] = Math.max(0, n.res[k] + v);
    }
    return true;
  }
  function addCard(W, u, rng) {
    const n = W.A[u];
    if (!n.chain && !n.cards.some(c => String(c.i).startsWith('ch:')) && rng() < .18) { const recent = n.seenCh || []; const opts = CHAIN_STARTS.filter(k => !recent.includes(k)); if (opts.length) { const k = opts[Math.floor(rng() * opts.length)]; n.cards.push({ id: rid(), i: 'ch:' + k }); n.seenCh = [k, ...recent].slice(0, 3); return; } } const used = new Set([...n.cards.map(c => c.i), ...(n.seen || [])]);
    let pool = CARDS.map((c, i) => i).filter(i => !used.has(i) && condOk(W, u, CARDS[i].c));
    if (!pool.length) pool = CARDS.map((c, i) => i).filter(i => !n.cards.some(c => c.i === i) && condOk(W, u, CARDS[i].c));
    if (!pool.length) return;
    const weighted = []; for (const i of pool) { weighted.push(i); if (CARDS[i].c) weighted.push(i, i); }
    const i = weighted[Math.floor(rng() * weighted.length)];
    n.cards.push({ id: rid(), i }); n.seen = [i, ...(n.seen || [])].slice(0, 60);
  }
  function decide(W, u, id, o, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const c = n.cards.find(x => x.id === id); if (!c) fail('That decision is no longer pending.');
    const card = getCard(c.i), oi = Number(o); if (!card || !Number.isInteger(oi) || oi < 0 || oi >= card.o.length) fail('Invalid choice.'); const opt = card.o[oi];
    const ok = applyEff(W, u, opt[1], rng); n.cards = n.cards.filter(x => x.id !== id); n.cnt.decide = (n.cnt.decide || 0) + 1; gainXP(W, u, 10);
    if (opt[2] && CHAINS[opt[2]]) n.chain = { k: opt[2], at: W.now + (30 + Math.floor(rng() * 30)) * MIN }; // the story continues later
    const msg = `${card.t}: ${opt[0]}${opt[1].risk != null ? (ok ? ' — it succeeded.' : ' — it backfired.') : '.'}`; log(n, msg, W); touch(W, u);
    return { msg };
  }

  function attack(W, u, h, X, AIR, rng) {
    const me = W.A[u]; h = Number(h); if (!Number.isInteger(h) || !P[h]) fail('Unknown province.'); const why = canAttack(W, u, h); if (why) fail(why);
    X = Math.floor(Number(X)); AIR = Math.max(0, Math.floor(Number(AIR) || 0));
    if (!(X >= 10) || X > me.troops) fail('Commit at least 10 troops, and no more than you have.');
    if (AIR > me.air) fail('You do not have that many aircraft.');
    const RCH = reach(W, u, h), rt = RCH.rt, SEA = rt === 'sea' || rt === 'ocean', OCEAN = rt === 'ocean', MARCH = rt === 'march', perShip = PER_SHIP[rt] || 0, shipsNeeded = SEA ? Math.ceil(X / perShip) : 0;
    if (shipsNeeded > me.ships) fail(`${OCEAN ? 'An overseas' : 'A sea'} invasion of ${num(X)} troops needs ${shipsNeeded} warships to carry them (${perShip} troops each). You have ${me.ships}.`);
    const c = atkCost(W, X), cx = routeCostX(RCH, me); c.cash = Math.round(c.cash * cx); c.oil = Math.ceil(c.oil * cx); c.food = Math.ceil(c.food * cx); if (me.cash < c.cash || me.res.oil < c.oil + AIR * 2 || me.res.food < c.food) fail(`This operation requires ${money(c.cash)}, ${c.oil + AIR * 2} oil and ${c.food} food.`);
    const v = owner(W, h), d = W.A[v];
    me.cash -= c.cash; me.res.oil -= c.oil + AIR * 2; me.res.food -= c.food; me.cd.attack = W.now + 15 * MIN; me.regroup = W.now + (OCEAN ? 60 : MARCH ? 45 : 30) * MIN; const retal = (d.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR); me.aggr = Math.min(100, (me.aggr || 0) + (rogue(W, d) ? 0 : retal ? 5 : W.m.aggrPerAttack)); rogueCheck(W, u);
    me.approval = clamp(me.approval - (me.gov === 'dem' ? 6 : me.gov === 'dic' ? 1 : 3), 0, 100); me.stability = clamp(me.stability - 2, 0, 100);
    const result = { h, X, air: AIR, route: rt, km: RCH.km, naval: null };
    // 1) naval battle for sea invasions
    if (SEA && d.ships > 0) {
      const atkN = me.ships * 25 * techF(me) * (.85 + rng() * .3), defN = navalDefense(W, h) * (.9 + rng() * .2), rn = defN / (atkN + defN);
      const lostA = Math.min(me.ships, Math.round(me.ships * rn * .4)), lostD = Math.min(d.ships, Math.round(d.ships * (1 - rn) * .4));
      me.ships -= lostA; d.ships -= lostD; result.naval = { win: atkN > defN, atk: Math.round(atkN), def: Math.round(defN), lostA, lostD };
      if (atkN <= defN) {
        const drowned = Math.round(X * .2); me.troops -= drowned;
        Object.assign(result, { win: false, atk: 0, def: Math.round(defN), lossA: drowned, lossD: 0, loot: 0, airLostA: 0, airLostD: 0 });
        pushOut(W, u, { type: 'battle', to: v, h, X, win: false, lossA: drowned, lossD: 0, loot: 0, sea: 1, ocean: OCEAN ? 1 : 0 });
        log(d, `Your navy turned back ${OCEAN ? 'an overseas' : 'a sea'} invasion of ${pname(h)} by ${me.name}.`, W); note(W, v, 'attack', `Your navy repelled a sea invasion of ${pname(h)} by ${me.name}.`);
        news(W, u, `${d.name}'s navy repelled a sea invasion of ${pname(h)} by ${me.name}.`); gainXP(W, u, 5); touch(W, u, v);
        result.sanctioned = sanctioned(me); return { msg: 'Defeat at sea.', battle: result };
      }
    }
    // 2) land battle with air support
    const atk = (X + AIR * 20) * atkMult(me) * routeMult(RCH, me) * (rogue(W, d) ? 1.15 : 1) * (.85 + rng() * .3), def = defense(W, h, u) * (.9 + rng() * .2); const win = atk > def, ra = def / (atk + def);
    const lossA = Math.min(X, Math.round(X * ra * .6)), lossD = Math.min(d.troops, Math.round(d.troops * .5 * (1 - ra) * .5));
    const airLostA = Math.min(AIR, Math.round(AIR * ra * .3)), airLostD = Math.min(d.air, Math.round(d.air * .5 * (1 - ra) * .3));
    me.troops -= lossA; me.air -= airLostA; d.troops = Math.max(0, d.troops - lossD); d.air -= airLostD;
    let loot = 0;
    const isCap = !!(W.OWN[h] && W.OWN[h].cap);
    if (win && isCap) { result.conquered = true; loot = Math.max(0, Math.round(d.cash * .25)); me.cash += loot; for (const r in RES) me.res[r] = (me.res[r] || 0) + Math.floor((d.res[r] || 0) * .5); me.hexes[h] = W.now; me.lastStand = 0; gainXP(W, u, 150); }
    else if (win) { loot = Math.round(Math.max(0, Math.min(d.cash * .05, X * 60))); me.cash += loot; d.cash -= loot; delete d.hexes[h]; me.hexes[h] = W.now; me.lastStand = 0; W.OWN[h] = { u, ts: W.now }; d.approval = clamp(d.approval - 4, 0, 100); d.stability = clamp(d.stability - 3, 0, 100); gainXP(W, u, 40);
      if (W.cfg.conquest && Object.keys(d.hexes).length === 1 && !d.lastStand) { d.lastStand = W.now; log(d, `Only your capital remains. In ${W.cfg.lastStandH ?? 24} hours it can be besieged — make peace, rally allies, fortify, or retake land.`, W); note(W, v, 'attack', `LAST STAND: ${d.name} has only its capital left. Enemies can besiege it in ${W.cfg.lastStandH ?? 24} hours.`); news(W, v, `${d.name} has lost all but its capital and is making a last stand.`); } }
    else gainXP(W, u, 5);
    Object.assign(result, { win, atk: Math.round(atk), def: Math.round(def), lossA, lossD, loot, airLostA, airLostD, sanctioned: sanctioned(me) });
    // generals: victories can produce a new general and promote the commander; defeats can cost a general's life
    const ag = bestGen(me, 'attack');
    if (win) { if (ag) { ag.wins++; if (ag.wins % 3 === 0 && ag.stars < 5) { ag.stars++; result.genUp = ag.name; } } if (rng() < .25) { const g = newGeneral(W, u, rng); if (g) { result.newGen = g; log(me, `${g.name} distinguished themselves in battle and was appointed ${GEN_TYPES[g.type].n}.`, W); note(W, u, 'rank', `New general: ${g.name}, ${GEN_TYPES[g.type].n}.`); } }
      const dg = bestGen(d, 'defense'); if (dg && rng() < .15) { d.gens = d.gens.filter(x => x !== dg); log(d, `${dg.name}, your defense commander, was killed defending ${pname(h)}.`, W); note(W, v, 'attack', `General ${dg.name} was killed defending ${pname(h)}.`); } }
    else if (ag && rng() < .2) { me.gens = me.gens.filter(x => x !== ag); result.genLost = ag.name; log(me, `${ag.name}, your field marshal, was killed in the failed attack on ${pname(h)}.`, W); news(W, u, `General ${ag.name} of ${me.name} fell in battle at ${pname(h)}.`); }
    // newly conquered land may rebel unless it is garrisoned
    if (win && !isCap) { me.conq = me.conq || {}; me.conq[h] = { t: W.now, from: v }; }
    for (const a of allies(W, v)) if (a !== u) note(W, a, 'war', `${me.name} ${win ? 'captured' : 'attacked'} ${pname(h)} from your ally ${d.name}.`);
    pushOut(W, u, { type: 'battle', to: v, h, X, win, lossA, lossD, loot, sea: SEA ? 1 : 0, ocean: OCEAN ? 1 : 0 });
    if (result.conquered) {
      const days = Math.max(0, (W.now - (d.created || W.now)) / 864e5);
      news(W, u, `${me.name} has conquered ${d.name}. ${d.name} has fallen after ${days < 1 ? 'less than a day' : Math.floor(days) + ' day' + (Math.floor(days) === 1 ? '' : 's')}.`);
      log(me, `You conquered ${d.name}, seizing ${pname(h)}, ${money(loot)} and half its stockpiles.`, W);
      fallNation(W, v, { by: u, byName: me.name, h, days, peakRank: rankName(d), xp: d.xp, name: d.name, color: d.color });
      touch(W, u); return { msg: 'Conquest.', battle: result };
    }
    const how = OCEAN ? 'an overseas invasion of' : rt === 'sea' ? 'an amphibious assault on' : MARCH ? 'a long-range offensive against' : 'an invasion of';
    log(d, win ? `${me.name} captured ${pname(h)} in ${how.replace('an ', '')}. Losses: ${num(lossD)} troops${loot ? ', ' + money(loot) : ''}.` : `Your forces repelled ${how} ${pname(h)} by ${me.name}. Losses: ${num(lossD)} troops.`, W);
    note(W, v, 'attack', win ? `${me.name} captured ${pname(h)}!` : `You repelled ${how} ${pname(h)} by ${me.name}.`);
    news(W, u, win ? `${me.name} captured ${pname(h)} from ${d.name}${OCEAN ? ' in an overseas invasion' : rt === 'sea' ? ' in an amphibious assault' : ''}.` : `${d.name} repelled ${how} ${pname(h)} by ${me.name}.`);
    touch(W, u, v);
    return { msg: win ? 'Victory.' : 'Defeat.', battle: result };
  }

  // air and missile strikes: damage without invading
  function canStrike(W, u, v) {
    const me = W.A[u], n = W.A[v]; if (!me) return 'Found a nation first.'; if (!n || v === u) return 'Unknown nation.';
    if (!W.cfg.war) return 'Warfare is currently disabled by the administrators.';
    if (rankOf(me.xp) < 2) return 'You must reach the rank of Mayor to wage war.';
    if (!atWar(W, u, v)) return `You are not at war with ${n.name}. Declare war first.`;
    const mob = W.m.mobilize * MIN; if (W.now - warSince(W, u, v) < mob) return `Forces are mobilizing — ready in ${fmtT(mob - (W.now - warSince(W, u, v)))}.`;
    const theyHitMe = (n.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR);
    if (!theyHitMe && !n.ai && W.now - n.created < W.cfg.protectH * HOUR && !(n.out || []).some(e => e.type === 'battle')) return `${n.name} is under new-nation protection.`;
    if (left(W, me, 'strike')) return `Your strike forces are rearming: ${fmtT(left(W, me, 'strike'))}.`;
    return null;
  }
  const MISSILE = { tech: 8, cash: 4e5, steel: 40, oil: 40 };
  function strike(W, u, v, kind, target, count, rng) {
    const why = canStrike(W, u, v); if (why) fail(why);
    const me = W.A[u], d = W.A[v]; if (!['stock', 'infra', 'mil'].includes(target)) fail('Choose a target.');
    count = Math.floor(Number(count)); let P = 0, lost = 0, hits = 0;
    if (kind === 'air') {
      if (!(count >= 5) || count > (me.air || 0)) fail(`Send between 5 and ${me.air || 0} aircraft.`);
      if (me.res.oil < count * 3) fail(`Needs ${count * 3} oil.`);
      me.res.oil -= count * 3; const icp = (d.air || 0) / ((d.air || 0) + count + 1);
      lost = Math.min(count, Math.round(count * icp * .6 + count * .03)); me.air -= lost; P = (count - lost) * techF(me);
    } else if (kind === 'missile') {
      if ((me.tech || 0) < MISSILE.tech) fail(`Missiles require tech level ${MISSILE.tech}.`);
      if (!(count >= 1) || count > 5) fail('Launch between 1 and 5 missiles.');
      const c = { cash: MISSILE.cash * count, steel: MISSILE.steel * count, oil: MISSILE.oil * count };
      if (me.cash < c.cash || me.res.steel < c.steel || me.res.oil < c.oil) fail(`${count} missile${count > 1 ? 's need' : ' needs'} ${money(c.cash)}, ${c.steel} steel and ${c.oil} oil.`);
      me.cash -= c.cash; me.res.steel -= c.steel; me.res.oil -= c.oil;
      const hp = clamp(.85 - soft(d.fort, 8) * .04, .4, .9); for (let i = 0; i < count; i++) if (rng() < hp) hits++; P = hits * 12 * techF(me);
    } else fail('Unknown strike.');
    const dmg = {};
    if (target === 'stock') { const f = Math.min(.3, P * .004); for (const r in RES) { dmg[r] = Math.floor((d.res[r] || 0) * f); d.res[r] -= dmg[r]; } }
    else if (target === 'infra') { const lv = P >= 40 ? 2 : P >= 15 ? 1 : 0; dmg.infra = Math.min(d.infra || 0, lv); d.infra -= dmg.infra; dmg.gdp = Math.min(.05, P * .0008); d.gdp = (d.gdp || 0) * (1 - dmg.gdp); }
    else { dmg.troops = Math.min(Math.floor((d.troops || 0) * .15), Math.round(P * 25)); d.troops -= dmg.troops; dmg.ships = Math.min(d.ships || 0, Math.floor(P / 15)); d.ships -= dmg.ships; dmg.air = Math.min(d.air || 0, Math.floor(P / 20)); d.air -= dmg.air; }
    me.cd.strike = W.now + 30 * MIN; me.aggr = Math.min(100, (me.aggr || 0) + (rogue(W, d) ? 0 : 8)); rogueCheck(W, u); me.approval = clamp(me.approval - (me.gov === 'dem' ? 4 : 2), 0, 100);
    const what = target === 'stock' ? 'stockpiles' : target === 'infra' ? 'infrastructure' : 'military';
    const sum = target === 'stock' ? (Object.entries(dmg).filter(([, x]) => x > 0).map(([r, x]) => `${num(x)} ${r}`).join(', ') || 'almost nothing') + ' destroyed'
      : target === 'infra' ? (dmg.infra ? `infrastructure −${dmg.infra} level${dmg.infra > 1 ? 's' : ''}` : 'no infrastructure destroyed') + `, GDP −${(dmg.gdp * 100).toFixed(1)}%`
      : `${num(dmg.troops)} troops killed${dmg.ships ? `, ${dmg.ships} warships sunk` : ''}${dmg.air ? `, ${dmg.air} aircraft destroyed` : ''}`;
    const how = kind === 'air' ? `air strike (${count} aircraft${lost ? `, ${lost} shot down` : ''})` : `missile strike (${hits} of ${count} hit)`;
    log(me, `Your ${how} on ${d.name}'s ${what}: ${sum}.`, W); log(d, `${me.name} launched a ${how.replace(/ \(.*/, '')} on your ${what}: ${sum}.`, W);
    note(W, v, 'attack', `${me.name} hit your ${what} with a ${kind === 'air' ? 'air' : 'missile'} strike.`); news(W, u, `${me.name} launched ${kind === 'air' ? 'air strikes' : 'missiles'} against ${d.name}.`);
    for (const a of allies(W, v)) if (a !== u) note(W, a, 'war', `${me.name} launched a ${kind === 'air' ? 'air' : 'missile'} strike on your ally ${d.name}.`);
    gainXP(W, u, 10); touch(W, u, v);
    return { msg: `Strike complete — ${sum}.`, strike: { kind, target, count, lost, hits, dmg, sum } };
  }
  function buildNuke(W, u) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (n.nuke) fail('You already have a nuclear deterrent.');
    if ((n.tech || 0) < NUKE.tech) fail(`A nuclear program requires tech level ${NUKE.tech}.`);
    if (!W.cfg.nukeTest && rankOf(n.xp) < NUKE.rank) fail(`A nuclear program requires the rank of ${RANKS[NUKE.rank][1]}.`);
    if (n.cash < NUKE.cash || n.res.steel < NUKE.steel || n.res.oil < NUKE.oil || n.res.goods < NUKE.goods) fail(`Requires ${money(NUKE.cash)}, ${NUKE.steel} steel, ${NUKE.oil} oil and ${NUKE.goods} goods.`);
    n.cash -= NUKE.cash; n.res.steel -= NUKE.steel; n.res.oil -= NUKE.oil; n.res.goods -= NUKE.goods; n.nuke = W.now;
    n.aggr = Math.min(100, (n.aggr || 0) + 40); n.stability = clamp(n.stability + 5, 0, 100); rogueCheck(W, u);
    news(W, u, `☢ ${n.name} has tested a nuclear weapon. The world is on alert.`); log(n, 'Your nuclear deterrent is operational. Your capital can no longer be besieged, but the world will not forget.', W);
    for (const v of Object.keys(W.A)) if (v !== u) note(W, v, 'war', `☢ ${n.name} has tested a nuclear weapon.`);
    gainXP(W, u, 50); touch(W, u); return { msg: 'Your nuclear deterrent is operational.' };
  }
  // admin "nuke test mode": no 24h wait, warheads arm in 1 minute, no 7-day lockout
  const nkT = W => W.cfg.nukeTest ? { holdH: 0, buildH: 1 / 60, cdD: 0 } : WARHEAD;
  function canWarhead(W, u) {
    const n = W.A[u]; if (!n) return 'Found a nation first.';
    if (!n.nuke) return 'You need an operational nuclear deterrent first.';
    if (n.warhead) return n.warhead.ready > W.now ? `A warhead is already being assembled: ready in ${fmtT(n.warhead.ready - W.now)}.` : 'You already have an armed warhead.';
    if (W.now - n.nuke < nkT(W).holdH * HOUR) return `Your deterrent must be operational for ${nkT(W).holdH} hours first: ${fmtT(nkT(W).holdH * HOUR - (W.now - n.nuke))} left.`;
    if (left(W, n, 'warhead') && !W.cfg.nukeTest) return `After a launch, a new warhead takes time to approve: ${fmtT(left(W, n, 'warhead'))} left.`;
    if ((n.tech || 0) < WARHEAD.tech) return `A launchable warhead requires tech level ${WARHEAD.tech}.`;
    if (!W.cfg.nukeTest && rankOf(n.xp) < WARHEAD.rank) return `A launchable warhead requires the rank of ${RANKS[WARHEAD.rank][1]}.`;
    if (n.cash < WARHEAD.cash || n.res.steel < WARHEAD.steel || n.res.oil < WARHEAD.oil || n.res.goods < WARHEAD.goods) return `Requires ${money(WARHEAD.cash)}, ${num(WARHEAD.steel)} steel, ${num(WARHEAD.oil)} oil and ${num(WARHEAD.goods)} goods.`;
    return null;
  }
  function buildWarhead(W, u) {
    const why = canWarhead(W, u); if (why) fail(why); const n = W.A[u];
    n.cash -= WARHEAD.cash; n.res.steel -= WARHEAD.steel; n.res.oil -= WARHEAD.oil; n.res.goods -= WARHEAD.goods;
    n.warhead = { t: W.now, ready: W.now + nkT(W).buildH * HOUR }; n.aggr = Math.min(100, (n.aggr || 0) + 20); rogueCheck(W, u);
    news(W, u, `☢ Intelligence agencies report that ${n.name} is assembling a launchable nuclear warhead.`);
    log(n, `Warhead assembly has begun. It will be armed in ${fmtT(nkT(W).buildH * HOUR)}.`, W);
    for (const v of Object.keys(W.A)) if (v !== u && !W.A[v].ai) note(W, v, 'war', `☢ ${n.name} is assembling a launchable nuclear warhead. It will be armed in ${fmtT(nkT(W).buildH * HOUR)}.`);
    touch(W, u); return { msg: `Warhead assembly begun — armed in ${fmtT(nkT(W).buildH * HOUR)}.` };
  }
  const warheadReady = (W, n) => !!(n && n.warhead && (n.warhead === 2 || n.warhead.ready <= W.now || (W.cfg.nukeTest && n.warhead.t + 60e3 <= W.now)));
  function canLaunch(W, u, v) {
    const me = W.A[u], d = W.A[v]; if (!me) return 'Found a nation first.'; if (!d || v === u) return 'Unknown nation.';
    if (!W.cfg.war) return 'Warfare is currently disabled by the administrators.';
    if (!warheadReady(W, me)) return me.warhead ? `Your warhead is not armed yet: ${fmtT(me.warhead.ready - W.now)} left.` : 'You have no armed warhead.';
    if (!atWar(W, u, v)) return `You are not at war with ${d.name}. Declare war first.`;
    const mob = W.m.mobilize * MIN; if (W.now - warSince(W, u, v) < mob) return `Forces are mobilizing — ready in ${fmtT(mob - (W.now - warSince(W, u, v)))}.`;
    if (!d.ai && W.now - d.created < W.cfg.protectH * HOUR) return `${d.name} is under new-nation protection.`;
    if (nuked(W, d)) return `${d.name} is already in ruins from a nuclear strike.`;
    return null;
  }
  function detonate(W, u, v, h, retaliation) {
    const me = W.A[u], d = W.A[v], pct = x => Math.round(x * 100);
    // ground zero
    const loss = { pop: Math.round(d.pop * .25), troops: Math.floor((d.troops || 0) * .5), ships: Math.floor((d.ships || 0) * .3), air: Math.floor((d.air || 0) * .4), infra: Math.min(d.infra || 0, 3) };
    d.pop -= loss.pop; d.troops -= loss.troops; d.ships -= loss.ships; d.air -= loss.air; d.infra -= loss.infra; d.gdp = (d.gdp || 0) * .6;
    for (const r in RES) d.res[r] = Math.floor((d.res[r] || 0) * .6);
    d.approval = clamp(d.approval - 30, 0, 100); d.stability = clamp(d.stability - 40, 0, 100); d.health = clamp((d.health || 50) - 25, 0, 100); d.morale = clamp((d.morale || 50) - 30, 0, 100);
    d.nuked = { t: W.now, until: W.now + WARHEAD.nukedH * HOUR, h: +h, by: u, byName: me.name };
    // fallout zone and worldwide nuclear winter
    const hit = [];
    for (const x of Object.keys(W.A)) {
      const n = W.A[x]; if (x === v) continue; n.winter = Math.max(n.winter || 0, W.now + WARHEAD.winterH * HOUR); n.health = clamp((n.health || 50) - 3, 0, 100); n.stability = clamp(n.stability - 3, 0, 100);
      const near = hexesOf(W, x).some(k => kmBetween(+k, +h) <= WARHEAD.km);
      if (near) { n.fallout = Math.max(n.fallout || 0, W.now + WARHEAD.falloutH * HOUR); n.pop = Math.round(n.pop * .94); n.health = clamp(n.health - 12, 0, 100); n.approval = clamp(n.approval - 10, 0, 100); hit.push(x); note(W, x, 'war', `☢ Radioactive fallout from the strike on ${d.name} is drifting over your nation: population −6%, health falling, tax revenue halved for ${WARHEAD.falloutH} hours.`); }
      touch(W, x);
    }
    // the attacker becomes a pariah
    me.warhead = null; me.cd.warhead = W.now + nkT(W).cdD * 24 * HOUR; me.aggr = 100; me.rogue = Math.max(me.rogue || 0, W.now + 72 * HOUR);
    for (const a of allies(W, u)) { setRel(W.A[a], u, 'unally', W.now); note(W, a, 'diplo', `You ended your alliance with ${me.name} after its nuclear strike.`); touch(W, a); }
    me.approval = clamp(me.approval - (me.gov === 'dic' ? 5 : 20), 0, 100);
    const sum = `${num(loss.pop)} people and ${num(loss.troops)} troops killed${loss.infra ? `, ${loss.infra} infrastructure level${loss.infra > 1 ? 's' : ''} destroyed` : ''}, GDP −40%, tax collection halted for ${WARHEAD.nukedH} hours`;
    log(me, `☢ Your nuclear strike on ${pname(h)} (${d.name}): ${sum}. Your nation is now a rogue state for at least 72 hours.`, W);
    log(d, `☢ ${me.name} detonated a nuclear weapon over ${pname(h)}: ${sum}.`, W);
    note(W, v, 'attack', `☢ ${me.name} launched a nuclear strike on ${pname(h)}. ${sum}.`);
    news(W, u, `☢ ${retaliation ? 'RETALIATION — ' : ''}${me.name} has launched a nuclear strike on ${d.name}. ${pname(h)} is in ruins and fallout is spreading.`);
    for (const x of Object.keys(W.A)) if (x !== u && x !== v && !W.A[x].ai && !hit.includes(x)) note(W, x, 'war', `☢ ${me.name} has launched a nuclear strike on ${d.name}. The world enters a nuclear winter for ${WARHEAD.winterH} hours.`);
    (W.nukeFx = W.nukeFx || []).push({ by: u, byName: me.name, to: v, toName: d.name, h: +h, place: pname(h), retaliation: !!retaliation, t: W.now });
    touch(W, u, v); return sum;
  }
  function launchNuke(W, u, v, h) {
    const why = canLaunch(W, u, v); if (why) fail(why); const d = W.A[v];
    h = h == null || h === '' ? d.cap : Number(h); if (owner(W, h) !== v) fail(`That province does not belong to ${d.name}.`);
    const sum = detonate(W, u, v, h, false);
    // mutually assured destruction: an armed warhead fires back automatically
    let mad = '';
    if (warheadReady(W, d) && W.A[u]) { detonate(W, v, u, W.A[u].cap, true); mad = ` ${d.name} had an armed warhead and retaliated automatically against your capital.`; }
    return { msg: `☢ Detonation confirmed — ${sum}.${mad}`, nuked: { h, sum, mad: !!mad } };
  }
  function dip(W, u, kind, v) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them || v === u) fail('Unknown nation.');
    const t = W.now;
    if (kind === 'war') {
      if (!W.cfg.war) fail('Warfare is currently disabled by the administrators.');
      if (rankOf(me.xp) < 2) fail('You must reach the rank of Mayor to declare war.');
      if (atWar(W, u, v)) fail('You are already at war.');
      setRel(me, v, 'war', t); setRel(me, v, 'unally', t); setRel(me, v, 'untrade', t); me.rel[v].fair = score(W, v) >= score(W, u) * .4 ? 1 : 0;
      news(W, u, `${me.name} has declared war on ${them.name}.`); log(them, `${me.name} has declared war on you.`, W); note(W, v, 'war', `${me.name} has declared war on you!`);
      if (W.cfg.conquest && !them.ai && Object.keys(them.hexes || {}).length === 1) { const hrs = W.cfg.lastStandH ?? 24; log(them, `You hold only your capital. ${me.name} can besiege it in ${hrs} hours — make peace, rally allies, fortify or expand.`, W); note(W, v, 'attack', `LAST STAND: ${me.name} can besiege your capital in ${hrs} hours.`); }
    } else if (kind === 'peace') {
      if (!atWar(W, u, v)) fail('You are not at war with them.');
      if ((R(W, u, v).peace || 0) > warSince(W, u, v)) fail(`You have already offered peace to ${them.name}. Waiting for their answer.`);
      setRel(me, v, 'peace', t);
      if (!atWar(W, u, v)) { news(W, u, `${me.name} and ${them.name} signed a peace treaty.`); note(W, v, 'diplo', `${me.name} accepted peace. The war is over.`); }
      else { log(me, `Peace offered to ${them.name}.`, W); log(them, `${me.name} is offering peace.`, W); note(W, v, 'diplo', `${me.name} is offering peace.`); }
    } else if (kind === 'ally') {
      if (atWar(W, u, v)) fail('Make peace first.');
      if (pact(W, u, v, 'ally')) fail(`You are already allied with ${them.name}.`);
      if (rogue(W, me) !== rogue(W, them)) fail(rogue(W, me) ? 'No nation will ally with a rogue state.' : `${them.name} is a rogue state. No alliance is possible.`);
      if (offered(W, u, v, 'ally')) fail(`You have already proposed an alliance to ${them.name}. Waiting for their answer.`);
      setRel(me, v, 'ally', t);
      if (pact(W, u, v, 'ally')) { news(W, u, `${me.name} and ${them.name} formed an alliance.`); note(W, v, 'diplo', `${me.name} accepted your alliance.`); note(W, u, 'diplo', `Alliance with ${them.name} formed.`); }
      else { log(me, `Alliance proposed to ${them.name}.`, W); log(them, `${me.name} proposes an alliance.`, W); note(W, v, 'diplo', `${me.name} proposes an alliance.`); }
    } else if (kind === 'unally') { if (!pact(W, u, v, 'ally') && !offered(W, u, v, 'ally')) fail('There is no alliance to end.'); setRel(me, v, 'unally', t); news(W, u, `${me.name} ended its alliance with ${them.name}.`); note(W, v, 'diplo', `${me.name} ended your alliance.`); }
    else if (kind === 'trade') {
      if (atWar(W, u, v)) fail('Make peace first.');
      if (sanctioned(me)) fail('No nation will sign trade agreements with you while you are under sanctions.');
      if (rogue(W, me) || rogue(W, them)) fail(rogue(W, me) ? 'No nation will trade with a rogue state.' : `${them.name} is a rogue state under international embargo.`);
      if (embargoed(W, me)) fail('You are under a World Council embargo.');
      if (pact(W, u, v, 'trade')) fail(`You already have a trade agreement with ${them.name}.`);
      if (offered(W, u, v, 'trade')) fail(`You have already proposed a trade agreement to ${them.name}. Waiting for their answer.`);
      if (traders(W, u).length >= 5) fail('You can hold at most 5 trade agreements.');
      setRel(me, v, 'trade', t);
      if (pact(W, u, v, 'trade')) { news(W, u, `${me.name} and ${them.name} signed a trade agreement.`); note(W, v, 'diplo', `${me.name} accepted your trade agreement.`); note(W, u, 'diplo', `Trade agreement with ${them.name} signed.`); }
      else { log(me, `Trade agreement proposed to ${them.name}.`, W); log(them, `${me.name} proposes a trade agreement.`, W); note(W, v, 'diplo', `${me.name} proposes a trade agreement.`); }
    } else if (kind === 'untrade') { if (!pact(W, u, v, 'trade') && !offered(W, u, v, 'trade')) fail('There is no trade agreement to cancel.'); setRel(me, v, 'untrade', t); log(me, `Trade agreement with ${them.name} cancelled.`, W); log(them, `${me.name} cancelled your trade agreement.`, W); note(W, v, 'diplo', `${me.name} cancelled your trade agreement.`); }
    else fail('Unknown action.');
    touch(W, u, v); return { msg: 'Done.' };
  }

  function aid(W, u, v, amt) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them || v === u) fail('Unknown nation.');
    const a = { cash: Math.max(0, Math.floor(Number(amt.cash) || 0)) }; for (const r in RES) a[r] = Math.max(0, Math.floor(Number(amt[r]) || 0));
    if (rogue(W, me)) fail('Rogue states cannot send aid.'); if (rogue(W, them)) fail(`${them.name} is a rogue state under international embargo. Aid is not allowed.`);
    if (a.cash > 1e13 || Object.keys(RES).some(r => a[r] > 1e9)) fail('Amount too large.');
    if (!a.cash && !Object.keys(RES).some(r => a[r])) fail('Enter an amount.');
    if (a.cash > me.cash) fail('Insufficient funds.'); for (const r in RES) if (a[r] > me.res[r]) fail('Not enough ' + r + '.');
    me.cash -= a.cash; them.cash += a.cash; for (const r in RES) { me.res[r] -= a[r]; them.res[r] += a[r]; }
    const txt = [a.cash ? money(a.cash) : '', ...Object.keys(RES).filter(r => a[r]).map(r => `${num(a[r])} ${r}`)].filter(Boolean).join(', ');
    pushOut(W, u, { type: 'aid', to: v, ...a }); log(them, `${me.name} sent you aid: ${txt}.`, W); note(W, v, 'diplo', `${me.name} sent you aid: ${txt}.`); news(W, u, `${me.name} sent aid to ${them.name}.`); gainXP(W, u, 5);
    touch(W, u, v); return { msg: `Aid sent: ${txt}.`, amount: a };
  }

  function market(W, u, r, q, buy) {
    const me = W.A[u]; if (!me) fail('Found a nation first.'); if (!has(RES, r)) fail('Unknown commodity.');
    if (embargoed(W, me)) fail('You are under a World Council embargo and cannot trade on the world market.');
    if (rogue(W, me)) fail('Your nation is a rogue state under a full international embargo. The world market is closed to you.');
    q = Math.floor(Number(q)); if (!(q > 0) || q > 1e6) fail('Enter a valid quantity.');
    const p = prices(W)[r], s = spreads(W, u); let msg;
    if (buy) { const cost = Math.round(p * s.buy * q); if (cost > me.cash) fail(`That order costs ${money(cost)}.`); me.cash -= cost; me.res[r] += q; me.imp = (me.imp || 0) + cost; me.trades = [{ t: W.now, r, q }, ...(me.trades || [])].slice(0, 40); msg = `Imported ${num(q)} ${r} for ${money(cost)}.`; }
    else { if (q > me.res[r]) fail('You do not have that much.'); const got = Math.round(p * s.sell * q); me.cash += got; me.rev = (me.rev || 0) + got; me.res[r] -= q; me.exp = (me.exp || 0) + got; me.trades = [{ t: W.now, r, q: -q }, ...(me.trades || [])].slice(0, 40); msg = `Exported ${num(q)} ${r} for ${money(got)}.`; }
    log(me, msg, W); gainXP(W, u, 2); touch(W, u); return { msg };
  }

  function setTax(W, u, t) { const n = W.A[u]; if (!n) fail('Found a nation first.'); t = Math.round(Number(t)); if (!(t >= 5 && t <= 50)) fail('Tax must be between 5% and 50%.'); n.tax = t; touch(W, u); return { msg: `Tax rate set to ${t}%.` }; }
  function setBudget(W, u, b) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const spend = Math.round(Number(b.spend)); if (!(spend >= 5 && spend <= 40)) fail('Government spending must be between 5% and 40% of GDP.');
    const parts = ['mil', 'health', 'edu', 'infra'].map(k => Math.max(0, Number(b[k]) || 0)); const sum = parts.reduce((a, c) => a + c, 0); if (!(sum > 0)) fail('Allocate the budget.');
    const nb = { spend }; ['mil', 'health', 'edu', 'infra'].forEach((k, i) => nb[k] = Math.round(parts[i] / sum * 1000) / 10);
    n.budget = nb; touch(W, u); return { msg: 'Budget approved.' };
  }
  function bonds(W, u, amt, repay) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    amt = Math.floor(Number(amt)); if (!(amt > 0) || amt > 1e13) fail('Enter an amount.');
    if (repay) { if (amt > n.debt) amt = Math.floor(n.debt); if (amt > n.cash) fail('You do not have that much cash.'); n.cash -= amt; n.debt -= amt; log(n, `Repaid ${money(amt)} of national debt.`, W); touch(W, u); return { msg: `Repaid ${money(amt)}. Debt is now ${moneyS(n.debt)}.` }; }
    if ((n.defaulted || 0) > W.now - 48 * HOUR) fail('No one will lend to you for 48 hours after a default.');
    if (amt > maxBorrow(n)) fail(`Lenders will only lend up to ${money(maxBorrow(n))} more (120% of GDP in total).`);
    n.cash += amt; n.debt += amt; n.infl = clamp(n.infl + amt / Math.max(1, n.gdp) * 4, -2, 80);
    log(n, `Issued ${money(amt)} in government bonds at ${interestRate(W, n).toFixed(1)}% interest.`, W); touch(W, u);
    return { msg: `Bonds issued: +${money(amt)}. Interest rate ${interestRate(W, n).toFixed(1)}% per year.` };
  }
  function setGov(W, u, g) { const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!has(GOV, g)) fail('Unknown government.'); if (g === n.gov) fail('That is already your government.'); if (left(W, n, 'gov')) fail(`Your government can change again in ${fmtT(left(W, n, 'gov'))}.`); n.gov = g; n.stability = clamp(n.stability - 25, 0, 100); n.approval = clamp(n.approval - 10, 0, 100); n.cd.gov = W.now + 6 * HOUR; n.nextElection = g === 'dem' ? W.now + W.cfg.electionH * HOUR : 0; n.campaign = 0; n.rig = 0; news(W, u, `${n.name} is now a ${GOV[g].n}.`); touch(W, u); return { msg: `You now govern a ${GOV[g].n}.` }; }

  function covert(W, u, op, v, rng) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them) fail('Unknown nation.');
    if (!has(COVERT, op)) fail('Unknown operation.'); const o = COVERT[op];
    if (v === u && op !== 'rig') fail('You cannot target yourself with that operation.');
    if (op === 'rig' && them.gov !== 'dem') fail('That nation does not hold elections.');
    if (left(W, me, 'covert')) fail(`Your agents are still on assignment: ${fmtT(left(W, me, 'covert'))}.`);
    if (me.spies < o.spies) fail(`This operation needs ${o.spies} agents. You have ${me.spies}.`);
    if (me.cash < o.cost) fail(`This operation costs ${money(o.cost)}.`);
    me.cash -= o.cost; me.cd.covert = W.now + 20 * MIN;
    const self = v === u;
    const p = self ? .7 : clamp(.5 + (me.spies - (them.spies || 0) * .6) * .03 + (me.tech - them.tech) * .02 - them.fort * .01, .1, .85);
    const ok = rng() < p; let msg;
    if (ok) {
      if (op === 'steal') { if (them.tech > me.tech) { me.tech++; msg = `Your agents stole research from ${them.name}. Tech level ${me.tech}.`; } else { me.cash += o.cost * .5; msg = `Your agents infiltrated ${them.name} but found nothing more advanced than your own research.`; } log(them, 'Security services suspect a data breach at a research institute.', W); }
      else if (op === 'sabotage') { for (const r in RES) them.res[r] = Math.round(them.res[r] * .8); if (them.infra > 0 && rng() < .5) them.infra--; msg = `Sabotage in ${them.name} succeeded: stockpiles destroyed${them.infra >= 0 ? ' and infrastructure damaged' : ''}.`; log(them, 'Explosions at industrial sites destroyed supplies. The culprits are unknown.', W); note(W, v, 'covert', 'Sabotage hit your industry. The culprits are unknown.'); }
      else if (op === 'unrest') { them.stability = clamp(them.stability - 10, 0, 100); them.approval = clamp(them.approval - 5, 0, 100); msg = `Protests have broken out across ${them.name}.`; log(them, 'Mysteriously well-funded protests have broken out.', W); }
      else if (op === 'rig') { them.rig = (them.rig || 0) + (self ? 8 : -10); msg = self ? 'Your agents quietly secured votes for the next election (+8%).' : `Your agents are swinging ${them.name}'s next election against its government.`; }
    } else {
      const caught = rng() < .7; const lost = Math.ceil(o.spies / 2); me.spies -= lost;
      if (caught && !self) {
        me.aggr = clamp((me.aggr || 0) + 10, 0, 100); setRel(me, v, 'unally', W.now);
        news(W, u, `Agents working for ${me.name} were caught attempting to ${o.n.toLowerCase()} in ${them.name}.`);
        log(them, `Your counter-intelligence caught agents from ${me.name} attempting to ${o.n.toLowerCase()}.`, W); note(W, v, 'covert', `Agents from ${me.name} were caught attempting to ${o.n.toLowerCase()} in your nation!`);
        msg = `The operation failed and your agents were caught. ${lost} agents lost; the world now knows.`;
      } else if (caught && self) { me.approval = clamp(me.approval - 10, 0, 100); news(W, u, `Election fraud scandal: ${me.name}'s government was caught rigging its own election.`); msg = 'Your vote-rigging was exposed! Approval −10.'; }
      else msg = `The operation failed, but your agents escaped undetected. ${lost} agents lost.`;
    }
    log(me, msg, W); gainXP(W, u, 10); touch(W, u, v); return { msg, ok };
  }

  // ---------- passive simulation (every 10 real minutes) ----------
  function tickOnce(W, u, rng) {
    const n = W.A[u], hs = hexesOf(W, u), p = production(W, u), c = consumption(n), g = GOV[n.gov], w = wars(W, u).length, b = budget(n);
    for (const r in p) n.res[r] += p[r] - c[r];
    n.cash += hs.filter(h => ['P', 'D'].includes(P[h].t) && h != n.cap).length * 2000 * W.cfg.income;
    // government budget
    const spend = spendPerTick(n); n.cash -= spend; n.spent = (n.spent || 0) * .993 + spend; n.rev = (n.rev || 0) * .993;
    const milFund = spend * b.mil / 100, need = upkeep(W, n), ratio = need > 0 ? milFund / need : 2;
    if (ratio >= 1) n.morale = clamp(n.morale + Math.min(2, (ratio - 1) * 4 + .5), 0, 100);
    else { n.morale = clamp(n.morale - 6 * (1 - ratio), 0, 100); if (n.morale < 30) { n.troops = Math.floor(n.troops * (1 - .02 * (1 - ratio))); } }
    const pctGdp = k => b.spend * b[k] / 100;
    const drift = (k, tgt, rate) => { n[k] = n[k] + (clamp(tgt, 0, 100) - n[k]) * rate; };
    drift('health', pctGdp('health') * 12, .03); drift('edu', pctGdp('edu') * 15, .03); drift('iq', pctGdp('infra') * 14 + soft(n.infra, 10) * 2, .03);
    // interest and bankruptcy
    const interest = n.debt * interestRate(W, n) / 100 / TICKS_PER_YEAR; if (interest > 0) { if (n.cash >= interest) n.cash -= interest; else n.debt += interest; }
    if (n.debt > n.gdp * 2 || n.cash < -n.gdp * .2) {
      n.debt = Math.round(n.debt * .4); n.cash = Math.max(0, n.cash); n.stability = clamp(n.stability - 30, 0, 100); n.approval = clamp(n.approval - 20, 0, 100); n.gdp *= .85; n.infl = clamp(n.infl + 15, -2, 80); n.defaulted = W.now;
      news(W, u, `${n.name} has defaulted on its national debt. Its economy is in crisis.`); note(W, u, 'economy', 'Your government has gone bankrupt and defaulted on its debt. Lenders will not lend for 48 hours.');
    }
    const short = []; for (const r in n.res) if (n.res[r] < 0) { short.push(r); n.res[r] = 0; }
    const foodShort = short.includes('food'), goodsShort = short.includes('goods');
    // unemployment and inflation
    const deficit = (n.spent - n.rev) / Math.max(1, n.gdp) * TICKS_PER_YEAR / 144 * 100;
    const uT = 12 - soft(n.infra, 10) * .4 - n.edu * .04 - Math.min(5, traders(W, u).length) * .5 + w * 1.5 + (sanctioned(n) ? 4 : 0) + (n.infl > 10 ? 3 : 0) - (Math.min(b.spend, 30) - 15) * .15 + W.m.unemp;
    n.unemp = clamp(n.unemp + (clamp(uT, 1, 35) - n.unemp) * .05, 1, 40);
    const iT = 2 + Math.max(0, deficit) * .3 + debtRatio(n) * 3 + short.length * 2 - (n.tax - 20) * .05 + W.m.infl;
    n.infl = clamp(n.infl + (clamp(iT, -1, 60) - n.infl) * .04, -2, 80);
    // GDP
    n.gdp = n.gdp + (gdpTarget(W, u) - n.gdp) * .1;
    if (!n.gdpHist.length || W.now - n.gdpHist[n.gdpHist.length - 1].t >= HOUR) { n.gdpHist.push({ t: W.now, v: Math.round(n.gdp), p: Math.round(n.pop), m: Math.round(n.troops || 0) }); if (n.gdpHist.length > 48) n.gdpHist.shift(); }
    // population
    if (W.m.pandemic) n.pop *= 1 - .004 * (1 - n.health / 100);
    if (foodShort) n.pop *= .985; else if (n.approval > 35) n.pop = Math.min(Math.max(n.pop, popCap(W, u)), n.pop * (1 + .012 * (.5 + n.health / 100)));
    if (n.cash < 0) n.morale = clamp(n.morale - 3, 0, 100);
    // public opinion
    const apT = 55 - (n.tax - 20) * 1.2 + g.ap - w * (n.gov === 'dem' ? 10 : n.gov === 'dic' ? 3 : 6) - (foodShort ? 15 : 0) - (goodsShort ? 8 : 0) - (sanctioned(n) ? 6 : 0) + Math.min(5, traders(W, u).length) * 1.5
      - Math.max(0, n.unemp - 6) * .8 - Math.max(0, n.infl - 4) * .5 + (n.health - 50) * .08 + (n.edu - 50) * .03 + W.m.apBonus;
    n.approval = clamp(n.approval + (apT - n.approval) * .1, 0, 100);
    const stT = 30 + n.approval * .5 + g.st + n.fort - w * 5 - (n.aggr || 0) * .1 - Math.max(0, n.unemp - 10) * .5; n.stability = clamp(n.stability + (stT - n.stability) * .08, 0, 100);
    n.aggr = Math.max(0, (n.aggr || 0) - W.m.aggrDecay);
    if (nuked(W, n)) { n.pop *= .998; n.stability = clamp(n.stability - .2, 0, 100); }
    if (rogue(W, n)) { n.approval = clamp(n.approval - .25, 0, 100); n.stability = clamp(n.stability - .25, 0, 100); }
    if (n.stability < 25 && rng() < .05) { const lst = Object.keys(n.hexes).map(Number).filter(h => h != n.cap && owner(W, h) === u); if (lst.length) { const h = lst[Math.floor(rng() * lst.length)]; delete n.hexes[h]; delete W.OWN[h]; news(W, u, `Separatists in ${pname(h)} declared independence from ${n.name}.`); note(W, u, 'economy', `Separatists in ${pname(h)} declared independence.`); } }
    if (n.gov !== 'dem' && n.stability < 12 && n.approval < 20 && rng() < .06) { const ks = Object.keys(GOV).filter(k => k !== n.gov); n.gov = ks[Math.floor(rng() * ks.length)]; n.cash *= .7; n.troops = Math.floor(n.troops * .85); n.stability = 45; n.approval = 50; if (n.gov === 'dem') n.nextElection = W.now + W.cfg.electionH * HOUR; news(W, u, `Revolution in ${n.name}. The new regime is a ${GOV[n.gov].n}.`); note(W, u, 'economy', `Revolution! Your nation is now a ${GOV[n.gov].n}.`); }
  }
  function election(W, u, rng) {
    const n = W.A[u];
    const vote = clamp(n.approval * .75 + 12 - n.unemp * .7 - Math.max(0, n.infl - 3) + (n.campaign || 0) + (n.rig || 0) + (rng() * 12 - 6), 3, 97);
    const v = Math.round(vote * 10) / 10; n.lastElection = { t: W.now, vote: v, won: vote >= 50 }; n.campaign = 0; n.rig = 0; n.nextElection = W.now + W.cfg.electionH * HOUR;
    if (vote >= 50) { n.stability = clamp(n.stability + 8, 0, 100); n.approval = clamp(n.approval + 4, 0, 100); gainXP(W, u, 40); news(W, u, `${n.name}'s government was re-elected with ${v}% of the vote.`); note(W, u, 'election', `You won re-election with ${v}% of the vote!`); }
    else {
      n.stability = clamp(n.stability - 15, 0, 100); n.approval = 55; n.tax = 20; n.budget = { ...DEFBUDGET }; n.cd.gov = W.now + 12 * HOUR;
      if (vote < 35) { n.cash *= .85; n.morale = clamp(n.morale - 15, 0, 100); news(W, u, `Landslide defeat in ${n.name}: the government won only ${v}% and a new administration has taken over.`); note(W, u, 'election', `Landslide defeat (${v}%). A new administration has reversed your policies and purged ministries.`); }
      else { news(W, u, `The government of ${n.name} lost its election with ${v}% of the vote. A coalition takes power.`); note(W, u, 'election', `You lost the election with ${v}%. The new coalition reset your tax rate and budget.`); }
    }
  }
  // Runs on the server about twice a minute for every nation.
  // conquered provinces stay restless for 48 hours: without ~800 troops per province, they may rise up
  const GARRISON = 800;
  function rebels(W, u, rng) {
    const n = W.A[u]; let any = false; const held = hexesOf(W, u).length, ratio = (n.troops || 0) / Math.max(1, held * GARRISON);
    for (const [h, c] of Object.entries(n.conq || {})) {
      if (W.now - c.t > 48 * HOUR || owner(W, h) !== u) { delete n.conq[h]; any = true; continue; }
      const p = .02 * (1 - Math.min(1, ratio)) * (n.stability < 40 ? 1.5 : 1);
      if (p > 0 && rng() < p) {
        delete n.hexes[h]; delete n.conq[h]; any = true; const back = c.from && W.A[c.from] ? c.from : null;
        if (back) { W.A[back].hexes[h] = W.now; log(W.A[back], `${pname(h)} rose up against ${n.name} and rejoined your nation.`, W); note(W, back, 'attack', `${pname(h)} rebelled against ${n.name} and returned to you!`); touch(W, back); }
        W.OWN = computeOwn(W.A); n.stability = clamp(n.stability - 3, 0, 100);
        log(n, `Rebellion! ${pname(h)} rose up and ${back ? 'returned to ' + W.A[back].name : 'declared independence'}. Keep about ${GARRISON} troops per province to hold new land.`, W);
        note(W, u, 'attack', `Rebellion in ${pname(h)} — the province ${back ? 'returned to ' + W.A[back].name : 'broke away'}.`);
        news(W, u, `${pname(h)} rebelled against ${n.name}${back ? ' and rejoined ' + W.A[back].name : ''}.`);
      }
    }
    return any;
  }
  function rogueCheck(W, u) {
    const n = W.A[u]; if (!n) return false;
    if ((n.aggr || 0) >= ROGUE_AT) {
      const was = rogue(W, n); n.rogue = Math.max(n.rogue || 0, W.now + 24 * HOUR);
      if (!was) {
        news(W, u, `☠ ${n.name} has been declared a rogue state. The world has imposed a full embargo.`);
        log(n, 'Your nation has been declared a rogue state: full trade embargo, trade agreements cancelled, allies have walked away, and the world may attack you freely. It lasts at least 24 hours and ends only when your aggression falls below 50.', W);
        note(W, u, 'war', '☠ Your nation is now a rogue state under full international embargo.');
        for (const a of allies(W, u)) { setRel(W.A[a], u, 'unally', W.now); note(W, a, 'diplo', `You ended your alliance with ${n.name}, which has been declared a rogue state.`); touch(W, a); }
        for (const v of others(W, u)) if (!W.A[v].ai) note(W, v, 'war', `☠ ${n.name} has been declared a rogue state. Attacking it adds no aggression, and you fight it at +15% strength.`);
      }
      return !was;
    }
    if (n.rogue && W.now >= n.rogue) {
      if ((n.aggr || 0) < 50) { n.rogue = 0; news(W, u, `International sanctions on ${n.name} have been lifted.`); note(W, u, 'war', 'The world has lifted its embargo. Your nation is no longer a rogue state.'); }
      else n.rogue = W.now + 6 * HOUR; // still too aggressive: the embargo continues
      return true;
    }
    return false;
  }
  function tick(W, u, active, rng) {
    const n = W.A[u]; let changed = false;
    const k = Math.floor((W.now - n.lastTick) / TICK);
    if (k > 0) { if (active) for (let i = 0; i < Math.min(k, 12); i++) tickOnce(W, u, rng); n.lastTick += k * TICK; changed = true; }
    if (W.now - n.nextCard > 3 * HOUR) n.nextCard = W.now - 3 * HOUR;
    if (rogueCheck(W, u)) changed = true;
    if (n.chain && W.now >= n.chain.at && n.cards.length < 4) { n.cards.push({ id: rid(), i: 'ch:' + n.chain.k }); delete n.chain; changed = true; }
    if (k > 0 && n.conq) for (let i = 0; i < Math.min(k, 12); i++) if (rebels(W, u, rng)) changed = true;
    while (W.now >= n.nextCard) { if (n.cards.length < 3 && active) addCard(W, u, rng); n.nextCard += 40 * MIN; changed = true; }
    if (n.gov === 'dem' && n.nextElection && W.now >= n.nextElection) { election(W, u, rng); changed = true; }
    for (const h of Object.keys(n.hexes)) if (owner(W, h) !== u) { delete n.hexes[h]; changed = true; }
    if (changed) touch(W, u);
    return changed;
  }
  // a world event begins: every nation gets a response decision
  function startEvent(W, key) { const e = EVENTS[key]; if (!e) return; for (const u of Object.keys(W.A)) { const n = W.A[u]; n.cards = [{ id: rid(), i: 'ev:' + key }, ...n.cards.filter(c => c.i !== 'ev:' + key)].slice(0, 4); touch(W, u); } }

  function exec(W, u, cmd, rng) {
    const c = cmd || {};
    switch (c.c) {
      case 'found': return found(W, u, c, rng);
      case 'act': return act(W, u, String(c.k), c.arg, rng);
      case 'decide': return decide(W, u, String(c.id), c.o, rng);
      case 'attack': return attack(W, u, c.h, c.x, c.air, rng);
      case 'strike': return strike(W, u, String(c.v), String(c.kind), String(c.target), c.n, rng);
      case 'nuke': return buildNuke(W, u);
      case 'warhead': return buildWarhead(W, u);
      case 'launch': return launchNuke(W, u, String(c.v), c.h);
      case 'dip': return dip(W, u, String(c.kind), String(c.v));
      case 'aid': return aid(W, u, String(c.v), c.amt || {});
      case 'market': return market(W, u, String(c.r), c.q, !!c.buy);
      case 'tax': return setTax(W, u, c.t);
      case 'budget': return setBudget(W, u, c.b || {});
      case 'bonds': return bonds(W, u, c.amt, !!c.repay);
      case 'gov': return setGov(W, u, String(c.g));
      case 'covert': return covert(W, u, String(c.op), String(c.v), rng);
      case 'hideguide': { const n = W.A[u]; if (n) { n.hideGuide = true; touch(W, u); } return { msg: '' }; }
      default: fail('Unknown command.');
    }
  }

  return { P, CN, land, sea, nbrs, pname, getCard, rogue, ROGUE_AT, rogueCheck, nuked, nukeF, canWarhead, canLaunch, warheadReady, WARHEAD, devAid, canStrike, bestGen, genF, streakMult, GARRISON, MISSILE, NUKE, GEN_TYPES, CHAINS, troopCap, soft, reach, attackPlan, kmBetween, world, mods, computeOwn, owner, hexesOf, rankOf, rankName, maxHex, R, atWar, warSince, pact, offered, others, wars, allies, traders, embargoed, sanctioned, oilF, cheap, power, score, isCoastal, hasCoast,
    budget, debtRatio, rating, interestRate, gdpTarget, taxIncome, spendPerTick, upkeep, production, consumption, popCap, prices, spreads, maxBorrow,
    recruitBatch, navyBatch, airBatch, spyCap, expandCost, researchCost, maxTrain, infraCost, fortCost, rallyCost, campaignCost, dailyGrant, left, expandTargets, startOk, hexAge, route, canAttack, defense, navalDefense, atkMult, atkCost, techF, moraleF,
    condOk, normalize, exec, tick, startEvent, applyEff, fmtT, log, news, note, touch, setRel, CARDS };
}
return { Core, CHAINS, NUKE, WARHEAD, GEN_TYPES, MIN, HOUR, TICK, TICKS_PER_YEAR, RES, TYPE, CAPP, RANKS, GOV, COLORS, ACTS, DEFCFG, DEFBUDGET, EFFKEYS, COVERT, RESOLUTIONS, EVENTS, money, moneyS, num, clamp };
});
