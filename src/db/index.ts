import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, PoolConfig } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

function determineSslConfig(connectionUrl?: string): boolean | { rejectUnauthorized: boolean } {
  if (!connectionUrl) return false;
  const lower = connectionUrl.toLowerCase();
  // Check for local database connection
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) {
    return false;
  }
  // Check if SSL is explicitly disabled in connection string
  if (lower.includes('sslmode=disable') || lower.includes('ssl=false')) {
    return false;
  }
  // Standard production deployment (Render, AWS, Supabase, Cloud SQL, Neon)
  return { rejectUnauthorized: false };
}

export const createPool = (): Pool => {
  if (!global._postgresPool) {
    let poolConfig: PoolConfig;
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      poolConfig = {
        connectionString: databaseUrl,
        ssl: determineSslConfig(databaseUrl),
      };
    } else {
      const isUnixSocket = process.env.SQL_HOST && process.env.SQL_HOST.startsWith('/');
      const isLocal = !process.env.SQL_HOST || process.env.SQL_HOST === 'localhost' || process.env.SQL_HOST === '127.0.0.1';
      
      poolConfig = {
        host: process.env.SQL_HOST || 'localhost',
        user: process.env.SQL_USER || 'postgres',
        password: process.env.SQL_PASSWORD || '',
        database: process.env.SQL_DB_NAME || 'postgres',
        port: Number(process.env.SQL_PORT) || 5432,
        ssl: isUnixSocket || isLocal ? false : { rejectUnauthorized: false },
      };
    }

    global._postgresPool = new Pool({
      ...poolConfig,
      max: Number(process.env.PG_POOL_MAX) || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL pool client:', err);
    });
  }
  return global._postgresPool;
};

export const pool = createPool();
export const db = drizzle(pool, { schema });

/**
 * Initializes required PostgreSQL tables automatically if they do not already exist.
 * This guarantees zero-downtime boots and self-healing deployments on Render.
 */
export async function initDatabase(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" serial PRIMARY KEY NOT NULL,
        "uid" text NOT NULL UNIQUE,
        "email" text NOT NULL,
        "created_at" timestamp DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "baileys_auth_creds" (
        "id" text PRIMARY KEY NOT NULL,
        "creds" jsonb NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "baileys_auth_keys" (
        "id" text PRIMARY KEY NOT NULL,
        "value" jsonb NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "bot_config" (
        "id" serial PRIMARY KEY NOT NULL,
        "config" jsonb NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "bot_logs" (
        "id" serial PRIMARY KEY NOT NULL,
        "timestamp" timestamp DEFAULT now() NOT NULL,
        "message" text NOT NULL,
        "type" text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "voicemails" (
        "id" serial PRIMARY KEY NOT NULL,
        "caller_number" text NOT NULL,
        "caller_name" text,
        "call_id" text NOT NULL,
        "call_type" text DEFAULT 'voice' NOT NULL,
        "timestamp" timestamp DEFAULT now() NOT NULL,
        "status" text DEFAULT 'missed' NOT NULL,
        "message_text" text,
        "is_voice_note" text DEFAULT 'false',
        "audio_url" text
      );
    `);
    return true;
  } catch (err: any) {
    console.error('Database initialization warning:', err.message);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Tests database connectivity and returns a status result without leaking credentials.
 */
export async function testDbConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await pool.query('SELECT 1 AS check');
    return { ok: res.rows?.[0]?.check === 1 };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Unknown database error' };
  }
}

