import { getSock } from '../bot.js';

async function requireGroup(ctx) {
  if (!ctx.isGroup) throw new Error('Group only command');
}

async function isAdmin(sock, jid, user) {
  const meta = await sock.groupMetadata(jid);
  const p = meta.participants.find((x) => x.id === user);
  return p?.admin === 'admin' || p?.admin === 'superadmin';
}

export default {
  tagall: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, args } = ctx;
    const meta = await sock.groupMetadata(jid);
    const msg = args.join(' ') || '📢 Attention everyone!';
    const mentions = meta.participants.map((p) => p.id);
    const text =
      `*${msg}*\n\n` +
      meta.participants
        .map((p) => `• @${p.id.split('@')[0]}`)
        .join('\n');
    await sock.sendMessage(jid, { text, mentions });
  },

  groupinfo: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, reply } = ctx;
    const meta = await sock.groupMetadata(jid);
    const admins = meta.participants.filter((p) => p.admin).length;
    await reply({
      text:
        `*📊 Group Info*\n` +
        `*Name:* ${meta.subject}\n` +
        `*ID:* ${meta.id}\n` +
        `*Members:* ${meta.participants.length}\n` +
        `*Admins:* ${admins}\n` +
        `*Created:* ${new Date(meta.creation * 1000).toLocaleString()}`,
    });
  },

  promote: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, msg, reply } = ctx;
    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!target) return reply({ text: '❗ Mention a user to promote.' });
    const me = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    if (!(await isAdmin(sock, jid, me))) return reply({ text: '❗ I am not admin.' });
    await sock.groupParticipantsUpdate(jid, [target], 'promote');
    await reply({ text: `⬆️ Promoted @${target.split('@')[0]}`, mentions: [target] });
  },

  demote: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, msg, reply } = ctx;
    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!target) return reply({ text: '❗ Mention a user to demote.' });
    await sock.groupParticipantsUpdate(jid, [target], 'demote');
    await reply({ text: `⬇️ Demoted @${target.split('@')[0]}`, mentions: [target] });
  },

  kick: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, msg, reply } = ctx;
    const target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!target) return reply({ text: '❗ Mention a user to kick.' });
    await sock.groupParticipantsUpdate(jid, [target], 'remove');
    await reply({ text: `👢 Removed @${target.split('@')[0]}`, mentions: [target] });
  },

  mute: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, reply } = ctx;
    await sock.groupSettingUpdate(jid, 'announcement');
    await reply({ text: '🔇 Group muted (admins only).' });
  },

  unmute: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, reply } = ctx;
    await sock.groupSettingUpdate(jid, 'not_announcement');
    await reply({ text: '🔊 Group unmuted.' });
  },

  link: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, reply } = ctx;
    const code = await sock.groupInviteCode(jid);
    await reply({ text: `🔗 https://chat.whatsapp.com/${code}` });
  },

  revoke: async (ctx) => {
    await requireGroup(ctx);
    const { sock, jid, reply } = ctx;
    await sock.groupRevokeInvite(jid);
    await reply({ text: '♻️ Invite link revoked.' });
  },
};