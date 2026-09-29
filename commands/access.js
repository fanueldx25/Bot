import { pool } from '../db.js';

/* ═══════════════════════════════════════════════
   Owner check
   ═══════════════════════════════════════════════
   Reads OWNER_NUMBERS from env (comma-separated digits, no + or spaces).
   Example: OWNER_NUMBERS=2348012345678,15551234567
   
   If empty, everyone is treated as owner (dev mode).
*/
export function isOwner(jid) {
  const owners = (process.env.OWNER_NUMBERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!owners.length) return true;

  // jid is like "2348012345678@s.whatsapp.net" or "2348012345678:12@s.whatsapp.net"
  const num = jid.split('@')[0].split(':')[0];
  return owners.includes(num);
}

/* ═══════════════════════════════════════════════
   Command toggle check
   ═══════════════════════════════════════════════
   Reads command_settings table. If no row exists, command defaults to enabled.
   Called from bot.js before running each command handler.
*/
export async function isCommandEnabled(cmd) {
  try {
    const { rows } = await pool.query(
      `SELECT enabled FROM command_settings
       WHERE session_id='owner' AND command=$1`,
      [cmd]
    );
    // Default to true when no explicit setting exists
    return rows[0]?.enabled ?? true;
  } catch (e) {
    console.error('isCommandEnabled failed:', e.message);
    return true; // fail-open so DB errors don't break all commands
  }
}

/* ═══════════════════════════════════════════════
   Enable / disable a command
   ═══════════════════════════════════════════════
   Not used by the bot itself, but exposed for programmatic use
   (e.g. future commands like .disable ping)
*/
export async function setCommandEnabled(cmd, enabled) {
  await pool.query(
    `INSERT INTO command_settings (session_id, command, enabled)
     VALUES ('owner', $1, $2)
     ON CONFLICT (session_id, command) DO UPDATE SET enabled=$2`,
    [cmd, !!enabled]
  );
}

/* ═══════════════════════════════════════════════
   Register a new command with metadata
   ═══════════════════════════════════════════════
   Called by commands/index.js at load time so every command
   appears in the dashboard, even before it's toggled.
*/
export async function registerCommandSetting(cmd, enabled = true) {
  try {
    await pool.query(
      `INSERT INTO command_settings (session_id, command, enabled)
       VALUES ('owner', $1, $2)
       ON CONFLICT (session_id, command) DO NOTHING`,
      [cmd, enabled]
    );
  } catch (e) {
    console.error('registerCommandSetting failed:', e.message);
  }
}

/* ═══════════════════════════════════════════════
   Commands
   ═══════════════════════════════════════════════ */

const commands = {
  owner: async ({ jid, reply }) => {
    await reply({
      text: isOwner(jid) ? '✅ You are owner.' : '❌ Not owner.',
    });
  },

  access: {
    ownerOnly: true,
    handler: async ({ args, reply }) => {
      const sub = (args[0] || '').toLowerCase();

      if (sub === 'list') {
        const { rows } = await pool.query(
          `SELECT command, enabled FROM command_settings
           WHERE session_id='owner'
           ORDER BY command`
        );
        const enabled = rows.filter((r) => r.enabled).length;
        const disabled = rows.length - enabled;
        await reply({
          text:
            `*🔐 Command Access*\n` +
            `Total: ${rows.length}\n` +
            `Enabled: ${enabled}\n` +
            `Disabled: ${disabled}`,
        });
        return;
      }

      if (sub === 'enable' || sub === 'disable') {
        const cmd = args[1]?.toLowerCase();
        if (!cmd) {
          return reply({ text: `❗ Usage: .access ${sub} <command>` });
        }
        const enable = sub === 'enable';
        await setCommandEnabled(cmd, enable);
        await reply({ text: `${enable ? '✅ Enabled' : '⏸️ Disabled'} .${cmd}` });
        return;
      }

      await reply({
        text:
          `*🔐 Access Commands*\n` +
          `.access list — show all commands\n` +
          `.access enable <cmd>\n` +
          `.access disable <cmd>`,
      });
    },
  },
};

export default commands;