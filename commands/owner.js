import { getSock, humanSend } from '../bot.js';
import { pool } from '../db.js';

export default {
  broadcast: {
    ownerOnly: true,
    handler: async ({ sock, args, reply }) => {
      const text = args.join(' ');
      if (!text) return reply({ text: '❗ Usage: .broadcast <message>' });

      const { rows } = await pool.query(
        `SELECT DISTINCT key FROM storage WHERE session_id='owner' AND type='chat'`
      );
      let sent = 0;
      for (const { key: chatJid } of rows) {
        try {
          await humanSend(chatJid, { text: `📢 *Broadcast*\n\n${text}` });
          sent++;
          await new Promise((r) => setTimeout(r, 1200));
        } catch {}
      }
      await reply({ text: `✅ Sent to ${sent} chats.` });
    },
  },

  restart: {
    ownerOnly: true,
    handler: async ({ reply }) => {
      await reply({ text: '🔄 Restarting...' });
      setTimeout(() => process.exit(0), 1000);
    },
  },

  setname: {
    ownerOnly: true,
    handler: async ({ sock, args, reply }) => {
      const name = args.join(' ');
      if (!name) return reply({ text: '❗ Usage: .setname <name>' });
      await sock.updateProfileName(name);
      await reply({ text: `✅ Name set to "${name}".` });
    },
  },

  setstatus: {
    ownerOnly: true,
    handler: async ({ sock, args, reply }) => {
      const status = args.join(' ');
      await sock.updateProfileStatus(status);
      await reply({ text: '✅ Status updated.' });
    },
  },

  setpp: {
    ownerOnly: true,
    handler: async ({ sock, msg, reply }) => {
      const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      const img = quoted?.imageMessage;
      if (!img) return reply({ text: '❗ Reply to an image.' });
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const buf = await downloadMediaMessage(
        { key: msg.key, message: quoted },
        'buffer',
        {},
        { logger: console }
      );
      await sock.updateProfilePicture(sock.user.id, buf);
      await reply({ text: '✅ Profile picture updated.' });
    },
  },
};