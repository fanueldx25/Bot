import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import axios from 'axios';

registerCommand({
  name: 'sticker',
  aliases: ['s', 'wm'],
  category: 'utility',
  description: 'Convert image/video to sticker',
  execute: async (ctx: CommandContext) => {
    const mek = ctx.mek;
    const type = Object.keys(mek.message || {})[0];
    const isQuotedImage = type === 'extendedTextMessage' && mek.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    const isQuotedVideo = type === 'extendedTextMessage' && mek.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;
    const isImage = type === 'imageMessage';
    const isVideo = type === 'videoMessage';

    if (!isImage && !isVideo && !isQuotedImage && !isQuotedVideo) {
      await reply(ctx.sock, ctx.from, '❌ Please reply to an image or video with .sticker', ctx.mek);
      return;
    }

    await reply(ctx.sock, ctx.from, '⏳ Converting to sticker...', ctx.mek);

    try {
      const targetMek = (isQuotedImage || isQuotedVideo) 
        ? mek.message?.extendedTextMessage?.contextInfo?.quotedMessage 
        : mek.message;
      
      const mediaType = (isImage || isQuotedImage) ? 'image' : 'video';
      const stream = await downloadContentFromMessage(targetMek![mediaType + 'Message'] as any, mediaType);
      
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      const sticker = new Sticker(buffer, {
        pack: 'Panda Bot Pack',
        author: ctx.pushName || 'Panda Bot',
        type: StickerTypes.FULL,
        categories: [], // Keep empty to avoid enum issues
        id: '12345',
        quality: 50,
      });

      const stickerBuffer = await sticker.toBuffer();
      await ctx.sock.sendMessage(ctx.from, { sticker: stickerBuffer }, { quoted: ctx.mek });
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'weather',
  category: 'utility',
  description: 'Get weather info for a city',
  execute: async (ctx: CommandContext) => {
    if (!ctx.q) {
      await reply(ctx.sock, ctx.from, '❌ Please provide a city name.', ctx.mek);
      return;
    }

    try {
      const res = await axios.get(`https://api.weatherapi.com/v1/current.json?key=ff0e779fb62a4f478e2133246241005&q=${encodeURIComponent(ctx.q)}`);
      const { current, location } = res.data;
      
      const text = `🌤️ *Weather in ${location.name}, ${location.country}*\n\n` +
                 `➤ *Condition:* ${current.condition.text}\n` +
                 `➤ *Temperature:* ${current.temp_c}°C / ${current.temp_f}°F\n` +
                 `➤ *Humidity:* ${current.humidity}%\n` +
                 `➤ *Wind:* ${current.wind_kph} kph\n` +
                 `➤ *Last Updated:* ${current.last_updated}`;
                 
      await reply(ctx.sock, ctx.from, text, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, '❌ City not found or API error.', ctx.mek);
    }
    return;
  }
});
