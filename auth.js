import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { pool } from './db.js';

/**
 * Baileys auth state backed by Postgres.
 * Fixes: proper BufferJSON serialization + initAuthCreds fallback.
 */
export async function usePostgresAuthState(sessionId) {
  const writeData = async (data, key) => {
    const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await pool.query(
      `INSERT INTO storage (session_id, type, key, value)
       VALUES ($1, 'key', $2, $3)
       ON CONFLICT (session_id, type, key) DO UPDATE SET value = $3`,
      [sessionId, key, value]
    );
  };
  
  const readData = async (key) => {
    const { rows } = await pool.query(
      `SELECT value FROM storage WHERE session_id=$1 AND type='key' AND key=$2`,
      [sessionId, key]
    );
    if (!rows[0]) return null;
    return JSON.parse(JSON.stringify(rows[0].value), BufferJSON.reviver);
  };
  
  const removeData = async (key) => {
    await pool.query(
      `DELETE FROM storage WHERE session_id=$1 AND type='key' AND key=$2`,
      [sessionId, key]
    );
  };
  
  const creds = (await readData('creds')) || initAuthCreds();
  
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
}

export async function clearAuthState(sessionId) {
  await pool.query(
    `DELETE FROM storage WHERE session_id=$1 AND type='key'`,
    [sessionId]
  );
  await pool.query(
    `UPDATE sessions SET creds=NULL, status='disconnected', phone=NULL WHERE session_id=$1`,
    [sessionId]
  );
}