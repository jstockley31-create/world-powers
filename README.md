# Striphe's World Powers

A multiplayer nation-building game you host yourself. Players sign up with an email and password (one account per email), found a country on a hex map of the world, click timed actions to grow, trade, ally, chat, and go to war.

No extra packages needed — only **Node.js 18 or newer**.

## Run it

```
node server.js
```

Then open http://localhost:3000. **The first account that signs up becomes the admin**, so sign up yourself first.

Settings (optional environment variables):

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the website runs on |
| `DATA_DIR` | `./data` | Where the world is saved (`world.json`) |
| `ADMIN_EMAIL` | — | This email also becomes an admin when it signs up |

Everything — accounts, nations, chat — is saved in `data/world.json`. **Back up that file** to back up the game. Stop the server with Ctrl+C (it saves first).

## Put it online

Any host that runs Node.js works. Some easy options:

- **Railway / Render / Fly.io:** create a new Node app from this folder, start command `node server.js`. Add a **persistent disk/volume** and set `DATA_DIR` to its path, or the world resets every time the app restarts.
- **Your own VPS (DigitalOcean, Linode, etc.):** copy the folder, run `node server.js` with a process manager like `pm2` (`pm2 start server.js --name world-powers`), and put it behind Caddy or nginx for HTTPS.
- **Docker:** `docker build -t world-powers .` then `docker run -d -p 3000:3000 -v worldpowers-data:/data world-powers`
- **Your home PC:** works for friends on your Wi-Fi at `http://<your-PC-IP>:3000`. For people elsewhere you'd need port forwarding or a tunnel (e.g. Cloudflare Tunnel).

Use **HTTPS** when it's on the internet so passwords are encrypted in transit. (Caddy does this automatically: `caddy reverse-proxy --from yourdomain.com --to localhost:3000`.) If you use nginx, turn off buffering for `/api/stream` (`proxy_buffering off;`) so chat stays live.

## Admin page

The admin page lives at a **secret address** (like `/hq-3f9a…`) that is created the first time the server starts. Only admin accounts can open it — everyone else gets "Not found", even with the link.

- **Easiest way in:** sign in to the game with your admin account and click **Admin** in the top bar. Only admins see that button.
- The address is also printed in the server log at startup, and `node server.js admin-link` prints it.
- To change it (if you think someone learned it), use **Game settings → Private admin link → Change secret link**.

The first account to sign up becomes the admin. Other people can only be made admin from the server command line (`node server.js make-admin email`). There is no button for it on the website.

What's inside:

- **Dashboard** — server health (saving, storage volume, memory, errors), player counts, who's online, and anything that needs attention.
- **Players** — search everyone; click a player to edit any number in their nation, reset cooldowns, reset their nation, set a new password, ban/unban, or delete the account.
- **Cheat watch** — flags bots clicking faster than a person can, accounts that share a network (possible duplicates), and aid sent between them.
- **Game settings** — speed, income and XP multipliers, new-player protection, turn war on/off, open/close sign-ups, a banner message, chat announcements, clear chat, wipe the world (auto-backup first), download a full backup, and change the secret admin link.
- **Activity log** — every admin action and recent server errors.

From the server's command line:

```
node server.js list-users
node server.js reset-password player@email.com NewPassword123
node server.js make-admin player@email.com
node server.js remove-admin player@email.com
```

Run these while the server is stopped (or restart it afterward), since the running server keeps its own copy in memory.

## AI nations

The world starts with **12 computer-controlled nations** so it never feels empty. They're always labeled **AI**, never appear in the online list, and never chat. They play by exactly the same rules as people (same timers, costs and war protections) at the pace of a dedicated player, and each has a personality: Merchant, Expansionist, Warlord or Isolationist.

By default they **retire gradually** as real players join (one fewer AI per 3 players), weakest first. In **Game settings** you can change how many there are, whether they may attack real players (yes / only if attacked first / never) and whether they retire. **Players → AI nations** lets you add or remove individual ones.

## Security

- **All game rules run on the server.** Browsers only send requests like "collect taxes" or "attack this province"; the server checks cooldowns, costs and rules, rolls the dice, and saves the result. Players cannot give themselves money, skip timers or change their stats.
- Other players only receive public information about your nation (no treasury, stockpiles, logs or pending decisions).
- Passwords are hashed with scrypt. Sign-ins are rate-limited per network and per account. Sessions use secure, HTTP-only cookies.
- Requests from other websites are rejected, pages can't be embedded in other sites, and a content security policy blocks injected scripts.
- Rapid-fire requests are rate-limited and flagged in Cheat watch.
- Emails aren't verified (there's no email sending), so someone could make a second account with another address. Cheat watch flags accounts that share a network so you can review them.

## Good to know

- Built for a group of friends up to a few hundred players. The whole world lives in memory and one file.
