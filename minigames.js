// World Powers — the duel mini-games: puzzle generation and scoring.
// Every puzzle is built from a seed, so two players (or a player and a recorded "ghost") get exactly the same one,
// and the server re-plays what the player did to work out the score. Nothing here touches the game world.
'use strict';
const LVLS = ['easy', 'medium', 'hard'];
const OPS = ['heist', 'cipher', 'warplans', 'assassinate', 'missile', 'capital', 'border', 'market'];
const DUEL_NAMES = { warplans: 'a memory duel', heist: 'a vault-cracking duel', cipher: 'a code-breaking duel', assassinate: 'a shooting duel', missile: 'a missile-defense duel', capital: 'a map duel', border: 'a checkpoint duel', market: 'a trading duel' };
const TITLES = { heist: 'Master safecracker', cipher: 'Master codebreaker', warplans: 'Master of memory', assassinate: 'Sharpshooter', missile: 'Shield of the nation', capital: 'Master navigator', border: 'Chief inspector', market: 'Market wizard' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function rngOf(seed) { let a = (seed >>> 0) || 1; const f = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo)); f.pick = L => L[Math.floor(f() * L.length)]; f.shuffle = L => { for (let i = L.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [L[i], L[j]] = [L[j], L[i]]; } return L; }; return f; }

// ---- memory ----
const MEMO = { easy: { pairs: 4, show: 4, time: 45, f: .78 }, medium: { pairs: 6, show: 5, time: 60, f: .9 }, hard: { pairs: 8, show: 6, time: 75, f: 1 } };
const MEMO_ICONS = ['tank', 'jet', 'ship', 'missile', 'radar', 'sub', 'heli', 'sat', 'shield', 'flag', 'map', 'key'];
// ---- cipher ----
const MSGS = ['THE NORTHERN FLEET SAILS AT DAWN AND RETURNS BEFORE THE STORM', 'MEET THE COURIER AT THE OLD BRIDGE WHEN THE CLOCK STRIKES NINE', 'THE HARVEST WAS GOOD AND THE GRAIN SHIPS LEAVE PORT TOMORROW', 'KEEP THE RESERVES HIDDEN IN THE HILLS UNTIL THE SIGNAL IS GIVEN', 'THE AMBASSADOR ARRIVES BY TRAIN AND EXPECTS A QUIET WELCOME', 'MOVE THE GOLD TO THE MOUNTAIN VAULT BEFORE THE FIRST SNOW FALLS', 'THE ENGINEERS FINISH THE TUNNEL NEXT WEEK IF THE WEATHER HOLDS', 'SEND THREE SQUADRONS SOUTH AND HOLD THE REST AT THE CAPITAL',
  'THE RADIO TOWER ON THE RIDGE MUST BE REPAIRED BEFORE NIGHTFALL', 'OUR SCOUTS REPORT HEAVY RAIN AND FLOODED ROADS IN THE EAST', 'THE TREATY WILL BE SIGNED IN THE GREAT HALL AT NOON ON FRIDAY', 'LOAD THE SUPPLY TRUCKS TONIGHT AND TAKE THE COAST ROAD NORTH', 'THE HARBOR MASTER WANTS EVERY SHIP INSPECTED BEFORE IT SAILS', 'TELL THE GOVERNOR THE BRIDGE IS SAFE AND THE MARKET IS OPEN'];
const CIPHER_HINTS = { easy: 6, medium: 4, hard: 2 };
// ---- sniper ----
const SNIPE = { easy: { sp: .75, r: 13 }, medium: { sp: 1, r: 10 }, hard: { sp: 1.3, r: 8 } };
const snipePos = (q, t) => ({ x: 150 + 105 * Math.sin(t * q.w1 + q.p1), y: 118 + 34 * Math.sin(t * q.w2 + q.p2) });
// ---- vault ----
const SAFE = { easy: { n: 3, time: 60 }, medium: { n: 3, time: 50 }, hard: { n: 4, time: 55 } };
// ---- missile defense: a 300 x 200 radar; cities along the bottom ----
const MSL = { W: 300, H: 200, cityY: 188, cities: [30, 78, 126, 174, 222, 270], R: 17, fuse: .45, burn: .5,
  easy: { n: 9, int: 12, d0: 7, d1: 9, time: 34 }, medium: { n: 13, int: 15, d0: 5.5, d1: 7.5, time: 36 }, hard: { n: 18, int: 19, d0: 4.5, d1: 6.5, time: 38 } };
