import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
// @ts-ignore
import ffmpeg from 'fluent-ffmpeg';
import { YtDlp, helpers } from 'ytdlp-nodejs';
import { saveTempDownload } from '../../lib/tempStorage.ts';
// @ts-ignore
import igPackage from 'instagram-url-direct';
// @ts-ignore
import gplay from 'google-play-scraper';

let ytdlpInstance: YtDlp | null = null;

function getYtDlp(): YtDlp | null {
  if (ytdlpInstance) return ytdlpInstance;
  try {
    const binaryLocation = fs.existsSync('/usr/local/bin/yt-dlp') 
      ? '/usr/local/bin/yt-dlp' 
      : (helpers.findYtdlpBinary() || undefined);
    if (binaryLocation) {
      ytdlpInstance = new YtDlp({ binaryPath: binaryLocation });
    }
  } catch (e) {
    ytdlpInstance = null;
  }
  return ytdlpInstance;
}

function isYtDlpReady(): boolean {
  try {
    const inst = getYtDlp();
    return !!(inst && inst.checkInstallation());
  } catch {
    return false;
  }
}

// Ensure yt-dlp binary exists asynchronously in background
(async () => {
  try {
    const existing = helpers.findYtdlpBinary();
    if (!existing && !fs.existsSync('/usr/local/bin/yt-dlp')) {
      await helpers.downloadYtDlp();
      const loc = helpers.findYtdlpBinary();
      if (loc) {
        ytdlpInstance = new YtDlp({ binaryPath: loc });
      }
    }
  } catch (e) {
    // Non-fatal, online scavengers handle downloads
  }
})();
const cookiesPath = path.join(process.cwd(), 'cookies.txt');
const MAX_DIRECT_WHATSAPP_MB = 55;

// Scavenger API Pool for YouTube
const YT_APIS = {
  mp3: [
    (url: string) => `https://api.botcahx.live/api/dowloader/ytbaileys?url=${encodeURIComponent(url)}`,
    (url: string) => `https://api.xyroinee.xyz/api/downloader/youtube-audio?url=${encodeURIComponent(url)}&apikey=lydqE2VshL`,
  ],
  mp4: [
    (url: string) => `https://api.botcahx.live/api/dowloader/ytvideo?url=${encodeURIComponent(url)}`,
    (url: string) => `https://api.xyroinee.xyz/api/downloader/youtube-video?url=${encodeURIComponent(url)}&apikey=lydqE2VshL`,
  ]
};

interface TikTokMediaResult {
  type: 'video' | 'images';
  title: string;
  author: string;
  videoBuffer?: Buffer;
  imageUrls?: string[];
  musicUrl?: string;
}

/**
 * Robust Multi-Engine TikTok Downloader
 * Supports: standard URLs, vt.tiktok.com, vm.tiktok.com, slideshows, direct MP4 buffers (no watermark)
 */
