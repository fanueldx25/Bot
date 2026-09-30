import { registerCommand, CommandContext } from '../../lib/commandHandler.ts';
import axios from 'axios';

registerCommand({
  name: 'tts',
  aliases: ['ptt', 'voice'],
  category: 'utility',
  description: 'Convert text to WhatsApp PTT Voice Note',
  execute: async (ctx: CommandContext) => {
    if (!ctx.q) {
      await ctx.sock.sendMessage(ctx.from, { text: '❌ Please provide text. Usage: .tts [text]' }, { quoted: ctx.mek });
      return;
    }

    const text = ctx.q;
    const lang = 'en';

    let audioBuffer: Buffer | null = null;

    // 1. Try Google Translate TTS
    try {
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
      const res = await axios.get(ttsUrl, { 
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://translate.google.com/'
        }
      });
      if (res.data && res.data.byteLength > 100) {
        audioBuffer = Buffer.from(res.data);
      }
    } catch {}

    // 2. Fallback API
    if (!audioBuffer) {
      try {
        const fallbackRes = await axios.get(`https://api.vreden.my.id/api/tts?text=${encodeURIComponent(text)}`, { responseType: 'arraybuffer' });
        if (fallbackRes.data) {
          audioBuffer = Buffer.from(fallbackRes.data);
        }
      } catch {}
    }

    if (!audioBuffer) {
      await ctx.sock.sendMessage(ctx.from, { text: '❌ Failed to generate voice note.' }, { quoted: ctx.mek });
      return;
    }

    try {
      // Show recording presence specifically for audio/PTT
      await ctx.sock.sendPresenceUpdate('recording', ctx.from);
      await new Promise(r => setTimeout(r, 1000));

      await ctx.sock.sendMessage(ctx.from, { 
        audio: audioBuffer, 
        mimetype: 'audio/mp4',
        ptt: true 
      }, { quoted: ctx.mek });
    } catch (err: any) {
      await ctx.sock.sendMessage(ctx.from, { text: `❌ Send Error: ${err.message}` }, { quoted: ctx.mek });
    }
    return;
  }
});
