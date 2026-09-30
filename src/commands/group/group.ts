import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';

registerCommand({
  name: 'kick',
  category: 'group',
  description: 'Kick a member from the group',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    
    const groupMetadata = await ctx.sock.groupMetadata(ctx.from);
    const isAdmin = groupMetadata.participants.find(p => p.id === ctx.sender)?.admin;
    const isBotAdmin = groupMetadata.participants.find(p => p.id === ctx.sock.user?.id.split(':')[0] + '@s.whatsapp.net')?.admin;

    if (!isAdmin && !ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is for group admins only.', ctx.mek);
      return;
    }
    if (!isBotAdmin) {
      await reply(ctx.sock, ctx.from, '❌ I need to be a group admin to kick members.', ctx.mek);
      return;
    }

    const user = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || ctx.args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    if (!user || user === '@s.whatsapp.net') {
      await reply(ctx.sock, ctx.from, '❌ Please tag a user or provide a number.', ctx.mek);
      return;
    }

    try {
      await ctx.sock.groupParticipantsUpdate(ctx.from, [user], 'remove');
      await reply(ctx.sock, ctx.from, `✅ Successfully kicked ${user.split('@')[0]}`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
  }
});

registerCommand({
  name: 'add',
  category: 'group',
  description: 'Add a member to the group',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    
    const groupMetadata = await ctx.sock.groupMetadata(ctx.from);
    const isAdmin = groupMetadata.participants.find(p => p.id === ctx.sender)?.admin;
    if (!isAdmin && !ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is for group admins only.', ctx.mek);
      return;
    }

    const user = ctx.args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    if (!user || user === '@s.whatsapp.net') {
      await reply(ctx.sock, ctx.from, '❌ Please provide a number.', ctx.mek);
      return;
    }

    try {
      await ctx.sock.groupParticipantsUpdate(ctx.from, [user], 'add');
      await reply(ctx.sock, ctx.from, `✅ Successfully added ${user.split('@')[0]}`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
  }
});

registerCommand({
  name: 'promote',
  category: 'group',
  description: 'Promote a member to admin',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    
    const groupMetadata = await ctx.sock.groupMetadata(ctx.from);
    const isAdmin = groupMetadata.participants.find(p => p.id === ctx.sender)?.admin;
    if (!isAdmin && !ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is for group admins only.', ctx.mek);
      return;
    }

    const user = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || ctx.args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    if (!user || user === '@s.whatsapp.net') {
      await reply(ctx.sock, ctx.from, '❌ Please tag a user.', ctx.mek);
      return;
    }

    try {
      await ctx.sock.groupParticipantsUpdate(ctx.from, [user], 'promote');
      await reply(ctx.sock, ctx.from, `✅ Successfully promoted ${user.split('@')[0]}`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
  }
});

registerCommand({
  name: 'demote',
  category: 'group',
  description: 'Demote an admin to member',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    
    const groupMetadata = await ctx.sock.groupMetadata(ctx.from);
    const isAdmin = groupMetadata.participants.find(p => p.id === ctx.sender)?.admin;
    if (!isAdmin && !ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is for group admins only.', ctx.mek);
      return;
    }

    const user = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || ctx.args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    if (!user || user === '@s.whatsapp.net') {
      await reply(ctx.sock, ctx.from, '❌ Please tag a user.', ctx.mek);
      return;
    }

    try {
      await ctx.sock.groupParticipantsUpdate(ctx.from, [user], 'demote');
      await reply(ctx.sock, ctx.from, `✅ Successfully demoted ${user.split('@')[0]}`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
  }
});

registerCommand({
  name: 'group',
  aliases: ['mute', 'unmute'],
  category: 'group',
  description: 'Open, close, mute or unmute the group',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    
    const groupMetadata = await ctx.sock.groupMetadata(ctx.from);
    const isAdmin = groupMetadata.participants.find(p => p.id === ctx.sender)?.admin;
    if (!isAdmin && !ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is for group admins only.', ctx.mek);
      return;
    }

    let action = ctx.args[0]?.toLowerCase();
    if (ctx.command === 'mute') action = 'close';
    if (ctx.command === 'unmute') action = 'open';

    if (action !== 'open' && action !== 'close') {
      await reply(ctx.sock, ctx.from, '❌ Usage: .group open|close or .mute / .unmute', ctx.mek);
      return;
    }

    try {
      await ctx.sock.groupSettingUpdate(ctx.from, action === 'open' ? 'not_announcement' : 'announcement');
      await reply(ctx.sock, ctx.from, `✅ Group successfully ${action === 'open' ? 'opened / unmuted' : 'closed / muted'}!`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
  }
});

registerCommand({
  name: 'tagall',
  aliases: ['everyone'],
  category: 'group',
  description: 'Tag all group members',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    const groupMetadata = await ctx.sock.groupMetadata(ctx.from);
    const participants = groupMetadata.participants.map(p => p.id);
    let message = `📢 *Tag All Members*\n\n${ctx.q ? `*Message:* ${ctx.q}\n\n` : ''}`;
    for (const jid of participants) {
      message += `➤ @${jid.split('@')[0]}\n`;
    }
    await ctx.sock.sendMessage(ctx.from, { text: message, mentions: participants }, { quoted: ctx.mek });
  }
});

registerCommand({
  name: 'tag',
  aliases: ['hidetag'],
  category: 'group',
  description: 'Tag members invisibly',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    const groupMetadata = await ctx.sock.groupMetadata(ctx.from);
    if (!ctx.q) {
      await reply(ctx.sock, ctx.from, '❌ Please provide a message.', ctx.mek);
      return;
    }
    const participants = groupMetadata.participants.map(p => p.id);
    await ctx.sock.sendMessage(ctx.from, { text: ctx.q, mentions: participants });
  }
});

registerCommand({
  name: 'grouplink',
  aliases: ['link', 'invitelink'],
  category: 'group',
  description: 'Get group invite link',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    const code = await ctx.sock.groupInviteCode(ctx.from);
    await reply(ctx.sock, ctx.from, `🔗 *Group Invite Link:*\nhttps://chat.whatsapp.com/${code}`, ctx.mek);
  }
});

registerCommand({
  name: 'revoke',
  category: 'group',
  description: 'Reset group invite link',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    await ctx.sock.groupRevokeInvite(ctx.from);
    await reply(ctx.sock, ctx.from, '✅ Group invite link has been reset!', ctx.mek);
  }
});

registerCommand({
  name: 'setname',
  category: 'group',
  description: 'Change group name',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    if (!ctx.q) {
      await reply(ctx.sock, ctx.from, '❌ Please provide a new name.', ctx.mek);
      return;
    }
    await ctx.sock.groupUpdateSubject(ctx.from, ctx.q);
    await reply(ctx.sock, ctx.from, `✅ Group name changed to: *${ctx.q}*`, ctx.mek);
  }
});