async function downloadTikTokMedia(inputUrl: string): Promise<TikTokMediaResult | null> {
  const urlMatch = inputUrl.match(/https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s]+/i);
  let targetUrl = urlMatch ? urlMatch[0] : inputUrl.trim();

  // If shortlink (vt.tiktok.com or vm.tiktok.com), attempt redirect expansion
  if (targetUrl.includes('vt.tiktok.com') || targetUrl.includes('vm.tiktok.com')) {
    try {
      const headRes = await axios.get(targetUrl, {
        maxRedirects: 5,
        timeout: 6000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const resolved = headRes.request?.res?.responseUrl;
      if (resolved && resolved.includes('tiktok.com/@')) {
        targetUrl = resolved;
      }
    } catch {}
  }

  // Engine 1: TikWM (GET & POST)
  try {
    let res = await axios.get('https://www.tikwm.com/api/', {
      params: { url: targetUrl, hd: 1 },
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (res.data?.code !== 0) {
      // Retry with POST if GET hit a rate limit or notice
      res = await axios.post('https://www.tikwm.com/api/', new URLSearchParams({ url: targetUrl, hd: '1' }), {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
    }

    if (res.data?.code === 0 && res.data?.data) {
      const data = res.data.data;
      const title = data.title || 'TikTok Media';
      const author = data.author?.nickname || data.author?.unique_id || 'TikTok Creator';

      // Photo gallery / slideshow
      if (Array.isArray(data.images) && data.images.length > 0) {
        return {
          type: 'images',
          title,
          author,
          imageUrls: data.images,
          musicUrl: data.music
        };
      }

      // Video (watermark-free)
      const videoDownloadUrl = data.play || data.hdplay || data.wmplay;
      if (videoDownloadUrl) {
        const vidRes = await axios.get(videoDownloadUrl, {
          responseType: 'arraybuffer',
          timeout: 25000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.tiktok.com/'
          }
        });
        if (vidRes.data && vidRes.data.byteLength > 1000) {
          return {
            type: 'video',
            title,
            author,
            videoBuffer: Buffer.from(vidRes.data),
            musicUrl: data.music
          };
        }
      }
    }
  } catch (err: any) {
    console.warn('TikWM download notice:', err.message);
  }

  // Engine 2: SSSTik Scraper Fallback
  try {
    const page = await axios.get('https://ssstik.io/en', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000
    });
    const tt = page.data.match(/s_tt\s*=\s*'([^']+)'/)?.[1] || '';
    if (tt) {
      const postRes = await axios.post('https://ssstik.io/abc?url=dl', new URLSearchParams({
        id: targetUrl,
        locale: 'en',
        tt: tt
      }), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'HX-Request': 'true',
          'HX-Target': 'target',
          'HX-Current-URL': 'https://ssstik.io/en',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': 'https://ssstik.io/en'
        },
        timeout: 10000
      });

      const dlMatch = postRes.data.match(/href=\"([^\"]+)\"[^>]*class=\"[^\"]*without_watermark[^\"]*\"/);
      if (dlMatch?.[1]) {
        const vidRes = await axios.get(dlMatch[1], {
          responseType: 'arraybuffer',
          timeout: 25000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://ssstik.io/'
          }
        });
        if (vidRes.data && vidRes.data.byteLength > 1000) {
          return {
            type: 'video',
            title: 'TikTok Video',
            author: 'TikTok Creator',
            videoBuffer: Buffer.from(vidRes.data)
          };
        }
      }
    }
  } catch (err: any) {
    console.warn('SSSTik download notice:', err.message);
  }

  return null;
}

async function downloadThreadsMedia(inputUrl: string): Promise<string | null> {
  const cobalt = await scavengeCobalt(inputUrl, true);
  if (cobalt) return cobalt;

  try {
    const res = await axios.get(`https://api.vreden.my.id/api/igdl?url=${encodeURIComponent(inputUrl)}`, { timeout: 10000 });
    const results = res.data?.result;
    if (results && results.length > 0 && results[0]?.url) {
      return results[0].url;
    }
  } catch {}

  try {
    const ytdlp = getYtDlp();
    if (ytdlp && isYtDlpReady()) {
      const outTemplate = `/tmp/threads-${Date.now()}-%(id)s.%(ext)s`;
      const result = await ytdlp.download(inputUrl).filter('mergevideo').output(outTemplate).run();
      const downloadedPath = getDownloadedFile(result.filePaths);
      if (downloadedPath && fs.existsSync(downloadedPath)) {
        return downloadedPath;
      }
    }
  } catch {}

  return null;
}

async function scavengeCobalt(url: string, isVideo: boolean = false): Promise<string | null> {
  try {
    const res = await axios.post('https://api.cobalt.cc/api/json', {
      url,
      isAudioOnly: !isVideo,
      filenamePattern: 'classic'
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 12000
    });
    if (res.data && (res.data.url || res.data.picker)) {
      return res.data.url || res.data.picker?.[0]?.url || null;
    }
  } catch {}
  try {
    const res2 = await axios.post('https://co.wuk.sh/api/json', {
      url,
      isAudioOnly: !isVideo
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    if (res2.data && res2.data.url) {
      return res2.data.url;
    }
  } catch {}
  return null;
}

async function scavengeYT(url: string, type: 'mp3' | 'mp4'): Promise<string | null> {
  const cobaltResult = await scavengeCobalt(url, type === 'mp4');
  if (cobaltResult) return cobaltResult;

  const pool = type === 'mp3' ? YT_APIS.mp3 : YT_APIS.mp4;
  for (const getApiUrl of pool) {
    try {
      const res = await axios.get(getApiUrl(url), { timeout: 8000 });
      const audioUrl = res.data.result?.download?.url || res.data.result?.url || res.data.result?.mp3 || res.data.result?.mp4 || res.data.url;
      if (audioUrl) return audioUrl;
    } catch (e) {
      continue;
    }
  }
  return null;
}

function getDownloadedFile(filePaths: string[]): string | null {
  if (!filePaths || !Array.isArray(filePaths)) return null;
  for (const fp of filePaths) {
    if (typeof fp === 'string' && fs.existsSync(fp)) {
      if (fs.statSync(fp).isFile()) return fp;
      if (fs.statSync(fp).isDirectory()) {
        const entries = fs.readdirSync(fp);
        if (entries.length > 0) {
          const innerPath = path.join(fp, entries[0]);
          if (fs.existsSync(innerPath) && fs.statSync(innerPath).isFile()) {
            return innerPath;
          }
        }
      }
    }
  }
  return null;
}

function cleanupFile(filePath: string | null) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      const parentDir = path.dirname(filePath);
      if (parentDir.startsWith('/tmp/') && parentDir !== '/tmp') {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    }
  } catch {}
}

