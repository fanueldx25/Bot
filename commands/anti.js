import { pool } from '../db.js';

const FLAGS = new Map(); // groupId -> Set of enabled anti-features
const spamMap = new Map(); // jid -> [timestamps]

/* ═══════════════════════════════════════════════
   NAMED EXPORTS (imported by bot.js)
   ═══════════════════════════════════════════════ */

export async function loadAntiSettings(sessionId = 'owner') {
  const { rows } = await pool.query(
    `SELECT value FROM storage WHERE session_id=$1 AND type='anti' AND key='groups'`,
    [sessionId]
  );
  const cfg = rows[0]?.value || {};
  FLAGS.clear();
  for (const [group, flags] of Object.entries(cfg)) {
    FLAGS.set(group, new Set(flags));
  }
}

export async function setAnti(groupId, feature, enabled, sessionId = 'owner') {
  const current = FLAGS.get(groupId) || new Set();
  enabled ? current.add(feature) : current.delete(feature);
  FLAGS.set(groupId, current);
  
  const obj = {};
  for (const [g, s] of FLAGS) obj[g] = [...s];
  
  await pool.query(
    `INSERT INTO storage (session_id, type, key, value)
     VALUES ($1, 'anti', 'groups', $2)
     ON CONFLICT (session_id, type, key) DO UPDATE SET value=$2`,
    [sessionId, obj]
  );
}

export function isAntiEnabled(groupId, feature) {
  return FLAGS.get(groupId)?.has(feature) || false;
}

/**
 * Runs on every incoming message.
 * Returns true if the message was blocked (bot.js should stop processing).
 */
export async function antiCheck({ sock, msg, jid, text }) {
  if (!jid.endsWith('@g.us')) return false;
  
  const isLink = /https?:\/\/|chat\.whatsapp\.com\//i.test(text);
  
  if (isLink && isAntiEnabled(jid, 'link')) {
    try {
      await sock.sendMessage(jid, { delete: msg.key });
      await sock.sendMessage(jid, {
        text: `⚠️ @${msg.key.participant?.split('@')[0]} links aren't allowed here.`,
        mentions: [msg.key.participant],
      });
    } catch (e) {
      console.error('antiCheck delete failed:', e.message);
    }
    return true;
  }
  
  if (isAntiEnabled(jid, 'spam')) {
    const sender = msg.key.participant || jid;
    const now = Date.now();
    const arr = (spamMap.get(sender) || []).filter((t) => now - t < 6000);
    arr.push(now);
    spamMap.set(sender, arr);
    
    if (arr.length > 6) {
      try {
        await sock.sendMessage(jid, {
          text: `🚫 @${sender.split('@')[0]} slow down (spam detected).`,
          mentions: [sender],
        });
      } catch {}
      return true;
    }
  }
  
  return false;
}

/* ═══════════════════════════════════════════════
   DEFAULT EXPORT (commands loaded by commands/index.js)
   ═══════════════════════════════════════════════ */

export default {
  antilink: async ({ args, jid, reply, isGroup }) => {
    if (!isGroup) return reply({ text: '❗ Group only.' });
    const on = args[0] === 'on';
    await setAnti(jid, 'link', on);
    await reply({ text: `🔗 Anti-link ${on ? 'enabled' : 'disabled'}.` });
  },
  
  antispam: async ({ args, jid, reply, isGroup }) => {
    if (!isGroup) return reply({ text: '❗ Group only.' });
    const on = args[0] === 'on';
    await setAnti(jid, 'spam', on);
    await reply({ text: `🛡️ Anti-spam ${on ? 'enabled' : 'disabled'}.` });
  },
};