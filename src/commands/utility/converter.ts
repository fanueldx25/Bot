import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
import fs from 'fs';
import path from 'path';

registerCommand({
  name: 'toimg',
  aliases: ['image', 'jpeg'],
  category: 'download',
  description: 'Convert a sticker into an image',
  execute: async (ctx: CommandContext) => {
    const mek = ctx.mek;
    const quoted = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isSticker = mek.message?.stickerMessage || quoted?.stickerMessage;

    if (!isSticker) {
      await reply(ctx.sock, ctx.from, '❌ Please reply to a sticker with .toimg', ctx.mek);
      return;
    }

    try {
      await reply(ctx.sock, ctx.from, '⏳ *Converting sticker to image...*', ctx.mek);
      const targetMsg = mek.message?.stickerMessage || quoted?.stickerMessage;
      const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(targetMsg as any, 'sticker');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      await ctx.sock.sendMessage(ctx.from, { 
        image: buffer, 
        caption: '✅ *Converted Sticker to Image*' 
      }, { quoted: mek });
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Conversion Error: ${err.message}`, ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'tovd',
  aliases: ['tovideo', 'mp4'],
  category: 'download',
  description: 'Convert an animated sticker or GIF to video',
  execute: async (ctx: CommandContext) => {
    const mek = ctx.mek;
    const quoted = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isSticker = mek.message?.stickerMessage || quoted?.stickerMessage;

    if (!isSticker) {
      await reply(ctx.sock, ctx.from, '❌ Please reply to an animated sticker with .tovd', ctx.mek);
      return;
    }

    try {
      await reply(ctx.sock, ctx.from, '⏳ *Converting sticker to video...*', ctx.mek);
      const targetMsg = mek.message?.stickerMessage || quoted?.stickerMessage;
      const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(targetMsg as any, 'sticker');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      // If animated webp, send as video mp4
      await ctx.sock.sendMessage(ctx.from, { 
        video: buffer, 
        caption: '✅ *Converted Sticker to Video*',
        gifPlayback: false
      }, { quoted: mek });
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Conversion Error: ${err.message}`, ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'togif',
  aliases: ['gif'],
  category: 'download',
  description: 'Convert video or sticker to GIF',
  execute: async (ctx: CommandContext) => {
    const mek = ctx.mek;
    const quoted = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const isVideo = mek.message?.videoMessage || quoted?.videoMessage;
    const isSticker = mek.message?.stickerMessage || quoted?.stickerMessage;

    if (!isVideo && !isSticker) {
      await reply(ctx.sock, ctx.from, '❌ Please reply to a video or sticker with .togif', ctx.mek);
      return;
    }

    try {
      await reply(ctx.sock, ctx.from, '⏳ *Converting to GIF...*', ctx.mek);
      const targetMsg = isVideo ? (mek.message?.videoMessage || quoted?.videoMessage) : (mek.message?.stickerMessage || quoted?.stickerMessage);
      const mediaType = isVideo ? 'video' : 'sticker';

      const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(targetMsg as any, mediaType);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      await ctx.sock.sendMessage(ctx.from, { 
        video: buffer, 
        caption: '✅ *Converted to GIF*',
        gifPlayback: true
      }, { quoted: mek });
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Conversion Error: ${err.message}`, ctx.mek);
    }
    return;
  }
});
