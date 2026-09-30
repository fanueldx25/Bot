import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
import { updateConfig, getConfig } from '../../lib/config.ts';
import fs from 'fs';
import path from 'path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// 1. STEALTH / GHOST MODE
registerCommand({
  name: 'stealth',
  aliases: ['ghost', 'ninja'],
  category: 'owner',
  description: 'Toggle ghost mode (no read receipts, no typing indicators)',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const current = await getConfig();
    const arg = ctx.args[0]?.toLowerCase();
    const newStatus = arg === 'on' ? true : arg === 'off' ? false : !current.stealthMode;
    await updateConfig({ stealthMode: newStatus });
    await reply(
      ctx.sock,
      ctx.from,
      `👻 *Stealth Mode is now ${newStatus ? '🟢 ACTIVE' : '🔴 DISABLED'}*\n\n` +
      (newStatus
        ? '• Blue ticks / read receipts disabled\n• Typing & recording indicators hidden\n• The bot operates completely invisible.'
        : '• Standard delivery receipts and typing indicators restored.'),
      ctx.mek
    );
  }
});

// 2. ANTI-CALL SHIELD
registerCommand({
  name: 'anticall',
  aliases: ['blockcall', 'rejectcall'],
  category: 'owner',
  description: 'Automatically decline incoming voice and video calls',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const current = await getConfig();
    const arg = ctx.args[0]?.toLowerCase();
    const newStatus = arg === 'on' ? true : arg === 'off' ? false : !current.antiCall;
    await updateConfig({ antiCall: newStatus });
    await reply(
      ctx.sock,
      ctx.from,
      `📵 *Anti-Call Shield is now ${newStatus ? '🟢 ACTIVE' : '🔴 DISABLED'}*\n\n` +
      (newStatus
        ? '• Incoming WhatsApp voice and video calls will be automatically declined\n• A privacy notice will be dispatched to the caller.'
        : '• Calls will ring normally.'),
      ctx.mek
    );
  }
});

// 3. DO NOT DISTURB (DND)
registerCommand({
  name: 'dnd',
  aliases: ['donotdisturb', 'silentmode'],
  category: 'owner',
  description: 'Ignore incoming commands from non-owner users',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const current = await getConfig();
    const arg = ctx.args[0]?.toLowerCase();
    const newStatus = arg === 'on' ? true : arg === 'off' ? false : !current.dnd;
    await updateConfig({ dnd: newStatus });
    await reply(
      ctx.sock,
      ctx.from,
      `🔕 *Do Not Disturb (DND) is now ${newStatus ? '🟢 ACTIVE' : '🔴 DISABLED'}*\n\n` +
      (newStatus
        ? '• Bot will silently ignore commands from non-admin users\n• Zero interruptions or pings.'
        : '• Public commands are active for everyone.'),
      ctx.mek
    );
  }
});

// 4. BLOCK USER
registerCommand({
  name: 'block',
  category: 'owner',
  description: 'Block a user on WhatsApp',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }

    let targetJid = '';
    const quoted = ctx.mek.message?.extendedTextMessage?.contextInfo;
    if (quoted?.participant) {
      targetJid = quoted.participant;
    } else if (ctx.args[0]) {
      const cleanNum = ctx.args[0].replace(/[^0-9]/g, '');
      if (cleanNum) targetJid = `${cleanNum}@s.whatsapp.net`;
    } else if (!ctx.from.endsWith('@g.us')) {
      targetJid = ctx.from;
    }

    if (!targetJid) {
      await reply(ctx.sock, ctx.from, `❌ Usage: Reply to a user's message with ${ctx.prefix}block, or type ${ctx.prefix}block <number>`, ctx.mek);
      return;
    }

    try {
      await ctx.sock.updateBlockStatus(targetJid, 'block');
      await reply(ctx.sock, ctx.from, `🚫 *Blocked successfully:* +${targetJid.split('@')[0]}`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Failed to block user: ${err.message}`, ctx.mek);
    }
  }
});

// 5. UNBLOCK USER
registerCommand({
  name: 'unblock',
  category: 'owner',
  description: 'Unblock a user on WhatsApp',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }

    let targetJid = '';
    const quoted = ctx.mek.message?.extendedTextMessage?.contextInfo;
    if (quoted?.participant) {
      targetJid = quoted.participant;
    } else if (ctx.args[0]) {
      const cleanNum = ctx.args[0].replace(/[^0-9]/g, '');
      if (cleanNum) targetJid = `${cleanNum}@s.whatsapp.net`;
    }

    if (!targetJid) {
      await reply(ctx.sock, ctx.from, `❌ Usage: Reply to a user with ${ctx.prefix}unblock or type ${ctx.prefix}unblock <number>`, ctx.mek);
      return;
    }

    try {
      await ctx.sock.updateBlockStatus(targetJid, 'unblock');
      await reply(ctx.sock, ctx.from, `✅ *Unblocked successfully:* +${targetJid.split('@')[0]}`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Failed to unblock user: ${err.message}`, ctx.mek);
    }
  }
});