async function convertToPlayableMp3(inputPath: string): Promise<string> {
  return new Promise((resolve) => {
    const outputPath = path.join(os.tmpdir(), `playable-${Date.now()}.mp3`);
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .on('end', () => resolve(outputPath))
      .on('error', () => resolve(inputPath))
      .save(outputPath);
  });
}

async function deliverMedia(
  sock: any,
  from: string,
  mek: any,
  filePathOrUrl: string,
  mediaType: 'video' | 'audio' | 'image',
  title: string,
  isUrl: boolean = false
) {
  let mediaSource = filePathOrUrl;
  let tempDownloadedPath: string | null = null;

  if (isUrl) {
    try {
      const res = await axios.get(filePathOrUrl, {
        responseType: 'arraybuffer',
        timeout: 45000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*'
        }
      });
      if (res.data && res.data.byteLength > 1000) {
        const ext = mediaType === 'video' ? 'mp4' : mediaType === 'audio' ? 'mp3' : 'jpg';
        tempDownloadedPath = path.join(os.tmpdir(), `download-${Date.now()}.${ext}`);
        fs.writeFileSync(tempDownloadedPath, Buffer.from(res.data));
        mediaSource = tempDownloadedPath;
        isUrl = false;
      }
    } catch (e) {
      // Fallback to URL passing if buffer download fails
    }
  }

  if (mediaType === 'audio' && !isUrl && fs.existsSync(mediaSource)) {
    try {
      const convertedPath = await convertToPlayableMp3(mediaSource);
      if (convertedPath && convertedPath !== mediaSource) {
        if (tempDownloadedPath && tempDownloadedPath !== mediaSource) {
          cleanupFile(tempDownloadedPath);
        }
        tempDownloadedPath = convertedPath;
        mediaSource = convertedPath;
      }
    } catch {}
  }

  if (isUrl) {
    if (mediaType === 'video') {
      await sock.sendMessage(from, { video: { url: filePathOrUrl }, caption: `✅ *${title}*` }, { quoted: mek });
    } else if (mediaType === 'audio') {
      await sock.sendMessage(from, { audio: { url: filePathOrUrl }, mimetype: 'audio/mpeg', fileName: `${title}.mp3` }, { quoted: mek });
    }
    return;
  }

  try {
    const fileStats = fs.statSync(mediaSource);
    const sizeMb = fileStats.size / (1024 * 1024);
    const fileName = path.basename(mediaSource);

    if (sizeMb > MAX_DIRECT_WHATSAPP_MB) {
      const tempResult = saveTempDownload(mediaSource, fileName);
      await sock.sendMessage(from, {
        text: `⚠️ *File exceeds direct WhatsApp limit (${MAX_DIRECT_WHATSAPP_MB}MB)*\n\n`
          + `🎬 *Title:* ${title || fileName}\n`
          + `📦 *Size:* ${sizeMb.toFixed(1)} MB\n`
          + `⏳ *Link Validity:* 20 minutes\n\n`
          + `🔗 *Download Link:*\n${tempResult.url}`
      }, { quoted: mek });
    } else {
      const buffer = fs.readFileSync(mediaSource);
      if (mediaType === 'video') {
        await sock.sendMessage(from, {
          video: buffer,
          caption: `🎬 *${title || fileName}*\n📦 *Size:* ${sizeMb.toFixed(1)} MB`
        }, { quoted: mek });
      } else if (mediaType === 'audio') {
        await sock.sendMessage(from, {
          audio: buffer,
          mimetype: 'audio/mpeg',
          fileName: `${(title || 'audio').replace(/[^a-zA-Z0-9_-]/g, '_')}.mp3`
        }, { quoted: mek });
      } else {
        await sock.sendMessage(from, {
          image: buffer,
          caption: `🖼️ *${title || fileName}*`
        }, { quoted: mek });
      }
    }
  } finally {
    if (tempDownloadedPath) {
      cleanupFile(tempDownloadedPath);
    }
  }
}

