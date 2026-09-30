import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
import { getAllCommands } from '../../lib/commandHandler.ts';
import { getConfig, updateConfig } from '../../lib/config.ts';

registerCommand({
  name: 'menu',
  aliases: ['help', 'list', '?'],
  category: 'general',
  description: 'Show WA Bot command menu',
  execute: async (ctx: CommandContext) => {
    const config = await getConfig();
    const cmds = getAllCommands();

    const uptime = Math.floor((Date.now() - ((global as any).startTime || Date.now())) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    let menuText = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *FANUEL BOT* — COMMAND MENU\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  *👤 Owner* ···· ${config.owner || '237678899829'}\n`;
    menuText += `║  *🔒 Mode* ····· ${config.mode.toUpperCase()}\n`;
    menuText += `║  *⚡ Prefix* ···· [ ${ctx.prefix} ]\n`;
    menuText += `║  *⏱ Uptime* ···· ${hours}h ${minutes}m\n`;
    menuText += `║  *📦 Commands* ·· ${cmds.length}\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 📋 INFO 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}list\n`;
    menuText += `║  ✺ ${ctx.prefix}menu\n`;
    menuText += `║  ✺ ${ctx.prefix}owner\n`;
    menuText += `║  ✺ ${ctx.prefix}ping\n`;
    menuText += `║  ✺ ${ctx.prefix}speed\n`;
    menuText += `║  ✺ ${ctx.prefix}status\n`;
    menuText += `║  ✺ ${ctx.prefix}uptime\n`;
    menuText += `║  ✺ ${ctx.prefix}help\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 🔐 ACCESS 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}mode\n`;
    menuText += `║  ✺ ${ctx.prefix}prefix\n`;
    menuText += `║  ✺ ${ctx.prefix}token\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 📥 DOWNLOADERS 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}yt\n`;
    menuText += `║  ✺ ${ctx.prefix}tiktok\n`;
    menuText += `║  ✺ ${ctx.prefix}ig\n`;
    menuText += `║  ✺ ${ctx.prefix}fb\n`;
    menuText += `║  ✺ ${ctx.prefix}play\n`;
    menuText += `║  ✺ ${ctx.prefix}song\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 🎨 MEDIA TOOLS 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}ops\n`;
    menuText += `║  ✺ ${ctx.prefix}save\n`;
    menuText += `║  ✺ ${ctx.prefix}sticker\n`;
    menuText += `║  ✺ ${ctx.prefix}toimg\n`;
    menuText += `║  ✺ ${ctx.prefix}text2img\n`;
    menuText += `║  ✺ ${ctx.prefix}getpp\n`;
    menuText += `║  ✺ ${ctx.prefix}tts\n`;
    menuText += `║  ✺ ${ctx.prefix}tourl\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 🔧 UTILITY 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}lyrics\n`;
    menuText += `║  ✺ ${ctx.prefix}forward\n`;
    menuText += `║  ✺ ${ctx.prefix}weather\n`;
    menuText += `║  ✺ ${ctx.prefix}currency\n`;
    menuText += `║  ✺ ${ctx.prefix}google\n`;
    menuText += `║  ✺ ${ctx.prefix}calc\n`;
    menuText += `║  ✺ ${ctx.prefix}qr\n`;
    menuText += `║  ✺ ${ctx.prefix}news\n`;
    menuText += `║  ✺ ${ctx.prefix}football\n`;
    menuText += `║  ✺ ${ctx.prefix}predict\n`;
    menuText += `║  ✺ ${ctx.prefix}live\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 🛡️ ANTI 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}antidelete\n`;
    menuText += `║  ✺ ${ctx.prefix}antiedit\n`;
    menuText += `║  ✺ ${ctx.prefix}history\n`;
    menuText += `║  ✺ ${ctx.prefix}lastdeleted\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 👥 GROUP 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}welcome\n`;
    menuText += `║  ✺ ${ctx.prefix}setwelcome\n`;
    menuText += `║  ✺ ${ctx.prefix}goodbye\n`;
    menuText += `║  ✺ ${ctx.prefix}setgoodbye\n`;
    menuText += `║  ✺ ${ctx.prefix}kick\n`;
    menuText += `║  ✺ ${ctx.prefix}add\n`;
    menuText += `║  ✺ ${ctx.prefix}promote\n`;
    menuText += `║  ✺ ${ctx.prefix}demote\n`;
    menuText += `║  ✺ ${ctx.prefix}mute\n`;
    menuText += `║  ✺ ${ctx.prefix}unmute\n`;
    menuText += `║  ✺ ${ctx.prefix}tagall\n`;
    menuText += `║  ✺ ${ctx.prefix}tag\n`;
    menuText += `║  ✺ ${ctx.prefix}ginfo\n`;
    menuText += `║  ✺ ${ctx.prefix}grouplink\n`;
    menuText += `║  ✺ ${ctx.prefix}setname\n`;
    menuText += `║  ✺ ${ctx.prefix}setdesc\n`;
    menuText += `║  ✺ ${ctx.prefix}setgcpp\n`;
    menuText += `║  ✺ ${ctx.prefix}admins\n`;
    menuText += `║  ✺ ${ctx.prefix}whois\n`;
    menuText += `║  ✺ ${ctx.prefix}revoke\n`;
    menuText += `║  ✺ ${ctx.prefix}warn\n`;
    menuText += `║  ✺ ${ctx.prefix}warnings\n`;
    menuText += `║  ✺ ${ctx.prefix}resetwarn\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 👑 OWNER 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}setbanner\n`;
    menuText += `║  ✺ ${ctx.prefix}setprefix\n`;
    menuText += `║  ✺ ${ctx.prefix}setbotname\n`;
    menuText += `║  ✺ ${ctx.prefix}broadcast\n`;
    menuText += `║  ✺ ${ctx.prefix}block\n`;
    menuText += `║  ✺ ${ctx.prefix}unblock\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    menuText += `║  *「 ⚙️ SYSTEM 」*\n`;
    menuText += `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
    menuText += `║  ✺ ${ctx.prefix}restart\n`;
    menuText += `║  ✺ ${ctx.prefix}logout\n`;
    menuText += `║  ✺ ${ctx.prefix}cleartemp\n`;
    menuText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    menuText += `> *WA Bot* · Powered by Baileys\n`;
    menuText += `> 🐼 React to view-once  ·  ⏳ Processing  ·  ✅ Done  ·  ❌ Failed`;

    try {
      const bannerUrl = (config as any).bannerUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1000&auto=format&fit=crop';
      await ctx.sock.sendMessage(ctx.from, { 
        image: { url: bannerUrl }, 
        caption: menuText 
      }, { quoted: ctx.mek });
    } catch {
      await reply(ctx.sock, ctx.from, menuText, ctx.mek);
    }
  }
});

registerCommand({
  name: 'stats',
  aliases: ['botstatus'],
  category: 'general',
  description: 'Show bot statistics and uptime',
  execute: async (ctx: CommandContext) => {
    const uptime = Math.floor((Date.now() - (global as any).startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const stats = `📊 *Bot Statistics*\n\n` +
                  `⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n` +
                  `🛡️ *Mode:* ${(await getConfig()).mode}\n` +
                  `📦 *Total Commands:* ${getAllCommands().length}\n` +
                  `💻 *Platform:* ${process.platform}`;
    
    await reply(ctx.sock, ctx.from, stats, ctx.mek);
  }
});

registerCommand({
  name: 'mode',
  aliases: ['botmode'],
  category: 'general',
  description: 'Check or change bot mode (public/private)',
  execute: async (ctx: CommandContext) => {
    const config = await getConfig();
    if (!ctx.args[0]) {
      await reply(ctx.sock, ctx.from, `🔒 *Bot Mode:* *${config.mode.toUpperCase()}*\n\nUsage: \`${ctx.prefix}mode public\` or \`${ctx.prefix}mode private\``, ctx.mek);
      return;
    }
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const newMode = ctx.args[0].toLowerCase();
    if (newMode !== 'public' && newMode !== 'private') {
      await reply(ctx.sock, ctx.from, '❌ Invalid mode. Use `public` or `private`.', ctx.mek);
      return;
    }
    await updateConfig({ mode: newMode as 'public' | 'private' });
    await reply(ctx.sock, ctx.from, `✅ Bot mode successfully updated to *${newMode}*`, ctx.mek);
  }
});

