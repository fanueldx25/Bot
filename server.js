// ============================================================================
// server.js — Express + Socket.io + Auth + Self-ping dashboard
// ----------------------------------------------------------------------------
// Responsibilities:
//   - Serve the static dashboard (public/)
//   - Authenticate dashboard users (cookie session)
//   - Expose the REST API the dashboard talks to
//   - Bridge Socket.IO clients to the connection/state layer
//   - Self-ping /healthz to keep Render free-tier awake
//   - Graceful shutdown
//
// NOTE: all bot logic lives in connection.js / handlers.js / state.js.
// This file must never manipulate the Baileys socket directly.
// ============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const state = require('./state');
const connection = require('./connection');
const collection = require('./collection');

// ============================================================================
// APP + SERVER
// ============================================================================
const app = express();
const server = http.createServer(app);

// 🔧 FIX: tighten CORS. `*` is fine for local dev but leaks your dashboard
// to any origin in production. Set DASHBOARD_ORIGIN in env to lock it down;
// if unset, fall back to permissive for local development.
const ALLOWED_ORIGIN = process.env.DASHBOARD_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, credentials: true }
});

// 🔧 FIX: trust the first proxy in front of us (Render/Heroku/nginx).
// Without this, req.ip is the proxy's IP, cookie Secure detection breaks,
// and rate-limit logic misfires.
app.set('trust proxy', 1);

// 🔧 FIX: dashboard is the only thing that needs a 25MB body. The bot never
// POSTs that much. Restrict the big limit to the session-upload route and
// keep a sane default everywhere else. Prevents trivial memory-exhaustion
// from an unauthenticated POST to any other endpoint.
app.use('/api/session/upload', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '256kb' }));

app.use(express.static(path.join(__dirname, 'public')));

// 🔧 FIX: security headers. Cheap, no dependencies, and stops the dashboard
// from being framed or MIME-sniffed into executing something weird.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

state.io = io;

// ============================================================================
// AUTH
// ============================================================================
// Session model: opaque random token stored in memory + HttpOnly cookie.
// Simple, no dependency, and adequate for a single-instance dashboard.
// ============================================================================

const PASSWORD = process.env.DASHBOARD_PASSWORD || '';

// 🔧 FIX: warn loudly at boot if auth is disabled. Previously the only hint
// was in the boot banner, which is easy to miss in a log firehose.
if (!PASSWORD) {
  console.warn(
    '[Auth] ⚠️  DASHBOARD_PASSWORD is NOT set — dashboard is PUBLIC. ' +
    'Set it in your environment before deploying.'
  );
}

// 🔧 FIX: only mark cookies Secure when we're actually behind HTTPS. If you
// set Secure unconditionally on a Render app behind their proxy, the cookie
// is dropped and login silently fails.
const COOKIE_SECURE = process.env.NODE_ENV === 'production' ||
  process.env.COOKIE_SECURE === '1';

const SESSIONS = new Map(); // token → expiresAt (ms)
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24h

// 🔧 FIX: periodic sweep so expired tokens don't accumulate forever. This
// replaces the two-Set/two-Map dance with a single Map, and it's a single
// place to look when you need to reason about session lifetime.
setInterval(() => {
  const now = Date.now();
  for (const [tok, exp] of SESSIONS) {
    if (exp <= now) SESSIONS.delete(tok);
  }
}, 1000 * 60 * 30).unref(); // .unref() so it doesn't keep the process alive

function makeToken() {
  const t = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(t, Date.now() + SESSION_TTL_MS);
  return t;
}

function isValidToken(t) {
  if (!t) return false;
  const exp = SESSIONS.get(t);
  if (!exp) return false;
  if (Date.now() > exp) {
    SESSIONS.delete(t);
    return false;
  }
  return true;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((p) => {
    const [k, ...v] = p.trim().split('=');
    if (!k) return;
    try {
      out[k] = decodeURIComponent(v.join('='));
    } catch {
      out[k] = v.join('='); // fall back to raw on bad encoding
    }
  });
  return out;
}

