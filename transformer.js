// transformer.js — multi-platform media downloader for PANDA bot
// ---------------------------------------------------------------------------
// Public API:
//   handleDownload({ platform, url, from, state, helpers, safeSend })
//     → returns true  if handled (media sent)
//     → returns false if platform is unknown (caller decides what to do)
//
// Deps:
//   yt-dlp   (system binary, install via `pip install yt-dlp` or apt/brew)
//   ffmpeg   (system binary, usually already present alongside yt-dlp)
//   fluent-ffmpeg (already in package.json)
//   @whiskeysockets/baileys (already in package.json)
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

const UIkit = require('./ui');

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG = {
  // Max file size (in MB) we'll send over WhatsApp. WhatsApp caps ~ 64 MB for
  // videos and ~ 16 MB for audio on most clients; we stay under both.
  MAX_VIDEO_MB: 60,
  MAX_AUDIO_MB: 15,
  MAX_IMAGE_MB: 10,

  // yt-dlp binary name (override with env YTDLP_BIN=…)
  YTDLP: process.env.YTDLP_BIN || 'yt-dlp',

  // ffmpeg binary name (override with env FFMPEG_BIN=…)
  FFMPEG: process.env.FFMPEG_BIN || 'ffmpeg',

  // Per-job timeout in ms
  JOB_TIMEOUT_MS: 5 * 60 * 1000
};

// ============================================================================
// TINY HELPERS
// ============================================================================