// 6. BLOCKLIST
registerCommand({
  name: 'blocklist',
  aliases: ['blocked'],
  category: 'owner',
  description: 'View list of blocked numbers',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }

    try {
      const list = await ctx.sock.fetchBlocklist();
      if (!list || list.length === 0) {
        await reply(ctx.sock, ctx.from, '🛡️ *Blocklist is empty.* No users are currently blocked.', ctx.mek);
        return;
      }

      let text = `🚫 *WhatsApp Blocklist (${list.length} users)*\n\n`;
      list.forEach((jid?: string, index?: number) => {
        if (!jid) return;
        text += `${(index || 0) + 1}. +${jid.split('@')[0]}\n`;
      });
      await reply(ctx.sock, ctx.from, text, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Failed to fetch blocklist: ${err.message}`, ctx.mek);
    }
  }
});

// 7. DISAPPEARING MESSAGES (EPHEMERAL)
registerCommand({
  name: 'disappear',
  aliases: ['ephemeral', 'disappearing'],
  category: 'owner',
  description: 'Configure disappearing messages in chat (24h, 7d, 90d, off)',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }

    const durationArg = ctx.args[0]?.toLowerCase();
    let seconds = 0;
    let label = 'OFF';

    if (durationArg === '24h' || durationArg === '1d' || durationArg === '86400') {
      seconds = 86400;
      label = '24 Hours';
    } else if (durationArg === '7d' || durationArg === '604800') {
      seconds = 604800;
      label = '7 Days';
    } else if (durationArg === '90d' || durationArg === '7776000') {
      seconds = 7776000;
      label = '90 Days';
    } else if (durationArg === 'off' || durationArg === '0') {
      seconds = 0;
      label = 'Disabled (Permanent)';
    } else {
      await reply(
        ctx.sock,
        ctx.from,
        `⏳ *Disappearing Messages Usage:*\n\n` +
        `• *${ctx.prefix}disappear 24h* (Disappear after 24 hours)\n` +
        `• *${ctx.prefix}disappear 7d* (Disappear after 7 days)\n` +
        `• *${ctx.prefix}disappear 90d* (Disappear after 90 days)\n` +
        `• *${ctx.prefix}disappear off* (Disable disappearing messages)`,
        ctx.mek
      );
      return;
    }

    try {
      await ctx.sock.sendMessage(ctx.from, {
        disappearingMessagesInChat: seconds
      });
      await updateConfig({ ephemeralDuration: seconds });
      await reply(ctx.sock, ctx.from, `⏱️ *Disappearing Messages set to:* ${label}`, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Failed to update ephemeral timer: ${err.message}`, ctx.mek);
    }
  }
});

