import os from 'os';
import { pool } from '../db.js';
import { getSock, sendToSelf } from '../bot.js';
import { isOwner } from './access.js';

const commands = {
  /* ═══════════════════════════════════════════
     .selftest — sends a message to your own number
     Verifies the full outbound pipeline works.
     ═══════════════════════════════════════════ */
  selftest: async ({ reply, sendToSelf: sendSelf }) => {
    try {
      await reply({ text: '🧪 Running self-test…' });

      const sock = getSock();
      if (!sock || !sock.user) {
        return reply({ text: '❌ Socket not connected' });
      }

      const ownNum = sock.user.id.split(':')[0];
      const selfJid = `${ownNum}@s.whatsapp.net`;

      // Test 1: Send a message to ourselves
      await sock.sendMessage(selfJid, {
        text:
          `✅ *Self-test message*\n` +
          `Sent at: ${new Date().toISOString()}\n` +
          `To: \`${selfJid}\`\n` +
          `From socket: \`${sock.user.id}\`\n\n` +
          `_If you're seeing this, outbound messages work._`,
      });

      // Test 2: Send via humanSend (with typing delay)
      try {
        await sendSelf({
          text: '🎭 This one used the human-typing helper ✅',
        });
      } catch (e) {
        await reply({ text: `⚠️ humanSend failed: ${e.message}` });
      }

      await reply({
        text:
          `✅ Self-test complete\n` +
          `Sent 2 messages to your own number.\n` +
          `Check your "Message yourself" chat.`,
      });
    } catch (e) {
      await reply({ text: `❌ Self-test failed: ${e.message}` });
    }
  },

  uptime: async ({ reply }) => {
    const s = process.uptime();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    await reply({ text: `⏱️ Uptime: ${h}h ${m}m ${sec}s` });
  },

  ping: async ({ reply }) => {
    const start = Date.now();
    await reply({ text: `🏓 Pong! ${Date.now() - start}ms` });
  },

  sysinfo: {
    ownerOnly: true,
    handler: async ({ reply }) => {
      const total = os.totalmem() / 1024 / 1024 / 1024;
      const free = os.freemem() / 1024 / 1024 / 1024;
      const used = total - free;
      await reply({
        text:
          `*🖥️ System Info*\n` +
          `Platform: ${os.platform()} ${os.arch()}\n` +
          `CPU: ${os.cpus()[0]?.model}\n` +
          `Cores: ${os.cpus().length}\n` +
          `RAM: ${used.toFixed(2)}/${total.toFixed(2)} GB\n` +
          `Load: ${os.loadavg().map((n) => n.toFixed(2)).join(', ')}`,
      });
    },
  },

  dbstats: {
    ownerOnly: true,
    handler: async ({ reply }) => {
      const { rows } = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM storage) AS storage,
          (SELECT COUNT(*)::int FROM automations) AS automations,
          (SELECT COUNT(*)::int FROM logs) AS logs
      `);
      const r = rows[0];
      await reply({
        text: `*🗄️ DB Stats*\nStorage: ${r.storage}\nAutomations: ${r.automations}\nLogs: ${r.logs}`,
      });
    },
  },

  clearlogs: {
    ownerOnly: true,
    handler: async ({ reply }) => {
      await pool.query(`DELETE FROM logs WHERE session_id='owner'`);
      await reply({ text: '🧹 Logs cleared.' });
    },
  },

  test: async ({ sock, jid, reply, isGroup }) => {
    const checks = [];
    const t0 = Date.now();

    const s = getSock();
    checks.push({
      name: 'Socket',
      ok: !!s && !!s.user,
      detail: s?.user?.id?.split(':')[0] || 'not connected',
    });

    try {
      const { rows } = await pool.query('SELECT NOW() AS now');
      checks.push({
        name: 'Database',
        ok: true,
        detail: new Date(rows[0].now).toISOString().slice(11, 19),
      });
    } catch (e) {
      checks.push({ name: 'Database', ok: false, detail: e.message });
    }

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE enabled)::int AS enabled
         FROM command_settings WHERE session_id='owner'`
      );
      const r = rows[0];
      checks.push({
        name: 'Commands',
        ok: true,
        detail: `${r.enabled}/${r.total} enabled`,
      });
    } catch (e) {
      checks.push({ name: 'Commands', ok: false, detail: e.message });
    }

    checks.push({
      name: 'Owner',
      ok: isOwner(jid),
      detail: isOwner(jid) ? 'yes' : 'no',
    });

    checks.push({
      name: 'Context',
      ok: true,
      detail: isGroup ? 'group' : 'DM',
    });

    const up = process.uptime();
    checks.push({
      name: 'Uptime',
      ok: true,
      detail: `${Math.floor(up / 60)}m ${Math.floor(up % 60)}s`,
    });

    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    checks.push({
      name: 'Memory',
      ok: memMB < 400,
      detail: `${memMB} MB`,
    });

    const lat = Date.now() - t0;
    checks.push({ name: 'Latency', ok: lat < 2000, detail: `${lat}ms` });

    const passed = checks.filter((c) => c.ok).length;
    const total = checks.length;
    const allOk = passed === total;

    const report = [
      `*🧪 Bot Diagnostic Report*`,
      `${allOk ? '✅' : '⚠️'} ${passed}/${total} checks passed`,
      '',
      ...checks.map((c) => `${c.ok ? '✅' : '❌'} *${c.name}* · ${c.detail}`),
    ].join('\n');

    await reply({ text: report });
  },

  diag: async ({ reply }) => {
    const t0 = Date.now();
    await pool.query('SELECT 1 AS ok');
    const dbMs = Date.now() - t0;
    await reply({
      text:
        `*🔍 Quick Diagnostic*\n` +
        `Socket: ${getSock()?.user ? '✅ live' : '❌ dead'}\n` +
        `DB round-trip: ${dbMs}ms\n` +
        `PID: ${process.pid}\n` +
        `Node: ${process.version}`,
    });
  },
};

export default commands;