const mslPos = (m, t) => { const f = (t - m.t) / m.d; return { x: m.x0 + (MSL.cities[m.c] - m.x0) * f, y: MSL.cityY * f }; };
// ---- pin the capital: [name, country, lon, lat, tier] (1 = famous, 3 = hard) ----
const CAPS = [['Washington', 'United States', -77.04, 38.9, 1], ['Ottawa', 'Canada', -75.7, 45.42, 1], ['Mexico City', 'Mexico', -99.13, 19.43, 1], ['Brasília', 'Brazil', -47.88, -15.79, 2], ['Buenos Aires', 'Argentina', -58.38, -34.6, 1], ['Lima', 'Peru', -77.04, -12.05, 2], ['Bogotá', 'Colombia', -74.07, 4.71, 2], ['Santiago', 'Chile', -70.67, -33.45, 2], ['Havana', 'Cuba', -82.37, 23.11, 2],
  ['London', 'United Kingdom', -0.13, 51.51, 1], ['Paris', 'France', 2.35, 48.86, 1], ['Madrid', 'Spain', -3.7, 40.42, 1], ['Rome', 'Italy', 12.5, 41.9, 1], ['Berlin', 'Germany', 13.4, 52.52, 1], ['Moscow', 'Russia', 37.62, 55.75, 1], ['Athens', 'Greece', 23.73, 37.98, 1], ['Stockholm', 'Sweden', 18.07, 59.33, 2], ['Oslo', 'Norway', 10.75, 59.91, 2], ['Warsaw', 'Poland', 21.01, 52.23, 2], ['Kyiv', 'Ukraine', 30.52, 50.45, 2], ['Lisbon', 'Portugal', -9.14, 38.72, 2], ['Dublin', 'Ireland', -6.26, 53.35, 2], ['Vienna', 'Austria', 16.37, 48.21, 2], ['Helsinki', 'Finland', 24.94, 60.17, 2], ['Reykjavík', 'Iceland', -21.94, 64.15, 2], ['Bucharest', 'Romania', 26.1, 44.43, 3], ['Budapest', 'Hungary', 19.04, 47.5, 3], ['Belgrade', 'Serbia', 20.46, 44.79, 3],
  ['Cairo', 'Egypt', 31.24, 30.04, 1], ['Nairobi', 'Kenya', 36.82, -1.29, 2], ['Pretoria', 'South Africa', 28.19, -25.75, 2], ['Abuja', 'Nigeria', 7.49, 9.06, 3], ['Addis Ababa', 'Ethiopia', 38.75, 9.02, 2], ['Rabat', 'Morocco', -6.85, 34.02, 3], ['Algiers', 'Algeria', 3.06, 36.75, 3], ['Accra', 'Ghana', -0.19, 5.6, 3], ['Dakar', 'Senegal', -17.47, 14.72, 3], ['Kinshasa', 'DR Congo', 15.27, -4.44, 3], ['Luanda', 'Angola', 13.23, -8.84, 3], ['Antananarivo', 'Madagascar', 47.52, -18.88, 3], ['Khartoum', 'Sudan', 32.56, 15.5, 3],
  ['Beijing', 'China', 116.4, 39.9, 1], ['Tokyo', 'Japan', 139.69, 35.69, 1], ['New Delhi', 'India', 77.21, 28.61, 1], ['Seoul', 'South Korea', 126.98, 37.57, 1], ['Bangkok', 'Thailand', 100.5, 13.76, 2], ['Jakarta', 'Indonesia', 106.85, -6.21, 2], ['Manila', 'Philippines', 120.98, 14.6, 2], ['Hanoi', 'Vietnam', 105.83, 21.03, 2], ['Tehran', 'Iran', 51.39, 35.69, 2], ['Baghdad', 'Iraq', 44.36, 33.31, 2], ['Riyadh', 'Saudi Arabia', 46.68, 24.71, 2], ['Ankara', 'Turkey', 32.85, 39.93, 2], ['Islamabad', 'Pakistan', 73.05, 33.68, 3], ['Kabul', 'Afghanistan', 69.17, 34.56, 3], ['Ulaanbaatar', 'Mongolia', 106.91, 47.92, 3], ['Astana', 'Kazakhstan', 71.43, 51.17, 3], ['Kathmandu', 'Nepal', 85.32, 27.72, 3], ['Dhaka', 'Bangladesh', 90.41, 23.81, 3], ['Kuala Lumpur', 'Malaysia', 101.69, 3.14, 3], ['Tashkent', 'Uzbekistan', 69.24, 41.3, 3],
  ['Canberra', 'Australia', 149.13, -35.28, 1], ['Wellington', 'New Zealand', 174.78, -41.29, 2], ['Port Moresby', 'Papua New Guinea', 147.18, -9.44, 3]];