registerCommand({
  name: 'yta',
  aliases: ['ytv', 'tiktok', 'ig', 'spotify', 'apk', 'play', 'aio3', 'fdroid', 'threads', 'thread'],
  category: 'download',
  description: 'Download media from YouTube, TikTok, Instagram, Spotify & more with multi-API scavenger engine.',
  execute: async (ctx: CommandContext) => {
    const { sock, from, mek, command, args, prefix, q } = ctx;

    if (!args[0] && command !== 'play') {
      await sock.sendMessage(from, { text: `❌ *Usage:* ${prefix}${command} [link or query]` }, { quoted: mek });
      return;
    }

    const input = q;

    switch (command) {
      case 'yta': {
        await sock.sendMessage(from, { text: '⏳ *Scavenging YouTube Audio (MP3)...*' }, { quoted: mek });
        
        // 1. Try Scavenger Pool
        const audioUrl = await scavengeYT(input, 'mp3');
        if (audioUrl) {
          await deliverMedia(sock, from, mek, audioUrl, 'audio', 'YouTube Audio', true);
          return;
        }

        // 2. Fallback to Local ytdlp
        let downloadedPath: string | null = null;
        try {
          const ytdlp = getYtDlp();
          if (ytdlp && isYtDlpReady()) {
            const outTemplate = `/tmp/yta-${Date.now()}-%(id)s.%(ext)s`;
            const downloadBuilder = ytdlp.download(input).extractAudio().audioFormat('mp3').output(outTemplate);
            if (fs.existsSync(cookiesPath)) downloadBuilder.cookies(cookiesPath);

            const result = await downloadBuilder.run();
            downloadedPath = getDownloadedFile(result.filePaths);
            if (downloadedPath && fs.existsSync(downloadedPath)) {
              await deliverMedia(sock, from, mek, downloadedPath, 'audio', input);
            } else {
              throw new Error('All engines failed.');
            }
          } else {
            throw new Error('All engines failed.');
          }
        } catch (e: any) {
          await sock.sendMessage(from, { text: `❌ *Download Error:* This audio could not be retrieved from online sources or local engine. Try another link!` }, { quoted: mek });
        } finally {
          cleanupFile(downloadedPath);
        }
        break;
      }

      case 'ytv': {
        await sock.sendMessage(from, { text: '⏳ *Scavenging YouTube Video (MP4)...*' }, { quoted: mek });
        
        // 1. Try Scavenger Pool
        const videoUrl = await scavengeYT(input, 'mp4');
        if (videoUrl) {
          await deliverMedia(sock, from, mek, videoUrl, 'video', 'YouTube Video', true);
          return;
        }

        // 2. Fallback to Local ytdlp
        let downloadedPath: string | null = null;
        try {
          const ytdlp = getYtDlp();
          if (ytdlp && isYtDlpReady()) {
            const outTemplate = `/tmp/ytv-${Date.now()}-%(id)s.%(ext)s`;
            const downloadBuilder = ytdlp.download(input).filter('mergevideo').quality('720p').type('mp4').output(outTemplate);
            if (fs.existsSync(cookiesPath)) downloadBuilder.cookies(cookiesPath);

            const result = await downloadBuilder.run();
            downloadedPath = getDownloadedFile(result.filePaths);
            if (downloadedPath && fs.existsSync(downloadedPath)) {
              await deliverMedia(sock, from, mek, downloadedPath, 'video', path.basename(downloadedPath));
            } else {
              throw new Error('All engines failed.');
            }
          } else {
            throw new Error('All engines failed.');
          }
        } catch (e: any) {
          await sock.sendMessage(from, { text: `❌ *Download Error:* This video could not be retrieved from online sources or local engine. Try another link!` }, { quoted: mek });
        } finally {
          cleanupFile(downloadedPath);
        }
        break;
      }

      case 'play': {
        if (!input) {
          await sock.sendMessage(from, { text: `❌ *Usage:* ${prefix}play <song title or lyrics>` }, { quoted: mek });
          return;
        }
        await sock.sendMessage(from, { text: `🔎 *Searching across platforms:* "${input}"...` }, { quoted: mek });

        try {
          // @ts-ignore
          const yts = (await import('yt-search')).default;
          const search = await (yts as any)(input);
          const candidates = search?.videos?.slice(0, 3) || [];
          
          let audioUrl: string | null = null;
          let songTitle = input;

          if (candidates.length > 0) {
            songTitle = candidates[0].title;
            await sock.sendMessage(from, {
              image: { url: candidates[0].thumbnail },
              caption: `🎵 *Now Playing*\n📌 *Title:* ${songTitle}\n⌚ *Duration:* ${candidates[0].timestamp}\n👤 *Author:* ${candidates[0].author.name}\n\n_⏳ Fetching audio..._`
            }, { quoted: mek });

            // Try YouTube Scavenger Pool
            audioUrl = await scavengeYT(candidates[0].url, 'mp3');
          }

          const ytdlp = getYtDlp();

          // If YouTube failed, fallback to SoundCloud / Alternative search
          if (!audioUrl && ytdlp && isYtDlpReady()) {
            try {
              const scTemplate = `/tmp/play-sc-${Date.now()}-%(id)s.%(ext)s`;
              const scResult = await ytdlp.download(`scsearch:${input}`).extractAudio().audioFormat('mp3').output(scTemplate).run();
              const scPath = getDownloadedFile(scResult.filePaths);
              if (scPath && fs.existsSync(scPath)) {
                await deliverMedia(sock, from, mek, scPath, 'audio', songTitle);
                cleanupFile(scPath);
                return;
              }
            } catch {}
          }

          if (audioUrl) {
            await deliverMedia(sock, from, mek, audioUrl, 'audio', songTitle, true);
          } else if (ytdlp && isYtDlpReady()) {
            // Local ytdlp fallback as absolute last resort
            let downloadedPath: string | null = null;
            try {
              const outTemplate = `/tmp/play-${Date.now()}-%(id)s.%(ext)s`;
              const result = await ytdlp.download(candidates[0]?.url || `ytsearch:${input}`).extractAudio().audioFormat('mp3').output(outTemplate).run();
              downloadedPath = getDownloadedFile(result.filePaths);
              if (downloadedPath && fs.existsSync(downloadedPath)) {
                await deliverMedia(sock, from, mek, downloadedPath, 'audio', songTitle);
              } else {
                throw new Error('All platforms failed.');
              }
            } finally {
              cleanupFile(downloadedPath);
            }
          } else {
            throw new Error('All audio sources failed.');
          }
        } catch (e: any) {
          await sock.sendMessage(from, { text: `❌ *Playback Error:* Could not find or download this track on YouTube, SoundCloud, or alternative platforms.` }, { quoted: mek });
        }
        break;
      }

      // ... (other cases tiktok, ig, spotify, apk remain similar but also with scavenger if possible)
      case 'tiktok': {
        await sock.sendMessage(from, { text: '⏳ *Fetching TikTok media...* Please wait.' }, { quoted: mek });
        try {
          const result = await downloadTikTokMedia(input);
          if (!result) {
            await sock.sendMessage(from, {
              text: '❌ *TikTok Error:* Could not fetch media. Please make sure the video or account is public and valid.'
            }, { quoted: mek });
            return;
          }

          // Case A: Photo Gallery / Slideshow post
          if (result.type === 'images' && result.imageUrls && result.imageUrls.length > 0) {
            await sock.sendMessage(from, {
              text: `📸 *TikTok Photo Gallery (${result.imageUrls.length} slides)*\n👤 *Creator:* ${result.author}\n📝 *Caption:* ${result.title}`
            }, { quoted: mek });

            for (const imgUrl of result.imageUrls.slice(0, 10)) {
              await sock.sendMessage(from, { image: { url: imgUrl } });
              await new Promise(r => setTimeout(r, 600));
            }
            return;
          }

          // Case B: Video post
          if (result.videoBuffer) {
            const sizeMb = result.videoBuffer.byteLength / (1024 * 1024);
            const caption =
              `✅ *TikTok Video (No Watermark)*\n` +
              `👤 *Creator:* ${result.author}\n` +
              `📝 *Caption:* ${result.title}\n` +
              `📦 *Size:* ${sizeMb.toFixed(1)} MB`;

            if (sizeMb > MAX_DIRECT_WHATSAPP_MB) {
              const tempPath = `/tmp/tiktok-${Date.now()}.mp4`;
              fs.writeFileSync(tempPath, result.videoBuffer);
              const tempResult = saveTempDownload(tempPath, `tiktok-${Date.now()}.mp4`);
              await sock.sendMessage(from, {
                text: `⚠️ *File exceeds direct WhatsApp limit (${MAX_DIRECT_WHATSAPP_MB}MB)*\n\n` +
                      `🎬 *Title:* ${result.title}\n` +
                      `📦 *Size:* ${sizeMb.toFixed(1)} MB\n` +
                      `🔗 *Download Link:*\n${tempResult.url}`
              }, { quoted: mek });
              cleanupFile(tempPath);
            } else {
              await sock.sendMessage(from, {
                video: result.videoBuffer,
                caption
              }, { quoted: mek });
            }
            return;
          }

          throw new Error('Media extraction failed');
        } catch (e: any) {
          console.error('TikTok downloader error:', e.message);
          await sock.sendMessage(from, {
            text: `❌ *TikTok Error:* ${e.message || 'Failed to fetch media'}. Please verify the link is public and accessible.`
          }, { quoted: mek });
        }
        break;
      }

      case 'ig': {
        await sock.sendMessage(from, { text: '⏳ *Downloading Instagram media...*' }, { quoted: mek });
        try {
          const res = await axios.get(`https://api.vreden.my.id/api/igdl?url=${encodeURIComponent(input)}`);
          const results = res.data.result;
          if (results && results.length > 0) {
            for (const item of results) {
              const isVideo = item.url.includes('.mp4');
              if (isVideo) {
                await sock.sendMessage(from, { video: { url: item.url } }, { quoted: mek });
              } else {
                await sock.sendMessage(from, { image: { url: item.url } }, { quoted: mek });
              }
            }
            return;
          }
          throw new Error('Failed');
        } catch (e) {
          await sock.sendMessage(from, { text: `❌ *Instagram Error:* Failed to fetch media.` }, { quoted: mek });
        }
        break;
      }

      case 'threads':
      case 'thread': {
        await sock.sendMessage(from, { text: '⏳ *Downloading Threads media...*' }, { quoted: mek });
        try {
          const mediaUrlOrPath = await downloadThreadsMedia(input);
          if (!mediaUrlOrPath) {
            throw new Error('Could not extract media from Threads link');
          }
          const isLocal = fs.existsSync(mediaUrlOrPath);
          await deliverMedia(sock, from, mek, mediaUrlOrPath, 'video', 'Threads Media', !isLocal);
          if (isLocal) cleanupFile(mediaUrlOrPath);
        } catch (e: any) {
          await sock.sendMessage(from, { text: `❌ *Threads Error:* Failed to download media. Please make sure the thread link is valid and public.` }, { quoted: mek });
        }
        break;
      }

      case 'spotify': {
        await sock.sendMessage(from, { text: '⏳ *Downloading Spotify track...*' }, { quoted: mek });
        try {
          const res = await axios.get(`https://api.vreden.my.id/api/spotify?url=${encodeURIComponent(input)}`);
          const data = res.data.result;
          if (data && data.music) {
            await sock.sendMessage(from, { audio: { url: data.music }, mimetype: 'audio/mpeg', fileName: `${data.title || 'spotify'}.mp3` }, { quoted: mek });
            return;
          }
          throw new Error('Failed');
        } catch (e) {
          await sock.sendMessage(from, { text: `❌ *Spotify Error:* Failed to fetch track.` }, { quoted: mek });
        }
        break;
      }

      case 'apk': {
        await sock.sendMessage(from, { text: `🔍 *Searching Google Play:* "${input}"...` }, { quoted: mek });
        try {
          const searchResults = await (gplay as any).search({ term: input, num: 1 });
          const app = searchResults?.[0];
          if (!app) {
            await sock.sendMessage(from, { text: `❌ No apps found.` }, { quoted: mek });
            return;
          }

          const appDetails = await (gplay as any).app({ appId: app.appId });
          const apkUrl = `https://d.apkpure.com/b/APK/${app.appId}?version=latest`;

          const info = `📦 *${appDetails.title}*\n`
            + `🆔 Package: \`${appDetails.appId}\`\n`
            + `⭐ Rating: ${appDetails.scoreText}\n`
            + `📥 Installs: ${appDetails.installs}\n\n`
            + `🔗 [Play Store](${appDetails.url})\n`
            + `⚡ [Direct APK Download](${apkUrl})`;

          if (appDetails.icon) {
            await sock.sendMessage(from, { image: { url: appDetails.icon }, caption: info }, { quoted: mek });
          } else {
            await sock.sendMessage(from, { text: info }, { quoted: mek });
          }
        } catch (e: any) {
          await sock.sendMessage(from, { text: `❌ *APK Error:* ${e.message}` }, { quoted: mek });
        }
        break;
      }
    }
    return;
  }
});
