// World Powers poker: no-limit Texas Hold'em between nations.
// Pure table logic: the server owns the money (buy-ins and cash-outs) and decides who sees what.
'use strict';
const crypto = require('crypto');

const SUITS = ['♠', '♥', '♦', '♣'];
const NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const RANKN = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
const plural = v => v === 6 ? 'Sixes' : RANKN[v] + 's';
const SEATS = 6, TURN_MS = 25e3, NEXT_MS = 6e3, RAKE = .02, RAKE_BB = 2;

function newDeck() { const d = []; for (const s of SUITS) for (let v = 2; v <= 14; v++) d.push({ v, s }); for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; } return d; }

// ---- hand ranking: best five of seven ----
function rank5(cs) {
  const vs = cs.map(c => c.v).sort((a, b) => b - a), fl = cs.every(c => c.s === cs[0].s);
  const cnt = {}; for (const v of vs) cnt[v] = (cnt[v] || 0) + 1;
  const groups = Object.entries(cnt).map(([v, n]) => [n, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const uniq = [...new Set(vs)]; let st = 0;
  if (uniq.length === 5) { if (uniq[0] - uniq[4] === 4) st = uniq[0]; else if (uniq.join() === '14,5,4,3,2') st = 5; }
  let cat, keys;
  if (st && fl) { cat = 8; keys = [st]; }
  else if (groups[0][0] === 4) { cat = 7; keys = [groups[0][1], groups[1][1]]; }
  else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; keys = [groups[0][1], groups[1][1]]; }
  else if (fl) { cat = 5; keys = vs; }
  else if (st) { cat = 4; keys = [st]; }
  else if (groups[0][0] === 3) { cat = 3; keys = groups.map(g => g[1]); }
  else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; keys = groups.map(g => g[1]); }
  else if (groups[0][0] === 2) { cat = 1; keys = groups.map(g => g[1]); }
  else { cat = 0; keys = vs; }
  let score = cat; for (let i = 0; i < 5; i++) score = score * 15 + (keys[i] || 0);
  return { score, cat, keys };
}
function best(cards) {
  let top = null;
  for (let a = 0; a < cards.length; a++) for (let b = a + 1; b < cards.length; b++) {
    const five = cards.filter((_, i) => i !== a && i !== b); if (five.length !== 5) continue; const r = rank5(five); if (!top || r.score > top.score) top = { ...r, cards: five };
  }
  if (cards.length === 5) { const r = rank5(cards); top = { ...r, cards }; }
  return top;
}
function handName(r) {
  const k = r.keys;
  switch (r.cat) {
    case 8: return k[0] === 14 ? 'Royal flush' : `Straight flush, ${RANKN[k[0]]} high`;
    case 7: return `Four ${plural(k[0])}`;
    case 6: return `Full house, ${plural(k[0])} over ${plural(k[1])}`;
    case 5: return `Flush, ${RANKN[k[0]]} high`;
    case 4: return `Straight, ${RANKN[k[0]]} high`;
    case 3: return `Three ${plural(k[0])}`;
    case 2: return `Two pair, ${plural(k[0])} and ${plural(k[1])}`;
    case 1: return `Pair of ${plural(k[0])}`;
    default: return `${RANKN[k[0]]} high`;
  }
}

// ---- table ----
function newTable(id, name, sb, bb, min, max) { return { id, name, sb, bb, min, max, seats: Array(SEATS).fill(null), btn: -1, hand: null, next: 0, hist: [], handNo: 0 }; }
const occupied = t => t.seats.map((s, i) => s ? i : -1).filter(i => i >= 0);
const ready = t => t.seats.map((s, i) => s && !s.sitOut && !s.leaving && s.stack >= t.bb ? i : -1).filter(i => i >= 0);
const nextOf = (list, from) => { const sorted = [...list].sort((a, b) => a - b); return sorted.find(i => i > from) ?? sorted[0]; };

