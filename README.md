# WhatsApp Bot

A self-hosted WhatsApp bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) with a web dashboard for pairing, session backup, and live status. Pair with a phone number (no QR scanning), control it from chat or from the browser, and extend it by dropping a single object into a commands array.

```
╭━━━━━━━━━━━━━━━━━━━━╮
┃  🤖  COMMAND CENTER
╰━━━━━━━━━━━━━━━━━━━━╯
```

---

## Features

- **Number-based pairing** — no QR code. Enter your number on the dashboard, get a pairing code, done.
- **Web dashboard** — live connection state via Socket.io, pairing code display, session backup/restore.
- **Session portability** — download the session as JSON, re-upload after a redeploy to skip re-pairing.
- **~60 built-in commands** across general, media, fun, tools, admin, group, moderation, and special.
- **Group management** — welcome/goodbye, anti-link, warnings, mute, kick/promote/demote, scheduled open/close.
- **View-once capture** — forward captured view-once media to the admin, plus a per-message `.vv` reveal for anyone.
- **Extensible registry** — add a command by dropping one object into `COMMANDS` in `handlers.js`. The help menu updates itself.
- **Self-ping** — built-in keep-alive for Render free tier and similar hosts.

---

## Requirements

- **Node.js ≥ 18** (uses global `fetch`)
- **ffmpeg** *(optional)* — needed for `.tts` to send a real voice note. Without it, TTS falls back to an MP3 document.
- A phone number with WhatsApp installed, to link as a device.

---

## Quick Start

```bash
git clone <your-repo-url>
cd <your-repo>
npm install
```

### Configure

