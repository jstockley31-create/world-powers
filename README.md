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

## Admin tools

In the game (Rankings page) admins can **Remove nation** (they can start over) or **Ban** (account locked, nation and chat deleted).

From the server's command line:

```
node server.js list-users
node server.js reset-password player@email.com NewPassword123
node server.js make-admin player@email.com
node server.js remove-admin player@email.com
```

Run these while the server is stopped (or restart it afterward), since the running server keeps its own copy in memory.

## Good to know

- Passwords are stored hashed (scrypt), never in plain text. Logins and sign-ups are rate-limited.
- Emails aren't verified (there's no email sending), so "one account per email" stops casual duplicates but someone could still sign up with a second email address. Ban duplicates you spot.
- The game rules run in each player's browser, and the server only checks that players change their own data. A determined player who knows web development could cheat. Fine for friends; ask if you want the rules moved onto the server.
- Built for a group of friends up to a few hundred players. The whole world lives in memory and one file.
