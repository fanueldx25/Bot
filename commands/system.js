import os from 'os';
import { pool } from '../db.js';
import { getSock } from '../bot.js';
import { isOwner } from './access.js';

const commands = {
  uptime: async ({ reply }) => {
    const s = process.uptime();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    await reply({ text: `⏱️ Uptime: ${h}h ${m}m ${sec}s` });
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

  /* ═══════════════════════════════════════════
     🧪 SELF-DIAGNOSTIC TEST
     ═══════════════════════════════════════════ */
  test: async ({ sock, jid, reply, isGroup }) => {
    const checks = [];
    const t0 = Date.now();

    // 1. Socket
    const s = getSock();
    checks.push({
      name: 'Socket',
      ok: !!s && !!s.user,
      detail: s?.user?.id?.split(':')[0] || 'not connected',
    });

    // 2. DB
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

    // 3. Command registry
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

    // 4. Self-ping
    try {
      const { rows } = await pool.query(
        `SELECT value FROM storage
         WHERE session_id='owner' AND type='ping'
         ORDER BY id DESC LIMIT 1`
      );
      if (rows.length) {
        const p = rows[0].value;
        const ago = Math.round((Date.now() - new Date(p.at).getTime()) / 1000);
        checks.push({
          name: 'Self-ping',
          ok: p.ok,
          detail: `${p.ms}ms, ${ago}s ago`,
        });
      } else {
        checks.push({ name: 'Self-ping', ok: false, detail: 'no pings yet' });
      }
    } catch (e) {
      checks.push({ name: 'Self-ping', ok: false, detail: e.message });
    }

    // 5. Owner status
    checks.push({
      name: 'Owner',
      ok: isOwner(jid),
      detail: isOwner(jid) ? 'yes' : 'no',
    });

    // 6. Context
    checks.push({
      name: 'Context',
      ok: true,
      detail: isGroup ? 'group' : 'DM',
    });

    // 7. Uptime
    const up = process.uptime();
    checks.push({
      name: 'Uptime',
      ok: true,
      detail: `${Math.floor(up / 60)}m ${Math.floor(up % 60)}s`,
    });

    // 8. Memory
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    checks.push({
      name: 'Memory',
      ok: memMB < 400,
      detail: `${memMB} MB`,
    });

    // 9. Latency
    const lat = Date.now() - t0;
    checks.push({ name: 'Latency', ok: lat < 2000, detail: `${lat}ms` });

    // Format report
    const passed = checks.filter((c) => c.ok).length;
    const total = checks.length;
    const allOk = passed === total;

    const report = [
      `*🧪 Bot Diagnostic Report*`,
      `${allOk ? '✅' : '⚠️'} ${passed}/${total} checks passed`,
      '',
      ...checks.map((c) => `${c.ok ? '✅' : '❌'} *${c.name}* · ${c.detail}`),
      '',
      `_${new Date().toISOString()} _`,
    ].join('\n');

    await reply({ text: report });
  },

  /* ═══════════════════════════════════════════
     🔍 QUICK PING TEST
     ═══════════════════════════════════════════ */
  diag: async ({ reply }) => {
    const t0 = Date.now();
    const { rows } = await pool.query('SELECT 1 AS ok');
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