Create a `.env` file (or set env vars in your host's dashboard):

```env
# Required
ADMIN_NUMBER=237678899829             # Your phone number, digits only, country code, no +
DASHBOARD_PASSWORD=changeme           # Password for the web dashboard

# Optional
PORT=3000                             # Server port (default 3000)
SESSION_SECRET=some-random-string     # HMAC secret for seasonal reconnect codes
SELF_URL=https://yourapp.onrender.com # Enables self-ping keep-alive
```

### Run

```bash
node server.js
```

Open `http://localhost:3000`, enter the dashboard password, type your number, and enter the pairing code WhatsApp shows you.

### Optional: enable real voice notes

```bash
# Debian / Ubuntu
sudo apt install ffmpeg
npm install fluent-ffmpeg

# macOS
brew install ffmpeg
npm install fluent-ffmpeg
```

> **Note:** Render's free tier does **not** ship ffmpeg. Use a Dockerfile with ffmpeg installed, or accept the MP3 fallback.

---

## Project Structure

```
.
├── server.js              # Express + Socket.io + auth + self-ping
├── state.js               # Shared mutable state + persistence
├── connection.js          # Baileys socket lifecycle, pairing, session I/O
├── handlers.js            # Command registry + router + event handlers
├── collection.js          # Command metadata (used by /api/commands)
├── bot_state.json         # Auto-generated persistence file (gitignore this)
├── auth_info_baileys/     # Baileys session files (gitignore this)
├── public/
│   └── index.html         # Dashboard UI
├── .env                   # Your secrets (gitignore this)
└── README.md
```

---

## Command Reference

Prefix is `.` — change it by editing the `base` detection in `handlers.js` if you want something else.

### 📌 General

| Command | Description |
|---|---|
| `.help` / `.menu` | Show the auto-generated menu |
| `.ping` | Check the bot is alive |
| `.id` / `.myid` | Your JID and number |
| `.whoami` | Admin status + debug info |
| `.time` | Server time (UTC) |
| `.uptime` | How long the bot has been running |
| `.echo <text>` | Repeat text |
| `.calc <expr>` | Safe calculator |

### 🎨 Media

| Command | Description |
|---|---|
| `.sticker` / `.s` | Reply to image/video → sticker |
| `.toimg` | Reply to sticker → image |
| `.tts <text>` | Text → voice note (reply to a message to use its text) |
| `.voice` | Alias for `.tts` |
| `.getpp` | Get a user's profile picture (mention or reply) |
| `.vv` | Reply to a view-once message to reveal it in chat |

### 🎲 Fun

| Command | Description |
|---|---|
| `.roll 2d6` | Roll dice |
| `.flip` | Coin flip |
| `.8ball <q>` | Magic 8-ball |
| `.joke` | Random joke |
| `.quote` | Random quote |
| `.trivia` | 30-second quiz question |
| `.truth` | Truth prompt |
| `.dare` | Dare prompt |
| `.ship @a @b` | Deterministic compatibility score |

### 🛠️ Tools

| Command | Description |
|---|---|
| `.shorten <url>` | Shorten a URL via TinyURL |
| `.weather <city>` | Weather via wttr.in |
| `.translate <lang> <text>` | Google Translate (free endpoint) |
| `.lyrics <song>` | Fetch lyrics via lyrics.ovh |

### 👮 Admin *(admin-only)*

| Command | Description |
|---|---|
| `.status` | Full bot status with feature toggles |
| `.logout` | Disconnect the WhatsApp session |
| `.restart` | Restart the Baileys socket |
| `.pair <number>` | Request a fresh pairing code |
| `.addadmin @user` | Promote a user to bot admin |
| `.deladmin @user` | Demote a bot admin |

### ⏸️ Pause *(admin-only)*

| Command | Description |
|---|---|
| `.pause [all]` | Silence the bot in this chat (or everywhere) |
| `.resume [all]` | Resume |
| `.pausestatus` | Show current pause state |

### 👥 Group *(admin-only)*

| Command | Description |
|---|---|
| `.welcome on\|off` | Toggle welcome messages |
| `.goodbye on\|off` | Toggle goodbye messages |
| `.setwelcome <text>` | Custom welcome (`@user`, `@group` placeholders) |
| `.tagall <msg>` | Mention everyone with a header |
| `.hidetag <msg>` | Mention everyone silently |
| `.kick @user` | Remove from group |
| `.promote @user` | Make group admin |
| `.demote @user` | Remove group admin |
| `.mute` / `.unmute` | Group announcement mode |
| `.groupinfo` | Group metadata + admin list |

### 🛡️ Moderation *(admin-only)*

| Command | Description |
|---|---|
| `.antilink on\|off` | Toggle anti-link |
| `.antilink action delete\|warn\|kick` | Set anti-link punishment |
| `.warn @user [reason]` | Warn — auto-kick at 3 |
| `.warnings @user` | List warnings |
| `.resetwarn @user` | Clear warnings |
| `.reactions on\|off [global]` | Toggle bot reactions |
| `.schedule open\|close <HH:MM\|30m\|2h> [daily]` | Schedule group open/close |
| `.schedule list` / `.schedule cancel` | Manage schedules |

### 📸 Special

| Command | Description |
|---|---|
| `.vo on\|off` | Global view-once capture *(admin)* — forwards to admin |
| `.vv` | Reveal a single view-once message *(anyone)* |
| `.autodl on\|off` | Auto-download media *(admin)* |
| `.poststatus` | Reply to a message → post it to your status *(admin)* |

---

## Adding a Command

Open `handlers.js`, find the `COMMANDS` array, drop in an object:

```js
{
  name: '.uuid',
  aliases: ['.guid'],          // optional
  category: 'tools',           // general | media | fun | tools | admin
                                // | pause | group | moderation | special
  desc: 'Generate a random UUID',
  usage: '.uuid',              // optional
  admin: false,                // true = admin-only gate
  handler: async ({ from }) => {
    const { randomUUID } = require('crypto');
    await helpers.reply(from, `🆔 ${randomUUID()}`);
  }
}
```

Save and restart. The command is immediately usable, and it appears in `.help` under the matching category.

### Handler context (`ctx`)

Every handler receives:

| Field | Description |
|---|---|
| `msg` | Raw Baileys message object |
| `from` | Chat JID (group or DM) |
| `senderJid` | Resolved sender JID |
| `args` | Array of words after the command |
| `text` | Raw text after the leading `.` |
| `base` | The command name as sent, e.g. `.echo` |
| `isGroup` | `true` if the chat is a group |
| `admin` | `true` if the sender is a bot admin |
| `sock` | Live Baileys socket |
| `state` | The full `state` module |

### Available helpers

| Helper | Purpose |
|---|---|
| `helpers.reply(from, text, opts?)` | Send a message |
| `helpers.replyTyping(from, text)` | Send with typing presence |
| `helpers.replyWithBanner(from, text)` | Send banner + caption |
| `helpers.denied(from)` | Standard "access denied" reply |
| `helpers.fail('msg')` | Throw a user-facing error (auto-replied) |
| `helpers.requireGroup(from)` | Fail if not a group |
| `helpers.requireMention(msg, usage)` | Fail if no mention; returns mentioned JIDs |
| `helpers.mentions(msg)` | Extract mentioned JIDs |
| `helpers.quoted(msg)` | Extract quoted message |
| `helpers.contextInfo(msg)` | Extract quote context |

---

## Session Backup

The bot's session lives in `auth_info_baileys/`. On ephemeral hosts (Render, Railway, Fly), this directory is wiped on every deploy. To avoid re-pairing:

1. Open the dashboard after pairing.
2. Scroll to **Session Backup** → **Download Session File**.
3. Store the JSON somewhere safe.
4. After the next deploy, click **Upload Session File** and pick the JSON.
5. The bot restarts automatically and reconnects with the restored credentials.

> **Keep this file secret.** It contains the credentials to your WhatsApp account.

---

## Deployment

### Render (free tier)

1. Push to GitHub.
2. Create a new **Web Service**, connect the repo.
3. Build: `npm install`
4. Start: `node server.js`
5. Set environment variables (`ADMIN_NUMBER`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `SELF_URL=https://<your-app>.onrender.com`).
6. Deploy. The self-ping keeps the instance warm.

To persist the session across deploys, add a Render **Disk** mounted at `/opt/render/project/src/auth_info_baileys` (paid feature), or rely on the download/upload flow.

### Docker

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

The Dockerfile installs ffmpeg, so `.tts` produces real voice notes.

### Other hosts

Anything that runs Node 18+ works — Heroku, Railway, Fly, a VPS, your laptop. Just make sure:

- `auth_info_baileys/` and `bot_state.json` persist across restarts (mount a volume or accept the download/upload flow).
- Set `SELF_URL` if the host sleeps idle instances.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_NUMBER` | ✅ | Bot owner's number. Digits only, with country code, no `+` |
| `DASHBOARD_PASSWORD` | ✅ | Password for the web dashboard |
| `PORT` | — | Server port (default `3000`) |
| `SESSION_SECRET` | — | HMAC secret for seasonal reconnect codes (default: hardcoded fallback) |
| `SELF_URL` | — | Public URL of the app; enables self-ping keep-alive |

---

## API Reference

All routes require the `sid` cookie set by `/api/login` **unless** `DASHBOARD_PASSWORD` is unset.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/healthz` | Uptime probe (no auth) |
| `POST` | `/api/login` | Exchange password for session cookie |
| `POST` | `/api/logout` | Clear session cookie |
| `GET` | `/api/session` | Check auth status |
| `GET` | `/api/state` | Snapshot of connection state |
| `POST` | `/api/connect` | Start the bot for a given number |
| `POST` | `/api/disconnect` | Stop the bot |
| `GET` | `/api/commands` | List registered commands |
| `GET` | `/api/session-code` | Current seasonal reconnect code |
| `GET` | `/api/session/status` | Whether a session exists on disk |
| `GET` | `/api/session/download` | Download the session as JSON |
| `POST` | `/api/session/upload` | Upload a session JSON |
| `POST` | `/api/session/delete` | Wipe the session from disk |

---

## Architecture Notes

- **`state.js` owns all mutable global state.** It exposes getters so other modules always see the latest value (`state.sock`, `state.botJid`, etc.). Never destructure getters at module load time — that snapshots the value at `null`.
- **Circular imports are avoided** by keeping `state.js` dependency-free and letting `handlers.js` and `connection.js` fetch the socket lazily via `state.sock`.
- **The command registry is data, not code.** `COMMANDS` is an array; the router builds a `Map` from it at startup. Adding a command means adding an object, not editing a switch statement.
- **Persistence is debounced-free but simple.** Every mutation calls `saveState()` synchronously. This is fine at this scale; if you start writing hundreds of times per second, switch to a debounced writer.

---

## Troubleshooting

**Commands show "typing…" and then stop responding.**
You have the stale-destructure bug. Check that `handlers.js` does **not** destructure `sock`, `botJid`, or `currentNumber` from `require('./state')` at the top. Always read them as `state.sock`.

**`.tts` sends a document, not a voice note.**
ffmpeg isn't installed, or `fluent-ffmpeg` isn't in `node_modules`. Install both, or accept the MP3 fallback (it's still playable and downloadable).

**Bot disconnects after every redeploy.**
The `auth_info_baileys/` directory isn't persistent. Use the dashboard's **Session Backup** to download the session and re-upload after deploy, or mount a persistent disk.

**Dashboard login loops.**
`DASHBOARD_PASSWORD` is set but the cookie isn't being stored. Check that your host isn't terminating TLS in a way that breaks `SameSite=Lax`, or use a custom domain with proper HTTPS.

**"Unauthorized" in the browser console.**
The `sid` cookie expired or wasn't sent. Log out and log back in. If it persists, check for a proxy stripping cookies.

---

## License

MIT — do whatever you want, no warranty.

---

## Credits

- [Baileys](https://github.com/WhiskeySockets/Baileys) — the WhatsApp Web protocol library
- [Socket.io](https://socket.io/) — real-time dashboard updates
- [Express](https://expressjs.com/) — HTTP server
- Everyone whose free APIs make the tools section work: wttr.in, lyrics.ovh, TinyURL, Google Translate, quotable.io