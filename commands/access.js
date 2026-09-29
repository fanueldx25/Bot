import { pool } from '../db.js';

export function isOwner(jid) {
  const owners = (process.env.OWNER_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!owners.length) return true; // dev mode: allow all
  const num = jid.split('@')[0].split(':')[0];
  return owners.includes(num);
}

export async function isCommandEnabled(cmd) {
  const { rows } = await pool.query(
    `SELECT enabled FROM command_settings WHERE session_id='owner' AND command=$1`,
    [cmd]
  );
  return rows[0]?.enabled ?? true;
}

export default {
  owner: async ({ jid, reply }) => {
    await reply({ text: isOwner(jid) ? '✅ You are owner.' : '❌ Not owner.' });
  },
};