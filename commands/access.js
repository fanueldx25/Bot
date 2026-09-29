import { pool } from '../db.js';

/* ═══════════════════════════════════════════════
   PRIVATE BOT OWNERSHIP
   ═══════════════════════════════════════════════
   Owner resolution order:
   1. OWNER_NUMBERS env var (comma-separated) — if set, that wins
   2. The linked WhatsApp number (set when bot connects)
   3. Dev fallback — allow all

   Private mode = bot's own linked number is the owner.
*/

let linkedNumber = null; // set on connect

export function setLinkedNumber(num) {
  linkedNumber = num ? String(num).split('@')[0].split(':')[0] : null;
  console.log(`👑 Owner set to linked number: ${linkedNumber}`);
}

export function getLinkedNumber() {
  return linkedNumber;
}

export function isOwner(jid) {
  if (!jid) return false;

  const envOwners = (process.env.OWNER_NUMBERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const num = String(jid).split('@')[0].split(':')[0];

  // 1. Explicit env list wins
  if (envOwners.length) {
    return envOwners.includes(num);
  }

  // 2. Private bot: linked number = owner
  if (linkedNumber) {
    return num === linkedNumber;
  }

  // 3. Dev fallback
  return true;
}

/* ═══════════════════════════════════════════════
   COMMAND TOGGLES
   ═══════════════════════════════════════════════ */
export async function isCommandEnabled(cmd) {
  try {
    const { rows } = await pool.query(
      `SELECT enabled FROM command_settings
       WHERE session_id='owner' AND command=$1`,
      [cmd]
    );
    return rows[0]?.enabled ?? true;
  } catch (e) {
    console.error('isCommandEnabled failed:', e.message);
    return true;
  }
}

export async function setCommandEnabled(cmd, enabled) {
  await pool.query(
    `INSERT INTO command_settings (session_id, command, enabled)
     VALUES ('owner', $1, $2)
     ON CONFLICT (session_id, command) DO UPDATE SET enabled=$2`,
    [cmd, !!enabled]
  );
}

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
   COMMANDS
   ═══════════════════════════════════════════════ */

const commands = {
  owner: async ({ jid, reply }) => {
    const num = String(jid).split('@')[0].split(':')[0];
    const linked = getLinkedNumber();

    if (isOwner(jid)) {
      await reply({
        text:
          `✅ *You are owner.*\n` +
          `Your number: \`${num}\`\n` +
          (linked ? `Linked bot: \`${linked}\`\n` : '') +
          (process.env.OWNER_NUMBERS
            ? `Mode: explicit (\`OWNER_NUMBERS\`)`
            : `Mode: private (bot account = owner)`),
      });
    } else {
      await reply({ text: '❌ Not owner.' });
    }
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