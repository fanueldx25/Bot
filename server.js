import express from 'express';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { pool, initDb, getStatus, log } from './db.js';
import { startBot, setIO, logout, getSock, getIO } from './bot.js';
import { loadCommands } from './commands/index.js';
import { loadAntiSettings } from './commands/anti.js';
import { invalidateAutomationCache } from './engine.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: true, credentials: true },
});

setIO(io);

/* ═══════════════ Middleware ═══════════════ */
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ═══════════════ Session Store ═══════════════ */
const PgStore = connectPgSimple(session);
const sessionMiddleware = session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);

/* Share session with Socket.IO */
io.engine.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════ Auth Middleware ═══════════════ */
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

/* ═══════════════ Auth Routes ═══════════════ */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    if (username !== process.env.OWNER_USERNAME) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const expected = process.env.OWNER_PASSWORD || '';
    const ok = password === expected;
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.user = { username, role: 'owner' };
    await log('owner', 'info', `Login from ${req.ip}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

/* ═══════════════ Status ═══════════════ */
app.get('/api/status', requireAuth, async (req, res) => {
  const status = await getStatus('owner');
  res.json(status);
});

/* ═══════════════ Bot Control ═══════════════ */
app.post('/api/bot/start', requireAuth, async (req, res) => {
  try {
    const existing = getSock();
    if (existing?.user) return res.json({ ok: true, message: 'Already connected' });
    await startBot();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bot/logout', requireAuth, async (req, res) => {
  try {
    await logout();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ Commands ═══════════════ */
app.get('/api/commands', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT command, enabled, config FROM command_settings WHERE session_id='owner' ORDER BY command`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/commands/:name', requireAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const { enabled } = req.body;
    await pool.query(
      `INSERT INTO command_settings (session_id, command, enabled)
       VALUES ('owner', $1, $2)
       ON CONFLICT (session_id, command) DO UPDATE SET enabled=$2`,
      [name, !!enabled]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ Storage ═══════════════ */
app.get('/api/storage', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const q = type
      ? `SELECT id, type, key, value, created_at FROM storage
         WHERE session_id='owner' AND type=$1
         ORDER BY id DESC LIMIT 300`
      : `SELECT id, type, key, value, created_at FROM storage
         WHERE session_id='owner' AND type NOT IN ('key')
         ORDER BY id DESC LIMIT 300`;
    const { rows } = await pool.query(q, type ? [type] : []);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/storage/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM storage WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ Automations ═══════════════ */
app.get('/api/automations', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, trigger, action, enabled, created_at FROM automations
       WHERE session_id='owner' ORDER BY id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/automations', requireAuth, async (req, res) => {
  try {
    const { trigger, action } = req.body;
    if (!trigger?.type || !action?.type) {
      return res.status(400).json({ error: 'Invalid trigger/action' });
    }
    await pool.query(
      `INSERT INTO automations (session_id, trigger, action, enabled)
       VALUES ('owner', $1, $2, TRUE)`,
      [trigger, action]
    );
    invalidateAutomationCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/automations/:id', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    await pool.query(
      `UPDATE automations SET enabled=$1 WHERE id=$2 AND session_id='owner'`,
      [!!enabled, req.params.id]
    );
    invalidateAutomationCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/automations/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM automations WHERE id=$1 AND session_id='owner'`,
      [req.params.id]
    );
    invalidateAutomationCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ Logs ═══════════════ */
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, level, message, created_at FROM logs
       WHERE session_id='owner' ORDER BY id DESC LIMIT 200`
    );
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ System ═══════════════ */
app.get('/api/system', requireAuth, async (req, res) => {
  try {
    const total = os.totalmem() / 1024 / 1024 / 1024;
    const free = os.freemem() / 1024 / 1024 / 1024;
    const up = process.uptime();
    const h = Math.floor(up / 3600);
    const m = Math.floor((up % 3600) / 60);
    const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM storage`);
    res.json({
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      uptime: `${h}h ${m}m`,
      memTotal: total.toFixed(2),
      memUsed: (total - free).toFixed(2),
      cpus: os.cpus().length,
      dbStorage: rows[0].c,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ Health Check ═══════════════ */
app.get('/healthz', (req, res) => res.send('ok'));

/* ═══════════════ Socket.IO ═══════════════ */
io.on('connection', (socket) => {
  const user = socket.request.session?.user;
  console.log('🔌 UI connected', user?.username || 'anonymous');
  socket.emit('ready');
});

/* ═══════════════ Log broadcaster ═══════════════ */
// Wrap db log() to also emit to sockets
const originalLog = log;
global.__emitLog = (entry) => io.emit('log', entry);

/* ═══════════════ Boot ═══════════════ */
async function boot() {
  try {
    await initDb();
    console.log('🗄️  Database ready');
    await loadCommands();
    await loadAntiSettings();
    console.log('⚙️  Commands + anti settings loaded');
  } catch (e) {
    console.error('❌ Boot prep failed:', e);
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Auto-start bot on boot (it will use stored creds if available)
  try {
    await startBot();
  } catch (e) {
    console.error('⚠️  Bot auto-start failed:', e.message);
  }
}

boot();

/* ═══════════════ Graceful Shutdown ═══════════════ */
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  try { await logout(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});