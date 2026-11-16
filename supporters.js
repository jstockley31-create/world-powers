'use strict';
// Supporter rewards: PayPal donations linked to a player's account, verified with PayPal before any reward is given.
//
// How a donation is linked: the Donate page sends a signed-in player to PayPal with a private token in the `custom` field
// and our IPN address in `notify_url`. PayPal then posts the payment to /api/paypal/ipn. We send that exact message back to
// PayPal (cmd=_notify-validate) and only act when PayPal answers VERIFIED, the money went to OUR PayPal address, the payment
// is Completed, and the transaction id has not been seen before. Refunds and chargebacks take the donation back off the
// player's total, so their tier and perks drop with it. Nothing the player's browser says is ever trusted.
// Donations that can't be matched (paypal.me, a different currency, no token) wait for an admin to approve them.
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const TIERS = [ // lifetime USD total needed, name, badge
  { min: 0, n: '', b: '' },
  { min: 5, n: 'Supporter', b: '⭐' },
  { min: 20, n: 'Patron', b: '🌟' },
  { min: 50, n: 'Benefactor', b: '👑' }
];
const PERKS = { // per tier index
  rushDay: [0, 1, 10, 20],        // Rush orders per day: finish one operation's cooldown at once
  instantDay: [0, 0, 2, 4],       // Rapid redeployment per day: clear attack, strike and spy cooldowns and the army regroup
  chestMin: [0, 0, 10e6, 25e6],   // weekly war chest: the larger of this and a share of GDP, capped
  chestGdp: [0, 0, .05, .10],
  chestCap: [0, 0, 100e6, 250e6]
};
const DAY = 864e5, WEEK = 7 * DAY;
const dayKey = t => new Date(t).toISOString().slice(0, 10);