function tmpFile(ext) {
  return path.join(os.tmpdir(), `panda-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

function tmpDir() {
  const d = path.join(os.tmpdir(), `panda-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function safeRm(p) {
  try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function bytesToMB(n) { return n / 1024 / 1024; }

// Fetch with timeout + UA
async function httpGet(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeout || 30000);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(opts.headers || {})
      },
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function downloadToBuffer(url, { timeout = 120000 } = {}) {
  const res = await httpGet(url, { timeout });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ============================================================================
// YT-DLP WRAPPER
// ============================================================================

/**
 * Run yt-dlp with given args in a cwd. Resolves with stdout string.
 * Rejects on non-zero exit or timeout.
 */
function runYtDlp(args, { cwd, timeout = CONFIG.JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.YTDLP, args, { cwd });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`yt-dlp timeout after ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp spawn failed: ${err.message}. Is yt-dlp installed?`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) return resolve(stdout);
      reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Check yt-dlp availability once at startup. */
let YTDLP_OK = null;
async function hasYtDlp() {
  if (YTDLP_OK !== null) return YTDLP_OK;
  try {
    await runYtDlp(['--version'], { timeout: 8000 });
    YTDLP_OK = true;
  } catch {
    YTDLP_OK = false;
  }
  return YTDLP_OK;
}

/**
 * Use yt-dlp to fetch metadata for a URL without downloading.
 */
async function ytDlpInfo(url) {
  const out = await runYtDlp(['--dump-json', '--no-warnings', '--no-playlist', url], {
    timeout: 45000
  });
  // yt-dlp can emit multiple JSON lines; take the first valid one.
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { return JSON.parse(s); } catch {}
  }
  throw new Error('yt-dlp: could not parse info');
}

/**
 * Use yt-dlp to download a video URL into a temp dir.
 * Returns { file, info }.
 */
async function ytDlpDownloadVideo(url) {
  const dir = tmpDir();
  const outTpl = path.join(dir, 'video.%(ext)s');

  // Prefer mp4 with merged audio; fall back gracefully.
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '-o', outTpl,
    url
  ];

  await runYtDlp(args);
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.part'));
  if (!files.length) throw new Error('yt-dlp: no output file');
  const file = path.join(dir, files[0]);
  const size = fs.statSync(file).size;

  if (bytesToMB(size) > CONFIG.MAX_VIDEO_MB) {
    safeRm(dir);
    throw new Error(
      `File is ${bytesToMB(size).toFixed(1)} MB — over the ${CONFIG.MAX_VIDEO_MB} MB WhatsApp limit.`
    );
  }
  return { file, dir, size };
}

/**
 * Use yt-dlp to download audio (mp3) into a temp dir.
 */
async function ytDlpDownloadAudio(url) {
  const dir = tmpDir();
  const outTpl = path.join(dir, 'audio.%(ext)s');

  const args = [
    '--no-warnings',
    '--no-playlist',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '128K',
    '-o', outTpl,
    url
  ];

  await runYtDlp(args);
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.part'));
  if (!files.length) throw new Error('yt-dlp: no audio output');
  const file = path.join(dir, files[0]);
  const size = fs.statSync(file).size;

  if (bytesToMB(size) > CONFIG.MAX_AUDIO_MB) {
    safeRm(dir);
    throw new Error(
      `Audio is ${bytesToMB(size).toFixed(1)} MB — over the ${CONFIG.MAX_AUDIO_MB} MB limit.`
    );
  }
  return { file, dir, size };
}

// ============================================================================
// PROGRESS UI
// ============================================================================

/** Send an editable progress card; returns a function to update/delete it. */
async function makeProgressCard(safeSend, from, title) {
  const key = `${title.slice(0, 20)}-${Date.now()}`;
  const startText = `${UIkit.pandaBanner('DOWNLOADING')}

${UIkit.section(title, '⏳')}
${UIkit.row('Status', 'starting…')}
${UIkit.row('Progress', UIkit.bar(0))}`;

  let sent;
  try {
    sent = await safeSend(from, { text: startText });
  } catch {
    sent = null;
  }

  let lastEdit = 0;
  return {
    async update(pct, note = '') {
      const now = Date.now();
      if (now - lastEdit < 1500) return; // throttle
      lastEdit = now;
      if (!sent?.key?.id) return;
      const text = `${UIkit.pandaBanner('DOWNLOADING')}

${UIkit.section(title, '⏳')}
${UIkit.row('Status', note || 'in progress')}
${UIkit.row('Progress', `${UIkit.bar(pct)} ${pct}%`)}`;
      try {
        await safeSend(from, {
          text,
          edit: sent.key
        });
      } catch {}
    },
    async done(note = 'ready') {
      if (!sent?.key?.id) return;
      const text = `${UIkit.pandaBanner('READY')}

${UIkit.section(title, '✅')}
${UIkit.row('Status', note)}
${UIkit.row('Progress', `${UIkit.bar(100)} 100%`)}`;
      try {
        await safeSend(from, { text, edit: sent.key });
      } catch {}
    },
    async fail(err) {
      if (!sent?.key?.id) return;
      const text = `${UIkit.pandaBanner('FAILED')}

${UIkit.section(title, '❌')}
${UIkit.row('Reason', String(err).slice(0, 80))}`;
      try {
        await safeSend(from, { text, edit: sent.key });
      } catch {}
    }
  };
}

// ============================================================================
// PLATFORM: TIKTOK  (tikwm.com — no key, returns direct mp4 + mp3)
// ============================================================================
async function downloadTikTok({ url, from, safeSend, helpers }) {
  const card = await makeProgressCard(safeSend, from, 'TikTok');
  try {
    await card.update(15, 'fetching metadata');

    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
    const res = await httpGet(apiUrl, { timeout: 30000 });
    if (!res.ok) throw new Error(`tikwm HTTP ${res.status}`);
    const j = await res.json();
    if (j.code !== 0 || !j.data) throw new Error(j.msg || 'tikwm returned no data');

    const d = j.data;
    const title = (d.title || 'TikTok').slice(0, 80);
    const author = d.author?.unique_id ? `@${d.author.unique_id}` : '';
    const videoUrl = d.hdplay || d.play;
    const audioUrl = d.music;

    if (!videoUrl) throw new Error('No video URL returned.');

    await card.update(50, 'downloading video');
    const buf = await downloadToBuffer(videoUrl, { timeout: 120000 });

    if (bytesToMB(buf.length) > CONFIG.MAX_VIDEO_MB) {
      throw new Error(`Video is ${bytesToMB(buf.length).toFixed(1)} MB — too big.`);
    }

    const caption = `${UIkit.pandaBanner('TIKTOK')}

${UIkit.section('INFO', '🎵')}
${UIkit.row('Title', title)}
${UIkit.row('Author', author || '—')}
${UIkit.row('Size', `${bytesToMB(buf.length).toFixed(2)} MB`)}`;

    await card.update(90, 'sending video');
    await safeSend(from, { video: buf, caption, mimetype: 'video/mp4' });

    // Bonus: audio track as a voice-note style mp3
    if (audioUrl) {
      try {
        const mp3 = await downloadToBuffer(audioUrl, { timeout: 60000 });
        if (bytesToMB(mp3.length) <= CONFIG.MAX_AUDIO_MB) {
          await safeSend(from, {
            audio: mp3,
            mimetype: 'audio/mpeg',
            fileName: 'tiktok-audio.mp3'
          });
        }
      } catch (e) {
        console.log('[tt] audio skip:', e.message);
      }
    }

    await card.done('sent ✅');
    return true;
  } catch (e) {
    await card.fail(e.message);
    throw e;
  }
}

// ============================================================================
// PLATFORM: YOUTUBE
// ============================================================================
async function downloadYouTube({ url, from, safeSend, args = [] }) {
  const card = await makeProgressCard(safeSend, from, 'YouTube');
  try {
    if (!(await hasYtDlp())) {
      throw new Error('yt-dlp is not installed on the server. Install it with `pip install yt-dlp` or `apt install yt-dlp`.');
    }

    await card.update(10, 'fetching info');
    const info = await ytDlpInfo(url).catch(() => null);
    const title = (info?.title || 'YouTube').slice(0, 80);
    const uploader = info?.uploader || info?.channel || '';
    const duration = info?.duration ? `${Math.floor(info.duration / 60)}m ${info.duration % 60}s` : '—';

    // If user asked for audio-only (`yt a <url>` or `yt mp3 <url>`)
    const audioOnly = args.some((a) => ['a', 'audio', 'mp3', 'music'].includes(String(a).toLowerCase()));

    if (audioOnly) {
      await card.update(35, 'downloading audio');
      const { file, dir, size } = await ytDlpDownloadAudio(url);
      const buf = fs.readFileSync(file);

      await card.update(85, 'sending audio');
      await safeSend(from, {
        audio: buf,
        mimetype: 'audio/mpeg',
        fileName: `${title.replace(/[\\/:*?"<>|]/g, '_')}.mp3`,
        ptt: false
      });

      safeRm(dir);
      await card.done(`audio · ${bytesToMB(size).toFixed(2)} MB`);
      return true;
    }

    await card.update(35, 'downloading video (this can take a while)');
    const { file, dir, size } = await ytDlpDownloadVideo(url);
    const buf = fs.readFileSync(file);

    const caption = `${UIkit.pandaBanner('YOUTUBE')}

${UIkit.section('INFO', '▶️')}
${UIkit.row('Title', title)}
${UIkit.row('Channel', uploader || '—')}
${UIkit.row('Duration', duration)}
${UIkit.row('Size', `${bytesToMB(size).toFixed(2)} MB`)}`;

    await card.update(90, 'sending video');
    await safeSend(from, { video: buf, caption, mimetype: 'video/mp4' });

    safeRm(dir);
    await card.done('sent ✅');
    return true;
  } catch (e) {
    await card.fail(e.message);
    throw e;
  }
}

// ============================================================================
// PLATFORM: INSTAGRAM
// ============================================================================
async function downloadInstagram({ url, from, safeSend }) {
  const card = await makeProgressCard(safeSend, from, 'Instagram');
  try {
    if (!(await hasYtDlp())) {
      throw new Error('yt-dlp is not installed. Install with `pip install yt-dlp`.');
    }

    await card.update(20, 'fetching post');
    const info = await ytDlpInfo(url).catch(() => null);
    const title = (info?.title || 'Instagram').slice(0, 80);
    const uploader = info?.uploader || info?.channel || '';

    await card.update(45, 'downloading');
    const { file, dir, size } = await ytDlpDownloadVideo(url);
    const buf = fs.readFileSync(file);

    const caption = `${UIkit.pandaBanner('INSTAGRAM')}

${UIkit.section('INFO', '📸')}
${UIkit.row('Title', title)}
${UIkit.row('Author', uploader || '—')}
${UIkit.row('Size', `${bytesToMB(size).toFixed(2)} MB`)}`;

    await card.update(90, 'sending');
    await safeSend(from, { video: buf, caption, mimetype: 'video/mp4' });

    safeRm(dir);
    await card.done('sent ✅');
    return true;
  } catch (e) {
    await card.fail(e.message);
    throw e;
  }
}

// ============================================================================
// PLATFORM: FACEBOOK
// ============================================================================
async function downloadFacebook({ url, from, safeSend }) {
  const card = await makeProgressCard(safeSend, from, 'Facebook');
  try {
    if (!(await hasYtDlp())) {
      throw new Error('yt-dlp is not installed. Install with `pip install yt-dlp`.');
    }

    await card.update(20, 'fetching video');
    const info = await ytDlpInfo(url).catch(() => null);
    const title = (info?.title || 'Facebook').slice(0, 80);

    await card.update(45, 'downloading');
    const { file, dir, size } = await ytDlpDownloadVideo(url);
    const buf = fs.readFileSync(file);

    const caption = `${UIkit.pandaBanner('FACEBOOK')}

${UIkit.section('INFO', '📘')}
${UIkit.row('Title', title)}
${UIkit.row('Size', `${bytesToMB(size).toFixed(2)} MB`)}`;

    await card.update(90, 'sending');
    await safeSend(from, { video: buf, caption, mimetype: 'video/mp4' });

    safeRm(dir);
    await card.done('sent ✅');
    return true;
  } catch (e) {
    await card.fail(e.message);
    throw e;
  }
}

// ============================================================================
// PLATFORM: SPOTIFY  (oEmbed for metadata, yt-dlp for the actual track)
// ============================================================================
async function downloadSpotify({ url, from, safeSend }) {
  const card = await makeProgressCard(safeSend, from, 'Spotify');
  try {
    await card.update(15, 'reading metadata');
    let meta = null;
    try {
      const r = await httpGet(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { timeout: 15000 });
      if (r.ok) meta = await r.json();
    } catch {}

    const title = (meta?.title || 'Spotify track').slice(0, 80);
    const artist = (meta?.author_name || '').slice(0, 60);

    if (!(await hasYtDlp())) {
      throw new Error(
        'Spotify audio cannot be fetched directly. yt-dlp is required to pull the song from YouTube.'
      );
    }

    await card.update(35, 'searching for the song');
    // Search YouTube for "<artist> - <title>" and grab the first result's audio
    const query = `ytsearch1:${artist} ${title} audio`;
    const dir = tmpDir();
    const outTpl = path.join(dir, 'spotify.%(ext)s');

    await runYtDlp([
      '--no-warnings',
      '--no-playlist',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '-o', outTpl,
      query
    ]);

    const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.part'));
    if (!files.length) throw new Error('yt-dlp could not find the song.');
    const file = path.join(dir, files[0]);
    const size = fs.statSync(file).size;

    if (bytesToMB(size) > CONFIG.MAX_AUDIO_MB) {
      safeRm(dir);
      throw new Error(`Audio is ${bytesToMB(size).toFixed(1)} MB — too big.`);
    }

    const buf = fs.readFileSync(file);

    const caption = `${UIkit.pandaBanner('SPOTIFY')}

${UIkit.section('TRACK', '🎧')}
${UIkit.row('Title', title)}
${UIkit.row('Artist', artist || '—')}
${UIkit.row('Size', `${bytesToMB(size).toFixed(2)} MB`)}`;

    await card.update(85, 'sending audio');
    await safeSend(from, {
      audio: buf,
      mimetype: 'audio/mpeg',
      fileName: `${title.replace(/[\\/:*?"<>|]/g, '_')}.mp3`,
      ptt: false
    });
    // Send cover separately if we have it
    if (meta?.thumbnail_url) {
      try {
        await safeSend(from, { image: { url: meta.thumbnail_url }, caption });
      } catch {
        await safeSend(from, { text: caption });
      }
    } else {
      await safeSend(from, { text: caption });
    }

    safeRm(dir);
    await card.done('sent ✅');
    return true;
  } catch (e) {
    await card.fail(e.message);
    throw e;
  }
}

// ============================================================================
// PLATFORM: TWITTER / X
// ============================================================================
async function downloadTwitter({ url, from, safeSend }) {
  const card = await makeProgressCard(safeSend, from, 'Twitter/X');
  try {
    if (!(await hasYtDlp())) {
      throw new Error('yt-dlp is not installed. Install with `pip install yt-dlp`.');
    }

    await card.update(20, 'fetching tweet');
    const info = await ytDlpInfo(url).catch(() => null);
    const title = (info?.title || 'Twitter video').slice(0, 80);

    await card.update(45, 'downloading');
    const { file, dir, size } = await ytDlpDownloadVideo(url);
    const buf = fs.readFileSync(file);

    const caption = `${UIkit.pandaBanner('TWITTER / X')}

${UIkit.section('INFO', '🐦')}
${UIkit.row('Title', title)}
${UIkit.row('Size', `${bytesToMB(size).toFixed(2)} MB`)}`;

    await card.update(90, 'sending');
    await safeSend(from, { video: buf, caption, mimetype: 'video/mp4' });

    safeRm(dir);
    await card.done('sent ✅');
    return true;
  } catch (e) {
    await card.fail(e.message);
    throw e;
  }
}

// ============================================================================
// PLATFORM: PINTEREST
// ============================================================================
async function downloadPinterest({ url, from, safeSend }) {
  const card = await makeProgressCard(safeSend, from, 'Pinterest');
  try {
    if (!(await hasYtDlp())) {
      throw new Error('yt-dlp is not installed. Install with `pip install yt-dlp`.');
    }
    await card.update(30, 'downloading');
    const { file, dir, size } = await ytDlpDownloadVideo(url);
    const buf = fs.readFileSync(file);
    const isVideo = /\.(mp4|webm|mkv|mov)$/i.test(file);

    await card.update(90, 'sending');
    if (isVideo) {
      await safeSend(from, { video: buf, caption: '📌 Pinterest', mimetype: 'video/mp4' });
    } else {
      await safeSend(from, { image: buf, caption: '📌 Pinterest' });
    }

    safeRm(dir);
    await card.done('sent ✅');
    return true;
  } catch (e) {
    await card.fail(e.message);
    throw e;
  }
}

// ============================================================================
// MASTER DISPATCHER
// ============================================================================
const HANDLERS = {
  tiktok:   downloadTikTok,
  tt:       downloadTikTok,

  yt:       downloadYouTube,
  youtube:  downloadYouTube,

  ig:       downloadInstagram,
  instagram:downloadInstagram,

  fb:       downloadFacebook,
  facebook: downloadFacebook,

  spotify:  downloadSpotify,
  sp:       downloadSpotify,

  x:        downloadTwitter,
  twitter:  downloadTwitter,

  pinterest: downloadPinterest,
  pin:       downloadPinterest
};

async function handleDownload({ platform, url, from, state, helpers, safeSend, args = [] }) {
  if (!platform || platform === 'unknown') return false;

  const handler = HANDLERS[platform];
  if (!handler) return false;

  // Normalise args for handlers that care (only YouTube currently)
  const passArgs = { url, from, state, helpers, safeSend, args };

  await handler(passArgs);
  return true;
}

// ============================================================================
// HEALTHCHECK (call once on startup)
// ============================================================================
async function selfTest() {
  const ok = await hasYtDlp();
  console.log(`[transformer] yt-dlp: ${ok ? '✅ available' : '❌ missing (YouTube/IG/FB/X/Spotify disabled)'}`);
  return { ytdlp: ok };
}

module.exports = {
  handleDownload,
  selfTest,
  // exposed for testing
  downloadTikTok,
  downloadYouTube,
  downloadInstagram,
  downloadFacebook,
  downloadSpotify,
  downloadTwitter,
  downloadPinterest,
  hasYtDlp,
  CONFIG
};