const CAP = { easy: { n: 6, tiers: [1], time: 70, d0: 350, d1: 3000 }, medium: { n: 8, tiers: [1, 2], time: 85, d0: 250, d1: 2500 }, hard: { n: 10, tiers: [2, 3], time: 100, d0: 200, d1: 2000 } };
const kmBetween = (a, b) => { const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r, x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(x))); };
// ---- border checkpoint: every name and nation here is invented ----
const BN = ['Arvenia', 'Kaldor', 'Mirelle', 'Norvik', 'Sarenne', 'Tovaria', 'Velmora', 'Draskel', 'Elberon'];
const BFIRST = ['Anja', 'Bram', 'Cira', 'Dov', 'Elke', 'Finn', 'Gita', 'Halvor', 'Ines', 'Jarek', 'Kaya', 'Lorn', 'Mira', 'Nilo', 'Orla', 'Pavo', 'Rhea', 'Soren', 'Tamsin', 'Ulrik', 'Vesna', 'Yorick'];
const BLAST = ['Aldane', 'Brevik', 'Corvane', 'Dunmar', 'Estrel', 'Farrow', 'Golven', 'Harrek', 'Ilvane', 'Jorund', 'Kestrel', 'Lomar', 'Marek', 'Norwen', 'Ostrel', 'Pellan', 'Rasmar', 'Selvik', 'Torvald', 'Vantor'];
const BPURP = [['Tourism', 'Tourist visa'], ['Work', 'Work permit'], ['Transit', 'Transit pass'], ['Diplomacy', 'Diplomatic seal']];
const BMON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BORDER = { easy: { n: 8, rules: ['exp', 'ban'], time: 60 }, medium: { n: 10, rules: ['exp', 'permit', 'ban'], time: 60 }, hard: { n: 12, rules: ['exp', 'permit', 'ban', 'seal', 'stay'], time: 65 } };
const bDate = d => `${d.d} ${BMON[d.m]} ${d.y}`;
// ---- market sprint ----
const MKTS = { easy: { n: 80, vol: .007, s0: .012, s1: .02, l0: 9, l1: 16, alt: .85 }, medium: { n: 90, vol: .011, s0: .012, s1: .024, l0: 7, l1: 14, alt: .75 }, hard: { n: 90, vol: .016, s0: .012, s1: .028, l0: 5, l1: 11, alt: .65 }, tick: .5, cash: 1000, fee: .004 };
function mktBest(P) { let cash = MKTS.cash, hold = 0; for (const p of P) { const c2 = Math.max(cash, hold * p * (1 - MKTS.fee)), h2 = Math.max(hold, cash * (1 - MKTS.fee) / p); cash = c2; hold = h2; } return cash; }
function mktPlay(P, acts) { let cash = MKTS.cash, units = 0, last = -1, n = 0; for (const a of acts) { const k = Math.round(+a.k); if (!(k > last) || k >= P.length) continue; if (a.a === 'b' && units === 0 && cash > 0) { units = cash * (1 - MKTS.fee) / P[k]; cash = 0; last = k; n++; } else if (a.a === 's' && units > 0) { cash = units * P[k] * (1 - MKTS.fee); units = 0; last = k; n++; } } if (units > 0) cash = units * P[P.length - 1] * (1 - MKTS.fee); return { cash, trades: n }; }