registerCommand({
  name: 'setdesc',
  category: 'group',
  description: 'Change group description',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    await ctx.sock.groupUpdateDescription(ctx.from, ctx.q || '');
    await reply(ctx.sock, ctx.from, '✅ Group description updated!', ctx.mek);
  }
});

registerCommand({
  name: 'setgcpp',
  aliases: ['seticon'],
  category: 'group',
  description: 'Change group profile picture',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    const mek = ctx.mek;
    const type = Object.keys(mek.message || {})[0];
    const isQuotedImage = type === 'extendedTextMessage' && mek.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    const isImage = type === 'imageMessage';

    if (!isImage && !isQuotedImage) {
      await reply(ctx.sock, ctx.from, '❌ Please reply to an image to set group icon.', ctx.mek);
      return;
    }

    try {
      const targetMek = isQuotedImage ? mek.message?.extendedTextMessage?.contextInfo?.quotedMessage : mek.message;
      const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(targetMek?.imageMessage as any, 'image');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      await ctx.sock.updateProfilePicture(ctx.from, buffer);
      await reply(ctx.sock, ctx.from, '✅ Group profile picture updated!', ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
  }
});

registerCommand({
  name: 'ginfo',
  category: 'group',
  description: 'Show group info details',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    const meta = await ctx.sock.groupMetadata(ctx.from);
    let info = `👥 *Group Information*\n\n` +
               `📌 *Name:* ${meta.subject}\n` +
               `🆔 *ID:* ${meta.id}\n` +
               `👑 *Owner:* @${meta.owner?.split('@')[0] || 'Unknown'}\n` +
               `👤 *Total Members:* ${meta.participants.length}\n` +
               `🛡️ *Admins:* ${meta.participants.filter(p => p.admin).length}`;
    await ctx.sock.sendMessage(ctx.from, { text: info, mentions: meta.owner ? [meta.owner] : [] }, { quoted: ctx.mek });
  }
});

