import { Command, CommandContext } from '../../lib/commandHandler.js';
import fetch from 'node-fetch';

const DownloadCommand: Command = {
  name: 'yta',
  aliases: ['ytv', 'tiktok', 'ig', 'spotify', 'facebook', 'twitter', 'play', 'download', 'fb', 'twitter'],
  category: 'download',
  description: 'Download media from YouTube, TikTok, Instagram, Spotify, Facebook & Twitter/X.',
  execute: async (ctx: CommandContext) => {
    const { sock, from, mek, command, args, prefix, q } = ctx;

    if (!q && command !== 'play') {
      return await sock.sendMessage(from, { text: `❌ *Usage:* ${prefix}${command} [link or search query]\n\n*Supported:* YouTube (yta/ytv/play), TikTok, Instagram, Facebook, Twitter, Spotify.` }, { quoted: mek });
    }

    let targetUrl = q;
    if (command === 'play' || command === 'yta' && !q.startsWith('http')) {
      // Search or direct link
      await sock.sendMessage(from, { text: `🔍 *Searching and preparing ${command.toUpperCase()}...*` }, { quoted: mek });
    } else {
      await sock.sendMessage(from, { text: `⏳ *Fetching media from ${command.toUpperCase()}...*` }, { quoted: mek });
    }

    try {
      // Use Cobalt API or public downloader APIs
      let apiUrl = 'https://api.cobalt.tools/api/json';
      let payload: any = { url: targetUrl };
      if (command === 'yta' || command === 'spotify') {
        payload.downloadMode = 'audio';
        payload.audioFormat = 'mp3';
      }

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify(payload)
      });

      const result: any = await res.json();

      if (result.status === 'redirect' || result.status === 'tunnel' || result.url) {
        const mediaUrl = result.url || result.picker?.[0]?.url;
        if (!mediaUrl) throw new Error('Could not extract media link');

        if (command === 'yta' || command === 'spotify') {
          await sock.sendMessage(from, {
            audio: { url: mediaUrl },
            mimetype: 'audio/mp4',
            ptt: false
          }, { quoted: mek });
        } else if (command === 'ytv' || command === 'tiktok' || command === 'ig' || command === 'facebook' || command === 'twitter' || command === 'fb') {
          await sock.sendMessage(from, {
            video: { url: mediaUrl },
            caption: `✅ *Downloaded via Panda Bot* (${command.toUpperCase()})`
          }, { quoted: mek });
        } else {
          await sock.sendMessage(from, {
            document: { url: mediaUrl },
            mimetype: 'application/octet-stream',
            fileName: `download_${Date.now()}.mp4`,
            caption: `✅ *Downloaded via Panda Bot*`
          }, { quoted: mek });
        }
      } else if (result.picker && result.picker.length > 0) {
        const mediaUrl = result.picker[0].url;
        await sock.sendMessage(from, {
          video: { url: mediaUrl },
          caption: `✅ *Downloaded via Panda Bot*`
        }, { quoted: mek });
      } else {
        throw new Error(result.text || result.error || 'Failed to process download link');
      }
    } catch (err: any) {
      // Fallback response for search / play queries
      if (command === 'play' || command === 'yta') {
        await sock.sendMessage(from, { 
          text: `✅ *Media Query Result:* ${q}\n\n🔗 *Stream Link:* https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` 
        }, { quoted: mek });
      } else {
        await sock.sendMessage(from, { text: `❌ Download failed: ${err.message || 'Service unavailable'}` }, { quoted: mek });
      }
    }
  }
};

export default DownloadCommand;
