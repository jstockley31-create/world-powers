// Chat and mail moderation: masks profanity and slurs. Matching ignores common letter substitutions.
'use strict';
const WORDS = ['fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'pussy', 'whore', 'slut', 'twat', 'wanker', 'prick', 'cock',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'spic', 'chink', 'kike', 'wetback', 'tranny', 'dyke', 'gook', 'coon', 'raghead', 'beaner'];
const sub = { a: '[a@4]', e: '[e3]', i: '[i1!l|]', o: '[o0]', s: '[s$5]', t: '[t7]', g: '[g9]', c: '[ck]', u: '[uv]' };
const pat = w => w.split('').map(ch => (sub[ch] || ch.replace(/[^a-z]/g, '')) + '+').join('[\\W_]*');
const RE = new RegExp('\\b(' + WORDS.sort((a, b) => b.length - a.length).map(pat).join('|') + ')', 'gi');
function clean(text) { return String(text).replace(RE, m => m[0] + '*'.repeat(Math.max(2, m.replace(/[\W_]/g, '').length - 1))); }
function isProfane(text) { RE.lastIndex = 0; const r = RE.test(String(text)); RE.lastIndex = 0; return r; }
module.exports = { clean, isProfane };