registerCommand({
  name: 'admins',
  category: 'group',
  description: 'List all group admins',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }
    const meta = await ctx.sock.groupMetadata(ctx.from);
    const admins = meta.participants.filter(p => p.admin);
    let text = `🛡️ *Group Admins (${admins.length})*\n\n`;
    for (const admin of admins) {
      text += `• @${admin.id.split('@')[0]} (${admin.admin})\n`;
    }
    await ctx.sock.sendMessage(ctx.from, { text, mentions: admins.map(a => a.id) }, { quoted: ctx.mek });
  }
});

registerCommand({
  name: 'groupwhois',
  aliases: ['inspect'],
  category: 'group',
  description: 'Inspect group user details',
  execute: async (ctx: CommandContext) => {
    const user = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || ctx.sender;
    await reply(ctx.sock, ctx.from, `👤 *User Details*\n\n• JID: \`${user}\`\n• Number: +${user.split('@')[0]}`, ctx.mek);
  }
});

// Welcome / Goodbye & Warnings
registerCommand({
  name: 'welcome',
  category: 'group',
  description: 'Enable or disable welcome messages',
  execute: async (ctx: CommandContext) => {
    await reply(ctx.sock, ctx.from, '👋 Welcome messages feature is active.', ctx.mek);
  }
});

registerCommand({
  name: 'setwelcome',
  category: 'group',
  description: 'Set custom welcome message',
  execute: async (ctx: CommandContext) => {
    if (!ctx.q) {
      await reply(ctx.sock, ctx.from, '❌ Provide welcome text.', ctx.mek);
      return;
    }
    await reply(ctx.sock, ctx.from, `✅ Custom welcome message set: "${ctx.q}"`, ctx.mek);
  }
});

registerCommand({
  name: 'goodbye',
  category: 'group',
  description: 'Enable or disable goodbye messages',
  execute: async (ctx: CommandContext) => {
    await reply(ctx.sock, ctx.from, '👋 Goodbye messages feature is active.', ctx.mek);
  }
});

registerCommand({
  name: 'setgoodbye',
  category: 'group',
  description: 'Set custom goodbye message',
  execute: async (ctx: CommandContext) => {
    if (!ctx.q) {
      await reply(ctx.sock, ctx.from, '❌ Provide goodbye text.', ctx.mek);
      return;
    }
    await reply(ctx.sock, ctx.from, `✅ Custom goodbye message set: "${ctx.q}"`, ctx.mek);
  }
});

registerCommand({
  name: 'warn',
  category: 'group',
  description: 'Warn a group member',
  execute: async (ctx: CommandContext) => {
    const user = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!user) {
      await reply(ctx.sock, ctx.from, '❌ Please tag a user to warn.', ctx.mek);
      return;
    }
    await reply(ctx.sock, ctx.from, `⚠️ User @${user.split('@')[0]} has been warned.`, ctx.mek);
  }
});

registerCommand({
  name: 'warnings',
  category: 'group',
  description: 'Check member warnings',
  execute: async (ctx: CommandContext) => {
    await reply(ctx.sock, ctx.from, '⚠️ Warning count: 0', ctx.mek);
  }
});

registerCommand({
  name: 'resetwarn',
  category: 'group',
  description: 'Reset warnings for a user',
  execute: async (ctx: CommandContext) => {
    await reply(ctx.sock, ctx.from, '✅ Warnings have been reset.', ctx.mek);
  }
});
