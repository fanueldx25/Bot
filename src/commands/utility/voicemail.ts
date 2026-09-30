import { registerCommand, CommandContext } from '../../lib/commandHandler.ts';
import { getConfig, updateConfig, addLog } from '../../lib/config.ts';
import { generateVoicemailAudio, getVoicemailList, clearAllVoicemails } from '../../lib/voicemail.ts';

registerCommand({
  name: 'voicemail',
  aliases: ['vm', 'answeringmachine', 'callvoicemail'],
  category: 'utility',
  description: 'Manage automated Voicemail Answering Machine system for incoming WhatsApp calls',
  execute: async (ctx: CommandContext) => {
    const config = await getConfig();
    const sub = (ctx.args[0] || '').toLowerCase();
    const query = ctx.args.slice(1).join(' ').trim();

    // 1. Toggle On
    if (sub === 'on' || sub === 'enable') {
      await updateConfig({ voicemailEnabled: true });
      addLog(`Voicemail answering machine enabled by ${ctx.pushName}`, 'info');
      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: `🎙️ *Voicemail Answering Machine: ACTIVATED* ✅\n\n` +
                `• When someone calls your number, the bot will pick up and play your voice greeting.\n` +
                `• Callers will be prompted to leave a voice note or message.\n` +
                `• You will be notified whenever a new voicemail is recorded!\n\n` +
                `_Tip: Test your greeting by typing \`${ctx.prefix}voicemail test\`_`
        },
        { quoted: ctx.mek }
      );
      return;
    }

    // 2. Toggle Off
    if (sub === 'off' || sub === 'disable') {
      await updateConfig({ voicemailEnabled: false });
      addLog(`Voicemail answering machine disabled by ${ctx.pushName}`, 'info');
      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: `🎙️ *Voicemail Answering Machine: DEACTIVATED* ⏸️\n\n` +
                `Incoming calls will no longer receive an automated voicemail greeting.`
        },
        { quoted: ctx.mek }
      );
      return;
    }

    // 3. Test Greeting (Play Voicemail Voice Note)
    if (sub === 'test' || sub === 'play' || sub === 'listen') {
      await ctx.sock.sendMessage(
        ctx.from,
        { text: '🎙️ *Generating Voicemail Greeting Audio preview...* Please wait a moment.' },
        { quoted: ctx.mek }
      );

      const greetingText =
        config.voicemailGreeting ||
        'Hello! You have reached my automated voicemail. I am unable to answer your call right now. Please leave your name and message right after this tone, and I will get back to you shortly.';
      const lang = config.voicemailLang || 'en';

      const audioBuffer = await generateVoicemailAudio(greetingText, lang);
      if (!audioBuffer) {
        await ctx.sock.sendMessage(
          ctx.from,
          { text: '❌ Failed to generate audio greeting. Please check network connection or greeting text.' },
          { quoted: ctx.mek }
        );
        return;
      }

      await ctx.sock.sendPresenceUpdate('recording', ctx.from);
      await new Promise(r => setTimeout(r, 1000));

      await ctx.sock.sendMessage(
        ctx.from,
        {
          audio: audioBuffer,
          mimetype: 'audio/mp4',
          ptt: true
        },
        { quoted: ctx.mek }
      );

      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: `⬆️ *Voicemail Greeting Preview*\n\n` +
                `📝 *Transcript:* "${greetingText}"\n` +
                `🌐 *Language:* ${lang.toUpperCase()}\n` +
                `_This is the exact voice note played to callers when they ring your WhatsApp!_`
        },
        { quoted: ctx.mek }
      );
      return;
    }

    // 4. Update Greeting Text
    if (sub === 'greeting' || sub === 'setgreeting' || sub === 'msg') {
      if (!query) {
        await ctx.sock.sendMessage(
          ctx.from,
          {
            text: `❌ Please provide your greeting message text.\n\n` +
                  `*Example:*\n\`${ctx.prefix}voicemail greeting Hey there! I am currently in a meeting. Leave a message after the beep and I'll get back to you!\``
          },
          { quoted: ctx.mek }
        );
        return;
      }

      await updateConfig({ voicemailGreeting: query });
      addLog(`Voicemail greeting updated by ${ctx.pushName}`, 'info');

      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: `✅ *Voicemail Greeting Updated!*\n\n` +
                `💬 *New Greeting:* "${query}"\n\n` +
                `_Type \`${ctx.prefix}voicemail test\` to listen to how it sounds!_`
        },
        { quoted: ctx.mek }
      );
      return;
    }

    // 5. Update Language
    if (sub === 'lang' || sub === 'language') {
      if (!query) {
        await ctx.sock.sendMessage(
          ctx.from,
          {
            text: `❌ Please provide language code (e.g. en, es, fr, pt, de, it, id, sw).\n` +
                  `*Example:* \`${ctx.prefix}voicemail lang es\``
          },
          { quoted: ctx.mek }
        );
        return;
      }

      const cleanLang = query.toLowerCase().slice(0, 5);
      await updateConfig({ voicemailLang: cleanLang });
      await ctx.sock.sendMessage(
        ctx.from,
        {
          text: `✅ *Voicemail Voice Language Set:* ${cleanLang.toUpperCase()}\n\n` +
                `_Type \`${ctx.prefix}voicemail test\` to preview audio in this language!_`
        },
        { quoted: ctx.mek }
      );
      return;
    }

    // 6. List Voicemails
    if (sub === 'list' || sub === 'inbox') {
      const list = await getVoicemailList(10);
      if (list.length === 0) {
        await ctx.sock.sendMessage(
          ctx.from,
          { text: '📭 *Voicemail Inbox is empty.* No recent missed calls or voicemails.' },
          { quoted: ctx.mek }
        );
        return;
      }

      let text = `📬 *VOICEMAIL INBOX (${list.length} Recent)* 📬\n━━━━━━━━━━━━━━━━━━━━━━\n`;
      list.forEach((vm: any, idx: number) => {
        const date = new Date(vm.timestamp).toLocaleString();
        const icon = vm.status === 'left_message' ? '🎙️ [Message Left]' : '📞 [Missed Call]';
        text += `\n*${idx + 1}.* ${icon}\n`;
        text += `• *Caller:* +${vm.callerNumber}\n`;
        text += `• *Time:* ${date}\n`;
        text += `• *Type:* ${vm.callType || 'voice'} call\n`;
        if (vm.messageText) {
          text += `• *Message:* "${vm.messageText}"\n`;
        }
        text += `──────────────────────`;
      });

      await ctx.sock.sendMessage(ctx.from, { text }, { quoted: ctx.mek });
      return;
    }

    // 7. Clear Voicemails
    if (sub === 'clear') {
      await clearAllVoicemails();
      await ctx.sock.sendMessage(
        ctx.from,
        { text: '🗑️ *Voicemail Inbox cleared successfully.*' },
        { quoted: ctx.mek }
      );
      return;
    }

    // Default: Status & Menu
    const isEnabled = config.voicemailEnabled !== false;
    const greeting = config.voicemailGreeting || 'Default Greeting';
    const lang = (config.voicemailLang || 'en').toUpperCase();

    const menu =
      `🎙️ *VOICEMAIL ANSWERING MACHINE* 🎙️\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⚡ *Status:* ${isEnabled ? '🟢 ACTIVE (Auto-answering calls)' : '🔴 DISABLED'}\n` +
      `🗣️ *Voice Language:* ${lang}\n` +
      `📬 *Auto-Forward to Owner:* ${config.voicemailAutoForward !== false ? 'Enabled' : 'Disabled'}\n` +
      `💬 *Greeting:* "${greeting}"\n\n` +
      `*Commands Available:*\n` +
      `• \`${ctx.prefix}voicemail on\` - Turn on answering machine\n` +
      `• \`${ctx.prefix}voicemail off\` - Turn off answering machine\n` +
      `• \`${ctx.prefix}voicemail test\` - Preview current greeting voice note\n` +
      `• \`${ctx.prefix}voicemail greeting <text>\` - Set custom greeting text\n` +
      `• \`${ctx.prefix}voicemail lang <code>\` - Set voice accent/language (en, es, fr, etc.)\n` +
      `• \`${ctx.prefix}voicemail list\` - View recorded voicemails inbox\n` +
      `• \`${ctx.prefix}voicemail clear\` - Clear voicemail history\n` +
      `━━━━━━━━━━━━━━━━━━━━━━`;

    await ctx.sock.sendMessage(ctx.from, { text: menu }, { quoted: ctx.mek });
  }
});