module.exports = function makeSupporters(ctx) {
  const { S, send, readBody, persist, setDoc, sendTo, broadcast, addNote, flag, logErr, MOD, WP, auditLog, siteUrl } = ctx;
  // always read the live state (a backup restore can replace S.sup)
  const sup = () => { const x = S.sup = S.sup || {}; x.cfg = x.cfg || { email: '', sandbox: false }; if (!(x.cfg.namePrice > 0)) x.cfg.namePrice = 10; x.users = x.users || {}; x.ipn = x.ipn || []; x.claims = x.claims || []; return x; };
  sup();
  const payEmail = () => String(process.env.PAYPAL_EMAIL || sup().cfg.email || '').trim().toLowerCase();
  const sandbox = () => process.env.PAYPAL_SANDBOX === '1' || !!sup().cfg.sandbox;
  const verifyUrl = () => process.env.PAYPAL_VERIFY_URL || (sandbox() ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr' : 'https://ipnpb.paypal.com/cgi-bin/webscr');
  const payUrl = () => sandbox() ? 'https://www.sandbox.paypal.com/cgi-bin/webscr' : 'https://www.paypal.com/cgi-bin/webscr';
  const U = uid => sup().users[uid] = sup().users[uid] || { total: 0, tx: {} };
  const total = uid => { const u = sup().users[uid]; if (!u) return 0; let t = 0; for (const x of Object.values(u.tx || {})) if (x.st === 'ok') t += x.usd || 0; return Math.round(t * 100) / 100; };
  const tierOf = uid => { const t = total(uid); let k = 0; for (let i = 1; i < TIERS.length; i++) if (t >= TIERS[i].min) k = i; return k; };
  const nationOf = uid => S.docs['nations/' + uid] || null;
  const userName = uid => (S.users[uid] || {}).name || 'a player';
  const log = (kind, x) => { sup().ipn.unshift({ t: Date.now(), kind, ...x }); sup().ipn = sup().ipn.slice(0, 300); };

  // the badge map every client gets: uid -> tier (only for supporters)
  const badges = () => { const out = {}; for (const uid of Object.keys(sup().users)) { const k = tierOf(uid); if (k) out[uid] = k; } return out; };
  const pushBadges = () => { try { broadcast('sup', badges()); } catch (e) {} };

  function tokenOf(uid) { const u = U(uid); if (!u.tok) { u.tok = crypto.randomBytes(9).toString('base64url'); persist(); } return u.tok; }
  const uidOfToken = tok => { if (!tok) return null; for (const [uid, u] of Object.entries(sup().users)) if (u.tok && u.tok === tok) return uid; return null; };

  // add or update one donation, then tell the player and everyone else about any tier change
  function record(uid, txn, d) {
    const u = U(uid), before = tierOf(uid);
    u.tx[txn] = { ...(u.tx[txn] || {}), ...d };
    const after = tierOf(uid);
    persist();
    if (after > before) {
      addNote(uid, 'rank', `${TIERS[after].b} Thank you for supporting World Powers! You are now a ${TIERS[after].n}. Your perks are ready: open the Donate page or More → Supporter perks.`);
      try { sendTo(uid, 'supme', view(uid)); } catch (e) {}
    } else if (after < before) {
      addNote(uid, 'rank', `Your supporter level changed to ${after ? TIERS[after].n : 'none'} because a donation was refunded or reversed.`);
      try { sendTo(uid, 'supme', view(uid)); } catch (e) {}
    } else { try { sendTo(uid, 'supme', view(uid)); } catch (e) {} }
    if (after !== before) pushBadges();
    if (!after && u.name) { delete u.name; }
    return { before, after };
  }

  // ---- PayPal IPN ----
  function readRaw(req, limit) { return new Promise((res, rej) => { let size = 0; const ch = []; req.on('data', c => { size += c.length; if (size > limit) { req.destroy(); rej(new Error('too big')); } else ch.push(c); }); req.on('end', () => res(Buffer.concat(ch).toString('utf8'))); req.on('error', rej); }); }
  function verify(raw) {
    return new Promise(resolve => {
      const body = 'cmd=_notify-validate&' + raw, url = new URL(verifyUrl()), mod = url.protocol === 'http:' ? http : https;
      if (url.protocol === 'http:' && !process.env.PAYPAL_VERIFY_URL) return resolve('INVALID'); // plain http only for local tests
      const rq = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'WorldPowers-IPN' }, timeout: 20000 }, r => { let s = ''; r.on('data', c => s += c); r.on('end', () => resolve(s.trim())); });
      rq.on('timeout', () => { rq.destroy(); resolve('ERROR'); }); rq.on('error', () => resolve('ERROR')); rq.end(body);
    });
  }
  async function ipn(req, res) {
    let raw = ''; try { raw = await readRaw(req, 16 * 1024); } catch (e) { return send(res, 413, { error: 'too big' }); }
    send(res, 200, { ok: true }); // PayPal only needs a 200; the work happens after
    const f = Object.fromEntries(new URLSearchParams(raw));
    const v = await verify(raw);
    const txn = String(f.txn_id || '').slice(0, 40), st = String(f.payment_status || ''), amt = +f.mc_gross || 0, cur = String(f.mc_currency || ''), to = String(f.receiver_email || f.business || '').trim().toLowerCase();
    const base = { txn, st, amt, cur, payer: String(f.payer_email || '').slice(0, 80), name: [f.first_name, f.last_name].filter(Boolean).join(' ').slice(0, 60) };
    if (v !== 'VERIFIED') { log('rejected', { ...base, why: v === 'ERROR' ? 'Could not reach PayPal to verify. PayPal will retry.' : 'PayPal did not confirm this message (possible fake).' }); return; }
    if (!payEmail()) { log('held', { ...base, why: 'No PayPal address is set in Admin → Supporters, so this payment could not be checked.' }); return; }
    if (to !== payEmail()) { log('rejected', { ...base, why: `Paid to ${to || 'an unknown address'}, not your PayPal address.` }); return; }
    const cust = String(f.custom || '').split('.'), uid = uidOfToken(cust[0]) || null, forName = cust[1] === 'name';
    // refunds and chargebacks point at the original payment
    if (/^(Refunded|Reversed|Canceled_Reversal)$/.test(st)) {
      const parent = String(f.parent_txn_id || '').slice(0, 40);
      { const nOwner = Object.keys(sup().users).find(u => sup().users[u].ntx && sup().users[u].ntx[parent]); if (nOwner) { const nu = sup().users[nOwner]; if (st === 'Canceled_Reversal') { nu.ntx[parent].st = 'ok'; if (!nu.forever) nu.nameCred = (nu.nameCred || 0) + 1; } else { nu.ntx[parent].st = st === 'Refunded' ? 'refunded' : 'reversed'; if (nu.forever) { log('removed', { ...base, u: nOwner, who: userName(nOwner), why: `${st}: the forever name “${nu.forever}” is no longer reserved.` }); delete nu.forever; } else nu.nameCred = Math.max(0, (nu.nameCred || 0) - 1); if (st === 'Reversed' && flag) flag(nOwner, `A PayPal name reservation was charged back (${parent}).`); } persist(); try { sendTo(nOwner, 'supme', view(nOwner)); } catch (e) {} return; } }
      const owner = Object.keys(sup().users).find(u => sup().users[u].tx && sup().users[u].tx[parent]);
      if (!owner) { log('noted', { ...base, why: `${st} for a payment we never credited (${parent || 'unknown'}).` }); return; }
      if (st === 'Canceled_Reversal') { record(owner, parent, { st: 'ok' }); log('restored', { ...base, u: owner, who: userName(owner), why: 'The chargeback was cancelled: the donation counts again.' }); return; }
      record(owner, parent, { st: st === 'Refunded' ? 'refunded' : 'reversed', endT: Date.now() });
      log('removed', { ...base, u: owner, who: userName(owner), why: `${st}: the donation no longer counts toward their perks.` });
      if (st === 'Reversed' && flag) flag(owner, `A PayPal donation was charged back (${parent}). Their supporter perks were removed.`);
      return;
    }
    if (txn && Object.values(sup().users).some(u => (u.tx && u.tx[txn] && u.tx[txn].st === 'ok') || (u.ntx && u.ntx[txn]))) { log('duplicate', { ...base, why: 'Already credited.' }); return; }
    if (st !== 'Completed') { if (uid) U(uid).pend = { txn, amt, cur, st, t: Date.now() }; log('pending', { ...base, u: uid, who: uid ? userName(uid) : null, why: `Status is ${st || 'unknown'}. It will count once PayPal marks it Completed.` }); persist(); return; }
    if (!uid) { sup().claims.unshift({ id: crypto.randomBytes(6).toString('hex'), u: null, txn, amt, cur, payer: base.payer, name: base.name, t: Date.now(), st: 'wait', src: 'paypal', note: 'Verified by PayPal but not linked to a player (no token). Assign it to the right player.' }); log('unlinked', { ...base, why: 'Verified, but no player token: waiting in Claims for you to assign.' }); persist(); return; }
    if (cur !== 'USD') { sup().claims.unshift({ id: crypto.randomBytes(6).toString('hex'), u: uid, txn, amt, cur, payer: base.payer, name: base.name, t: Date.now(), st: 'wait', src: 'paypal', note: `Verified by PayPal, paid in ${cur}. Approve it with the US dollar value.` }); log('held', { ...base, u: uid, who: userName(uid), why: `Paid in ${cur}: waiting in Claims for you to approve in dollars.` }); persist(); return; }
    delete U(uid).pend;
    if (forName && amt >= sup().cfg.namePrice) { const u = U(uid); u.ntx = u.ntx || {}; u.ntx[txn] = { usd: amt, t: Date.now(), st: 'ok' }; u.nameCred = (u.nameCred || 0) + 1; persist();
      addNote(uid, 'rank', '🔒 Thank you! Your forever name reservation is ready: open the Donate page to choose the name.'); try { sendTo(uid, 'supme', view(uid)); } catch (e) {}
      log('credited', { ...base, u: uid, who: userName(uid), why: 'Verified with PayPal: forever name reservation.' }); return; }
    const r = record(uid, txn, { usd: amt, amt, cur, t: Date.now(), st: 'ok', src: 'paypal', payer: base.payer });
    log('credited', { ...base, u: uid, who: userName(uid), why: `Verified with PayPal. ${r.after > r.before ? 'Now ' + TIERS[r.after].n + '.' : ''}` });
    if (auditLog) try { auditLog('supporter', `${userName(uid)} donated ${'$' + amt.toFixed(2)} (verified by PayPal).`); } catch (e) {}
  }

  // ---- what a player sees ----
  function view(uid) {
    const u = sup().users[uid] || { tx: {} }, k = tierOf(uid), now = Date.now(), n = nationOf(uid), d = dayKey(now);
    const rushUsed = u.rush && u.rush.d === d ? u.rush.n : 0, instUsed = u.inst && u.inst.d === d ? u.inst.n : 0;
    return {
      tier: k, tierName: TIERS[k].n, badge: TIERS[k].b, total: total(uid), tiers: TIERS.slice(1).map((t, i) => ({ ...t, k: i + 1 })),
      linked: !!payEmail(), sandbox: sandbox(),
      rush: { max: PERKS.rushDay[k], left: Math.max(0, PERKS.rushDay[k] - rushUsed) },
      instant: { max: PERKS.instantDay[k], left: Math.max(0, PERKS.instantDay[k] - instUsed) },
      chest: { amt: n ? chestAmt(k, n) : 0, next: k >= 2 ? Math.max(now, (u.chest || 0) + WEEK) : 0, ready: k >= 2 && now >= (u.chest || 0) + WEEK },
      name: u.name || null, nameNext: u.nameT ? u.nameT + WEEK : 0, forever: u.forever || null, nameCred: u.nameCred || 0, namePrice: sup().cfg.namePrice,
      pending: u.pend || null,
      donations: Object.entries(u.tx || {}).map(([id, x]) => ({ id: id.slice(-6), usd: x.usd, t: x.t, st: x.st, src: x.src })).sort((a, b) => b.t - a.t),
      claims: sup().claims.filter(c => c.u === uid).map(c => ({ txn: c.txn && c.txn.slice(-6), amt: c.amt, cur: c.cur, t: c.t, st: c.st }))
    };
  }
  const chestAmt = (k, n) => Math.round(Math.min(PERKS.chestCap[k], Math.max(PERKS.chestMin[k], (n.gdp || 0) * PERKS.chestGdp[k])) / 1e5) * 1e5;
  const fail = (res, m) => send(res, 400, { error: m });
  const logLine = (n, x) => { (n.log = n.log || []).unshift({ t: Date.now(), x }); n.log = n.log.slice(0, 60); };

  // name reservation: true when `name` is reserved by someone other than uid
  function reservedBy(name, uid) { const x = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); if (!x) return null; for (const [u, s] of Object.entries(sup().users)) if (u !== uid && ((s.forever && s.forever.toLowerCase() === x) || (s.name && s.name.toLowerCase() === x && tierOf(u) >= 1))) return u; return null; }

  async function handle(req, res, p, me) {
    if (p === '/api/supporter' && req.method === 'GET') return send(res, 200, view(me.id)), true;
    if (p === '/api/donate/go' && req.method === 'GET') { // send a signed-in player to PayPal with their private token
      const q = new URL(req.url, 'http://x').searchParams, amt = Math.round(Math.max(0, Math.min(10000, +q.get('amt') || 0)) * 100) / 100;
      if (!payEmail()) { const d = /^https:\/\/[^\s"'<>]+$/i.test(S.config.donateUrl || '') ? S.config.donateUrl : WP.DEFCFG.donateUrl; res.writeHead(302, { Location: d, 'Cache-Control': 'no-store' }); res.end(); return true; }
      const site = siteUrl(req), u = new URL(payUrl());
      const prm = { cmd: '_donations', business: payEmail(), item_name: 'World Powers supporter donation', currency_code: 'USD', custom: tokenOf(me.id), notify_url: site + '/api/paypal/ipn', return: site + '/donate?thanks=1', cancel_return: site + '/donate', no_shipping: '1', rm: '1' };
      if (q.get('item') === 'name') { prm.item_name = 'World Powers: reserve your nation name forever'; prm.custom = tokenOf(me.id) + '.name'; prm.amount = (+sup().cfg.namePrice).toFixed(2); prm.return = site + '/donate?named=1'; }
      else if (amt >= 1) prm.amount = amt.toFixed(2);
      for (const [k, v] of Object.entries(prm)) u.searchParams.set(k, v);
      res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    if (!p.startsWith('/api/supporter/') || req.method !== 'POST') return false;
    const b = await readBody(req, 2048), uid = me.id, k = tierOf(uid), u = U(uid), now = Date.now(), d = dayKey(now);
    if (p === '/api/supporter/claim') { // a donation made another way (paypal.me): the admin checks PayPal and approves it
      const txn = String(b.txn || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 30), amt = Math.round((+b.amt || 0) * 100) / 100;
      if (txn.length < 8) return fail(res, 'Enter the PayPal transaction ID from your receipt (it is 17 letters and numbers).'), true;
      if (!(amt >= 1 && amt <= 10000)) return fail(res, 'Enter the amount you donated, in US dollars.'), true;
      if (sup().claims.filter(c => c.u === uid && c.st === 'wait').length >= 3) return fail(res, 'You already have 3 claims waiting. An admin will check them soon.'), true;
      if (sup().claims.some(c => c.txn === txn) || Object.values(sup().users).some(x => x.tx && x.tx[txn])) return fail(res, 'That transaction has already been submitted.'), true;
      sup().claims.unshift({ id: crypto.randomBytes(6).toString('hex'), u: uid, txn, amt, cur: 'USD', t: now, st: 'wait', src: 'claim', kind: b.kind === 'name' ? 'name' : 'donation', note: String(b.note || '').replace(/\s+/g, ' ').slice(0, 140) });
      sup().claims = sup().claims.slice(0, 500); persist();
      return send(res, 200, { ok: true, msg: 'Thanks! An admin will check your donation in PayPal and add your perks.', sup: view(uid) }), true;
    }
    if (p === '/api/supporter/forever') { // choose the name bought with a forever reservation
      if (u.forever) return fail(res, `“${u.forever}” is already reserved for you forever. Ask an admin if you need it changed.`), true;
      if (!(u.nameCred > 0)) return fail(res, 'Reserve a name forever on the Donate page first.'), true;
      const name = String(b.name || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 28 || !/^[\p{L}\p{N} .,'&()-]+$/u.test(name)) return fail(res, 'Choose a name of 2–28 letters, numbers and basic punctuation.'), true;
      if (MOD.isProfane(name)) return fail(res, 'Please choose a different name.'), true;
      if (reservedBy(name, uid)) return fail(res, 'That name is already reserved by someone else.'), true;
      const other = Object.entries(S.docs).find(([key, x]) => key.startsWith('nations/') && key !== 'nations/' + uid && x && x.name && x.name.toLowerCase() === name.toLowerCase());
      if (other) return fail(res, 'Another nation is using that name right now. Choose another.'), true;
      u.forever = name; u.foreverT = now; u.nameCred = Math.max(0, u.nameCred - 1); persist();
      return send(res, 200, { ok: true, msg: `“${name}” is reserved for you forever. Nobody else can ever found or rename a nation with it.`, sup: view(uid) }), true;
    }
    const n = nationOf(uid);
    if (!k) return fail(res, 'Supporter perks unlock with a donation of $5 or more.'), true;
    if (p === '/api/supporter/name') {
      if (u.nameT && now - u.nameT < WEEK && u.name) return fail(res, `You can change your reserved name again in ${Math.ceil((u.nameT + WEEK - now) / DAY)} day(s).`), true;
      const name = String(b.name || (n && n.name) || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 28 || !/^[\p{L}\p{N} .,'&()-]+$/u.test(name)) return fail(res, 'Choose a name of 2–28 letters, numbers and basic punctuation.'), true;
      if (MOD.isProfane(name)) return fail(res, 'Please choose a different name.'), true;
      if (reservedBy(name, uid)) return fail(res, 'Another supporter has already reserved that name.'), true;
      const other = Object.entries(S.docs).find(([key, x]) => key.startsWith('nations/') && key !== 'nations/' + uid && x && x.name && x.name.toLowerCase() === name.toLowerCase());
      if (other) return fail(res, 'Another nation is using that name right now.'), true;
      u.name = name; u.nameT = now; persist();
      return send(res, 200, { ok: true, msg: `“${name}” is now reserved for you. Nobody else can found or rename a nation with it.`, sup: view(uid) }), true;
    }
    if (!n) return fail(res, 'Found a nation first.'), true;
    if (p === '/api/supporter/rush') {
      const used = u.rush && u.rush.d === d ? u.rush.n : 0; if (used >= PERKS.rushDay[k]) return fail(res, 'No Rush orders left today. They refill at midnight UTC.'), true;
      const key = String(b.k || ''), act = (WP.ACTS || []).find(a => a.k === key);
      if (!act || key === 'expand') return fail(res, 'Pick an operation to rush.'), true;
      if ((act.cd || 0) >= 12 * 60) return fail(res, `${act.n} runs once a day and can't be rushed.`), true; // daily grants stay daily
      if (!n.cd || !((n.cd[key] || 0) > now)) return fail(res, 'That operation is already ready.'), true;
      n.cd[key] = now; u.rush = { d, n: used + 1 }; logLine(n, `⚡ Rush order: ${act.n} is ready now (supporter perk).`);
      setDoc('nations', uid, n); persist();
      return send(res, 200, { ok: true, msg: `${act.n} is ready now.`, sup: view(uid) }), true;
    }
    if (p === '/api/supporter/instant') {
      if (k < 2) return fail(res, 'Rapid redeployment is a Patron perk.'), true;
      const used = u.inst && u.inst.d === d ? u.inst.n : 0; if (used >= PERKS.instantDay[k]) return fail(res, 'No rapid redeployments left today. They refill at midnight UTC.'), true;
      const cd = n.cd || {}, keys = ['attack', 'strike', 'covert'].filter(x => (cd[x] || 0) > now), reg = (n.regroup || 0) > now;
      if (!keys.length && !reg) return fail(res, 'Your forces are already ready: nothing to clear.'), true;
      for (const x of keys) cd[x] = now; if (reg) n.regroup = 0; n.cd = cd; u.inst = { d, n: used + 1 };
      const what = [reg && 'army regrouping', keys.includes('attack') && 'attacks', keys.includes('strike') && 'strikes', keys.includes('covert') && 'spy operations'].filter(Boolean).join(', ');
      logLine(n, `🚀 Rapid redeployment (supporter perk): cleared ${what}.`); setDoc('nations', uid, n); persist();
      return send(res, 200, { ok: true, msg: `Rapid redeployment: ${what} cleared.`, sup: view(uid) }), true;
    }
    if (p === '/api/supporter/chest') {
      if (k < 2) return fail(res, 'The weekly war chest is a Patron perk.'), true;
      if (now < (u.chest || 0) + WEEK) return fail(res, `Your next war chest is ready in ${Math.ceil(((u.chest || 0) + WEEK - now) / DAY)} day(s).`), true;
      const amt = chestAmt(k, n); n.cash = (n.cash || 0) + amt; u.chest = now; logLine(n, `💰 Weekly supporter war chest: +${WP.moneyS(amt)}.`); setDoc('nations', uid, n); persist();
      return send(res, 200, { ok: true, msg: `+${WP.moneyS(amt)} added to your treasury. Thank you for supporting World Powers!`, sup: view(uid) }), true;
    }
    return fail(res, 'Not found.'), true;
  }

  // ---- admin ----
  function adminView() {
    const users = Object.entries(sup().users).filter(([, u]) => Object.keys(u.tx || {}).length || u.pend || u.forever || u.nameCred).map(([uid, u]) => ({ u: uid, who: userName(uid), nation: (nationOf(uid) || {}).name || null, total: total(uid), tier: tierOf(uid), name: u.name || null, forever: u.forever || null, nameCred: u.nameCred || 0, tx: Object.entries(u.tx || {}).map(([id, x]) => ({ id, ...x })).sort((a, b) => (b.t || 0) - (a.t || 0)), pend: u.pend || null })).sort((a, b) => b.total - a.total);
    return { cfg: { email: payEmail(), fromEnv: !!process.env.PAYPAL_EMAIL, sandbox: sandbox(), namePrice: sup().cfg.namePrice }, ipnUrl: '/api/paypal/ipn', tiers: TIERS.slice(1), perks: PERKS, users, claims: sup().claims.slice(0, 200).map(c => ({ ...c, who: c.u ? userName(c.u) : null })), log: sup().ipn.slice(0, 200) };
  }
  function adminAct(b, adminName) {
    if (b.op === 'price') { const v = Math.round((+b.namePrice || 0) * 100) / 100; if (!(v >= 1 && v <= 1000)) return { error: 'Enter a price between $1 and $1,000.' }; sup().cfg.namePrice = v; persist(); return { ok: true, msg: `Forever name reservations now cost $${v.toFixed(2)}.` }; }
    if (b.op === 'cfg') { const e = String(b.email || '').trim().toLowerCase(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: 'Enter the email address of your PayPal account.' }; sup().cfg.email = e; sup().cfg.sandbox = !!b.sandbox; persist(); return { ok: true, msg: e ? 'PayPal address saved. Donations will now be verified and linked automatically.' : 'PayPal address cleared. Donations go to your old donate link and must be added by hand.' }; }
    const findU = s => { s = String(s || '').trim().toLowerCase(); if (S.users[s]) return s; for (const [id, x] of Object.entries(S.users)) if ((x.name || '').toLowerCase() === s || (x.email || '').toLowerCase() === s) return id; for (const [key, x] of Object.entries(S.docs)) if (key.startsWith('nations/') && x && (x.name || '').toLowerCase() === s) return key.slice(8); return null; };
    if (b.op === 'grant') { const uid = findU(b.u); const amt = Math.round((+b.amt || 0) * 100) / 100; if (!uid) return { error: 'No player found with that leader name, nation name or email.' }; if (!(amt > 0 && amt <= 10000)) return { error: 'Enter the dollar amount.' }; const txn = 'MAN-' + crypto.randomBytes(5).toString('hex'); const r = record(uid, txn, { usd: amt, amt, cur: 'USD', t: Date.now(), st: 'ok', src: 'admin', by: adminName, note: String(b.note || '').slice(0, 140) }); log('credited', { txn, amt, cur: 'USD', u: uid, who: userName(uid), why: `Added by ${adminName}.` }); return { ok: true, msg: `Added $${amt.toFixed(2)} for ${userName(uid)}. They are now ${TIERS[r.after].n || 'not a supporter yet'}.` }; }
    if (b.op === 'revoke') { const uid = String(b.u || ''); const u = sup().users[uid]; if (!u || !u.tx || !u.tx[b.txn]) return { error: 'Donation not found.' }; const r = record(uid, String(b.txn), { st: 'removed', endT: Date.now(), by: adminName }); log('removed', { txn: b.txn, u: uid, who: userName(uid), why: `Removed by ${adminName}.` }); return { ok: true, msg: `Removed. ${userName(uid)} is now ${TIERS[r.after].n || 'not a supporter'}.` }; }
    if (b.op === 'forever') { const uid = findU(b.u); if (!uid) return { error: 'No player found with that leader name, nation name or email.' }; const u = U(uid); const nm = String(b.name || '').trim().replace(/\s+/g, ' ');
      if (!nm) { const old = u.forever; delete u.forever; persist(); return { ok: true, msg: old ? `Removed the forever name “${old}” from ${userName(uid)}.` : 'They had no forever name.' }; }
      if (nm.length < 2 || nm.length > 28) return { error: 'Names are 2–28 characters.' }; if (reservedBy(nm, uid)) return { error: 'That name is reserved by someone else.' }; u.forever = nm; u.foreverT = Date.now(); persist(); return { ok: true, msg: `“${nm}” is now reserved forever for ${userName(uid)}.` }; }
    if (b.op === 'claim') {
      const c = sup().claims.find(x => x.id === b.id); if (!c || c.st !== 'wait') return { error: 'That claim was already handled.' };
      if (!b.ok) { c.st = 'no'; c.by = adminName; persist(); if (c.u) addNote(c.u, 'rank', 'Your donation claim could not be matched to a PayPal payment. Check the transaction ID on your receipt and try again, or contact the admins.'); return { ok: true, msg: 'Claim rejected.' }; }
      const uid = c.u || findU(b.u); if (!uid) return { error: 'Choose which player this donation belongs to (leader name, nation name or email).' };
      const usd = Math.round((+b.usd || (c.cur === 'USD' ? c.amt : 0)) * 100) / 100; if (!(usd > 0)) return { error: 'Enter the US dollar value.' };
      if (Object.values(sup().users).some(x => x.tx && x.tx[c.txn] && x.tx[c.txn].st === 'ok')) { c.st = 'dup'; persist(); return { error: 'That transaction was already credited.' }; }
      if (c.kind === 'name') { c.st = 'ok'; c.by = adminName; c.u = uid; const nu = U(uid); nu.ntx = nu.ntx || {}; nu.ntx[c.txn] = { usd, t: Date.now(), st: 'ok', by: adminName }; nu.nameCred = (nu.nameCred || 0) + 1; persist(); addNote(uid, 'rank', '🔒 Your forever name reservation is ready: open the Donate page to choose the name.'); try { sendTo(uid, 'supme', view(uid)); } catch (e) {} log('credited', { txn: c.txn, amt: c.amt, cur: c.cur, u: uid, who: userName(uid), why: `Name reservation approved by ${adminName}.` }); return { ok: true, msg: `Approved. ${userName(uid)} can now choose a forever name.` }; }
      c.st = 'ok'; c.by = adminName; c.u = uid; const r = record(uid, c.txn, { usd, amt: c.amt, cur: c.cur, t: Date.now(), st: 'ok', src: c.src, by: adminName });
      log('credited', { txn: c.txn, amt: c.amt, cur: c.cur, u: uid, who: userName(uid), why: `Claim approved by ${adminName}.` });
      return { ok: true, msg: `Approved. ${userName(uid)} is now ${TIERS[r.after].n || 'not a supporter yet'}.` };
    }
    return { error: 'Unknown action.' };
  }

  return { ipn, handle, view, badges, tierOf, reservedBy, adminView, adminAct, TIERS, PERKS };
};
