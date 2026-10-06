import pg from 'pg'
import { initAuthCreds, proto } from '@whiskeysockets/baileys'
import config from './config.js'

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl?.includes('localhost') ?
    false :
    { rejectUnauthorized: false },
  max: 10,
})

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone_number   TEXT NOT NULL,
      creds          JSONB,
      status         TEXT NOT NULL DEFAULT 'pending',
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, phone_number)
    );

    CREATE TABLE IF NOT EXISTS auth_keys (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (session_id, type)
    );
  `)
}

/* ------------------------------------------------------------------ */
/*  Buffer-safe JSON (Baileys keys contain Buffers)                    */
/* ------------------------------------------------------------------ */
const bufferReviver = (_k, v) =>
  v?.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data) : v

const bufferReplacer = (_k, v) => {
  if (v?.type === 'Buffer' && Array.isArray(v.data)) return v
  if (Buffer.isBuffer(v)) return { type: 'Buffer', data: [...v] }
  return v
}

/* ------------------------------------------------------------------ */
/*  Baileys auth state backed by PostgreSQL                            */
/* ------------------------------------------------------------------ */
export async function usePostgresAuthState(sessionId) {
  const { rows } = await pool.query(
    'SELECT creds FROM sessions WHERE id = $1',
    [sessionId],
  )
  if (!rows[0]) throw new Error(`Session ${sessionId} not found`)
  
  const creds = rows[0].creds ?
    JSON.parse(JSON.stringify(rows[0].creds), bufferReviver) :
    initAuthCreds()
  
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const { rows } = await pool.query(
            'SELECT data FROM auth_keys WHERE session_id = $1 AND type = $2',
            [sessionId, type],
          )
          const all = rows[0]?.data ?? {}
          const out = {}
          for (const id of ids) {
            if (all[id] !== undefined) out[id] = all[id]
          }
          // Deserialize Buffers and apply proto coercion for app-state keys
          const parsed = JSON.parse(JSON.stringify(out), bufferReviver)
          if (type === 'app-state-sync-key' && parsed) {
            for (const k of Object.keys(parsed)) {
              if (parsed[k]) {
                parsed[k] = proto.Message.AppStateSyncKeyData.fromObject(parsed[k])
              }
            }
          }
          return parsed
        },
        
        set: async (data) => {
          for (const [type, values] of Object.entries(data)) {
            const { rows } = await pool.query(
              'SELECT data FROM auth_keys WHERE session_id = $1 AND type = $2',
              [sessionId, type],
            )
            const existing = rows[0]?.data ?? {}
            
            for (const [id, val] of Object.entries(values)) {
              if (val === null) delete existing[id]
              else existing[id] = JSON.parse(JSON.stringify(val, bufferReplacer))
            }
            
            await pool.query(
              `INSERT INTO auth_keys (session_id, type, data)
               VALUES ($1, $2, $3)
               ON CONFLICT (session_id, type) DO UPDATE SET data = EXCLUDED.data`,
              [sessionId, type, existing],
            )
          }
        },
      },
    },
    saveCreds: async () => {
      await pool.query('UPDATE sessions SET creds = $1 WHERE id = $2', [
        JSON.parse(JSON.stringify(creds, bufferReplacer)),
        sessionId,
      ])
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */
export const Users = {
  async create(email, passwordHash) {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email.toLowerCase(), passwordHash],
    )
    return rows[0]
  },
  async findByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [
      email.toLowerCase(),
    ])
    return rows[0]
  },
  async findById(id) {
    const { rows } = await pool.query(
      'SELECT id, email FROM users WHERE id = $1',
      [id],
    )
    return rows[0]
  },
}

/* ------------------------------------------------------------------ */
/*  Sessions                                                           */
/* ------------------------------------------------------------------ */
export const Sessions = {
  async create(userId, phoneNumber) {
    const { rows } = await pool.query(
      `INSERT INTO sessions (user_id, phone_number, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id, phone_number)
       DO UPDATE SET status = 'pending'
       RETURNING *`,
      [userId, phoneNumber],
    )
    return rows[0]
  },
  async listByUser(userId) {
    const { rows } = await pool.query(
      `SELECT id, phone_number, status, created_at
       FROM sessions WHERE user_id = $1 ORDER BY id DESC`,
      [userId],
    )
    return rows
  },
  async get(id, userId) {
    const { rows } = await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    return rows[0]
  },
  async getById(id) {
    const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1', [id])
    return rows[0]
  },
  async setStatus(id, status) {
    await pool.query('UPDATE sessions SET status = $1 WHERE id = $2', [status, id])
  },
  async delete(id, userId) {
    await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [
      id,
      userId,
    ])
  },
  async all() {
    const { rows } = await pool.query('SELECT * FROM sessions ORDER BY id')
    return rows
  },
}