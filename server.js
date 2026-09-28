import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import {
  startBot, requestPairing, state, persistConfig,
  regenerateToken, getBotData, exportSessionPackage,
  importSessionPackage, restartBot, clearSenderKeyMemory
} from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));

// ---- Auth configuration ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'wa_bot_auth';

if (!ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD not set. Set it in Render environment variables.');
}

// Parse cookies (simple)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      req.cookies[k] = decodeURIComponent(v.join('='));
    });
  }
  next();
});

// Auth middleware
function requireAuth(req, res, next) {
  // Allow login page and login endpoint
  if (req.path === '/login' || req.path === '/api/login') return next();

  const token = req.cookies[COOKIE_NAME];
  if (token && verifyToken(token)) return next();

  // Redirect to login for HTML requests, 401 for API
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// Token generation/verification
function generateToken() {
  const payload = `${Date.now()}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, hmac] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (hmac !== expected) return false;
  // Token valid for 7 days
  const age = Date.now() - parseInt(payload);
  return age < 7 * 24 * 60 * 60 * 1000;
}

// ---- Login page ----
const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login — WA Bot</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { darkMode: 'class' }</script>
</head>
<body class="bg-neutral-950 text-neutral-100 min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-sm">
    <div class="rounded-2xl bg-neutral-900 border border-neutral-800 p-6 space-y-4">
      <div class="text-center">
        <div class="w-12 h-12 mx-auto rounded-xl bg-emerald-500 flex items-center justify-center text-neutral-900 font-bold text-xl">W</div>
        <h1 class="text-lg font-semibold mt-3">WhatsApp Bot</h1>
        <p class="text-xs text-neutral-500 mt-1">Enter password to continue</p>
      </div>
      <form id="loginForm" class="space-y-3">
        <input id="password" type="password" placeholder="Password" required
          class="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:outline-none focus:border-emerald-500 transition-colors" />
        <button type="submit"
          class="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-neutral-900 text-sm font-medium transition-colors">
          Login
        </button>
      </form>
      <p id="error" class="hidden text-xs text-red-400 text-center"></p>
    </div>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const error = document.getElementById('error');
      error.classList.add('hidden');
      try {
        const r = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        }).then(r => r.json());
        if (r.ok) {
          window.location.href = '/';
        } else {
          error.textContent = r.error || 'Invalid password';
          error.classList.remove('hidden');
        }
      } catch (e) {
        error.textContent = 'Network error';
        error.classList.remove('hidden');
      }
    });
  </script>
</body>
</html>
`;

// ---- Login routes ----
app.get('/login', (req, res) => {
  res.type('html').send(LOGIN_HTML);
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Server password not configured' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = generateToken();
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// ---- Boot bot ----
startBot().catch((err) => console.error('Bot boot failed:', err));

// ---- Protected API routes ----
app.use(requireAuth);

app.get('/api/status', (req, res) => {
  res.json({
    connected: state.connected,
    mode: state.mode,
    ownerJid: state.ownerJid,
    pairingCode: state.pairingCode,
    sessionToken: state.sessionToken,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    antidelete: state.antidelete,
    antiedit: state.antiedit,
    welcome: state.welcome,
  });
});

app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const code = await requestPairing(phone);
    res.json({ code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/token/import', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  if (token === state.sessionToken) {
    return res.json({ ok: true, message: 'Token valid — bot already connected' });
  }
  state.sessionToken = token;
  persistConfig();
  res.json({ ok: true, message: 'Token saved locally' });
});

app.post('/api/token/regenerate', (req, res) => {
  const token = regenerateToken();
  res.json({ token });
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['private', 'public'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
  state.mode = mode; persistConfig();
  res.json({ ok: true, mode });
});

app.post('/api/toggle', (req, res) => {
  const { key, value } = req.body;
  if (!['antidelete', 'antiedit', 'welcome'].includes(key)) return res.status(400).json({ error: 'Invalid key' });
  state[key] = value; persistConfig();
  res.json({ ok: true });
});

// Session package endpoints
app.get('/api/session/export', (req, res) => {
  try {
    if (!state.connected) {
      return res.status(400).json({ error: 'Bot must be connected to export session' });
    }
    const pkg = exportSessionPackage();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="wa-session-${Date.now()}.json"`);
    res.send(JSON.stringify(pkg, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/import', async (req, res) => {
  try {
    const { package: pkg } = req.body;
    if (!pkg) return res.status(400).json({ error: 'Package required' });
    if (!pkg.files || typeof pkg.files !== 'object') {
      return res.status(400).json({ error: 'Invalid package format' });
    }
    await restartBot(pkg);
    res.json({ ok: true, message: 'Session imported and bot restarted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/refresh', async (req, res) => {
  try {
    const cleared = clearSenderKeyMemory();
    await restartBot();
    res.json({ ok: true, message: `Restarted. Cleared ${cleared} sender-key files.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Serve static frontend (protected) ----
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🖥️  UI on http://0.0.0.0:${PORT}`));