# 🤖 WA Bot — WhatsApp Automation Control Panel

A fully-featured, self-hostable WhatsApp bot with a modern web control panel, built on [Baileys](https://github.com/WhiskeySockets/Baileys). Pair via code or session import, control everything from a sleek UI, and extend with 60+ built-in commands.

<div align="center">

![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)
![Baileys](https://img.shields.io/badge/baileys-6.7.9-25D366?style=flat-square)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)

**⭐ Star this repo if you find it useful!**

</div>

---

## ✨ Features

### 🎛️ Web Control Panel
- 🔐 **Password-protected dashboard** — no token leaks, no public panels
- 📱 **Pairing-code flow** — link your phone without scanning QR codes
- 🔑 **Session import/export** — move your bot between hosts in seconds
- 🎨 **Glassmorphism UI** with animated gradients, toasts, and modals
- 📊 **Live activity log** — see every bot action in real time
- 🌗 **Dark mode by default**, fully mobile responsive
- ⌨️ **Keyboard shortcuts** — `Ctrl+K` focuses token, `Ctrl+P` focuses phone

### 💬 WhatsApp Commands (60+)
| Category | Commands |
|----------|----------|
| 📋 **Info** | `menu`, `list`, `help`, `ping`, `speed`, `status`, `uptime`, `owner` |
| 🔐 **Access** | `mode`, `prefix`, `token` |
| 📥 **Downloaders** | `yt`, `tiktok`, `ig`, `fb`, `play`, `song` |
| 🎨 **Media Tools** | `sticker`, `toimg`, `getpp`, `tts`, `tourl`, `ops`, `save` |
| 🔧 **Utility** | `lyrics`, `forward`, `weather`, `currency`, `google`, `calc`, `qr` |
| 🛡️ **Anti** | `antidelete`, `antiedit`, `history`, `lastdeleted` |
| 👥 **Group** | `welcome`, `goodbye`, `kick`, `add`, `promote`, `demote`, `mute`, `unmute`, `tagall`, `ginfo`, `link`, `setname`, `setdesc`, `setgcpp`, `admins`, `whois`, `revoke`, `warn`, `warnings`, `resetwarn` |
| 👑 **Owner** | `setbanner`, `setprefix`, `setbotname`, `broadcast`, `block`, `unblock` |
| ⚙️ **System** | `restart`, `logout`, `cleartemp` |

### 🧠 Smart Behaviors
- 🐼 **View-once recovery** — react with 🐼 to any view-once message to download it
- 🗑️ **Anti-delete** — recovers deleted messages and forwards to owner
- ✏️ **Anti-edit** — shows original vs. edited side by side
- ⏱️ **Auto-delete** — notifications self-destruct after 1 hour
- ⌨️ **Human-like presence** — typing, recording, online indicators
- 🎯 **Prefix fallback** — suggests correct prefix if you use the wrong one

---

## 🚀 Quick Deploy

### One-Click Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Manual Deploy to Render

1. **Fork this repo** to your GitHub account
2. Go to [render.com](https://render.com) → **New** → **Web Service**
3. Connect your forked repo
4. Configure:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free (or Starter for 24/7 uptime without self-ping)
5. Add environment variables (see [Configuration](#-configuration))
6. Click **Create Web Service**
7. Wait for deploy → open your app URL → log in → pair your phone

---

## 🔧 Configuration

### Environment Variables

Create a `.env` file (local) or add these in Render's dashboard:

```env
# ============================================================================
# 🔐 REQUIRED
# ============================================================================

# Control panel password
ADMIN_PASSWORD=your_strong_password_here

# 64-char random string — keeps sessions valid across redeploys
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=your_64_char_random_string

# Your public URL (no trailing slash) — keeps free tier awake
SELF_URL=https://your-app.onrender.com


# ============================================================================
# 🌤️ OPTIONAL — for !weather command
# ============================================================================
WEATHER_API_KEY=your_openweathermap_key


# ============================================================================
# 🖼️ OPTIONAL — for !tourl and persistent banners
# ============================================================================
IMGBB_API_KEY=your_imgbb_key


# ============================================================================
# 🎨 OPTIONAL — default banner shown in !menu
# ============================================================================
DEFAULT_BANNER_URL=https://i.imgur.com/yourbanner.jpg


# ============================================================================
# 💾 OPTIONAL — set "true" only if you have a Render disk mounted at /data
# ============================================================================
PERSISTENT_DISK=false
```

### Getting API Keys

| Key | Provider | Cost | Link |
|-----|----------|------|------|
| Weather | OpenWeatherMap | Free (1000/day) | [Sign up](https://openweathermap.org/api) |
| Image hosting | ImgBB | Free (unlimited) | [Sign up](https://api.imgbb.com/) |

---

## 💻 Local Development

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/wa-bot.git
cd wa-bot

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your values

# Run
npm start
```

Open `http://localhost:3000`, log in, and pair your phone.

### Requirements
- **Node.js** ≥ 18.0.0
- **npm** ≥ 9.0.0
- **ffmpeg** (for media processing) — install via `apt install ffmpeg` (Linux) or `brew install ffmpeg` (macOS)

---

## 📱 Pairing Your Phone

1. Open the control panel and log in
2. Enter your phone number **with country code, digits only** — e.g. `2376XXXXXXXX`
3. Click **Generate**
4. Open WhatsApp → **Settings** → **Linked Devices** → **Link a Device** → **Link with phone number**
5. Enter the 8-character code the panel gives you
6. Done — the bot connects within seconds

⚠️ **Codes expire in ~60 seconds.** If it expires, click **Request new code**.

---

## 🎯 Usage

### First Steps After Pairing

```
!menu                    → show all commands
!prefix .                → change prefix to "."
!mode public             → allow anyone to use the bot
!setbotname My Awesome Bot
!setbanner <image-url>   → or reply to an image with !setbanner
```

### Common Workflows

**Download a TikTok video:**
```
!tiktok https://vm.tiktok.com/xxxxx
```

**Convert an image to sticker:**
Reply to an image with `!sticker`

**Check weather:**
```
!weather London
```

**Convert currency:**
```
!currency 100 USD EUR
```

**Recover a deleted message:**
Just wait — the bot forwards it to you automatically if `antidelete` is on.

**Download a view-once photo:**
React to it with 🐼.

---

## 🏗️ Architecture

```
wa-bot/
├── server.js          # Express server + auth + API routes + self-ping
├── bot.js             # Baileys socket lifecycle + pairing + state
├── command.js         # All command handlers + message dispatcher
├── public/
│   └── index.html     # Control panel (single-file, Tailwind CDN)
├── package.json
├── .env.example
└── README.md
```

### How It Works

1. **`server.js`** boots an Express app, mounts auth middleware, and exposes the API the control panel talks to.
2. **`bot.js`** manages the Baileys socket — connecting, reconnecting, pairing, and persisting session credentials to disk.
3. **`command.js`** receives every incoming message, checks for the prefix, dispatches to the right handler, and manages presence (typing/recording).
4. **`public/index.html`** is a single-page control panel that polls `/api/status` every 3 seconds.

---

## 🔒 Security

- ✅ **HttpOnly cookies** — auth tokens are never exposed to JavaScript
- ✅ **HMAC-signed sessions** — cannot be forged without `SESSION_SECRET`
- ✅ **7-day expiry** on sessions
- ✅ **No secrets in code** — everything comes from environment variables
- ✅ **Owner-only commands** — mode, prefix, banner, restart, etc. only respond to the paired account

### ⚠️ Best Practices

- **Never** commit your `.env` file
- **Never** share your `sessionToken` — anyone with it can control your bot
- **Rotate** `ADMIN_PASSWORD` if you suspect a leak
- **Use** a paid Render plan if you handle sensitive data (free tier is public infrastructure)

---

## 🛠️ Extending the Bot

### Adding a Command

1. Open `command.js`
2. Add a handler function:

```javascript
async function cmdHello({ args, sock, jid, state, msg }) {
  const name = args[0] || 'world';
  await sock.sendMessage(jid, { text: `Hello, ${name}! 👋` });
}
```

3. Register it in the `commands` object:

```javascript
const commands = {
  // ...
  hello: cmdHello,
};
```

4. Restart the bot (`!restart` or redeploy)

### Adding a Web API Endpoint

In `server.js`, inside the protected section:

```javascript
app.get('/api/stats', (req, res) => {
  res.json({
    msgCount: state.msgCount,
    cacheSize: messageStore.size,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
  });
});
```

---

## 🐛 Troubleshooting

<details>
<summary><b>Pairing code rejected or doesn't work</b></summary>

- Make sure you're using **digits only** with country code (no `+`, no spaces)
- Ensure Baileys is at `^6.7.9` — run `npm ls @whiskeysockets/baileys`
- Wait 30-60 seconds between attempts (WhatsApp throttles)
- Check Render logs for `📡 Socket ready` before `🔑 Fresh pairing code`
- If logs say `Timed out waiting for socket readiness`, the WhatsApp servers are unreachable — try again in a few minutes
</details>

<details>
<summary><b>Bot replies twice to the same command</b></summary>

- This was a known bug in earlier versions — fixed by the `startingUp` guard in `startBot()`. Pull the latest `bot.js`.
</details>

<details>
<summary><b>"TikTok downloader not installed"</b></summary>

- Run `npm install` and confirm `@silent-tech-offc/ttdl` is present in `node_modules`
- If installing fails, try removing the package and using `btch-downloader` instead
</details>

<details>
<summary><b>Bot goes offline after 15 minutes on Render</b></summary>

- Set `SELF_URL` in your env vars to your app's public URL
- The bot pings `/health` every 14 minutes to keep itself awake
- Alternatively, use [UptimeRobot](https://uptimerobot.com) to ping `/health` externally
</details>

<details>
<summary><b>"Unauthorized" when opening the panel</b></summary>

- Clear cookies for your app's domain
- Verify `ADMIN_PASSWORD` matches what you set in env vars
- Check that `SESSION_SECRET` is set (otherwise cookies reset on redeploy)
</details>

<details>
<summary><b>Session lost after redeploy on free tier</b></summary>

- Free Render wipes `/tmp` on every deploy, including your auth folder
- Two options:
  1. **Download your session** (`/api/session/export`) before redeploy, re-import after
  2. **Attach a Render disk** (paid) mounted at `/data`, set `PERSISTENT_DISK=true`
</details>

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `@whiskeysockets/baileys` | WhatsApp Web protocol |
| `@hapi/boom` | HTTP error objects (Baileys requirement) |
| `express` | Web server |
| `pino` | Structured logging |
| `qrcode-terminal` | QR fallback display |
| `sharp` | High-quality image processing (stickers, thumbnails) |
| `wa-sticker-kit` | Animated sticker support |
| `@silent-tech-offc/ttdl` | TikTok downloader |
| `@slipknot/ytdl-core` | YouTube downloader |
| `btch-downloader` | Fallback TikTok/IG/FB downloader |

---

## 🗺️ Roadmap

- [x] Pairing code flow
- [x] Session import/export
- [x] Anti-delete / Anti-edit
- [x] View-once recovery
- [x] Weather, currency, search commands
- [x] Auto-delete after 1 hour
- [x] Self-ping for Render free tier
- [ ] WebSocket-based real-time panel (replace polling)
- [ ] Group activity analytics dashboard
- [ ] Plugin system for community commands
- [ ] Multi-account support
- [ ] Docker image + docker-compose

---

## 🤝 Contributing

PRs are welcome! Here's how:

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/amazing-idea`
3. Commit: `git commit -m "Add amazing idea"`
4. Push: `git push origin feature/amazing-idea`
5. Open a Pull Request

### Guidelines

- Keep commands small and focused
- Follow the existing code style (ESM, async/await, no semicolon abuse)
- Test on a real WhatsApp account before submitting
- Update this README if you add commands or env vars

---

## ⚠️ Disclaimer

This project is for **educational and personal use only**. Automating WhatsApp may violate their [Terms of Service](https://www.whatsapp.com/legal/terms-of-service). Use at your own risk. The authors are not responsible for:

- Account bans
- Data loss
- Misuse of the bot

**Never** use this bot for spam, harassment, or illegal activity.

---

## 📜 License

MIT © FANUEL DX(https://github.com/YOUR_USERNAME)

See [LICENSE](LICENSE) for full text.

---

## 🙏 Credits

- [Baileys](https://github.com/WhiskeySockets/Baileys) — the WhatsApp Web library that makes this possible
- [Tailwind CSS](https://tailwindcss.com/) — for the pretty panel
- [Render](https://render.com/) — free hosting
- All contributors and users ❤️

---

<div align="center">

**Made with ❤️ and lots of ☕**

⭐ Star • 🐛 [Report Bug](https://github.com/YOUR_USERNAME/wa-bot/issues) • 💡 [Request Feature](https://github.com/YOUR_USERNAME/wa-bot/issues)

</div>
```

---

## 📁 Companion Files

### `.env.example` (commit this one, NOT `.env`)

```env
# Required
ADMIN_PASSWORD=change_me
SESSION_SECRET=generate_with_node_crypto
SELF_URL=https://your-app.onrender.com

# Optional
WEATHER_API_KEY=
IMGBB_API_KEY=
DEFAULT_BANNER_URL=
PERSISTENT_DISK=false
```

### `.gitignore`

```gitignore
# Dependencies
node_modules/
package-lock.json

# Env & secrets
.env
.env.local
.env.*.local

# Bot state (contains session credentials!)
auth/
data/
*.session
wa-session-*.json

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# OS / Editor
.DS_Store
Thumbs.db
.vscode/
.idea/
*.swp
*~

# Build artifacts
dist/
build/
coverage/
.nyc_output/
```

### `LICENSE` (MIT)

```text
MIT License

Copyright (c) 2025 FANUEL DX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### `render.yaml` (optional — enables Infrastructure as Code deploy)

```yaml
services:
  - type: web
    name: wa-bot
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /health
    envVars:
      - key: NODE_VERSION
        value: 18.20.0
      - key: ADMIN_PASSWORD
        sync: false
      - key: SESSION_SECRET
        generateValue: true
      - key: SELF_URL
        sync: false
      - key: WEATHER_API_KEY
        sync: false
      - key: IMGBB_API_KEY
        sync: false
```

---

