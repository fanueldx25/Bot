import express from 'express';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { pool, initDb, getStatus, log } from './db.js';
import { startBot, setIO, logout, getSock, getRegisteredCommands } from './bot.js';
import { loadCommands } from './commands/index.js';
import { loadAntiSettings } from './commands/anti.js';
import { invalidateAutomationCache } from './engine.js';
import { startSelfPing, getPingHistory, getPingStats } from './ping.js';

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
const isProd = process.env.NODE_ENV === 'production';
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
    secure: isProd,
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);
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
    if (password !== (process.env.OWNER_PASSWORD || '')) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
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

    const { phone, mode } = req.body || {};

    if (mode === 'pair' && !phone) {
      return res.status(400).json({ error: 'Phone number required for pairing mode' });
    }

    await startBot({
      phoneNumber: phone || null,
      mode: mode === 'pair' ? 'pair' : 'qr',
    });
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
    // 1. Pull from DB
    const { rows } = await pool.query(
      `SELECT command, enabled, config FROM command_settings
       WHERE session_id='owner' ORDER BY command`
    );

    // 2. In-memory registry (source of truth right now)
    const inMemory = getRegisteredCommands();
    const dbNames = new Set(rows.map((r) => r.command));

    // 3. Backfill any registered command missing from DB
    const missing = inMemory.filter((name) => !dbNames.has(name));
    for (const name of missing) {
      rows.push({ command: name, enabled: true, config: {} });
      try {
        await pool.query(
          `INSERT INTO command_settings (session_id, command, enabled)
           VALUES ('owner', $1, TRUE)
           ON CONFLICT (session_id, command) DO NOTHING`,
          [name]
        );
      } catch (e) {
        console.error('backfill failed for', name, e.message);
      }
    }

    // 4. Sort alphabetically
    rows.sort((a, b) => a.command.localeCompare(b.command));

    res.json(rows);
  } catch (e) {
    console.error('/api/commands failed:', e.message);
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

    // By default hide internal types (key = auth state, ping = health checks)
    const hidden = ['key', 'ping'];
    const q = type
      ? `SELECT id, type, key, value, created_at FROM storage
         WHERE session_id='owner' AND type=$1
         ORDER BY id DESC LIMIT 300`
      : `SELECT id, type, key, value, created_at FROM storage
         WHERE session_id='owner' AND type <> ALL($1::text[])
         ORDER BY id DESC LIMIT 300`;
    const params = type ? [type] : [hidden];
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/storage/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM storage WHERE id=$1 AND session_id=$2', [
      req.params.id,
      'owner',
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ Storage Metrics ═══════════════ */
app.get('/api/storage/stats', requireAuth, async (req, res) => {
  try {
    const sizeQ = await pool.query(`
      SELECT
        pg_size_pretty(pg_database_size(current_database())) AS db_size,
        pg_database_size(current_database()) AS db_bytes,
        1073741824 AS limit_bytes
    `);

    const countsQ = await pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM storage
      WHERE session_id='owner'
      GROUP BY type
      ORDER BY count DESC
    `);

    const tablesQ = await pool.query(`
      SELECT 'storage'       AS table, COUNT(*)::int AS rows FROM storage
      UNION ALL SELECT 'logs',        COUNT(*)::int FROM logs
      UNION ALL SELECT 'automations', COUNT(*)::int FROM automations
      UNION ALL SELECT 'sessions',    COUNT(*)::int FROM sessions
      UNION ALL SELECT 'command_settings', COUNT(*)::int FROM command_settings
      UNION ALL SELECT 'session',     COUNT(*)::int FROM session
    `);

    const biggestQ = await pool.query(`
      SELECT type, key, pg_column_size(value)::int AS bytes
      FROM storage
      WHERE session_id='owner'
      ORDER BY bytes DESC
      LIMIT 10
    `);

    const sessionsQ = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status='connected')::int AS connected
      FROM sessions
    `);

    const breakdownQ = await pool.query(`
      SELECT
        COALESCE(SUM(pg_column_size(value)) FILTER (WHERE type='key'), 0)::bigint AS auth_bytes,
        COALESCE(SUM(pg_column_size(value)) FILTER (WHERE type NOT IN ('key','ping')), 0)::bigint AS data_bytes,
        COALESCE(SUM(pg_column_size(value)) FILTER (WHERE type='ping'), 0)::bigint AS ping_bytes
      FROM storage
      WHERE session_id='owner'
    `);

    const db = sizeQ.rows[0];
    const pct = Math.round((Number(db.db_bytes) / 1073741824) * 100 * 100) / 100;

    res.json({
      db: {
        pretty: db.db_size,
        bytes: Number(db.db_bytes),
        limit: 1073741824,
        limitPretty: '1 GB',
        percentUsed: pct,
      },
      breakdown: breakdownQ.rows[0],
      byType: countsQ.rows,
      tables: tablesQ.rows,
      biggest: biggestQ.rows,
      sessions: sessionsQ.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/storage/cleanup', requireAuth, async (req, res) => {
  try {
    const { logsOlderThanDays = 14, keepPings = 200 } = req.body || {};

    const logsDel = await pool.query(
      `DELETE FROM logs
       WHERE session_id='owner'
         AND created_at < NOW() - ($1 || ' days')::interval`,
      [String(logsOlderThanDays)]
    );

    const pingsDel = await pool.query(
      `DELETE FROM storage
       WHERE id IN (
         SELECT id FROM storage
         WHERE session_id='owner' AND type='ping'
         ORDER BY id DESC OFFSET $1
       )`,
      [keepPings]
    );

    const sessDel = await pool.query(
      `DELETE FROM session WHERE expire < NOW()`
    );

    res.json({
      ok: true,
      logsDeleted: logsDel.rowCount,
      pingsDeleted: pingsDel.rowCount,
      sessionsDeleted: sessDel.rowCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════ Self-Ping ═══════════════ */
app.get('/api/ping/history', requireAuth, async (req, res) => {
  try {
    const history = await getPingHistory(50);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ping/stats', requireAuth, async (req, res) => {
  try {
    const stats = await getPingStats();
    res.json(stats);
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
    let limit = parseInt(req.query.limit, 10) || 200;
    if (limit > 500) limit = 500;
    if (limit < 1) limit = 1;

    const { rows } = await pool.query(
      `SELECT id, level, message, created_at FROM logs
       WHERE session_id='owner' ORDER BY id DESC LIMIT $1`,
      [limit]
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
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM storage`);
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

/* ═══════════════ Emit log helper ═══════════════ */
global.__emitLog = (entry) => io.emit('log', entry);

/* ═══════════════ DB Maintenance ═══════════════ */
async function runMaintenance() {
  try {
    const logsPruned = await pool.query(
      `DELETE FROM logs
       WHERE created_at < NOW() - INTERVAL '14 days'`
    );
    if (logsPruned.rowCount > 0) {
      console.log(`🧹 Pruned ${logsPruned.rowCount} old logs`);
    }

    const sessPruned = await pool.query(
      `DELETE FROM session WHERE expire < NOW()`
    );
    if (sessPruned.rowCount > 0) {
      console.log(`🧹 Pruned ${sessPruned.rowCount} expired sessions`);
    }

    const pingsPruned = await pool.query(
      `DELETE FROM storage
       WHERE id IN (
         SELECT id FROM storage
         WHERE session_id='owner' AND type='ping'
         ORDER BY id DESC OFFSET 500
       )`
    );
    if (pingsPruned.rowCount > 0) {
      console.log(`🧹 Pruned ${pingsPruned.rowCount} old pings`);
    }
  } catch (e) {
    console.error('maintenance failed:', e.message);
  }
}

/* ═══════════════ Boot ═══════════════ */
async function boot() {
  try {
    await initDb();
    console.log('🗄️  Database ready');
    await loadCommands();
    await loadAntiSettings();
    console.log('⚙️  Commands + anti settings loaded');

    await runMaintenance();
    setInterval(runMaintenance, 6 * 60 * 60 * 1000);
  } catch (e) {
    console.error('❌ Boot prep failed:', e);
  }

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    startSelfPing(io);
  });

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