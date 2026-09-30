import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
// @ts-ignore
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import axios from 'axios';

registerCommand({
  name: 'whois',
  aliases: ['userinfo', 'profile'],
  category: 'utility',
  description: 'Get user profile information and mutual groups',
  execute: async (ctx: CommandContext) => {
    let target = ctx.sender;
    const mentioned = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (mentioned) {
      target = mentioned;
    } else if (ctx.args[0]) {
      target = ctx.args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    }

    let ppUrl = 'https://telegra.ph/file/24fa025cf26f3e1b77739.png';
    try {
      const url = await ctx.sock.profilePictureUrl(target, 'image');
      if (url) ppUrl = url;
    } catch {}

    let status = 'Private or Not Available';
    try {
      const st = await ctx.sock.fetchStatus(target) as any;
      if (st && (st.status || st[0]?.status)) status = st.status || st[0]?.status;
    } catch {}

    const mutualGroups: string[] = [];
    try {
      const chats = await ctx.sock.groupFetchAllParticipating();
      for (const gid in chats) {
        const group = chats[gid];
        const isMember = group.participants.some(p => p.id === target);
        if (isMember) {
          mutualGroups.push(group.subject);
        }
      }
    } catch {}

    const info = `👤 *WHOIS PROFILE INFO*\n\n` +
                 `📌 *Name / JID:* @${target.split('@')[0]}\n` +
                 `📱 *Phone Number:* +${target.split('@')[0]}\n` +
                 `💬 *About / Status:* ${status}\n` +
                 `👥 *Mutual Groups:* ${mutualGroups.length > 0 ? mutualGroups.join(', ') : 'None'}\n` +
                 `🔗 *WhatsApp Link:* wa.me/${target.split('@')[0]}`;

    try {
      await ctx.sock.sendMessage(ctx.from, { 
        image: { url: ppUrl }, 
        caption: info,
        mentions: [target]
      }, { quoted: ctx.mek });
    } catch {
      await ctx.sock.sendMessage(ctx.from, { text: info, mentions: [target] }, { quoted: ctx.mek });
    }
    return;
  }
});

registerCommand({
  name: 'id',
  aliases: ['whoami', 'userdetail'],
  category: 'utility',
  description: 'Get full technical details and mutual groups for a user',
  execute: async (ctx: CommandContext) => {
    let target = ctx.sender;
    const mentioned = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (mentioned) {
      target = mentioned;
    } else if (ctx.args[0]) {
      target = ctx.args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    }

    let ppUrl = 'https://telegra.ph/file/24fa025cf26f3e1b77739.png';
    try {
      const url = await ctx.sock.profilePictureUrl(target, 'image');
      if (url) ppUrl = url;
    } catch {}

    let status = 'Available / Hidden';
    try {
      const st = await ctx.sock.fetchStatus(target) as any;
      if (st && (st.status || st[0]?.status)) status = st.status || st[0]?.status;
    } catch {}

    const mutualGroupDetails: string[] = [];
    try {
      const chats = await ctx.sock.groupFetchAllParticipating();
      for (const gid in chats) {
        const group = chats[gid];
        const member = group.participants.find(p => p.id === target);
        if (member) {
          const role = member.admin ? (member.admin === 'superadmin' ? '👑 Superadmin' : '🛡️ Admin') : '👤 Member';
          mutualGroupDetails.push(`• *${group.subject}* (${role})`);
        }
      }
    } catch {}

    const details = `🔍 *FULL USER ID DETAILS*\n\n` +
                    `🆔 *JID:* \`${target}\`\n` +
                    `📱 *Number:* +${target.split('@')[0]}\n` +
                    `💬 *Status:* ${status}\n\n` +
                    `🌐 *Mutual Groups (${mutualGroupDetails.length}):*\n` +
                    (mutualGroupDetails.length > 0 ? mutualGroupDetails.join('\n') : '• No mutual groups found with bot');

    try {
      await ctx.sock.sendMessage(ctx.from, { 
        image: { url: ppUrl }, 
        caption: details,
        mentions: [target]
      }, { quoted: ctx.mek });
    } catch {
      await ctx.sock.sendMessage(ctx.from, { text: details, mentions: [target] }, { quoted: ctx.mek });
    }
    return;
  }
});