function make(op, lvl, seed) {
  const L = LVLS.includes(lvl) ? lvl : 'medium', r = rngOf(seed);
  if (op === 'warplans') { const M = MEMO[L], ic = r.shuffle(MEMO_ICONS.slice()), cards = []; for (const x of ic.slice(0, M.pairs)) cards.push(x, x); r.shuffle(cards);
    return { secret: { cards, lvl: L }, pub: { kind: 'memory', cards, lvl: L, pairs: M.pairs, show: M.show, time: M.time } }; }
  if (op === 'assassinate') { const S_ = SNIPE[L], q = { w1: (.45 + r() * .35) * S_.sp, w2: (.9 + r() * .6) * S_.sp, p1: r() * 6.28, p2: r() * 6.28, r: S_.r };
    return { secret: q, pub: { kind: 'sniper', ...q, lvl: L, time: 30, bullets: 3, gen: { name: 'Range target', stars: 0 } } }; }
  if (op === 'heist') { const S_ = SAFE[L], combo = [], dirs = []; while (combo.length < S_.n) { const x = r.int(4, 96); if (combo.every(c => Math.abs(c - x) > 8)) combo.push(x); } for (let i = 0; i < S_.n; i++) dirs.push(i % 2 ? 'left' : 'right');
    return { secret: combo, pub: { kind: 'safe', combo, dirs, lvl: L, time: S_.time } }; }
  if (op === 'cipher') { const plain = r.pick(MSGS), A_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), sh = r.shuffle(A_.slice()); for (let i = 0; i < 26; i++) if (sh[i] === A_[i]) { const j = (i + 1) % 26; [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const enc = {}; A_.forEach((c, i) => enc[c] = sh[i]); const cipher = plain.split('').map(c => enc[c] || c).join('');
    const used = [...new Set(plain.replace(/[^A-Z]/g, '').split(''))], freq = {}; for (const c of plain) if (enc[c]) freq[c] = (freq[c] || 0) + 1; const H = CIPHER_HINTS[L];
    const hints = used.slice().sort((a, b) => freq[b] - freq[a] || (a < b ? -1 : 1)).slice(0, 2).concat(r.shuffle(used.filter(c => 'AEIOU'.indexOf(c) < 0))); const give = {}; for (const c of [...new Set(hints)].slice(0, H)) give[enc[c]] = c;
    return { secret: plain, pub: { kind: 'cipher', cipher, give, lvl: L, time: 150 } }; }
  if (op === 'missile') { const M = MSL[L], ms = [], span = M.time - M.d1 - 2; const order = r.shuffle([0, 1, 2, 3, 4, 5]);
    for (let i = 0; i < M.n; i++) { const c = i < 6 ? order[i] : r.int(0, 6), wave = Math.floor(i / 3), t = clamp(wave * (span / Math.ceil(M.n / 3)) + r() * 2.2, .6, span); ms.push({ t: Math.round(t * 100) / 100, x0: Math.round(10 + r() * 280), c, d: Math.round((M.d0 + r() * (M.d1 - M.d0)) * 100) / 100 }); }
    ms.sort((a, b) => a.t - b.t);
    return { secret: { ms, lvl: L }, pub: { kind: 'missile', ms, lvl: L, time: M.time, int: M.int, cities: MSL.cities, cityY: MSL.cityY, W: MSL.W, H: MSL.H, R: MSL.R, fuse: MSL.fuse, burn: MSL.burn } }; }
  if (op === 'capital') { const K = CAP[L], pool = r.shuffle(CAPS.filter(c => K.tiers.includes(c[4]))).slice(0, K.n), caps = pool.map(c => ({ n: c[0], co: c[1], lon: c[2], lat: c[3] }));
    return { secret: { caps, lvl: L }, pub: { kind: 'capital', caps, lvl: L, time: K.time, d0: K.d0, d1: K.d1 } }; }
  if (op === 'border') { const K = BORDER[L], today = { d: r.int(2, 28), m: r.int(0, 12), y: 2031 }, banned = r.pick(BN), people = [], truth = [];
    const base = Date.UTC(today.y, today.m, today.d), dt = ms => { const D = new Date(ms); return { d: D.getUTCDate(), m: D.getUTCMonth(), y: D.getUTCFullYear() }; };
    const after = () => dt(base + r.int(20, 700) * 864e5), before = () => dt(base - r.int(2, 500) * 864e5);
    for (let i = 0; i < K.n; i++) { const okNations = BN.filter(n => n !== banned), nat = r.pick(okNations), pu = r.pick(BPURP);
      const t = { name: `${r.pick(BFIRST)} ${r.pick(BLAST)}`, nat, exp: after(), purpose: pu[0], permit: pu[1], seal: `${nat.slice(0, 2).toUpperCase()}-${r.int(1000, 9999)}`, stay: r.int(2, 30) }; let bad = null;
      if (r() < .5) { bad = r.pick(K.rules);
        if (bad === 'exp') t.exp = before(); else if (bad === 'ban') { t.nat = banned; t.seal = `${banned.slice(0, 2).toUpperCase()}-${r.int(1000, 9999)}`; } else if (bad === 'permit') t.permit = r.pick(BPURP.filter(x => x[0] !== t.purpose))[1];
        else if (bad === 'seal') t.seal = `${r.pick(BN.filter(n => n.slice(0, 2) !== t.nat.slice(0, 2))).slice(0, 2).toUpperCase()}-${r.int(1000, 9999)}`; else if (bad === 'stay') t.stay = r.int(31, 90); }
      people.push({ name: t.name, nat: t.nat, exp: bDate(t.exp), purpose: t.purpose, permit: t.permit, seal: t.seal, stay: t.stay }); truth.push(bad ? 0 : 1); }
    const RT = { exp: 'The passport must not have expired.', permit: 'The permit must match the purpose of the visit.', ban: `No entry for travellers from ${banned}.`, seal: 'The seal code must start with the first two letters of the traveller\'s nation.', stay: 'Nobody may stay longer than 30 days.' };
    return { secret: { truth, lvl: L }, pub: { kind: 'border', people, rules: K.rules.map(k => RT[k]), today: bDate(today), lvl: L, time: K.time, show: { seal: K.rules.includes('seal'), stay: K.rules.includes('stay'), permit: K.rules.includes('permit') } } }; }
  if (op === 'market') { const K = MKTS[L], P = [100]; let drift = 0, left = 0, sign = r() < .5 ? 1 : -1; // clear waves a person can ride, with noise on top; harder levels turn faster and fake more
    for (let i = 1; i < K.n; i++) { if (left-- <= 0) { sign = r() < K.alt ? -sign : sign; if (P[i - 1] > 190) sign = -1; if (P[i - 1] < 55) sign = 1; drift = sign * (K.s0 + r() * (K.s1 - K.s0)); left = r.int(K.l0, K.l1); } P.push(Math.round(clamp(P[i - 1] * (1 + drift + (r() - .5) * 2 * K.vol), 30, 320) * 100) / 100); }
    return { secret: { P, lvl: L }, pub: { kind: 'market', P, lvl: L, time: K.n * MKTS.tick, tick: MKTS.tick, cash: MKTS.cash, fee: MKTS.fee } }; }
  throw new Error('Unknown game.');
}

// what the player did -> a score from 0 to 1 and a short reason. secs = seconds since the puzzle was handed out.
function score(op, secret, b, secs) {
  b = b || {};
  if (op === 'warplans') { const S_ = secret, M = MEMO[S_.lvl], flips = Array.isArray(b.flips) ? b.flips.slice(0, 200) : []; let last = M.show - .3, open = null, matched = new Set(), miss = 0;
    for (const f of flips) { const i = Math.round(+f.i), t = +f.t; if (!(i >= 0 && i < S_.cards.length) || !(t >= last) || t > secs + 1.5) return { skill: 0, why: 'the flips did not add up' }; last = t; if (matched.has(i) || i === open) continue;
      if (open == null) { open = i; continue; } if (S_.cards[open] === S_.cards[i]) { matched.add(open); matched.add(i); } else miss++; open = null; }
    const pairs = matched.size / 2, all = pairs === M.pairs; if (all && last < M.show + M.pairs * .9) return { skill: 0, why: 'too fast to be real' };
    const tf = clamp(1 - (last - M.show - M.pairs * 2) / (M.time - M.show), 0, 1);
    const skill = all ? clamp((.55 + .45 * tf - .06 * miss) * M.f, .3, 1) : Math.max(0, pairs / M.pairs * .45 * M.f - .03 * miss);
    return { skill, why: `${pairs} of ${M.pairs} pairs${all ? ` in ${Math.round(last)} s` : ''}${miss ? ` with ${miss} wrong match${miss > 1 ? 'es' : ''}` : ''}` }; }
  if (op === 'assassinate') { const shots = Array.isArray(b.shots) ? b.shots.slice(0, 3) : [], R = secret.r || 10; let last = 0, miss = 0;
    for (const sh of shots) { const t = +sh.t, x = +sh.x, y = +sh.y; if (!(t >= 1.2) || t > secs + 1.5 || t < last || !isFinite(x) || !isFinite(y)) return { skill: 0, why: 'the shot did not add up' }; last = t;
      const q = snipePos(secret, t), d = Math.hypot(q.x - x, q.y - y); if (d <= R) { const qual = Math.max(.5, 1 - d / (2 * R)); return { skill: clamp(qual - .15 * miss, .2, 1), why: `${d <= R * .3 ? 'a clean hit' : 'a hit'} with bullet ${miss + 1}${miss ? ` after ${miss} miss${miss > 1 ? 'es' : ''}` : ''}` }; } miss++; }
    return { skill: 0, why: shots.length ? `all ${shots.length} shot${shots.length > 1 ? 's' : ''} missed` : 'no shot was taken' }; }
  if (op === 'heist') { const N = secret.length, ans = Array.isArray(b.combo) ? b.combo.slice(0, N).map(x => Math.round(+x)) : [], wrong = clamp(Math.round(+b.wrong || 0), 0, 10);
    const right = secret.filter((c, i) => ans[i] === c).length; if (right < N) return { skill: right * .08, why: right ? `${right} of ${N} numbers` : 'the vault stayed shut' };
    if (secs < N * 1.4) return { skill: 0, why: 'too fast to be real' };
    const t = clamp(1 - (secs - N * 3.3) / 40, 0, 1); return { skill: clamp(.45 + .55 * t - .12 * wrong, .25, 1), why: `cracked in ${Math.round(secs)} s${wrong ? ` with ${wrong} wrong guess${wrong > 1 ? 'es' : ''}` : ''}` }; }
  if (op === 'cipher') { const guess = String(b.text || '').toUpperCase().slice(0, 400), P_ = secret; let ok_ = 0, tot = 0; for (let i = 0; i < P_.length; i++) if (/[A-Z]/.test(P_[i])) { tot++; if (guess[i] === P_[i]) ok_++; }
    const acc = tot ? ok_ / tot : 0; if (acc >= .98 && secs < 6) return { skill: 0, why: 'too fast to be real' };
    const t = clamp(1 - (secs - 25) / 125, 0, 1); return { skill: clamp(acc * acc * (.55 + .45 * t), 0, 1), why: `${Math.round(acc * 100)}% decoded in ${Math.round(secs)} s` }; }
  if (op === 'missile') { const M = MSL[secret.lvl], taps = Array.isArray(b.taps) ? b.taps.slice(0, 60) : [], used = []; let last = -1;
    for (const tp of taps) { const t = +tp.t, x = +tp.x, y = +tp.y; if (!(t >= 0) || !isFinite(x) || !isFinite(y) || t > secs + 1.5 || t > M.time + 1) return { skill: 0, why: 'the shots did not add up' }; if (t < last + .1) continue; last = t; if (used.length < M.int) used.push({ t, x: clamp(x, 0, MSL.W), y: clamp(y, 0, MSL.H) }); }
    const dead = new Set(); let shot = 0;
    secret.ms.forEach((m, i) => { for (const tp of used) { const a = Math.max(tp.t + MSL.fuse, m.t), z = Math.min(tp.t + MSL.fuse + MSL.burn, m.t + m.d); let hit = false; for (let t = a; t <= z + 1e-9; t += .04) { const p = mslPos(m, t); if (Math.hypot(p.x - tp.x, p.y - tp.y) <= MSL.R) { hit = true; break; } } if (hit) { shot++; return; } } dead.add(m.c); });
    const saved = 6 - dead.size, leftI = M.int - used.length, eff = clamp(leftI / Math.max(1, M.int - Math.ceil(M.n * .55)), 0, 1);
    if (saved === 6 && used.length < Math.ceil(M.n / 4)) return { skill: 0, why: 'too few shots to be real' };
    return { skill: clamp(saved / 6 * (.75 + .25 * eff), 0, 1), why: `${saved} of 6 cities saved, ${shot} of ${secret.ms.length} missiles shot down, ${leftI} interceptor${leftI === 1 ? '' : 's'} left` }; }
  if (op === 'capital') { const K = CAP[secret.lvl], pins = Array.isArray(b.pins) ? b.pins.slice(0, K.n) : []; let last = 0, tot = 0, n = 0, sumD = 0;
    for (let i = 0; i < pins.length; i++) { const pn = pins[i], t = +pn.t, lon = +pn.lon, lat = +pn.lat; if (!(t >= last + .4) || t > secs + 1.5 || !(lon >= -180 && lon <= 180) || !(lat >= -90 && lat <= 90)) return { skill: 0, why: 'the pins did not add up' }; last = t;
      const c = secret.caps[i], d = kmBetween([lon, lat], [c.lon, c.lat]); sumD += d; n++; tot += clamp(1 - (d - K.d0) / (K.d1 - K.d0), 0, 1); }
    if (n === K.n && sumD / n < 40 && last < K.n * 1.5) return { skill: 0, why: 'too fast to be real' };
    const tf = clamp(1 - (last - K.n * 3) / (K.time - K.n * 3), 0, 1), avg = n ? Math.round(sumD / n) : 0;
    return { skill: clamp(tot / K.n * (.85 + .15 * tf), 0, 1), why: n ? `${n} of ${K.n} capitals pinned, ${avg.toLocaleString('en-US')} km off on average` : 'no capital was pinned' }; }
  if (op === 'border') { const K = BORDER[secret.lvl], ans = Array.isArray(b.ans) ? b.ans.slice(0, K.n) : []; let last = 0, c = 0, w = 0;
    for (let i = 0; i < ans.length; i++) { const t = +ans[i].t; if (!(t >= last + .3) || t > secs + 1.5) return { skill: 0, why: 'the decisions did not add up' }; last = t; if ((ans[i].a ? 1 : 0) === secret.truth[i]) c++; else w++; }
    if (c === K.n && last < K.n * .8) return { skill: 0, why: 'too fast to be real' };
    const tf = clamp(1 - (last - K.n * 2) / (K.time - K.n * 2), 0, 1);
    return { skill: clamp((c - .75 * w) / K.n * (.8 + .2 * tf), 0, 1), why: `${c} of ${K.n} right${w ? `, ${w} wrong` : ''}${ans.length < K.n ? `, ${K.n - ans.length} not seen` : ''}` }; }
  if (op === 'market') { const P = secret.P, acts = (Array.isArray(b.acts) ? b.acts.slice(0, 80) : []).filter(a => a && (a.a === 'b' || a.a === 's')); const nowK = Math.floor(secs / MKTS.tick) + 3;
    if (acts.some(a => Math.round(+a.k) > nowK)) return { skill: 0, why: 'the trades did not add up' };
    const r = mktPlay(P, acts), best = mktBest(P), ratio = r.cash > MKTS.cash && best > MKTS.cash ? Math.log(r.cash / MKTS.cash) / Math.log(best / MKTS.cash) : 0;
    if (ratio > .94) return { skill: 0, why: 'too perfect to be real' };
    const cash = Math.round(r.cash); return { skill: clamp(ratio / .82, 0, 1), why: r.trades ? `turned $${MKTS.cash.toLocaleString('en-US')} into $${cash.toLocaleString('en-US')} in ${r.trades} trade${r.trades === 1 ? '' : 's'}` : 'no trades were made' }; }
  return { skill: 0, why: 'unknown game' };
}
// what to show after the round (the decoded message, the real places, the right calls)
function reveal(op, secret) { if (op === 'cipher') return { plain: secret }; if (op === 'border') return { truth: secret.truth }; if (op === 'market') return { best: Math.round(mktBest(secret.P)) }; return {}; }
module.exports = { OPS, LVLS, DUEL_NAMES, TITLES, make, score, reveal, MSL, mslPos, CAPS, kmBetween, MKTS, mktBest, mktPlay, snipePos, rngOf };
