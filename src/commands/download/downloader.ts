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
import gplay from 'google-play-scraper';

// ---------------------------------------------------------------------------
// yt-dlp bootstrap
// ---------------------------------------------------------------------------

let ytdlpInstance: YtDlp | null = null;
let ytdlpBootstrapPromise: Promise<void> | null = null;

function getYtDlp(): YtDlp | null {
  return ytdlpInstance;
}

function isYtDlpReady(): boolean {
  if (!ytdlpInstance) return false;
  try {
    const result: any = (ytdlpInstance as any).checkInstallation?.();
    if (result instanceof Promise) return false; // shouldn't be, but guard
    return !!result;
  } catch {
    return false;
  }
}

async function ensureYtDlp(): Promise<YtDlp | null> {
  if (ytdlpInstance) return ytdlpInstance;
  if (ytdlpBootstrapPromise) {
    await ytdlpBootstrapPromise;
    return ytdlpInstance;
  }

  ytdlpBootstrapPromise = (async () => {
    const candidates = [
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
      path.join(os.homedir(), 'bin', 'yt-dlp'),
      path.join(process.cwd(), 'yt-dlp')
    ];

    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          console.log('[ytdlp] found binary at', c);
          ytdlpInstance = new YtDlp({ binaryPath: c });
          return;
        }
      } catch {}
    }

    try {
      const found = helpers.findYtdlpBinary?.();
      if (found) {
        console.log('[ytdlp] helpers.findYtdlpBinary ->', found);
        ytdlpInstance = new YtDlp({ binaryPath: found });
        return;
      }
    } catch (e: any) {
      console.warn('[ytdlp] findYtdlpBinary failed:', e.message);
    }

    try {
      console.log('[ytdlp] downloading binary via helpers.downloadYtDlp()...');
      await helpers.downloadYtDlp();
      const loc = helpers.findYtdlpBinary?.();
      if (loc) {
        console.log('[ytdlp] downloaded to', loc);
        ytdlpInstance = new YtDlp({ binaryPath: loc });
      } else {
        console.error('[ytdlp] download completed but binary not found');
      }
    } catch (e: any) {
      console.error('[ytdlp] bootstrap download failed:', e.message);
    }
  })();

  try {
    await ytdlpBootstrapPromise;
  } finally {
    ytdlpBootstrapPromise = null;
  }
  return ytdlpInstance;
}

// Kick off in background (non-blocking)
ensureYtDlp().catch((e) => console.error('[ytdlp] background init failed:', e?.message));

const cookiesPath = path.join(process.cwd(), 'cookies.txt');
const TMP = os.tmpdir();
const MAX_DIRECT_WHATSAPP_MB = 55;

// ---------------------------------------------------------------------------
// Scavenger API pools
// ---------------------------------------------------------------------------

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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Cobalt (multi-instance)
// ---------------------------------------------------------------------------

const COBALT_INSTANCES = [
  'https://api.cobalt.tools/api/json',
  'https://cobalt-api.kwiatekmiki.com/api/json',
  'https://co.eepy.today/api/json',
  'https://api.cobalt.best/api/json'
];