// 8. UNMASK VIEW ONCE (ANTI-VIEWONCE)
registerCommand({
  name: 'vv',
  aliases: ['antiviewonce', 'unmask'],
  category: 'owner',
  description: 'Download and reveal a view-once photo or video',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }

    const contextInfo = ctx.mek.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = contextInfo?.quotedMessage;

    if (!quotedMsg) {
      await reply(ctx.sock, ctx.from, '❌ Please reply to a View-Once image or video with .vv', ctx.mek);
      return;
    }

    const viewOnceMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message;
    const targetMsg = viewOnceMsg || quotedMsg;

    try {
      if (targetMsg.imageMessage) {
        const buffer = await downloadMediaMessage(
          { key: { id: contextInfo.stanzaId, remoteJid: ctx.from }, message: targetMsg },
          'buffer',
          {}
        );
        await ctx.sock.sendMessage(ctx.from, {
          image: buffer as Buffer,
          caption: `👁️ *View-Once Photo Unmasked*\n${targetMsg.imageMessage.caption ? `Caption: ${targetMsg.imageMessage.caption}` : ''}`
        }, { quoted: ctx.mek });
      } else if (targetMsg.videoMessage) {
        const buffer = await downloadMediaMessage(
          { key: { id: contextInfo.stanzaId, remoteJid: ctx.from }, message: targetMsg },
          'buffer',
          {}
        );
        await ctx.sock.sendMessage(ctx.from, {
          video: buffer as Buffer,
          caption: `👁️ *View-Once Video Unmasked*\n${targetMsg.videoMessage.caption ? `Caption: ${targetMsg.videoMessage.caption}` : ''}`
        }, { quoted: ctx.mek });
      } else {
        await reply(ctx.sock, ctx.from, '❌ Quoted message is not a recognizable media attachment.', ctx.mek);
      }
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Failed to unmask view-once: ${err.message}`, ctx.mek);
    }
  }
});

// 9. PURGE DATA & CACHE
registerCommand({
  name: 'purge',
  aliases: ['clearcache', 'wipedata'],
  category: 'owner',
  description: 'Purge ephemeral temp files and download cache',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }

    let purgedCount = 0;
    try {
      const tmpFiles = fs.readdirSync('/tmp');
      for (const file of tmpFiles) {
        if (file.startsWith('yta-') || file.startsWith('ytv-') || file.startsWith('play-') || file.endsWith('.mp3') || file.endsWith('.mp4') || file.endsWith('.webp')) {
          try {
            fs.unlinkSync(path.join('/tmp', file));
            purgedCount++;
          } catch {}
        }
      }
      await reply(
        ctx.sock,
        ctx.from,
        `🧹 *Storage Sanitized*\n\n` +
        `• Purged *${purgedCount}* temporary media caches from disk\n` +
        `• Ephemeral download buffers cleared\n` +
        `• Zero forensic footprints remaining.`,
        ctx.mek
      );
    } catch (e: any) {
      await reply(ctx.sock, ctx.from, `❌ Error during purge: ${e.message}`, ctx.mek);
    }
  }
});

// 10. PRIVACY DASHBOARD STATUS
registerCommand({
  name: 'privacy',
  aliases: ['privacystatus', 'security'],
  category: 'owner',
  description: 'Display real-time privacy and security settings',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }

    const cfg = await getConfig();
    let blockCount = 0;
    try {
      const bList = await ctx.sock.fetchBlocklist();
      blockCount = bList?.length || 0;
    } catch {}

    const text = 
      `🛡️ *PANDA BOT PRIVACY & SECURITY SUITE*\n\n` +
      `• *Access Mode:* ${cfg.mode.toUpperCase()}\n` +
      `• *Stealth / Ghost Mode:* ${cfg.stealthMode ? '🟢 Active (Invisible)' : '🔴 Disabled'}\n` +
      `• *Anti-Call Shield:* ${cfg.antiCall ? '🟢 Active (Rejecting Calls)' : '🔴 Disabled'}\n` +
      `• *Do Not Disturb (DND):* ${cfg.dnd ? '🟢 Active (Owner-Only)' : '🔴 Disabled'}\n` +
      `• *Anti-Delete Guard:* ${cfg.antiDelete ? '🟢 Active (Log & Catch)' : '🔴 Disabled'}\n` +
      `• *Anti-Link Protection:* ${cfg.antiLink ? '🟢 Active' : '🔴 Disabled'}\n` +
      `• *Auto View-Once Unmask:* ${cfg.antiViewOnce ? '🟢 Active' : '🔴 Disabled'}\n` +
      `• *Blocked Contacts:* ${blockCount} users\n` +
      `• *Disappearing Messages:* ${cfg.ephemeralDuration ? `${cfg.ephemeralDuration}s` : 'Off'}\n\n` +
      `_Type ${cfg.prefix}stealth, ${cfg.prefix}anticall, ${cfg.prefix}dnd, ${cfg.prefix}disappear, or ${cfg.prefix}block to toggle._`;

    await reply(ctx.sock, ctx.from, text, ctx.mek);
  }
});