registerCommand({
  name: 'joke',
  aliases: ['funny'],
  category: 'utility',
  description: 'Get a random tech or fun joke',
  execute: async (ctx: CommandContext) => {
    try {
      const res = await axios.get('https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,religious,political,racist,sexist,explicit&type=single');
      const jokeText = res.data?.joke || 'Why do programmers prefer dark mode? Because light attracts bugs!';
      await reply(ctx.sock, ctx.from, `😂 *Joke:*\n\n${jokeText}`, ctx.mek);
    } catch {
      await reply(ctx.sock, ctx.from, '😂 *Joke:*\n\nWhy did the database administrator break up with developer? Because there was no relational integrity!', ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'quote',
  aliases: ['inspiration'],
  category: 'utility',
  description: 'Get an inspirational quote',
  execute: async (ctx: CommandContext) => {
    try {
      const res = await axios.get('https://api.quotable.io/random');
      const data = res.data;
      await reply(ctx.sock, ctx.from, `💬 *Quote:* "${data.content}"\n\n— *${data.author}*`, ctx.mek);
    } catch {
      await reply(ctx.sock, ctx.from, '💬 *Quote:* "Code is like humor. When you have to explain it, it’s bad."\n\n— *Cory House*', ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'reveal',
  aliases: ['vv', 'antiviewonce', 'capture'],
  category: 'utility',
  description: 'Reveal/capture a replied view-once image or video',
  execute: async (ctx: CommandContext) => {
    const mek = ctx.mek;
    const quoted = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    
    if (!quoted) {
      await reply(ctx.sock, ctx.from, '❌ Please reply to a view-once image or video with .reveal', ctx.mek);
      return;
    }

    const viewOnceMsg = quoted.viewOnceMessage?.message || quoted.viewOnceMessageV2?.message || quoted.viewOnceMessageV2Extension?.message || quoted;
    const mediaType = Object.keys(viewOnceMsg || {})[0];

    if (!mediaType || (!mediaType.includes('imageMessage') && !mediaType.includes('videoMessage'))) {
      await reply(ctx.sock, ctx.from, '❌ The replied message is not a view-once media.', ctx.mek);
      return;
    }

    try {
      await reply(ctx.sock, ctx.from, '⏳ *Unlocking view-once media...*', ctx.mek);
      const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(viewOnceMsg[mediaType], mediaType.replace('Message', '') as any);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      if (mediaType.includes('imageMessage')) {
        await ctx.sock.sendMessage(ctx.from, { 
          image: buffer, 
          caption: viewOnceMsg.imageMessage?.caption || '' 
        }, { quoted: mek });
      } else if (mediaType.includes('videoMessage')) {
        await ctx.sock.sendMessage(ctx.from, { 
          video: buffer, 
          caption: viewOnceMsg.videoMessage?.caption || '' 
        }, { quoted: mek });
      }
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error revealing view-once: ${err.message}`, ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'getpp',
  aliases: ['pp', 'avatar'],
  category: 'utility',
  description: 'Get profile picture of a user or group',
  execute: async (ctx: CommandContext) => {
    let target = ctx.from;
    
    const mentioned = ctx.mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (mentioned) {
      target = mentioned;
    } else if (ctx.args[0]) {
      target = ctx.args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    }

    try {
      const ppUrl = await ctx.sock.profilePictureUrl(target, 'image');
      if (ppUrl) {
        await ctx.sock.sendMessage(ctx.from, { 
          image: { url: ppUrl }, 
          caption: `🖼️ *Profile Picture for ${target.split('@')[0]}*` 
        }, { quoted: ctx.mek });
      }
    } catch {
      await reply(ctx.sock, ctx.from, '❌ Could not retrieve profile picture (may be private or none).', ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'groupinfo',
  aliases: ['infogroup', 'ginfo'],
  category: 'group',
  description: 'Get detailed information about the group',
  execute: async (ctx: CommandContext) => {
    if (!ctx.from.endsWith('@g.us')) {
      await reply(ctx.sock, ctx.from, '❌ This command is for groups only.', ctx.mek);
      return;
    }

    try {
      const metadata = await ctx.sock.groupMetadata(ctx.from);
      let ppUrl = '';
      try {
        const url = await ctx.sock.profilePictureUrl(ctx.from, 'image');
        if (url) ppUrl = url;
      } catch {}

      const admins = metadata.participants.filter(p => p.admin).map(p => `@${p.id.split('@')[0]}`);
      const creationTime = metadata.creation ? new Date(metadata.creation * 1000).toLocaleString() : 'Unknown';
      
      const info = `📋 *Group Information*\n\n` +
                   `📌 *Name:* ${metadata.subject}\n` +
                   `🆔 *ID:* \`${metadata.id}\`\n` +
                   `👑 *Owner:* ${metadata.owner ? `@${metadata.owner.split('@')[0]}` : 'Unknown'}\n` +
                   `👥 *Total Members:* ${metadata.participants.length}\n` +
                   `🛡️ *Admins:* ${admins.length}\n` +
                   `📅 *Created On:* ${creationTime}\n\n` +
                   `📝 *Description:*\n${metadata.desc || 'No description'}`;

      if (ppUrl) {
        await ctx.sock.sendMessage(ctx.from, { 
          image: { url: ppUrl }, 
          caption: info,
          mentions: metadata.participants.map(p => p.id)
        }, { quoted: ctx.mek });
      } else {
        await ctx.sock.sendMessage(ctx.from, { 
          text: info,
          mentions: metadata.participants.map(p => p.id)
        }, { quoted: ctx.mek });
      }
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'ping',
  category: 'general',
  description: 'Check bot latency and status',
  execute: async (ctx: CommandContext) => {
    const start = Date.now();
    const sent = await reply(ctx.sock, ctx.from, '🏓 Pinging...', ctx.mek);
    const latency = Date.now() - start;
    
    if (sent && sent.key) {
      await ctx.sock.sendMessage(ctx.from, { text: `🏓 *Pong!*\n⚡ Latency: *${latency}ms*` }, { quoted: ctx.mek });
    }
    return;
  }
});

registerCommand({
  name: 'alive',
  category: 'general',
  description: 'Check if the bot is online',
  execute: async (ctx: CommandContext) => {
    const uptime = Math.floor(((Date.now() - ((global as any).startTime || Date.now())) / 1000));
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const text = `🤖 *Panda Bot is Online!*\n\n` +
                 `⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n` +
                 `⚡ *Status:* Active & Ready\n` +
                 `🌐 *Engine:* Baileys WhatsApp Multi-Device`;

    await reply(ctx.sock, ctx.from, text, ctx.mek);
    return;
  }
});