// 🔧 FIX: constant-time password compare. Prevents timing side-channels on
// the login endpoint even though it's not a high-value target.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function setSessionCookie(res, token, maxAgeSec) {
  const parts = [
    `sid=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ---------------------------------------------------------------------------
// Login rate limiting (in-memory, per-IP)
// ---------------------------------------------------------------------------
// 🔧 FIX: without this, /api/login can be brute-forced at thousands/sec.
// Simple sliding window — fine for a single-instance dashboard.
const LOGIN_ATTEMPTS = new Map(); // ip → { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;

function loginRateLimited(ip) {
  const now = Date.now();
  const rec = LOGIN_ATTEMPTS.get(ip);
  if (!rec || now > rec.resetAt) {
    LOGIN_ATTEMPTS.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  rec.count++;
  if (rec.count > LOGIN_MAX_ATTEMPTS) return true;
  return false;
}

// ============================================================================
// PUBLIC ROUTES (no auth)
// ============================================================================

app.get('/healthz', (req, res) => {
  // 🔧 FIX: report a tiny bit more, still no secrets. Render's healthcheck
  // just needs 200, but the extra fields make debugging prod easier.
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    state: state.connectionState,
    hasSession: connection.hasStoredSession()
  });
});

app.post('/api/login', (req, res) => {
  if (!PASSWORD) {
    return res.json({ ok: true, disabled: true });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (loginRateLimited(ip)) {
    console.log(`[Auth] rate-limited login from ${ip}`);
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }

  const { password } = req.body || {};
  if (!safeEqual(password || '', PASSWORD)) {
    console.log(`[Auth] failed login from ${ip}`);
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  const token = makeToken();
  setSessionCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
  console.log(`[Auth] login OK from ${ip}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const { sid } = parseCookies(req);
  if (sid) SESSIONS.delete(sid);
  // 🔧 FIX: expire the cookie with the same attributes it was set with
  // (otherwise some browsers ignore the deletion on Secure paths).
  const parts = ['sid=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const { sid } = parseCookies(req);
  res.json({
    authed: isValidToken(sid) || !PASSWORD,
    passwordRequired: !!PASSWORD
  });
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
// SNAPSHOT (single source of truth for /api/state and socket 'state' event)
// ============================================================================

function snapshot() {
  return {
    state: state.connectionState,
    code: state.pairingCode,
    number: state.currentNumber,
    jid: state.botJid,
    admin: state.ADMIN_NUMBER ? '+' + state.ADMIN_NUMBER : null,
    uptime: Math.floor(process.uptime()),
    // 🆕 extras useful to the UI without needing another round-trip
    hasSession: connection.hasStoredSession()
  };
}

// ============================================================================
// PROTECTED API — CONNECTION
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

// 🔧 FIX: stopBot is now async — must be awaited. See connection.js rewrite.
app.post('/api/disconnect', requireAuth, async (req, res) => {
  try {
    await connection.stopBot();
    res.json({ ok: true });
  } catch (e) {
    console.error('[API /disconnect]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/commands', requireAuth, (req, res) => {
  res.json(collection.all());
});

// ---------- Session code API ----------
// 🔧 FIX: refuse to mint a UI session code while the bot is mid-connect or
// live. Prevents the dashboard from spamming generateSessionCode() during
// a pairing window, which was making the state flip in the UI.
app.get('/api/session-code', requireAuth, (req, res) => {
  if (state.connectionState === 'connecting' || state.connectionState === 'connected') {
    return res.status(409).json({ ok: false, error: 'Bot is busy. Try again when idle.' });
  }
  const code = state.generateSessionCode(60);
  const expiresIn = 60 - (Math.floor(Date.now() / 1000) % 60);
  res.json({ ok: true, code, expiresIn });
});

// ============================================================================
// PROTECTED API — SESSION BACKUP / RESTORE
// ============================================================================

app.get('/api/session/status', requireAuth, (req, res) => {
  res.json({
    ok: true,
    hasSession: connection.hasStoredSession(),
    number: state.currentNumber || null,
    jid: state.botJid || null,
    state: state.connectionState
  });
});

app.get('/api/session/download', requireAuth, (req, res) => {
  const result = connection.exportSession();
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }

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

// 🔧 FIX: the old handler fired nested setTimeouts and never awaited
// stopBot. That was a primary source of the connect/disconnect loop.
// Now: stop fully → import → start fresh → respond with the real result.
app.post('/api/session/upload', requireAuth, async (req, res) => {
  try {
    const raw = JSON.stringify(req.body);

    // 1. Fully stop the old socket and wait for teardown to complete.
    await connection.stopBot();

    // 2. Now it's safe to rewrite auth files on disk.
    const result = connection.importSession(raw);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    // 3. Start fresh with the restored session.
    const started = await connection.startBot(result.number || state.currentNumber);
    if (!started.ok) {
      return res.status(500).json({ ok: false, error: started.error });
    }

    res.json({
      ok: true,
      written: result.written,
      number: result.number,
      message: 'Session imported and bot restarted.'
    });
  } catch (e) {
    console.error('[API /session/upload]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 🔧 FIX: stop the bot FIRST, then delete auth from disk. The old order
// (delete-then-stop) meant a live socket would try to read from a
// directory that just vanished — instant crash → ghost reconnect → loop.
app.post('/api/session/delete', requireAuth, async (req, res) => {
  try {
    await connection.stopBot();

    const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }

    // Clear in-memory session info so the UI doesn't show stale data.
    state.currentNumber = null;
    state.botJid = null;
    state.pairingCode = null;
    state.setState('disconnected');

    res.json({ ok: true, message: 'Session deleted.' });
  } catch (e) {
    console.error('[API /session/delete]', e);
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
  let sid = null;
  if (match) {
    try {
      sid = decodeURIComponent(match[1]);
    } catch {
      sid = match[1];
    }
  }

  if (isValidToken(sid)) return next();
  return next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  console.log('[Socket] client connected');

  // Send the current snapshot immediately on connect.
  socket.emit('state', snapshot());

  // 🔧 FIX: heartbeat. Render and most proxies drop idle WebSockets after
  // ~60s. Without a ping, the dashboard shows "connected" but receives
  // nothing after a minute of silence. Also helps the client detect a
  // dead server faster than waiting for TCP timeout.
  socket.on('ping', (cb) => {
    if (typeof cb === 'function') cb({ ok: true, t: Date.now() });
  });

  socket.on('request_state', () => socket.emit('state', snapshot()));

  socket.on('disconnect', (reason) =>
    console.log('[Socket] client disconnected:', reason)
  );
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
  if (typeof fetch !== 'function') {
    console.log('[Ping] global fetch unavailable (Node <18) — self-ping disabled');
    return;
  }

  const url = SELF_URL.replace(/\/$/, '') + '/healthz';
  const INTERVAL = 1000 * 60 * 4; // 4 min — under Render's 15-min sleep

  const ping = async () => {
    try {
      const res = await fetch(url, { method: 'GET' });
      console.log(`[Ping] ${new Date().toISOString()} → ${res.status}`);
    } catch (e) {
      console.log('[Ping] failed:', e.message);
    }
  };

  setTimeout(ping, 30 * 1000);
  // 🔧 FIX: .unref() so a stray ping timer never blocks shutdown.
  setInterval(ping, INTERVAL).unref();
  console.log('[Ping] enabled →', url, 'every 4 min');
}

// ============================================================================
// BOOT
// ============================================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 Dashboard : http://localhost:${PORT}`);
  console.log(`🔐 Password  : ${PASSWORD ? 'ENABLED' : 'DISABLED (set DASHBOARD_PASSWORD)'}`);
  console.log(`🍪 Cookie    : ${COOKIE_SECURE ? 'Secure' : 'not Secure (dev)'}`);
  console.log(`🌍 CORS      : ${ALLOWED_ORIGIN}`);
  console.log(`👑 Admin     : ${state.ADMIN_NUMBER ? '+' + state.ADMIN_NUMBER : 'NOT SET'}`);
  console.log(`📡 Self-ping : ${SELF_URL || 'disabled (no SELF_URL set)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  state.loadState();
  connection.loadBanner();
  startSelfPing();
});

// ============================================================================
// ERROR HANDLING
// ============================================================================
// 🔧 FIX: Express default error handler prints a stack trace to the client
// in dev. Give it a proper JSON shape and log server-side.
app.use((err, req, res, _next) => {
  console.error('[Express]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok: false, error: 'Internal server error' });
});

// 🔧 FIX: catch synchronous throws and unhandled rejections instead of
// letting the process exit silently. In production you'd forward these to
// a logging service; here we just ensure the process keeps serving.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
// 🔧 FIX: stopBot is async now, so await it. Also guard against double
// shutdown (SIGTERM and SIGINT can both arrive) and unref the kill timer.
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[Shutdown] ${signal} received`);

  // Force-exit if cleanup hangs longer than 5s.
  const killTimer = setTimeout(() => {
    console.error('[Shutdown] forcing exit after 5s');
    process.exit(1);
  }, 5000);
  killTimer.unref();

  try {
    await connection.stopBot();
  } catch (e) {
    console.error('[Shutdown] stopBot failed:', e.message);
  }

  io.close();
  server.close(() => {
    console.log('[Shutdown] clean exit');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));