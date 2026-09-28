// ============================================================================
// IMPORTS
// ============================================================================
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import fs from 'fs';
import {
  startBot, requestPairing, state, persistConfig,
  regenerateToken, getBotData, exportSessionPackage,
  importSessionPackage, restartBot, clearSenderKeyMemory
} from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));

// ============================================================================
// AUTH CONFIG
// ============================================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'wa_bot_auth';

if (!ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD not set. Set it in Render environment variables.');
}

// ============================================================================
// COOKIE PARSER
// ============================================================================
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

// ============================================================================
// AUTH HELPERS
// ============================================================================
function generateAuthToken() {
  const payload = `${Date.now()}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifyAuthToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, hmac] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (hmac !== expected) return false;
  const age = Date.now() - parseInt(payload);
  return age < 7 * 24 * 60 * 60 * 1000;
}

function requireAuth(req, res, next) {
  // Public assets (needed for login page to work)
  if (
    req.path === '/login' ||
    req.path === '/api/login' ||
    req.path === '/health' ||
    req.path === '/manifest.json' ||
    req.path === '/sw.js' ||
    req.path.startsWith('/icon-') ||
    req.path === '/favicon.ico'
  ) {
    return next();
  }

  const token = req.cookies[COOKIE_NAME];
  if (token && verifyAuthToken(token)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// ============================================================================
// LOGIN ROUTES (public)
// ============================================================================
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Server password not configured' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = generateAuthToken();
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// ============================================================================
// HEALTH CHECK (public — used by self-ping)
// ============================================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    connected: state.connected,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// STATIC ASSETS (public for PWA files)
// ============================================================================
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'icon-192.png'));
});

// ============================================================================
// BOOT BOT
// ============================================================================
startBot().catch((err) => console.error('Bot boot failed:', err));

// ============================================================================
// PROTECTED API ROUTES
// ============================================================================
app.use(requireAuth);

app.get('/api/status', (req, res) => {
  res.json({
    connected: state.connected,
    mode: state.mode,
    ownerJid: state.ownerJid,
    ownerNumber: state.ownerNumber,
    pairingCode: state.pairingCode,
    pairingPhone: state.pairingPhone,
    sessionToken: state.sessionToken,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    antidelete: state.antidelete,
    antiedit: state.antiedit,
    welcome: state.welcome,
    goodbye: state.goodbye,
    botName: state.botName,
    prefix: state.prefix,
    msgCount: state.msgCount || 0,
    startedAt: state.startedAt,
  });
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
app.post('/api/pair', async (req, res) => {
  try {
    const { phone, force } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const code = await requestPairing(phone, force !== false);
    res.json({ code });
  } catch (err) {
    console.error('Pair error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Mode / toggles
// ---------------------------------------------------------------------------
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['private', 'public'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
  state.mode = mode; persistConfig();
  res.json({ ok: true, mode });
});

app.post('/api/toggle', (req, res) => {
  const { key, value } = req.body;
  const allowed = ['antidelete', 'antiedit', 'welcome', 'goodbye'];
  if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid key' });
  state[key] = value; persistConfig();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Settings (bot name, prefix)
// ---------------------------------------------------------------------------
app.post('/api/settings', (req, res) => {
  const { botName, prefix } = req.body;
  if (typeof botName === 'string' && botName.trim()) state.botName = botName.trim();
  if (typeof prefix === 'string' && prefix.length <= 2) state.prefix = prefix;
  persistConfig();
  res.json({ ok: true, botName: state.botName, prefix: state.prefix });
});

// ---------------------------------------------------------------------------
// Session export / import / refresh
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Logout device
// ---------------------------------------------------------------------------
app.post('/api/logout-device', async (req, res) => {
  try {
    if (state.sock) {
      await state.sock.logout().catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PROTECTED STATIC (the main app)
// ============================================================================
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,       // we serve index manually below
  extensions: ['html'],
}));

app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// SELF-PING
// ============================================================================
const SELF_URL = process.env.SELF_URL;

function selfPing() {
  if (!SELF_URL) return;
  const url = `${SELF_URL.replace(/\/$/, '')}/health`;
  const client = url.startsWith('https') ? https : http;
  const req = client.get(url, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
      if (res.statusCode === 200) console.log(`💓 Self-ping OK (${res.statusCode})`);
      else console.warn(`💓 Self-ping returned ${res.statusCode}`);
    });
  });
  req.on('error', (err) => console.warn(`💓 Self-ping failed: ${err.message}`));
  req.setTimeout(10000, () => { req.destroy(); console.warn('💓 Self-ping timed out'); });
}

const PING_INTERVAL_MS = 14 * 60 * 1000;
if (SELF_URL) {
  console.log(`💓 Self-ping enabled → ${SELF_URL}/health every ${PING_INTERVAL_MS / 60000} min`);
  setTimeout(() => { selfPing(); setInterval(selfPing, PING_INTERVAL_MS); }, 30000);
} else {
  console.log('💓 Self-ping disabled (SELF_URL not set)');
}

// ============================================================================
// START
// ============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🖥️  UI on http://0.0.0.0:${PORT}`);
  if (SELF_URL) console.log(`🔗 Public URL: ${SELF_URL}`);
});