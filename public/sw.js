// World Powers service worker: shows push notifications and opens the game when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// opening the installed app with no connection (or while the server restarts for an update) shows a reconnecting screen that loads the game by itself
// as soon as it can. Nothing is cached, so players always get the newest version.
const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f151c"><title>World Powers</title>
<style>html,body{margin:0;height:100%;background:#090d12;color:#c5ced8;font:15px Inter,system-ui,-apple-system,sans-serif}body{display:grid;place-items:center;text-align:center;padding:24px;box-sizing:border-box}
.s{width:34px;height:34px;border:3px solid #2a3746;border-top-color:#d4a64a;border-radius:50%;margin:0 auto 16px;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}b{color:#fff;font-size:17px}p{color:#8b98a5;font-size:13px;margin:8px 0 18px}
button{background:#d4a64a;color:#17120a;border:0;border-radius:8px;padding:11px 20px;font:600 15px inherit;cursor:pointer}</style></head>
<body><div><div class="s"></div><b>Reconnecting to World Powers…</b><p>No connection right now, or the game is restarting for an update.<br>This page will load the game by itself.</p><button onclick="location.reload()">Try now</button></div>
<script>let n=0;const t=()=>fetch('/robots.txt',{cache:'no-store'}).then(r=>{if(r.ok)location.reload();else s()}).catch(s);function s(){n++;setTimeout(t,Math.min(10000,1500+n*1000))}addEventListener('online',()=>location.reload());s()</script></body></html>`;
self.addEventListener('fetch', e => {
  const r = e.request; if (r.mode !== 'navigate' || r.method !== 'GET') return; // only page loads; everything else goes straight to the network
  e.respondWith(fetch(r).then(res => res.status >= 502 && res.status <= 504 ? new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }) : res)
    .catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'World Powers', { body: d.body || '', icon: '/icon.svg', badge: '/icon.svg', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || '/play' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || '/play';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => { for (const c of list) if ('focus' in c) { c.navigate && c.navigate(url).catch(() => {}); return c.focus(); } return self.clients.openWindow(url); }));
});