registerCommand({
  name: 'prefix',
  aliases: ['botprefix'],
  category: 'general',
  description: 'Check or change bot command prefix',
  execute: async (ctx: CommandContext) => {
    const config = await getConfig();
    if (!ctx.args[0]) {
      await reply(ctx.sock, ctx.from, `⚡ *Current Prefix:* \`${config.prefix}\`\n\nUsage: \`${ctx.prefix}prefix !\``, ctx.mek);
      return;
    }
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const newPrefix = ctx.args[0];
    await updateConfig({ prefix: newPrefix });
    await reply(ctx.sock, ctx.from, `✅ Bot prefix successfully updated to *${newPrefix}*`, ctx.mek);
  }
});

registerCommand({
  name: 'token',
  aliases: ['session', 'auth'],
  category: 'general',
  description: 'Check session and authentication status',
  execute: async (ctx: CommandContext) => {
    const config = await getConfig();
    const text = `🔑 *Authentication & Session Status*\n\n` +
                 `• *Bot Name:* ${config.botName}\n` +
                 `• *Owner JID:* ${config.owner || 'Not Set'}\n` +
                 `• *Session State:* Connected & Authenticated 🟢\n` +
                 `• *Encryption:* Signal Protocol (End-to-End Secure)`;
    await reply(ctx.sock, ctx.from, text, ctx.mek);
  }
});

const categoryTitles: Record<string, string> = {
  utility: '🔧 UTILITY COMMANDS',
  download: '📥 DOWNLOADERS',
  group: '👥 GROUP MANAGEMENT',
  media: '🎨 MEDIA TOOLS',
  owner: '👑 OWNER COMMANDS',
  general: '📋 GENERAL & INFO',
  anti: '🛡️ ANTI PROTECTION',
  ai: '🤖 AI ASSISTANT'
};

for (const cat of Object.keys(categoryTitles)) {
  registerCommand({
    name: cat,
    category: 'general',
    description: `Show ${cat} category command menu`,
    execute: async (ctx: CommandContext) => {
      const config = await getConfig();
      const cmds = getAllCommands().filter(c => c.category === cat || (cat === 'anti' && c.name.startsWith('anti')));
      
      let text = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                 `║  *FANUEL BOT* — ${categoryTitles[cat]}\n` +
                 `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n`;
      
      for (const c of cmds) {
        text += `║  ✺ ${ctx.prefix}${c.name} - ${c.description}\n`;
      }
      text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
              `> Type *${ctx.prefix}menu* for full bot menu.`;

      try {
        const bannerUrl = (config as any).bannerUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1000&auto=format&fit=crop';
        await ctx.sock.sendMessage(ctx.from, { image: { url: bannerUrl }, caption: text }, { quoted: ctx.mek });
      } catch {
        await reply(ctx.sock, ctx.from, text, ctx.mek);
      }
    }
  });
}

