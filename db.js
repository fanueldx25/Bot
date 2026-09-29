import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.DATABASE_URL || '';

// Render's internal DB host looks like: dpg-xxxxx-a
// Render's external DB host looks like: dpg-xxxxx-a.region-postgres.render.com
const isRenderExternal = /\.render\.com/.test(url);
const isLocalhost = /localhost|127\.0\.0\.1/.test(url);

// SSL: needed for external connections, not for internal / local
const useSSL = isRenderExternal || url.includes('sslmode=require');

export const pool = new pg.Pool({
  connectionString: url,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('💥 Unexpected PG pool error:', err.message);
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      creds JSONB,
      status TEXT DEFAULT 'disconnected',
      phone TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS command_settings (
      session_id TEXT,
      command TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      config JSONB DEFAULT '{}',
      PRIMARY KEY (session_id, command)
    );

    CREATE TABLE IF NOT EXISTS storage (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      type TEXT,
      key TEXT,
      value JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (session_id, type, key)
    );

    CREATE TABLE IF NOT EXISTS automations (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      trigger JSONB,
      action JSONB,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      level TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_storage_session_type
      ON storage (session_id, type);
    CREATE INDEX IF NOT EXISTS idx_logs_session_id
      ON logs (session_id, id DESC);
  `);
}

/* ───────────── Baileys creds helpers ───────────── */
export async function readCreds(sessionId) {
  const { rows } = await pool.query(
    'SELECT creds FROM sessions WHERE session_id=$1',
    [sessionId]
  );
  return rows[0]?.creds || null;
}

export async function writeCreds(sessionId, creds) {
  await pool.query(
    `INSERT INTO sessions (session_id, creds, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (session_id) DO UPDATE SET creds=$2, updated_at=NOW()`,
    [sessionId, creds]
  );
}

export async function setStatus(sessionId, status, phone = null) {
  await pool.query(
    `INSERT INTO sessions (session_id, status, phone, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (session_id) DO UPDATE
       SET status=$2,
           phone=COALESCE($3, sessions.phone),
           updated_at=NOW()`,
    [sessionId, status, phone]
  );
}

export async function getStatus(sessionId) {
  const { rows } = await pool.query(
    'SELECT status, phone FROM sessions WHERE session_id=$1',
    [sessionId]
  );
  return rows[0] || { status: 'disconnected', phone: null };
}

export async function log(sessionId, level, message) {
  try {
    await pool.query(
      'INSERT INTO logs (session_id, level, message) VALUES ($1,$2,$3)',
      [sessionId, level, message]
    );
    if (global.__emitLog) {
      global.__emitLog({
        session_id: sessionId,
        level,
        message,
        created_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('log() failed:', e.message);
  }
}