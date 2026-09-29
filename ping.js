import https from 'https';
import http from 'http';
import { pool, log } from './db.js';

const PING_INTERVAL = 4 * 60 * 1000; // 4 minutes
let timer = null;
let ioRef = null;

export function setPingIO(io) { ioRef = io; }

export function getSelfUrl() {
  if (process.env.SELF_URL) return process.env.SELF_URL;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  return null;
}

function doFetch(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const start = Date.now();
    const req = lib.get(url, (res) => {
      res.resume();
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 400,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    req.on('error', (e) => {
      resolve({ ok: false, status: 0, ms: Date.now() - start, error: e.message });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ ok: false, status: 0, ms: Date.now() - start, error: 'timeout' });
    });
  });
}

async function pingOnce() {
  const base = getSelfUrl();
  if (!base) return;
  const url = base.replace(/\/$/, '') + '/healthz';
  const result = await doFetch(url);
  
  try {
    await pool.query(
      `INSERT INTO storage (session_id, type, key, value)
       VALUES ('owner', 'ping', $1, $2)
       ON CONFLICT (session_id, type, key) DO UPDATE SET value=$2, created_at=NOW()`,
      [String(Date.now()), { ...result, at: new Date().toISOString() }]
    );
    await pool.query(
      `DELETE FROM storage WHERE id IN (
        SELECT id FROM storage
        WHERE session_id='owner' AND type='ping'
        ORDER BY id DESC OFFSET 200
      )`
    );
  } catch (e) {
    console.error('ping persist failed:', e.message);
  }
  
  ioRef?.emit('ping', { ...result, at: new Date().toISOString(), url });
  
  if (result.ok) {
    console.log(`🏓 Self-ping OK (${result.ms}ms)`);
  } else {
    console.warn(`⚠️  Self-ping failed: ${result.error || result.status}`);
    await log('owner', 'warn', `Self-ping failed: ${result.error || result.status}`);
  }
}

export function startSelfPing(io) {
  setPingIO(io);
  if (timer) clearInterval(timer);
  
  const base = getSelfUrl();
  if (!base) {
    console.log('ℹ️  Self-ping disabled (no SELF_URL / RENDER_EXTERNAL_URL)');
    return;
  }
  
  console.log(`🏓 Self-ping started → ${base}/healthz every ${PING_INTERVAL / 60000} min`);
  setTimeout(pingOnce, 5_000);
  timer = setInterval(pingOnce, PING_INTERVAL);
}

export function stopSelfPing() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function getPingHistory(limit = 50) {
  const { rows } = await pool.query(
    `SELECT value, created_at FROM storage
     WHERE session_id='owner' AND type='ping'
     ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ ...r.value, created_at: r.created_at })).reverse();
}

export async function getPingStats() {
  const { rows } = await pool.query(
    `SELECT value FROM storage
     WHERE session_id='owner' AND type='ping'
     ORDER BY id DESC LIMIT 100`
  );
  if (!rows.length) return { total: 0, ok: 0, fail: 0, avgMs: 0, uptime: 0 };
  const pings = rows.map((r) => r.value);
  const ok = pings.filter((p) => p.ok).length;
  const avgMs = Math.round(
    pings.filter((p) => p.ok).reduce((a, p) => a + p.ms, 0) / Math.max(1, ok)
  );
  return {
    total: pings.length,
    ok,
    fail: pings.length - ok,
    avgMs,
    uptime: Math.round((ok / pings.length) * 100),
  };
}