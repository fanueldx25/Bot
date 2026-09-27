// ============================================================================
// server.js — Express + Socket.io + Auth + Self-ping dashboard
// ============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const state = require('./state');
const connection = require('./connection');
const collection = require('./collection');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

state.io = io;

// ============================================================================
// AUTH
// ============================================================================

const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSIONS = new Set();
const SESSION_TIMESTAMPS = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 24; // 24h

function makeToken() {
  const t = crypto.randomBytes(32).toString('hex');
  SESSIONS.add(t);
  SESSION_TIMESTAMPS.set(t, Date.now() + SESSION_TTL);
  return t;
}

function isValidToken(t) {
  if (!t || !SESSIONS.has(t)) return false;
  const exp = SESSION_TIMESTAMPS.get(t) || 0;
  if (Date.now() > exp) {
    SESSIONS.delete(t);
    SESSION_TIMESTAMPS.delete(t);
    return false;
  }
  return true;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((p) => {
    const [k, ...v] = p.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

// ============================================================================
// PUBLIC ROUTES (no auth)
// ============================================================================

app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
});

app.post('/api/login', (req, res) => {
  if (!PASSWORD) {
    return res.json({ ok: true, disabled: true });
  }
  const { password } = req.body || {};
  if (password !== PASSWORD) {
    console.log(`[Auth] failed login attempt from ${req.ip}`);
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }
  const token = makeToken();
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`
  );
  console.log(`[Auth] login OK from ${req.ip}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const { sid } = parseCookies(req);
  if (sid) {
    SESSIONS.delete(sid);
    SESSION_TIMESTAMPS.delete(sid);
  }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const { sid } = parseCookies(req);
  res.json({ authed: isValidToken(sid) || !PASSWORD, passwordRequired: !!PASSWORD });
});

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

function requireAuth(req, res, next) {
  if (!PASSWORD) return next();
  const { sid } = parseCookies(req);
  if (isValidToken(sid)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized — login required' });
}

// ============================================================================
// SNAPSHOT
// ============================================================================

function snapshot() {
  return {
    state: state.connectionState,
    code: state.pairingCode,
    number: state.currentNumber,
    jid: state.botJid,
    admin: state.ADMIN_NUMBER ? '+' + state.ADMIN_NUMBER : null,
    uptime: Math.floor(process.uptime())
  };
}

// ============================================================================
// PROTECTED API
// ============================================================================

app.post('/api/connect', requireAuth, async (req, res) => {
  const { number } = req.body || {};
  const v = connection.validateNumber(number);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  try {
    const result = await connection.startBot(v.clean);
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true, number: v.clean });
  } catch (e) {
    console.error('[API /connect]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/state', requireAuth, (req, res) => {
  res.json(snapshot());
});

app.post('/api/disconnect', requireAuth, (req, res) => {
  try {
    connection.stopBot();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/commands', requireAuth, (req, res) => {
  res.json(collection.all());
});


// ============================================================================
// SESSION BACKUP / RESTORE
// ============================================================================

// Check if a session exists
app.get('/api/session/status', requireAuth, (req, res) => {
  res.json({
    ok: true,
    hasSession: connection.hasStoredSession(),
    number: state.currentNumber || null,
    jid: state.botJid || null,
    state: state.connectionState
  });
});

// Download the current session as a JSON file
app.get('/api/session/download', requireAuth, (req, res) => {
  const result = connection.exportSession();
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  
  // Return as a downloadable JSON file
  const file = {
    version: 1,
    exportedAt: new Date().toISOString(),
    number: state.currentNumber,
    jid: state.botJid,
    payload: result.payload
  };
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${result.filename}"`
  );
  res.send(JSON.stringify(file, null, 2));
});

// Upload a session file (JSON body with payload or files)
app.post('/api/session/upload', requireAuth, async (req, res) => {
  try {
    // Accept either { payload: "base64..." } or a full JSON body
    const raw = JSON.stringify(req.body);
    const result = connection.importSession(raw);
    
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    
    // Restart the bot to pick up the restored session
    setTimeout(() => {
      try {
        connection.stopBot();
        setTimeout(() => {
          connection.startBot(result.number || state.currentNumber);
        }, 1500);
      } catch (e) {
        console.error('[Session] restart error:', e.message);
      }
    }, 1000);
    
    res.json({
      ok: true,
      written: result.written,
      number: result.number,
      message: 'Session imported. Bot is restarting...'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete the current session (logout from disk)
app.post('/api/session/delete', requireAuth, (req, res) => {
  try {
    const path = require('path');
    const fs = require('fs');
    const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    connection.stopBot();
    res.json({ ok: true, message: 'Session deleted.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================================
// SOCKET.IO WITH AUTH
// ============================================================================

io.use((socket, next) => {
  if (!PASSWORD) return next();
  const cookies = socket.handshake.headers.cookie || '';
  const match = cookies.match(/sid=([^;]+)/);
  const sid = match ? decodeURIComponent(match[1]) : null;
  if (isValidToken(sid)) return next();
  return next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  console.log('[Socket] client connected');
  socket.emit('state', snapshot());
  socket.on('request_state', () => socket.emit('state', snapshot()));
  socket.on('disconnect', () => console.log('[Socket] client disconnected'));
});

// ============================================================================
// SELF-PING (keep-alive for Render free tier)
// ============================================================================

const SELF_URL = process.env.SELF_URL || '';

function startSelfPing() {
  if (!SELF_URL) {
    console.log('[Ping] SELF_URL not set — self-ping disabled');
    return;
  }
  const url = SELF_URL.replace(/\/$/, '') + '/healthz';
  const INTERVAL = 1000 * 60 * 4; // 4 min — under Render's 15-min sleep
  
  const ping = async () => {
    try {
      const res = await fetch(url);
      console.log(`[Ping] ${new Date().toISOString()} → ${res.status}`);
    } catch (e) {
      console.log('[Ping] failed:', e.message);
    }
  };
  
  // first ping after 30s, then every 4 min
  setTimeout(ping, 30 * 1000);
  setInterval(ping, INTERVAL);
  console.log('[Ping] enabled →', url, 'every 4 min');
}

// ============================================================================
// BOOT
// ============================================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 Dashboard : http://localhost:${PORT}`);
  console.log(`🔐 Password  : ${PASSWORD ? 'ENABLED' : 'disabled (no DASHBOARD_PASSWORD set)'}`);
  console.log(`👑 Admin     : ${state.ADMIN_NUMBER ? '+' + state.ADMIN_NUMBER : 'NOT SET'}`);
  console.log(`📡 Self-ping : ${SELF_URL || 'disabled (no SELF_URL set)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  state.loadState();
  connection.loadBanner();
  startSelfPing();
});

// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received');
  try { connection.stopBot(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});

// ---------- Session code API ----------
app.get('/api/session-code', requireAuth, (req, res) => {
  const code = state.generateSessionCode(60);
  const expiresIn = 60 - (Math.floor(Date.now() / 1000) % 60);
  res.json({ ok: true, code, expiresIn });
});