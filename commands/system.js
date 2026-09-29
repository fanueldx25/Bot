import os from 'os';
import { pool } from '../db.js';
import { getSock } from '../bot.js';

export default {
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
          (SELECT COUNT(*) FROM storage) AS storage,
          (SELECT COUNT(*) FROM automations) AS automations,
          (SELECT COUNT(*) FROM logs) AS logs
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
};