async function scavengeCobalt(url: string, isVideo: boolean = false): Promise<string | null> {
  for (const ep of COBALT_INSTANCES) {
    try {
      const res = await axios.post(
        ep,
        { url, isAudioOnly: !isVideo, filenamePattern: 'classic' },
        {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': UA
          },
          timeout: 12000,
          validateStatus: () => true
        }
      );
      const out = res.data?.url || res.data?.picker?.[0]?.url || res.data?.audio;
      if (out) {
        console.log('[cobalt] success via', ep);
        return out;
      }
    } catch (e: any) {
      console.warn('[cobalt] failed via', ep, '-', e.message);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TikTok (multi-engine)
// ---------------------------------------------------------------------------

interface TikTokMediaResult {
  type: 'video' | 'images';
  title: string;
  author: string;
  videoBuffer?: Buffer;
  imageUrls?: string[];
  musicUrl?: string;
}

async function downloadTikTokMedia(inputUrl: string): Promise<TikTokMediaResult | null> {
  const urlMatch = inputUrl.match(/https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s]+/i);
  let targetUrl = urlMatch ? urlMatch[0] : inputUrl.trim();

  if (targetUrl.includes('vt.tiktok.com') || targetUrl.includes('vm.tiktok.com')) {
    try {
      const headRes = await axios.get(targetUrl, {
        maxRedirects: 5,
        timeout: 6000,
        validateStatus: () => true,
        headers: { 'User-Agent': UA }
      });
      const resolved = (headRes.request as any)?.res?.responseUrl;
      if (resolved && resolved.includes('tiktok.com/@')) targetUrl = resolved;
    } catch {}
  }

  // Engine 1: TikWM
  try {
    let res = await axios.get('https://www.tikwm.com/api/', {
      params: { url: targetUrl, hd: 1 },
      timeout: 10000,
      headers: { 'User-Agent': UA }
    });

    if (res.data?.code !== 0) {
      res = await axios.post(
        'https://www.tikwm.com/api/',
        new URLSearchParams({ url: targetUrl, hd: '1' }),
        {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': UA
          }
        }
      );
    }

    if (res.data?.code === 0 && res.data?.data) {
      const data = res.data.data;
      const title = data.title || 'TikTok Media';
      const author = data.author?.nickname || data.author?.unique_id || 'TikTok Creator';

      if (Array.isArray(data.images) && data.images.length > 0) {
        return { type: 'images', title, author, imageUrls: data.images, musicUrl: data.music };
      }

      const videoDownloadUrl = data.play || data.hdplay || data.wmplay;
      if (videoDownloadUrl) {
        const vidRes = await axios.get(videoDownloadUrl, {
          responseType: 'arraybuffer',
          timeout: 25000,
          headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/' }
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
    console.warn('[tiktok/tikwm]', err.message);
  }

  // Engine 2: SSSTik
  try {
    const page = await axios.get('https://ssstik.io/en', {
      headers: { 'User-Agent': UA },
      timeout: 8000
    });
    const tt = page.data.match(/s_tt\s*=\s*'([^']+)'/)?.[1] || '';
    if (tt) {
      const postRes = await axios.post(
        'https://ssstik.io/abc?url=dl',
        new URLSearchParams({ id: targetUrl, locale: 'en', tt }),
        {
          headers: {
            'User-Agent': UA,
            'HX-Request': 'true',
            'HX-Target': 'target',
            'HX-Current-URL': 'https://ssstik.io/en',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Referer: 'https://ssstik.io/en'
          },
          timeout: 10000
        }
      );

      const dlMatch = postRes.data.match(/href="([^"]+)"[^>]*class="[^"]*without_watermark[^"]*"/);
      if (dlMatch?.[1]) {
        const vidRes = await axios.get(dlMatch[1], {
          responseType: 'arraybuffer',
          timeout: 25000,
          headers: { 'User-Agent': UA, Referer: 'https://ssstik.io/' }
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
    console.warn('[tiktok/ssstik]', err.message);
  }

  return null;
}

// ---------------------------------------------------------------------------
// yt-dlp helpers
// ---------------------------------------------------------------------------

function getDownloadedFile(filePaths: any): string | null {
  if (!filePaths) return null;
  const list = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const fp of list) {
    if (typeof fp !== 'string') continue;
    try {
      if (!fs.existsSync(fp)) continue;
      if (fs.statSync(fp).isFile()) return fp;
      if (fs.statSync(fp).isDirectory()) {
        const entries = fs.readdirSync(fp);
        if (entries.length > 0) {
          const inner = path.join(fp, entries[0]);
          if (fs.existsSync(inner) && fs.statSync(inner).isFile()) return inner;
        }
      }
    } catch {}
  }
  return null;
}

async function ytDlpDownload(
  url: string,
  mode: 'audio' | 'video',
  prefix: string
): Promise<string | null> {
  const ytdlp = await ensureYtDlp();
  if (!ytdlp || !isYtDlpReady()) {
    console.warn('[ytdlp] not ready, skipping for', url);
    return null;
  }

  try {
    const outTemplate = path.join(TMP, `${prefix}-${Date.now()}-%(id)s.%(ext)s`);
    let builder: any = ytdlp.download(url).output(outTemplate);
    if (mode === 'audio') {
      builder = builder.extractAudio().audioFormat('mp3');
    } else {
      builder = builder.filter('mergevideo').quality('720p').type('mp4');
    }
    if (fs.existsSync(cookiesPath)) builder = builder.cookies(cookiesPath);

    const result = await builder.run();
    const p = getDownloadedFile(result?.filePaths);
    if (p && fs.existsSync(p)) return p;
  } catch (e: any) {
    console.error(`[ytdlp/${prefix}]`, e.message);
  }
  return null;
}

function cleanupFile(filePath: string | null) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
      const parentDir = path.dirname(filePath);
      if (parentDir.startsWith(TMP) && parentDir !== TMP) {
        try { fs.rmSync(parentDir, { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

async function convertToPlayableMp3(inputPath: string): Promise<string> {
  return new Promise((resolve) => {
    const outputPath = path.join(TMP, `playable-${Date.now()}.mp3`);
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .on('end', () => resolve(outputPath))
      .on('error', (e: any) => {
        console.warn('[ffmpeg] convert failed:', e?.message);
        resolve(inputPath);
      })
      .save(outputPath);
  });
}

// ---------------------------------------------------------------------------
// Media delivery (ALWAYS downloads to buffer for WhatsApp)
// ---------------------------------------------------------------------------

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
        timeout: 60000,
        maxRedirects: 5,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          Referer: (() => {
            try { return new URL(filePathOrUrl).origin; } catch { return undefined; }
          })()
        }
      });
      if (!res.data || res.data.byteLength < 1000) {
        throw new Error(`Response too small (${res.data?.byteLength ?? 0} bytes)`);
      }
      const ext = mediaType === 'video' ? 'mp4' : mediaType === 'audio' ? 'mp3' : 'jpg';
      tempDownloadedPath = path.join(TMP, `download-${Date.now()}.${ext}`);
      fs.writeFileSync(tempDownloadedPath, Buffer.from(res.data));
      mediaSource = tempDownloadedPath;
      isUrl = false;
    } catch (e: any) {
      console.error('[deliver] url fetch failed:', e.message);
      await sock.sendMessage(from, {
        text: `❌ *Delivery Error:* Could not fetch media from source (${e.message}). The link may be IP-locked or expired.`
      }, { quoted: mek });
      return;
    }
  }

  if (mediaType === 'audio' && fs.existsSync(mediaSource)) {
    try {
      const converted = await convertToPlayableMp3(mediaSource);
      if (converted && converted !== mediaSource) {
        if (tempDownloadedPath && tempDownloadedPath !== mediaSource) cleanupFile(tempDownloadedPath);
        tempDownloadedPath = converted;
        mediaSource = converted;
      }
    } catch {}
  }

  try {
    const fileStats = fs.statSync(mediaSource);
    const sizeMb = fileStats.size / (1024 * 1024);
    const fileName = path.basename(mediaSource);

    if (sizeMb > MAX_DIRECT_WHATSAPP_MB) {
      const tempResult = saveTempDownload(mediaSource, fileName);
      await sock.sendMessage(from, {
        text:
          `⚠️ *File exceeds direct WhatsApp limit (${MAX_DIRECT_WHATSAPP_MB}MB)*\n\n` +
          `🎬 *Title:* ${title || fileName}\n` +
          `📦 *Size:* ${sizeMb.toFixed(1)} MB\n` +
          `⏳ *Link Validity:* 20 minutes\n\n` +
          `🔗 *Download Link:*\n${tempResult.url}`
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
  } catch (e: any) {
    console.error('[deliver] send failed:', e.message);
    await sock.sendMessage(from, { text: `❌ *Delivery Error:* ${e.message}` }, { quoted: mek });
  } finally {
    if (tempDownloadedPath && tempDownloadedPath !== filePathOrUrl) cleanupFile(tempDownloadedPath);
  }
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

async function scavengeYT(url: string, type: 'mp3' | 'mp4'): Promise<string | null> {
  const cobaltResult = await scavengeCobalt(url, type === 'mp4');
  if (cobaltResult) return cobaltResult;

  const pool = type === 'mp3' ? YT_APIS.mp3 : YT_APIS.mp4;
  for (const getApiUrl of pool) {
    const apiUrl = getApiUrl(url);
    try {
      const res = await axios.get(apiUrl, { timeout: 8000, validateStatus: () => true });
      const audioUrl =
        res.data?.result?.download?.url ||
        res.data?.result?.url ||
        res.data?.result?.mp3 ||
        res.data?.result?.mp4 ||
        res.data?.url;
      if (audioUrl) {
        console.log('[yt-scavenger] success via', apiUrl);
        return audioUrl;
      }
    } catch (e: any) {
      console.warn('[yt-scavenger] failed via', apiUrl, '-', e.message);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Instagram / Facebook / Threads / Spotify
// ---------------------------------------------------------------------------

async function downloadInstagramMedia(inputUrl: string): Promise<string[]> {
  const cobalt = await scavengeCobalt(inputUrl, true);
  if (cobalt) return [cobalt];

  try {
    // @ts-ignore
    const igPackage = (await import('instagram-url-direct')).default;
    const result = await igPackage(inputUrl);
    const details = result?.media_details || result?.url_list || [];
    const urls = (Array.isArray(details) ? details : [])
      .map((m: any) => (typeof m === 'string' ? m : m?.url))
      .filter(Boolean);
    if (urls.length) return urls;
  } catch (e: any) {
    console.warn('[ig] instagram-url-direct failed:', e.message);
  }

  const local = await ytDlpDownload(inputUrl, 'video', 'ig');
  if (local) return [local];

  return [];
}

async function downloadFacebookMedia(inputUrl: string): Promise<string | null> {
  const cobalt = await scavengeCobalt(inputUrl, true);
  if (cobalt) return cobalt;

  const local = await ytDlpDownload(inputUrl, 'video', 'fb');
  if (local) return local;

  return null;
}

async function downloadThreadsMedia(inputUrl: string): Promise<string | null> {
  const cobalt = await scavengeCobalt(inputUrl, true);
  if (cobalt) return cobalt;

  const local = await ytDlpDownload(inputUrl, 'video', 'threads');
  if (local) return local;

  return null;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

registerCommand({
  name: 'yta',
  aliases: [
    'ytv', 'tiktok', 'ig', 'spotify', 'apk', 'play',
    'aio3', 'fdroid', 'threads', 'thread', 'fb', 'facebook', 'fbdl'
  ],
  category: 'download',
  description: 'Download media from YouTube, TikTok, Instagram, Spotify & more with multi-API scavenger engine.',
  execute: async (ctx: CommandContext) => {
    const { sock, from, mek, command, args, prefix, q } = ctx;
    const input = q;

    if (!args[0] && command !== 'play' && command !== 'aio3' && command !== 'fdroid') {
      await sock.sendMessage(from, { text: `❌ *Usage:* ${prefix}${command} [link or query]` }, { quoted: mek });
      return;
    }

    switch (command) {
      // -------------------------------------------------------------------
      case 'yta': {
        await sock.sendMessage(from, { text: '⏳ *Scavenging YouTube Audio (MP3)...*' }, { quoted: mek });

        const audioUrl = await scavengeYT(input, 'mp3');
        if (audioUrl) {
          await deliverMedia(sock, from, mek, audioUrl, 'audio', 'YouTube Audio', true);
          return;
        }

        let downloadedPath: string | null = null;
        try {
          downloadedPath = await ytDlpDownload(input, 'audio', 'yta');
          if (!downloadedPath) throw new Error('All engines failed.');
          await deliverMedia(sock, from, mek, downloadedPath, 'audio', input);
        } catch (e: any) {
          console.error('[yta]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *Download Error:* Audio could not be retrieved from any source. Try another link.`
          }, { quoted: mek });
        } finally {
          cleanupFile(downloadedPath);
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'ytv': {
        await sock.sendMessage(from, { text: '⏳ *Scavenging YouTube Video (MP4)...*' }, { quoted: mek });

        const videoUrl = await scavengeYT(input, 'mp4');
        if (videoUrl) {
          await deliverMedia(sock, from, mek, videoUrl, 'video', 'YouTube Video', true);
          return;
        }

        let downloadedPath: string | null = null;
        try {
          downloadedPath = await ytDlpDownload(input, 'video', 'ytv');
          if (!downloadedPath) throw new Error('All engines failed.');
          await deliverMedia(sock, from, mek, downloadedPath, 'video', path.basename(downloadedPath));
        } catch (e: any) {
          console.error('[ytv]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *Download Error:* Video could not be retrieved from any source. Try another link.`
          }, { quoted: mek });
        } finally {
          cleanupFile(downloadedPath);
        }
        break;
      }

      // -------------------------------------------------------------------
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
          const songTitle = candidates[0]?.title || input;
          const searchUrl = candidates[0]?.url || `ytsearch:${input}`;

          if (candidates[0]) {
            await sock.sendMessage(from, {
              image: { url: candidates[0].thumbnail },
              caption:
                `🎵 *Now Playing*\n` +
                `📌 *Title:* ${songTitle}\n` +
                `⌚ *Duration:* ${candidates[0].timestamp}\n` +
                `👤 *Author:* ${candidates[0].author?.name || 'Unknown'}\n\n` +
                `_⏳ Fetching audio..._`
            }, { quoted: mek });
          }

          // Try YouTube scavenger pool first
          let audioUrl: string | null = null;
          if (candidates[0]?.url) audioUrl = await scavengeYT(candidates[0].url, 'mp3');
          if (audioUrl) {
            await deliverMedia(sock, from, mek, audioUrl, 'audio', songTitle, true);
            return;
          }

          // Local yt-dlp (ytsearch fallback inside)
          const localPath = await ytDlpDownload(searchUrl, 'audio', 'play');
          if (localPath) {
            await deliverMedia(sock, from, mek, localPath, 'audio', songTitle);
            cleanupFile(localPath);
            return;
          }

          throw new Error('All audio sources failed.');
        } catch (e: any) {
          console.error('[play]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *Playback Error:* Could not find or download this track.`
          }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'tiktok': {
        await sock.sendMessage(from, { text: '⏳ *Fetching TikTok media...* Please wait.' }, { quoted: mek });
        try {
          const result = await downloadTikTokMedia(input);
          if (!result) {
            await sock.sendMessage(from, {
              text: '❌ *TikTok Error:* Could not fetch media. Ensure the video/account is public.'
            }, { quoted: mek });
            return;
          }

          if (result.type === 'images' && result.imageUrls && result.imageUrls.length > 0) {
            await sock.sendMessage(from, {
              text:
                `📸 *TikTok Photo Gallery (${result.imageUrls.length} slides)*\n` +
                `👤 *Creator:* ${result.author}\n` +
                `📝 *Caption:* ${result.title}`
            }, { quoted: mek });

            for (const imgUrl of result.imageUrls.slice(0, 10)) {
              await sock.sendMessage(from, { image: { url: imgUrl } });
              await new Promise((r) => setTimeout(r, 600));
            }
            return;
          }

          if (result.videoBuffer) {
            const sizeMb = result.videoBuffer.byteLength / (1024 * 1024);
            const caption =
              `✅ *TikTok Video (No Watermark)*\n` +
              `👤 *Creator:* ${result.author}\n` +
              `📝 *Caption:* ${result.title}\n` +
              `📦 *Size:* ${sizeMb.toFixed(1)} MB`;

            if (sizeMb > MAX_DIRECT_WHATSAPP_MB) {
              const tempPath = path.join(TMP, `tiktok-${Date.now()}.mp4`);
              fs.writeFileSync(tempPath, result.videoBuffer);
              const tempResult = saveTempDownload(tempPath, `tiktok-${Date.now()}.mp4`);
              await sock.sendMessage(from, {
                text:
                  `⚠️ *File exceeds direct WhatsApp limit (${MAX_DIRECT_WHATSAPP_MB}MB)*\n\n` +
                  `🎬 *Title:* ${result.title}\n` +
                  `📦 *Size:* ${sizeMb.toFixed(1)} MB\n` +
                  `🔗 *Download Link:*\n${tempResult.url}`
              }, { quoted: mek });
              cleanupFile(tempPath);
            } else {
              await sock.sendMessage(from, { video: result.videoBuffer, caption }, { quoted: mek });
            }
            return;
          }

          throw new Error('Media extraction failed');
        } catch (e: any) {
          console.error('[tiktok]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *TikTok Error:* ${e.message || 'Failed to fetch media'}. Verify the link is public.`
          }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'ig': {
        await sock.sendMessage(from, { text: '⏳ *Downloading Instagram media...*' }, { quoted: mek });
        try {
          const mediaUrlsOrPaths = await downloadInstagramMedia(input);
          if (!mediaUrlsOrPaths || mediaUrlsOrPaths.length === 0) {
            throw new Error('Failed to fetch Instagram media');
          }
          for (const m of mediaUrlsOrPaths) {
            const isLocal = fs.existsSync(m);
            const lower = m.toLowerCase();
            const isVideo =
              lower.includes('.mp4') ||
              lower.includes('.mov') ||
              lower.includes('.webm') ||
              (!isLocal && (lower.includes('video') || lower.includes('.mp4')));
            await deliverMedia(sock, from, mek, m, isVideo ? 'video' : 'image', 'Instagram Media', !isLocal);
            if (isLocal) cleanupFile(m);
          }
        } catch (e: any) {
          console.error('[ig]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *Instagram Error:* Failed to fetch media. Make sure the post/reel is public.`
          }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'fb':
      case 'facebook':
      case 'fbdl': {
        await sock.sendMessage(from, { text: '⏳ *Downloading Facebook video...*' }, { quoted: mek });
        try {
          const mediaUrlOrPath = await downloadFacebookMedia(input);
          if (!mediaUrlOrPath) throw new Error('Failed to fetch Facebook video');
          const isLocal = fs.existsSync(mediaUrlOrPath);
          await deliverMedia(sock, from, mek, mediaUrlOrPath, 'video', 'Facebook Video', !isLocal);
          if (isLocal) cleanupFile(mediaUrlOrPath);
        } catch (e: any) {
          console.error('[fb]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *Facebook Error:* Failed to download video. Ensure the video is public.`
          }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'threads':
      case 'thread': {
        await sock.sendMessage(from, { text: '⏳ *Downloading Threads media...*' }, { quoted: mek });
        try {
          const mediaUrlOrPath = await downloadThreadsMedia(input);
          if (!mediaUrlOrPath) throw new Error('Could not extract media from Threads link');
          const isLocal = fs.existsSync(mediaUrlOrPath);
          await deliverMedia(sock, from, mek, mediaUrlOrPath, 'video', 'Threads Media', !isLocal);
          if (isLocal) cleanupFile(mediaUrlOrPath);
        } catch (e: any) {
          console.error('[threads]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *Threads Error:* Failed to download media. Verify the link is public.`
          }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'spotify': {
        await sock.sendMessage(from, { text: '⏳ *Resolving Spotify track...*' }, { quoted: mek });
        try {
          // Strategy: resolve track name via public oEmbed, then use YouTube search fallback
          let query = input;
          try {
            const oembed = await axios.get(
              `https://open.spotify.com/oembed?url=${encodeURIComponent(input)}`,
              { timeout: 8000 }
            );
            if (oembed.data?.title) {
              query = `${oembed.data.title} ${oembed.data.author_name || ''}`.trim();
            }
          } catch {}

          // @ts-ignore
          const yts = (await import('yt-search')).default;
          const search = await (yts as any)(query);
          const top = search?.videos?.[0];
          const searchUrl = top?.url || `ytsearch:${query}`;
          const title = top?.title || query;

          // Try scavenger then yt-dlp
          let audioUrl: string | null = null;
          if (top?.url) audioUrl = await scavengeYT(top.url, 'mp3');
          if (audioUrl) {
            await deliverMedia(sock, from, mek, audioUrl, 'audio', title, true);
            return;
          }

          const localPath = await ytDlpDownload(searchUrl, 'audio', 'spotify');
          if (localPath) {
            await deliverMedia(sock, from, mek, localPath, 'audio', title);
            cleanupFile(localPath);
            return;
          }

          throw new Error('No audio source available');
        } catch (e: any) {
          console.error('[spotify]', e.message);
          await sock.sendMessage(from, {
            text: `❌ *Spotify Error:* Failed to fetch track.`
          }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
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

          const info =
            `📦 *${appDetails.title}*\n` +
            `🆔 Package: \`${appDetails.appId}\`\n` +
            `⭐ Rating: ${appDetails.scoreText}\n` +
            `📥 Installs: ${appDetails.installs}\n\n` +
            `🔗 [Play Store](${appDetails.url})\n` +
            `⚡ [Direct APK Download](${apkUrl})`;

          if (appDetails.icon) {
            await sock.sendMessage(from, { image: { url: appDetails.icon }, caption: info }, { quoted: mek });
          } else {
            await sock.sendMessage(from, { text: info }, { quoted: mek });
          }
        } catch (e: any) {
          console.error('[apk]', e.message);
          await sock.sendMessage(from, { text: `❌ *APK Error:* ${e.message}` }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'aio3': {
        // Generic multi-platform auto-detector
        await sock.sendMessage(from, { text: '⏳ *Auto-detecting platform...*' }, { quoted: mek });
        try {
          let target = input;
          if (!/^https?:\/\//i.test(target)) {
            // treat as search
            return ctx.execute
              ? // delegate to play-style logic
                (async () => {
                  const { sock, from, mek, prefix } = ctx;
                  await sock.sendMessage(from, {
                    text: `❌ *aio3* requires a URL. For search, use *${prefix}play*.`
                  }, { quoted: mek });
                })()
              : Promise.resolve();
          }

          const platform =
            /tiktok\.com/i.test(target) ? 'tiktok' :
            /instagram\.com/i.test(target) ? 'ig' :
            /facebook\.com|fb\.watch/i.test(target) ? 'fb' :
            /threads\.(net|com)/i.test(target) ? 'threads' :
            /youtu\.?be|youtube\.com/i.test(target) ? 'ytv' :
            /spotify\.com/i.test(target) ? 'spotify' :
            null;

          if (!platform) {
            await sock.sendMessage(from, { text: '❌ Unsupported URL.' }, { quoted: mek });
            return;
          }

          // Re-dispatch via the same handler with a synthesized command
          await sock.sendMessage(from, {
            text: `ℹ️ Detected *${platform}*. Use *${prefix}${platform === 'ytv' ? 'ytv' : platform} ${target}* — auto-routing not yet wired.`
          }, { quoted: mek });
        } catch (e: any) {
          await sock.sendMessage(from, { text: `❌ *aio3 Error:* ${e.message}` }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      case 'fdroid': {
        await sock.sendMessage(from, { text: `🔍 *Searching F-Droid:* "${input}"...` }, { quoted: mek });
        try {
          const res = await axios.get(
            `https://search.f-droid.org/?q=${encodeURIComponent(input)}&lang=en`,
            { timeout: 10000, headers: { 'User-Agent': UA } }
          );
          const html = res.data as string;
          const pkgMatch = html.match(/href="\/en\/packages\/([^/"]+)\/?"/);
          if (!pkgMatch?.[1]) {
            await sock.sendMessage(from, { text: `❌ No F-Droid packages found for "${input}".` }, { quoted: mek });
            return;
          }
          const pkg = pkgMatch[1];
          const apkUrl = `https://f-droid.org/repo/${pkg}_latest.apk`;
          await sock.sendMessage(from, {
            text:
              `📦 *F-Droid Package*\n` +
              `🆔 \`${pkg}\`\n\n` +
              `🔗 [F-Droid Page](https://f-droid.org/en/packages/${pkg}/)\n` +
              `⚡ [Direct APK](${apkUrl})`
          }, { quoted: mek });
        } catch (e: any) {
          console.error('[fdroid]', e.message);
          await sock.sendMessage(from, { text: `❌ *F-Droid Error:* ${e.message}` }, { quoted: mek });
        }
        break;
      }

      // -------------------------------------------------------------------
      default: {
        await sock.sendMessage(from, {
          text: `❌ *Unknown download target:* \`${command}\``
        }, { quoted: mek });
      }
    }
  }
});