function startHand(t, now) {
  const r = ready(t); if (r.length < 2) return false;
  const H = { no: ++t.handNo, deck: newDeck(), board: [], street: 'pre', p: {}, curBet: 0, minRaise: t.bb, raiseId: 0, toAct: -1, deadline: 0, started: now, done: null, flop: false, log: [] };
  for (const i of r) H.p[i] = { u: t.seats[i].u, hole: [], bet: 0, total: 0, folded: false, allin: false, acted: false, ack: -1 };
  t.btn = nextOf(r, t.btn); const heads = r.length === 2;
  const sbI = heads ? t.btn : nextOf(r, t.btn), bbI = nextOf(r, sbI);
  for (let k = 0; k < 2; k++) for (const i of order(r, t.btn)) H.p[i].hole.push(H.deck.pop());
  t.hand = H; post(t, sbI, t.sb); post(t, bbI, t.bb); H.curBet = t.bb; H.sbI = sbI; H.bbI = bbI;
  H.toAct = nextActor(t, bbI); H.deadline = now + TURN_MS;
  if (H.toAct < 0) runOut(t, now); // everyone is all-in from the blinds
  return true;
}
function order(list, btn) { const out = []; let i = btn; for (let k = 0; k < list.length; k++) { i = nextOf(list, i); out.push(i); } return out; }
function post(t, i, amt) { const s = t.seats[i], P = t.hand.p[i], a = Math.min(amt, s.stack); s.stack -= a; P.bet += a; P.total += a; if (s.stack === 0) P.allin = true; }
// the next seat after `from` that still has a decision to make
function nextActor(t, from) {
  const H = t.hand, live = Object.keys(H.p).map(Number).filter(i => !H.p[i].folded && !H.p[i].allin);
  if (!live.length) return -1;
  const need = live.filter(i => !H.p[i].acted || H.p[i].bet < H.curBet);
  if (!need.length) return -1;
  // a single player left who has matched the bet does not need to act
  if (live.length === 1 && H.p[live[0]].bet >= H.curBet) return -1;
  return nextOf(need, from);
}
const inHand = H => Object.keys(H.p).map(Number).filter(i => !H.p[i].folded);
function legal(t, i) {
  const H = t.hand; if (!H || H.done || H.toAct !== i) return null; const P = H.p[i], s = t.seats[i];
  const toCall = Math.max(0, Math.min(H.curBet - P.bet, s.stack)), canRaise = s.stack > toCall && (P.ack !== H.raiseId || !P.acted);
  const others = inHand(H).filter(j => j !== i && !H.p[j].allin).length;
  const minTo = Math.min(P.bet + s.stack, H.curBet + H.minRaise), maxTo = P.bet + s.stack;
  return { toCall, check: toCall === 0, canRaise: canRaise && others > 0, minTo, maxTo, curBet: H.curBet, pot: potTotal(H) };
}
const potTotal = H => Object.values(H.p).reduce((a, P) => a + P.total, 0);
function act(t, i, a, amt, now) {
  const H = t.hand, L = legal(t, i); if (!L) throw new Error('It is not your turn.');
  const P = H.p[i], s = t.seats[i];
  if (a === 'fold') { P.folded = true; H.log.push([i, 'fold']); }
  else if (a === 'check') { if (!L.check) throw new Error('You cannot check: there is a bet to call.'); P.acted = true; P.ack = H.raiseId; H.log.push([i, 'check']); }
  else if (a === 'call') { if (L.check) { P.acted = true; P.ack = H.raiseId; H.log.push([i, 'check']); } else { s.stack -= L.toCall; P.bet += L.toCall; P.total += L.toCall; if (!s.stack) P.allin = true; P.acted = true; P.ack = H.raiseId; H.log.push([i, P.allin ? 'allin' : 'call', L.toCall]); } }
  else if (a === 'raise' || a === 'allin') {
    if (!L.canRaise && !(a === 'allin' && L.toCall >= s.stack)) throw new Error('You can only call or fold now.');
    let to = a === 'allin' ? L.maxTo : Math.floor(+amt);
    if (!Number.isFinite(to)) throw new Error('Enter an amount.');
    to = Math.min(to, L.maxTo); if (to < L.minTo) throw new Error(`The smallest raise is to ${L.minTo}.`);
    if (to <= H.curBet) { return act(t, i, 'call', 0, now); }
    const add = to - P.bet; s.stack -= add; P.bet = to; P.total += add; if (!s.stack) P.allin = true;
    const inc = to - H.curBet; if (inc >= H.minRaise) { H.minRaise = inc; H.raiseId++; }
    H.curBet = to; P.acted = true; P.ack = H.raiseId;
    for (const j of Object.keys(H.p).map(Number)) if (j !== i && !H.p[j].folded && !H.p[j].allin) H.p[j].acted = false;
    H.log.push([i, P.allin ? 'allin' : 'raise', to]);
  } else throw new Error('Unknown action.');
  advance(t, i, now);
}
function advance(t, from, now) {
  const H = t.hand, alive = inHand(H);
  if (alive.length === 1) return finish(t, now);
  const nx = nextActor(t, from);
  if (nx >= 0) { H.toAct = nx; H.deadline = now + TURN_MS; return; }
  // the betting round is over
  const canBet = alive.filter(i => !H.p[i].allin);
  if (H.street === 'river') return finish(t, now);
  if (canBet.length <= 1) return runOut(t, now);
  nextStreet(t); H.toAct = nextActor(t, t.btn); H.deadline = now + TURN_MS;
  if (H.toAct < 0) runOut(t, now);
}
function nextStreet(t) {
  const H = t.hand; for (const P of Object.values(H.p)) { P.bet = 0; P.acted = false; P.ack = -1; } H.curBet = 0; H.minRaise = t.bb; H.raiseId++;
  if (H.street === 'pre') { H.deck.pop(); H.board.push(H.deck.pop(), H.deck.pop(), H.deck.pop()); H.street = 'flop'; H.flop = true; }
  else if (H.street === 'flop') { H.deck.pop(); H.board.push(H.deck.pop()); H.street = 'turn'; }
  else if (H.street === 'turn') { H.deck.pop(); H.board.push(H.deck.pop()); H.street = 'river'; }
}
function runOut(t, now) { const H = t.hand; while (H.board.length < 5) { if (H.street === 'pre') H.flop = true; nextStreet(t); } H.ranOut = true; finish(t, now); }
// settle: side pots, rake, winners. Returns nothing; results stay on the hand for everyone to see.
function finish(t, now) {
  const H = t.hand, alive = inHand(H), ids = Object.keys(H.p).map(Number);
  const pot = potTotal(H), tots = ids.map(i => H.p[i].total).sort((a, b) => b - a), uncalled = tots.length > 1 && tots[0] > tots[1] ? tots[0] - tots[1] : 0;
  const rake = H.flop ? Math.min(Math.floor((pot - uncalled) * RAKE), RAKE_BB * t.bb) : 0; // never rake a bet nobody called
  const won = {}, shown = {}, names = {};
  if (alive.length === 1) { won[alive[0]] = pot - rake; }
  else {
    for (const i of alive) { const r = best([...H.p[i].hole, ...H.board]); H.p[i].rank = r; names[i] = handName(r); shown[i] = H.p[i].hole; }
    const levels = [...new Set(ids.map(i => H.p[i].total).filter(v => v > 0))].sort((a, b) => a - b); let prev = 0, rk = rake;
    for (const lv of levels) {
      let amt = 0; for (const i of ids) amt += Math.max(0, Math.min(H.p[i].total, lv) - prev);
      const elig = alive.filter(i => H.p[i].total >= lv); prev = lv; if (!amt) continue;
      const take = Math.min(rk, amt); amt -= take; rk -= take;
      if (!elig.length) { const back = ids.filter(i => H.p[i].total >= lv); for (const i of back) won[i] = (won[i] || 0) + Math.floor(amt / back.length); continue; }
      const top = Math.max(...elig.map(i => H.p[i].rank.score)), win = elig.filter(i => H.p[i].rank.score === top);
      const each = Math.floor(amt / win.length); let odd = amt - each * win.length;
      for (const i of order(win, t.btn)) { won[i] = (won[i] || 0) + each + (odd > 0 ? 1 : 0); odd--; }
    }
  }
  for (const [i, v] of Object.entries(won)) if (t.seats[i]) t.seats[i].stack += v;
  H.done = { t: now, pot, rake, won, shown, names, board: H.board.slice(), net: Object.fromEntries(ids.map(i => [H.p[i].u, (won[i] || 0) - H.p[i].total])) };
  H.toAct = -1; t.next = now + NEXT_MS + (alive.length > 1 ? 2e3 : 0);
  t.hist = [{ no: H.no, t: now, pot, rake, board: H.board.slice(), win: Object.entries(won).filter(e => e[1] > 0).map(([i, v]) => ({ u: H.p[i].u, amt: v, hand: names[i] || null })), shown: Object.fromEntries(Object.entries(shown).map(([i, c]) => [H.p[i].u, c])) }, ...t.hist].slice(0, 15);
}
// clock: auto-play for players who run out of time, start the next hand
function tick(t, now) {
  const H = t.hand; let changed = false;
  if (H && !H.done && H.toAct >= 0 && now >= H.deadline) {
    const i = H.toAct, L = legal(t, i), s = t.seats[i];
    act(t, i, L && L.check ? 'check' : 'fold', 0, now); if (s) { s.missed = (s.missed || 0) + 1; if (s.missed >= 2) s.sitOut = true; } changed = true;
  }
  if ((!t.hand || t.hand.done) && now >= t.next) {
    for (let i = 0; i < SEATS; i++) { const s = t.seats[i]; if (s && s.stack < t.bb && !s.sitOut) { s.sitOut = true; changed = true; } }
    if (t.hand && t.hand.done) { t.hand = null; changed = true; }
    if (startHand(t, now)) changed = true;
  }
  return changed;
}
// a player leaves or is removed in the middle of a hand: their cards are folded, wherever the action is
function foldOut(t, i, now) {
  const H = t.hand; if (!H || H.done || !H.p[i] || H.p[i].folded) return false;
  if (H.toAct === i) { act(t, i, 'fold', 0, now); return true; }
  H.p[i].folded = true; H.log.push([i, 'fold']);
  if (inHand(H).length === 1) finish(t, now); else if (H.toAct < 0) advance(t, H.toAct, now);
  return true;
}
// money held at the table for one seat (stack plus what is committed to the current pot)
const committed = (t, i) => t.hand && !t.hand.done && t.hand.p[i] ? t.hand.p[i].total : 0;

module.exports = { SEATS, TURN_MS, NEXT_MS, RAKE, RAKE_BB, newTable, startHand, act, foldOut, legal, tick, best, handName, rank5, potTotal, occupied, ready, inHand, committed, newDeck };
