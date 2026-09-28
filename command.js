// ============================================================================
// IMPORTS
// ============================================================================
import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { persistConfig, messageStore, scheduleAutoDelete } from './bot.js';

// ============================================================================
// OPTIONAL MODULE IMPORTS
// ============================================================================
let ttdl, Sticker, sharp, playdl, yts;
try { const m = await import('@silent-tech-offc/ttdl'); ttdl = m.download; } catch { console.warn('ttdl not available'); }
try { playdl = await import('play-dl'); } catch { console.warn('play-dl not available'); }
try { yts = (await import('yt-search')).default; } catch { console.warn('yt-search not available'); }
try { const m = await import('wa-sticker-kit'); Sticker = m.Sticker || m.default?.Sticker || m.default; } catch { console.warn('wa-sticker-kit not available'); }
try { sharp = (await import('sharp')).default; } catch { console.warn('sharp not available'); }

// ============================================================================
// CONFIG
// ============================================================================
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || '';
const HARDCODED_BANNER = process.env.DEFAULT_BANNER_URL || '';
const TTS_MAX_CHARS = 200;
const logger = pino({ level: 'silent' });

// ============================================================================
// QUOTED MEDIA HELPERS
// ============================================================================
function getContextInfo(msg) {
  return msg.message?.extendedTextMessage?.contextInfo || null;
}

function getQuotedMessage(msg) {
  return getContextInfo(msg)?.quotedMessage || null;
}

function getQuotedKey(msg, jid, state) {
  const ctx = getContextInfo(msg);
  if (!ctx?.stanzaId) return null;
  return {
    remoteJid: jid,
    fromMe: ctx.participant === state.ownerJid,
    id: ctx.stanzaId,
    participant: ctx.participant,
  };
}

function unwrapViewOnce(message) {
  return (
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message?.viewOnceMessage?.message ||
    message
  );
}

async function downloadQuotedMedia(msg, jid, state, sock) {
  const quoted = getQuotedMessage(msg);
  const key = getQuotedKey(msg, jid, state);
  if (!quoted || !key) throw new Error('No quoted media found');
  const buffer = await downloadMediaMessage(
    { key, message: quoted },
    'buffer', {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );
  const type = getContentType(unwrapViewOnce(quoted));
  return { buffer, type, key, quoted };
}

// ============================================================================
// HUMAN-LIKE PRESENCE HELPERS
// ============================================================================
async function sendTyping(sock, jid, durationMs = 1500) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, durationMs));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
}

async function sendRecording(sock, jid, durationMs = 2000) {
  try {
    await sock.sendPresenceUpdate('recording', jid);
    await new Promise(r => setTimeout(r, durationMs));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
}

async function sendOnline(sock) {
  try { await sock.sendPresenceUpdate('available'); } catch (_) {}
}

// ============================================================================
// REACTIONS
// ============================================================================
async function setReaction(sock, msg, emoji) {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: emoji, key: msg.key }
    });
  } catch (e) { /* ignore */ }
}

async function clearReaction(sock, msg) {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: '', key: msg.key }
    });
  } catch (e) { /* ignore */ }
}

// ============================================================================
// IMGBB UPLOAD
// ============================================================================
async function uploadToImgBB(buffer, name = 'image.jpg') {
  if (!IMGBB_API_KEY) throw new Error('IMGBB_API_KEY not configured');
  const base64 = buffer.toString('base64');
  const form = new URLSearchParams();
  form.append('key', IMGBB_API_KEY);
  form.append('image', base64);
  form.append('name', name);

  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'ImgBB upload failed');
  return data.data.url;
}

// ============================================================================
// TEXT → IMAGE (black background, white text)
// ============================================================================
async function textToImage(text, width = 1080, height = 1080) {
  if (!sharp) throw new Error('sharp not installed — cannot render text to image');

  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const lines = [];
  const words = escaped.split(/\s+/);
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > 30) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  }
  if (current) lines.push(current);

  const lineHeight = 70;
  const fontSize = 48;
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;

  const tspans = lines.map((line, i) =>
    `<tspan x="50%" dy="${i === 0 ? 0 : lineHeight}">${line}</tspan>`
  ).join('');

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="black"/>
      <text x="50%" y="${startY}" text-anchor="middle" fill="white"
            font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold">
        ${tspans}
      </text>
    </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// ============================================================================
// COMMAND REGISTRY
// ============================================================================
const commands = {
  // Info
  menu: cmdMenu, list: cmdList, ping: cmdPing, owner: cmdOwner,
  uptime: cmdUptime, speed: cmdSpeed, status: cmdStatus, help: cmdHelp,
  // Access
  mode: cmdMode, prefix: cmdPrefix, token: cmdToken,
  // Media / view-once
  ops: cmdOps, save: cmdSaveMedia,
  // Downloaders
  yt: cmdYt, tiktok: cmdTiktok, ig: cmdIg, fb: cmdFb,
  play: cmdPlay, song: cmdSong, music: cmdPlay,
  // Media tools
  sticker: cmdSticker, toimg: cmdToImg, getpp: cmdGetPp, tts: cmdTts,
  tourl: cmdToUrl, img2url: cmdToUrl, url: cmdToUrl,
  text2img: cmdTextToImg, txt2img: cmdTextToImg, timg: cmdTextToImg,
  // Utility
  lyrics: cmdLyrics, forward: cmdForward,
  weather: cmdWeather, w: cmdWeather,
  currency: cmdCurrency, convert: cmdCurrency, forex: cmdCurrency,
  google: cmdGoogle, search: cmdGoogle, g: cmdGoogle,
  calc: cmdCalc,
  qr: cmdQr,
  // Anti
  antidelete: cmdAntiDelete, antiedit: cmdAntiEdit,
  history: cmdHistory, lastdeleted: cmdLastDeleted,
  // Group
  welcome: cmdWelcome, setwelcome: cmdSetWelcome,
  goodbye: cmdGoodbye, setgoodbye: cmdSetGoodbye,
  kick: cmdKick, add: cmdAdd, promote: cmdPromote, demote: cmdDemote,
  mute: cmdMute, unmute: cmdUnmute, tagall: cmdTagAll, tag: cmdTagAll,
  ginfo: cmdGroupInfo, groupinfo: cmdGroupInfo, grouplink: cmdLink, link: cmdLink,
  setname: cmdSetName, setdesc: cmdSetDesc, setgcpp: cmdSetGcPp,
  admins: cmdAdmins, whois: cmdWhois, revoke: cmdRevoke,
  warn: cmdWarn, warnings: cmdWarnings, resetwarn: cmdResetWarn,
  // Owner
  setbanner: cmdSetBanner, setprefix: cmdSetPrefix, setbotname: cmdSetBotName,
  broadcast: cmdBroadcast, block: cmdBlock, unblock: cmdUnblock,
  // System
  restart: cmdRestart, logout: cmdLogout, cleartemp: cmdClearTemp,
};

// ============================================================================
// MESSAGE HANDLER
// ============================================================================
export async function handleMessage(payload, sock, state) {
  const { messages, type } = payload;
  if (type !== 'notify') return;

  for (const msg of messages) {
    if (!msg.message) continue;
    const jid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    const sender = fromMe ? state.ownerJid : (msg.key.participant || jid);
    const isGroup = jid.endsWith('@g.us');

    // In private mode: only respond to owner
const isOwner =
  fromMe ||
  sender === state.ownerJid ||
  sender?.split('@')[0]?.split(':')[0] === state.ownerNumber;

if (state.mode === 'private' && !isOwner) continue;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption || '';

    if (!text.startsWith(state.prefix)) continue;
    const [rawCmd, ...args] = text.slice(state.prefix.length).trim().split(/\s+/);
    const handler = commands[rawCmd.toLowerCase()];
    if (!handler) continue;

    try {
      await sock.readMessages([msg.key]);
      await sendOnline(sock);
    } catch (_) {}

    try {
      await handler({ args, msg, sock, state, jid, sender, fromMe, isGroup });
    } catch (err) {
      console.error(`Command "${rawCmd}" failed:`, err.message);
      await setReaction(sock, msg, '❌');
      await sock.sendMessage(jid, { text: `❌ *Error:* ${err.message}` });
    }
  }
}

// ============================================================================
// REACTION HANDLER (🐼 view-once)
// ============================================================================
export async function handleReaction(reactions, sock, state) {
  for (const { key, reaction } of reactions) {
    if (reaction.text !== '🐼' || !state.ownerJid) continue;

    const original = messageStore.get(`${key.remoteJid}:${key.id}`);
    if (!original) continue;

    const content = unwrapViewOnce(original.message);
    if (!content || (!content.imageMessage && !content.videoMessage)) continue;

    await setReaction(sock, { key }, '⏳');

    try {
      const buffer = await downloadMediaMessage(
        original,
        'buffer', {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );

      const type = getContentType(content);
      const sendOpts = type === 'videoMessage'
        ? { video: buffer, caption: '📥 *View-once downloaded* (auto-deletes in 1h)' }
        : { image: buffer, caption: '📥 *View-once downloaded* (auto-deletes in 1h)' };

      const sent = await sock.sendMessage(state.ownerJid, sendOpts);
      await setReaction(sock, { key }, '✅');

      if (sent?.key) {
        scheduleAutoDelete(sock, state.ownerJid, sent.key, 60 * 60 * 1000);
      }
    } catch (e) {
      console.error('view-once download failed:', e.message);
      await setReaction(sock, { key }, '❌');
    }
  }
}

// ============================================================================
// GROUP PARTICIPANTS HANDLER
// ============================================================================
export async function handleGroupParticipants(update, sock, state) {
  const { id, participants, action } = update;
  if (!state.connected) return;

  let metadata;
  try { metadata = await sock.groupMetadata(id); } catch { metadata = { subject: 'the group' }; }
  const groupName = metadata.subject || 'the group';

  for (const p of participants) {
    const userJid = p.id || p;
    const userTag = userJid.split('@')[0].split(':')[0];

    if (action === 'add' && state.welcome) {
      const txt = state.welcomeText.replace('{group}', groupName).replace('{user}', userTag);
      await sock.sendMessage(id, { text: txt, mentions: [userJid] });
    }
    if (action === 'remove' && state.goodbye) {
      const txt = state.goodbyeText.replace('{group}', groupName).replace('{user}', userTag);
      await sock.sendMessage(id, { text: txt, mentions: [userJid] });
    }
    if (action === 'promote') {
      await sock.sendMessage(id, { text: `🛡️ @${userTag} promoted to admin.`, mentions: [userJid] });
    }
    if (action === 'demote') {
      await sock.sendMessage(id, { text: `📉 @${userTag} demoted.`, mentions: [userJid] });
    }
  }
}

// ============================================================================
// MENU BUILDER
// ============================================================================
const DIV = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SUB = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

function buildMenu(state) {
  const p = state.prefix;
  const users = state.ownerJid ? state.ownerJid.split('@')[0] : 'Owner';
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60);

  const lines = [
    `${DIV}`,
    `║  *${state.botName.toUpperCase()}* — COMMAND MENU`,
    `║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈`,
    `║  *👤 Owner* ···· ${users}`,
    `║  *🔒 Mode* ····· ${state.mode.toUpperCase()}`,
    `║  *⚡ Prefix* ···· [ ${p} ]`,
    `║  *⏱ Uptime* ···· ${h}h ${m}m`,
    `║  *📦 Commands* ·· ${Object.keys(commands).length}`,
    `${DIV}`,
    '',
  ];

  const categories = {
    '📋 INFO': ['list', 'menu', 'owner', 'ping', 'speed', 'status', 'uptime', 'help'],
    '🔐 ACCESS': ['mode', 'prefix', 'token'],
    '📥 DOWNLOADERS': ['yt', 'tiktok', 'ig', 'fb', 'play', 'song'],
    '🎨 MEDIA TOOLS': ['ops', 'save', 'sticker', 'toimg', 'text2img', 'getpp', 'tts', 'tourl'],
    '🔧 UTILITY': ['lyrics', 'forward', 'weather', 'currency', 'google', 'calc', 'qr'],
    '🛡️ ANTI': ['antidelete', 'antiedit', 'history', 'lastdeleted'],
    '👥 GROUP': ['welcome', 'setwelcome', 'goodbye', 'setgoodbye', 'kick', 'add', 'promote', 'demote', 'mute', 'unmute', 'tagall', 'tag', 'ginfo', 'grouplink', 'setname', 'setdesc', 'setgcpp', 'admins', 'whois', 'revoke', 'warn', 'warnings', 'resetwarn'],
    '👑 OWNER': ['setbanner', 'setprefix', 'setbotname', 'broadcast', 'block', 'unblock'],
    '⚙️ SYSTEM': ['restart', 'logout', 'cleartemp'],
  };

  for (const [cat, cmds] of Object.entries(categories)) {
    lines.push(`${DIV}`);
    lines.push(`║  *「 ${cat} 」*`);
    lines.push(`║  ${SUB}`);
    for (const c of cmds) {
      lines.push(`║  ✺ ${p}${c}`);
    }
    lines.push(`${DIV}`);
    lines.push('');
  }

  lines.push(`> *${state.botName}* · Powered by Baileys`);
  lines.push('> 🐼 React to view-once  ·  ⏳ Processing  ·  ✅ Done  ·  ❌ Failed');
  return lines.join('\n');
}

// ============================================================================
// BASIC COMMANDS
// ============================================================================
async function cmdMenu({ sock, jid, state, msg }) {
  await setReaction(sock, msg, '📋');
  await sendTyping(sock, jid, 800);
  const text = buildMenu(state);
  const banner = state.bannerUrl || HARDCODED_BANNER;
  if (banner) {
    await sock.sendMessage(jid, { image: { url: banner }, caption: text });
  } else {
    await sock.sendMessage(jid, { text });
  }
  await clearReaction(sock, msg);
}

async function cmdList({ sock, jid, state, msg }) { return cmdMenu({ sock, jid, state, msg }); }
async function cmdHelp({ sock, jid, state, msg }) { return cmdMenu({ sock, jid, state, msg }); }

async function cmdPing({ sock, jid, state, msg }) {
  const t0 = Date.now();
  await setReaction(sock, msg, '🏓');
  const latency = Date.now() - t0;
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  await clearReaction(sock, msg);
  await sock.sendMessage(jid, { text: `${DIV}\n║  🏓 *PONG*\n║  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n║  ⚡ Latency: ${latency}ms\n║  ⏱ Uptime: ${uptime}s\n║  🔒 Mode: ${state.mode}\n${DIV}` });
}

async function cmdSpeed({ sock, jid, state, msg }) {
  const t0 = Date.now();
  await setReaction(sock, msg, '⚡');
  const latency = Date.now() - t0;
  await clearReaction(sock, msg);
  await sock.sendMessage(jid, { text: `⚡ *Speed:* ${latency}ms` });
}

async function cmdUptime({ sock, jid, state, msg }) {
  const s = Math.floor((Date.now() - state.startedAt) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  await setReaction(sock, msg, '⏱');
  await clearReaction(sock, msg);
  await sock.sendMessage(jid, { text: `⏱ *Uptime:* ${h}h ${m}m ${sec}s` });
}

async function cmdOwner({ sock, jid, state }) {
  await sock.sendMessage(jid, { text: `👑 *Owner:* ${state.ownerJid || 'not set'}` });
}

async function cmdToken({ sock, jid, fromMe, state }) {
  if (!fromMe) return;
  await sock.sendMessage(jid, { text: `🔑 *Session Token:*\n\`${state.sessionToken || 'not generated'}\`` });
}

async function cmdMode({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const next = args[0]?.toLowerCase();
  if (!['private', 'public'].includes(next)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}mode private|public` });
  }
  state.mode = next; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✅ Mode set to *${next.toUpperCase()}*` });
}

async function cmdPrefix({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const p = args[0];
  if (!p || p.length > 2) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}prefix <char>` });
  }
  state.prefix = p; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✅ Prefix set to *"${p}"*` });
}

async function cmdStatus({ sock, jid, state, msg }) {
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, {
    text: `${DIV}\n║  📊 *STATUS*\n${SUB}\n║  🔗 Connected: ${state.connected}\n║  🔒 Mode: ${state.mode}\n║  ⏱ Uptime: ${uptime}s\n║  🛡️ Anti-delete: ${state.antidelete}\n║  ✏️ Anti-edit: ${state.antiedit}\n║  👋 Welcome: ${state.welcome}\n║  💾 Cache: ${messageStore.size} msgs\n║  📨 Messages: ${state.msgCount || 0}\n${DIV}`
  });
}

// ============================================================================
// 🌤️ WEATHER
// ============================================================================
async function cmdWeather({ args, sock, jid, state, msg }) {
  const city = args.join(' ');
  if (!city) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}weather <city>` });
  }
  if (!WEATHER_API_KEY) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: '⚠️ WEATHER_API_KEY not configured (get one free at openweathermap.org)' });
  }

  await setReaction(sock, msg, '🔎');
  await sendTyping(sock, jid, 1200);

  try {
    const wRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=metric`);
    const w = await wRes.json();
    if (w.cod !== 200) throw new Error(w.message || 'City not found');

    const fRes = await fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=metric&cnt=8`);
    const f = await fRes.json();

    const emojiMap = {
      Clear: '☀️', Clouds: '☁️', Rain: '🌧️', Drizzle: '🌦️',
      Thunderstorm: '⛈️', Snow: '❄️', Mist: '🌫️', Fog: '🌫️', Haze: '🌫️'
    };
    const emoji = emojiMap[w.weather[0].main] || '🌍';

    const sunrise = new Date(w.sys.sunrise * 1000).toLocaleTimeString();
    const sunset = new Date(w.sys.sunset * 1000).toLocaleTimeString();

    let forecastLines = '';
    if (f.list) {
      const byDay = {};
      for (const item of f.list) {
        const day = new Date(item.dt * 1000).toLocaleDateString('en-US', { weekday: 'short' });
        if (!byDay[day]) byDay[day] = { min: item.main.temp_min, max: item.main.temp_max, desc: item.weather[0].description, pop: item.pop };
        else {
          byDay[day].min = Math.min(byDay[day].min, item.main.temp_min);
          byDay[day].max = Math.max(byDay[day].max, item.main.temp_max);
          byDay[day].pop = Math.max(byDay[day].pop, item.pop);
        }
      }
      forecastLines = Object.entries(byDay).slice(0, 5).map(([day, d]) =>
        `║  📅 ${day}: ${Math.round(d.min)}° – ${Math.round(d.max)}° | ${d.desc} | 💧${Math.round((d.pop || 0) * 100)}%`
      ).join('\n');
    }

    const text =
      `${DIV}\n` +
      `║  ${emoji} *WEATHER — ${w.name}, ${w.sys.country}*\n` +
      `${SUB}\n` +
      `║  🌡️ Temp: *${Math.round(w.main.temp)}°C* (feels ${Math.round(w.main.feels_like)}°C)\n` +
      `║  📉 Min/Max: ${Math.round(w.main.temp_min)}° / ${Math.round(w.main.temp_max)}°\n` +
      `║  ☁️ Condition: ${w.weather[0].description}\n` +
      `║  💧 Humidity: ${w.main.humidity}%\n` +
      `║  🌬️ Wind: ${w.wind.speed} m/s (${w.wind.deg}°)\n` +
      `║  🔽 Pressure: ${w.main.pressure} hPa\n` +
      `║  👁️ Visibility: ${(w.visibility / 1000).toFixed(1)} km\n` +
      `║  ☀️ Sunrise: ${sunrise}\n` +
      `║  🌙 Sunset: ${sunset}\n` +
      `${DIV}\n` +
      `║  *5-DAY FORECAST*\n` +
      `${SUB}\n` +
      (forecastLines || '║  No forecast data') + '\n' +
      `${DIV}`;

    await sock.sendMessage(jid, { text });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Weather error: ${e.message}` });
  }
}

// ============================================================================
// 💱 CURRENCY
// ============================================================================
async function cmdCurrency({ args, sock, jid, state, msg }) {
  if (args.length < 3) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, {
      text: `Usage: ${state.prefix}currency <amount> <from> <to>\nExample: ${state.prefix}currency 100 USD EUR`
    });
  }
  const amount = parseFloat(args[0]);
  const from = args[1].toUpperCase();
  const to = args[2].toUpperCase();

  if (isNaN(amount)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: '❌ Invalid amount' });
  }

  await setReaction(sock, msg, '💱');
  await sendTyping(sock, jid, 1000);

  try {
    const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`);
    const data = await res.json();
    if (!data.rates) throw new Error('Invalid currency code');
    const rate = data.rates[to];
    if (!rate) throw new Error(`Unknown currency: ${to}`);

    const converted = amount * rate;
    const reverse = 1 / rate;

    const text =
      `${DIV}\n` +
      `║  💱 *CURRENCY CONVERTER*\n` +
      `${SUB}\n` +
      `║  💰 Amount: ${amount} ${from}\n` +
      `║  🔄 Converted: *${converted.toFixed(2)} ${to}*\n` +
      `║  📊 Rate: 1 ${from} = ${rate.toFixed(4)} ${to}\n` +
      `║  📊 Reverse: 1 ${to} = ${reverse.toFixed(4)} ${from}\n` +
      `║  📅 Date: ${data.date}\n` +
      `${DIV}`;

    await sock.sendMessage(jid, { text });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Currency error: ${e.message}` });
  }
}

// ============================================================================
// 🔍 GOOGLE SEARCH
// ============================================================================
async function cmdGoogle({ args, sock, jid, state, msg }) {
  const query = args.join(' ');
  if (!query) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}google <query>` });
  }

  await setReaction(sock, msg, '🔎');
  await sendTyping(sock, jid, 1500);

  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const data = await res.json();

    const lines = [];

    if (data.AbstractText) {
      lines.push(`📖 *Summary:*`);
      lines.push(data.AbstractText);
      if (data.AbstractURL) lines.push(`🔗 ${data.AbstractURL}`);
      lines.push('');
    }
    if (data.Answer) {
      lines.push(`💡 *Answer:* ${data.Answer}`);
      lines.push('');
    }
    if (data.RelatedTopics?.length) {
      lines.push(`🔗 *Related:*`);
      for (const t of data.RelatedTopics.slice(0, 5)) {
        if (t.Text) lines.push(`• ${t.Text.slice(0, 120)}`);
      }
      lines.push('');
    }
    if (!lines.length) {
      lines.push(`❌ No instant answer found for "${query}"`);
      lines.push(`🔗 Try: https://www.google.com/search?q=${encodeURIComponent(query)}`);
    }

    const text =
      `${DIV}\n` +
      `║  🔍 *SEARCH: ${query}*\n` +
      `${SUB}\n` +
      lines.join('\n') + '\n' +
      `${DIV}\n` +
      `> Full results: https://www.google.com/search?q=${encodeURIComponent(query)}`;

    await sock.sendMessage(jid, { text });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Search error: ${e.message}` });
  }
}

// ============================================================================
// 🧮 CALCULATOR
// ============================================================================
async function cmdCalc({ args, sock, jid, state, msg }) {
  const expr = args.join(' ');
  if (!expr) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}calc <expression>\nExample: ${state.prefix}calc 5 * (3 + 2)` });
  }

  if (!/^[\d\s+\-*/().,%^]+$/.test(expr)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: '❌ Only numbers and + - * / ( ) % ^ allowed' });
  }

  try {
    const safe = expr.replace(/\^/g, '**');
    const result = Function(`"use strict"; return (${safe})`)();
    if (typeof result !== 'number' || !isFinite(result)) throw new Error('Invalid result');

    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, {
      text: `🧮 *Calculator*\n\n📝 ${expr}\n= *${result}*`
    });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Invalid expression: ${e.message}` });
  }
}

// ============================================================================
// 📱 QR CODE
// ============================================================================
async function cmdQr({ args, sock, jid, state, msg }) {
  const text = args.join(' ');
  if (!text) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}qr <text or url>` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}`;
    await sock.sendMessage(jid, { image: { url }, caption: `📱 QR code for: ${text}` });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ QR error: ${e.message}` });
  }
}

// ============================================================================
// 🎵 MUSIC — using play-dl + yt-search
// ============================================================================
async function cmdPlay({ args, sock, jid, state, msg }) {
  const query = args.join(' ').trim();
  if (!query) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, {
      text: `Usage: ${state.prefix}play <song name>\nExample: ${state.prefix}play Lonely at the top`
    });
  }

  if (!playdl || !yts) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, {
      text: '❌ Music libraries not installed.\nRun: npm install play-dl yt-search'
    });
  }

  await setReaction(sock, msg, '🔎');
  await sendRecording(sock, jid, 1200);

  try {
    const results = await yts(query);
    const video = results.videos?.[0];
    if (!video) throw new Error('No results found');

    await sock.sendMessage(jid, {
      text:
        `${DIV}\n` +
        `║  🎵 *Found:* ${video.title}\n` +
        `║  ⏱ Duration: ${video.timestamp}\n` +
        `║  👤 ${video.author.name}\n` +
        `║  👁️ ${video.views?.toLocaleString() || '?'} views\n` +
        `║  ⏳ Downloading audio...\n` +
        `${DIV}`
    });

    let stream;
    try {
      stream = await playdl.stream(video.url, { quality: 2 });
    } catch (e) {
      console.warn('YT stream failed, trying SoundCloud fallback...');
      const sc = await playdl.search(query, { source: { soundcloud: 'tracks' }, limit: 1 });
      if (!sc.length) throw new Error('YouTube blocked + no SoundCloud fallback');
      stream = await playdl.stream(sc[0].url);
    }

    const chunks = [];
    for await (const chunk of stream.stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    if (buffer.length > 16 * 1024 * 1024) {
      await setReaction(sock, msg, '❌');
      return sock.sendMessage(jid, { text: '❌ Audio too large (max 16MB)' });
    }

    await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: 'audio/mp4',
      ptt: false,
      fileName: `${video.title.replace(/[^\w\s]/g, '').slice(0, 60)}.m4a`,
    });

    await setReaction(sock, msg, '✅');
  } catch (e) {
    console.error('Play error:', e);
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, {
      text: `❌ Music error: ${e.message}\n\n💡 Tip: Try again or use a different song name.`
    });
  }
}

async function cmdSong({ args, sock, jid, state, msg }) {
  return cmdPlay({ args, sock, jid, state, msg });
}

// ============================================================================
// DOWNLOADERS
// ============================================================================
async function cmdYt({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const url = args[0];
  if (!url || !/youtu/.test(url)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}yt <youtube-url>` });
  }
  if (!playdl) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, { text: '❌ play-dl not installed' });
  }

  await setReaction(sock, msg, '🔎');
  try {
    const info = await playdl.video_info(url);
    const v = info.video_details;

    await setReaction(sock, msg, '⏳');
    await sock.sendMessage(jid, {
      text: `${DIV}\n║  ⏳ *Processing YouTube video...*\n║  📹 ${v.title}\n║  ⏱ ${v.durationRaw}\n${DIV}`
    });

    const stream = await playdl.stream(url, { quality: 1 });
    const chunks = [];
    for await (const chunk of stream.stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    if (buffer.length > 64 * 1024 * 1024) {
      await setReaction(sock, msg, '❌');
      return sock.sendMessage(jid, { text: '❌ Video too large (max 64MB)' });
    }

    await sock.sendMessage(jid, { video: buffer, caption: `📹 *${v.title}*` });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ *Download failed:* ${e.message}` });
  }
}

async function cmdTiktok({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const url = args[0];
  if (!url || !url.includes('tiktok')) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}tiktok <url>` });
  }
  if (!ttdl) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, { text: '❌ TikTok downloader not installed' });
  }
  await setReaction(sock, msg, '🔎');
  try {
    const v = await ttdl(url);
    await setReaction(sock, msg, '⏳');
    const videoUrl =
      v.videoNoWatermark || v.video || v.play || v.data?.play ||
      v.data?.video || v.videoUrl;
    if (!videoUrl) throw new Error('No video URL in response');
    const res = await fetch(videoUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    await sock.sendMessage(jid, {
      video: buffer,
      caption: `📹 *${v.title || v.desc || 'TikTok video'}*\n👤 ${v.author || v.authorName || ''}`
    });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ *TikTok download failed:* ${e.message}` });
  }
}

async function cmdIg({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const url = args[0];
  if (!url || !url.includes('instagram')) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}ig <instagram-url>` });
  }
  await setReaction(sock, msg, '❌');
  await sock.sendMessage(jid, { text: '⚠️ Instagram downloader requires API configuration.' });
}

async function cmdFb({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const url = args[0];
  if (!url || (!url.includes('facebook') && !url.includes('fb.watch'))) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}fb <facebook-url>` });
  }
  await setReaction(sock, msg, '❌');
  await sock.sendMessage(jid, { text: '⚠️ Facebook downloader requires API configuration.' });
}

// ============================================================================
// MEDIA TOOLS
// ============================================================================
async function cmdOps({ msg, sock, jid, fromMe, state }) {
  if (!fromMe || !state.ownerJid) return;
  const quoted = getQuotedMessage(msg);
  if (!quoted) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to a view-once message with ${state.prefix}ops` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const { buffer, type } = await downloadQuotedMedia(msg, jid, state, sock);
    const opts = type === 'videoMessage'
      ? { video: buffer, caption: '📥 Downloaded from view-once (auto-deletes in 1h)' }
      : { image: buffer, caption: '📥 Downloaded from view-once (auto-deletes in 1h)' };
    const sent = await sock.sendMessage(state.ownerJid, opts);
    await setReaction(sock, msg, '✅');
    if (sent?.key) scheduleAutoDelete(sock, state.ownerJid, sent.key, 60 * 60 * 1000);
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` });
  }
}

async function cmdSaveMedia({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const quoted = getQuotedMessage(msg);
  if (!quoted) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to media with ${state.prefix}save` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const { buffer, type } = await downloadQuotedMedia(msg, jid, state, sock);
    const opts = type === 'videoMessage' ? { video: buffer } : { image: buffer };
    await sock.sendMessage(state.ownerJid, opts);
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// 🎨 IMAGE → STICKER
// ============================================================================
async function cmdSticker({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const quoted = getQuotedMessage(msg);
  if (!quoted?.imageMessage && !quoted?.videoMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to an image or video with ${state.prefix}sticker` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const { buffer } = await downloadQuotedMedia(msg, jid, state, sock);
    const isVideo = !!quoted.videoMessage;
    let stickerBuffer;
    if (sharp && !isVideo) {
      stickerBuffer = await sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 90 })
        .toBuffer();
    } else if (Sticker) {
      const sticker = new Sticker(buffer, {
        pack: state.botName,
        author: 'WA Bot',
        type: isVideo ? 'animated' : 'full',
        quality: 80,
      });
      stickerBuffer = await sticker.toBuffer();
    } else {
      throw new Error('No sticker library available');
    }
    await sock.sendMessage(jid, { sticker: stickerBuffer });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// 🖼️ STICKER → IMAGE (also supports text → image if no sticker)
// ============================================================================
async function cmdToImg({ args, msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const quoted = getQuotedMessage(msg);

  if (quoted?.stickerMessage) {
    await setReaction(sock, msg, '⏳');
    try {
      const { buffer } = await downloadQuotedMedia(msg, jid, state, sock);
      await sock.sendMessage(jid, { image: buffer, caption: '🖼️ Converted from sticker' });
      await setReaction(sock, msg, '✅');
    } catch (e) {
      await setReaction(sock, msg, '❌');
      await sock.sendMessage(jid, { text: `❌ ${e.message}` });
    }
    return;
  }

  const text = args.join(' ').trim();
  if (!text) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, {
      text:
        `↩️ Reply to a sticker with ${state.prefix}toimg\n` +
        `OR use ${state.prefix}toimg <text> to render text as image`
    });
  }

  if (!sharp) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, { text: '❌ sharp not installed — cannot render text' });
  }

  await setReaction(sock, msg, '⏳');
  try {
    const imageBuffer = await textToImage(text);
    await sock.sendMessage(jid, {
      image: imageBuffer,
      caption: `🖼️ Text rendered as image`
    });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// 🖼️ TEXT → IMAGE (dedicated command)
// ============================================================================
async function cmdTextToImg({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const text = args.join(' ').trim();
  if (!text) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}text2img <text>` });
  }

  if (!sharp) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, { text: '❌ sharp not installed' });
  }

  await setReaction(sock, msg, '⏳');
  try {
    const imageBuffer = await textToImage(text);
    await sock.sendMessage(jid, {
      image: imageBuffer,
      caption: `🖼️ "${text}"`
    });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// 🖼️ IMAGE → URL (ImgBB)
// ============================================================================
async function cmdToUrl({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const quoted = getQuotedMessage(msg);
  if (!quoted?.imageMessage && !quoted?.videoMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to an image/video with ${state.prefix}tourl` });
  }

  if (!IMGBB_API_KEY) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, { text: '⚠️ IMGBB_API_KEY not configured. Get a free key at api.imgbb.com' });
  }

  await setReaction(sock, msg, '⏳');
  await sendTyping(sock, jid, 1000);
  try {
    const { buffer } = await downloadQuotedMedia(msg, jid, state, sock);
    const url = await uploadToImgBB(buffer, `wa-${Date.now()}.jpg`);

    await sock.sendMessage(jid, {
      text: `${DIV}\n║  🖼️ *Image uploaded*\n${SUB}\n║  🔗 ${url}\n${DIV}`
    });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Upload failed: ${e.message}` });
  }
}

// ============================================================================
// GET PROFILE PICTURE
// ============================================================================
async function cmdGetPp({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = getContextInfo(msg);
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant || state.ownerJid;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user or reply to them' });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const url = await sock.profilePictureUrl(target, 'image');
    if (!url) throw new Error('No profile picture');
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    await sock.sendMessage(jid, { image: buffer, caption: `🖼️ Profile picture of @${target.split('@')[0]}`, mentions: [target] });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ No profile picture found` });
  }
}

// ============================================================================
// 🔊 TTS — 200 char limit, downloadable audio
// ============================================================================
async function cmdTts({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const text = args.join(' ').trim();

  if (!text) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, {
      text: `Usage: ${state.prefix}tts <text>\nMax: ${TTS_MAX_CHARS} characters\n\nExample: ${state.prefix}tts Hello world`
    });
  }

  if (text.length > TTS_MAX_CHARS) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, {
      text: `❌ Text too long (${text.length}/${TTS_MAX_CHARS} chars). Please shorten.`
    });
  }

  await setReaction(sock, msg, '⏳');
  await sendRecording(sock, jid, 800);

  try {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`TTS API returned ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 100) throw new Error('TTS returned empty audio');

    await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: 'audio/mpeg',
      ptt: false,
      fileName: `tts-${Date.now()}.mp3`,
    });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ TTS failed: ${e.message}` });
  }
}

// ============================================================================
// UTILITY — LYRICS
// ============================================================================
async function cmdLyrics({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const query = args.join(' ');
  if (!query) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}lyrics <song name>` });
  }
  await setReaction(sock, msg, '🔎');
  try {
    const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(query.split(' ')[0])}/${encodeURIComponent(query.split(' ').slice(1).join(' '))}`);
    const data = await res.json();
    if (!data.lyrics) throw new Error('No lyrics found');
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: `${DIV}\n║  🎵 *Lyrics: ${query}*\n${SUB}\n${data.lyrics.slice(0, 3000)}\n${DIV}` });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Lyrics not found for "${query}"` });
  }
}

// ============================================================================
// UTILITY — FORWARD
// ============================================================================
async function cmdForward({ args, msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const quoted = getQuotedMessage(msg);
  const key = getQuotedKey(msg, jid, state);
  if (!quoted || !key) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to a message with ${state.prefix}forward <number>` });
  }
  const targetNum = args[0];
  if (!targetNum) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}forward <number>` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const targetJid = `${targetNum.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(targetJid, { forward: { key, message: quoted } });
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: '✅ Message forwarded' });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// ANTI — ANTI-DELETE
// ============================================================================
async function cmdAntiDelete({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}antidelete on|off` });
  }
  state.antidelete = val === 'on'; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🛡️ Anti-delete: *${val.toUpperCase()}*` });
}

// ============================================================================
// ANTI — ANTI-EDIT
// ============================================================================
async function cmdAntiEdit({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}antiedit on|off` });
  }
  state.antiedit = val === 'on'; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✏️ Anti-edit: *${val.toUpperCase()}*` });
}

// ============================================================================
// ANTI — HISTORY
// ============================================================================
async function cmdHistory({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const n = Math.min(parseInt(args[0]) || 10, 50);
  const items = [...messageStore.values()].slice(-n);
  if (!items.length) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'No cached messages' });
  }
  const lines = items.map((m, i) => {
    const t = m.message?.conversation || m.message?.extendedTextMessage?.text || '[media]';
    return `${i + 1}. ${t.slice(0, 60)}`;
  });
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `${DIV}\n║  📜 *Last ${items.length} messages*\n${SUB}\n${lines.join('\n')}\n${DIV}` });
}

// ============================================================================
// ANTI — LAST DELETED
// ============================================================================
async function cmdLastDeleted({ sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  await setReaction(sock, msg, 'ℹ️');
  await sock.sendMessage(jid, { text: `Use ${state.prefix}history to view cached messages` });
}

// ============================================================================
// GROUP — WELCOME TOGGLE
// ============================================================================
async function cmdWelcome({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}welcome on|off` });
  }
  state.welcome = val === 'on'; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `👋 Welcome messages: *${val.toUpperCase()}*` });
}

// ============================================================================
// GROUP — SET WELCOME TEXT
// ============================================================================
async function cmdSetWelcome({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const txt = args.join(' ');
  if (!txt) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}setwelcome <text>\nPlaceholders: {user} {group}` });
  }
  state.welcomeText = txt; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Welcome text updated' });
}

// ============================================================================
// GROUP — GOODBYE TOGGLE
// ============================================================================
async function cmdGoodbye({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}goodbye on|off` });
  }
  state.goodbye = val === 'on'; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `👋 Goodbye messages: *${val.toUpperCase()}*` });
}

// ============================================================================
// GROUP — SET GOODBYE TEXT
// ============================================================================
async function cmdSetGoodbye({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const txt = args.join(' ');
  if (!txt) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}setgoodbye <text>` });
  }
  state.goodbyeText = txt; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Goodbye text updated' });
}

// ============================================================================
// GROUP — KICK
// ============================================================================
async function cmdKick({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = getContextInfo(msg);
  const mentioned = ctxInfo?.mentionedJid || [];
  const quoted = ctxInfo?.participant;
  const targets = mentioned.length ? mentioned : (quoted ? [quoted] : []);
  if (!targets.length) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention or reply to a user' });
  }
  await sock.groupParticipantsUpdate(jid, targets, 'remove');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Member removed' });
}

// ============================================================================
// GROUP — ADD
// ============================================================================
async function cmdAdd({ args, sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const num = args[0]?.replace(/\D/g, '');
  if (!num) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: add <number>` });
  }
  await sock.groupParticipantsUpdate(jid, [`${num}@s.whatsapp.net`], 'add');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Member added' });
}

// ============================================================================
// GROUP — PROMOTE
// ============================================================================
async function cmdPromote({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = getContextInfo(msg);
  const targets = ctxInfo?.mentionedJid?.length ? ctxInfo.mentionedJid : (ctxInfo?.participant ? [ctxInfo.participant] : []);
  if (!targets.length) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await sock.groupParticipantsUpdate(jid, targets, 'promote');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '🛡️ Member promoted' });
}

// ============================================================================
// GROUP — DEMOTE
// ============================================================================
async function cmdDemote({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = getContextInfo(msg);
  const targets = ctxInfo?.mentionedJid?.length ? ctxInfo.mentionedJid : (ctxInfo?.participant ? [ctxInfo.participant] : []);
  if (!targets.length) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await sock.groupParticipantsUpdate(jid, targets, 'demote');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '📉 Member demoted' });
}

// ============================================================================
// GROUP — MUTE
// ============================================================================
async function cmdMute({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  await sock.groupSettingUpdate(jid, 'announcement');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '🔇 Group muted (admins only)' });
}

// ============================================================================
// GROUP — UNMUTE
// ============================================================================
async function cmdUnmute({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  await sock.groupSettingUpdate(jid, 'not_announcement');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '🔊 Group unmuted' });
}

// ============================================================================
// GROUP — TAG ALL
// ============================================================================
async function cmdTagAll({ args, sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const metadata = await sock.groupMetadata(jid);
  const mentions = metadata.participants.map(p => p.id);
  const message = args.join(' ') || 'Attention everyone!';
  await sock.sendMessage(jid, {
    text: `📢 ${message}\n\n${mentions.map(m => `@${m.split('@')[0].split(':')[0]}`).join(' ')}`,
    mentions
  });
  await setReaction(sock, msg, '✅');
}

// ============================================================================
// GROUP — GROUP INFO
// ============================================================================
async function cmdGroupInfo({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const m = await sock.groupMetadata(jid);
  const admins = m.participants.filter(p => p.admin).length;
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, {
    text: `${DIV}\n║  📊 *Group Info*\n${SUB}\n║  📛 Name: ${m.subject}\n║  👥 Members: ${m.participants.length}\n║  🛡️ Admins: ${admins}\n║  📅 Created: ${new Date(m.creation * 1000).toLocaleDateString()}\n${DIV}`
  });
}

// ============================================================================
// GROUP — LINK
// ============================================================================
async function cmdLink({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const code = await sock.groupInviteCode(jid);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🔗 https://chat.whatsapp.com/${code}` });
}

// ============================================================================
// GROUP — SET NAME
// ============================================================================
async function cmdSetName({ args, sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const name = args.join(' ');
  if (!name) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: setname <name>` });
  }
  await sock.groupUpdateSubject(jid, name);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Group name updated' });
}

// ============================================================================
// GROUP — SET DESCRIPTION
// ============================================================================
async function cmdSetDesc({ args, sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const desc = args.join(' ');
  if (!desc) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: setdesc <text>` });
  }
  await sock.groupUpdateDescription(jid, desc);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Description updated' });
}

// ============================================================================
// GROUP — SET GROUP PROFILE PICTURE
// ============================================================================
async function cmdSetGcPp({ msg, sock, jid, fromMe, state }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const quoted = getQuotedMessage(msg);
  if (!quoted?.imageMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to an image with setgcpp` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const { buffer } = await downloadQuotedMedia(msg, jid, state, sock);
    await sock.updateProfilePicture(jid, buffer);
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: '✅ Group picture updated' });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// GROUP — ADMINS LIST
// ============================================================================
async function cmdAdmins({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const m = await sock.groupMetadata(jid);
  const admins = m.participants.filter(p => p.admin);
  const list = admins.map(a => `@${a.id.split('@')[0].split(':')[0]}`).join('\n');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🛡️ *Admins (${admins.length}):*\n${list}`, mentions: admins.map(a => a.id) });
}

// ============================================================================
// GROUP — WHOIS
// ============================================================================
async function cmdWhois({ msg, sock, jid, fromMe }) {
  if (!fromMe) return;
  const ctxInfo = getContextInfo(msg);
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `👤 *User Info*\nJID: ${target}\nNumber: ${target.split('@')[0].split(':')[0]}` });
}

// ============================================================================
// GROUP — REVOKE LINK
// ============================================================================
async function cmdRevoke({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const code = await sock.groupRevokeInvite(jid);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🔄 Link revoked. New: https://chat.whatsapp.com/${code}` });
}

// ============================================================================
// GROUP — WARN SYSTEM (in-memory)
// ============================================================================
const warnings = new Map();

async function cmdWarn({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = getContextInfo(msg);
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  const key = `${jid}:${target}`;
  const count = (warnings.get(key) || 0) + 1;
  warnings.set(key, count);
  await setReaction(sock, msg, '⚠️');
  await sock.sendMessage(jid, { text: `⚠️ @${target.split('@')[0]} warned (${count}/3)`, mentions: [target] });
  if (count >= 3) {
    try {
      await sock.groupParticipantsUpdate(jid, [target], 'remove');
      await sock.sendMessage(jid, { text: `🚫 Auto-kicked after 3 warnings` });
      warnings.delete(key);
    } catch (e) { /* ignore */ }
  }
}

// ============================================================================
// GROUP — LIST WARNINGS
// ============================================================================
async function cmdWarnings({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = getContextInfo(msg);
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  const count = warnings.get(`${jid}:${target}`) || 0;
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `📊 @${target.split('@')[0]}: ${count} warning(s)`, mentions: [target] });
}

// ============================================================================
// GROUP — RESET WARNINGS
// ============================================================================
async function cmdResetWarn({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = getContextInfo(msg);
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  warnings.delete(`${jid}:${target}`);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✅ Warnings reset for @${target.split('@')[0]}`, mentions: [target] });
}

// ============================================================================
// OWNER — SET BANNER
// ============================================================================
async function cmdSetBanner({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const quoted = getQuotedMessage(msg);
  const args = msg.message?.extendedTextMessage?.text?.split(/\s+/).slice(1) || [];
  const urlArg = args[0];

  if (urlArg && urlArg.startsWith('http')) {
    state.bannerUrl = urlArg;
    persistConfig();
    await setReaction(sock, msg, '✅');
    return sock.sendMessage(jid, { text: `✅ Banner URL set:\n${urlArg}` });
  }

  if (!quoted?.imageMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, {
      text: `↩️ Reply to an image with ${state.prefix}setbanner\nOR send ${state.prefix}setbanner <image-url>`
    });
  }

  if (!IMGBB_API_KEY) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, { text: '⚠️ IMGBB_API_KEY required for banner uploads' });
  }

  await setReaction(sock, msg, '⏳');
  try {
    const { buffer } = await downloadQuotedMedia(msg, jid, state, sock);
    const url = await uploadToImgBB(buffer, 'banner.jpg');
    state.bannerUrl = url;
    persistConfig();
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: `✅ Banner uploaded:\n${url}` });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// OWNER — SET PREFIX (alias)
// ============================================================================
async function cmdSetPrefix({ args, sock, jid, fromMe, state, msg }) {
  return cmdPrefix({ args, sock, jid, fromMe, state, msg });
}

// ============================================================================
// OWNER — SET BOT NAME
// ============================================================================
async function cmdSetBotName({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const name = args.join(' ');
  if (!name) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: setbotname <name>` });
  }
  state.botName = name; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✅ Bot name: *${name}*` });
}

// ============================================================================
// OWNER — BROADCAST
// ============================================================================
async function cmdBroadcast({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const text = args.join(' ');
  if (!text) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: broadcast <message>` });
  }
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `📢 Broadcast queued: ${text}` });
}

// ============================================================================
// OWNER — BLOCK
// ============================================================================
async function cmdBlock({ msg, sock, jid, fromMe }) {
  if (!fromMe) return;
  const ctxInfo = getContextInfo(msg);
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await sock.updateBlockStatus(target, 'block');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🚫 Blocked @${target.split('@')[0]}`, mentions: [target] });
}

// ============================================================================
// OWNER — UNBLOCK
// ============================================================================
async function cmdUnblock({ msg, sock, jid, fromMe }) {
  if (!fromMe) return;
  const ctxInfo = getContextInfo(msg);
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await sock.updateBlockStatus(target, 'unblock');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✅ Unblocked @${target.split('@')[0]}`, mentions: [target] });
}

// ============================================================================
// SYSTEM — CLEAR TEMP
// ============================================================================
async function cmdClearTemp({ sock, jid, fromMe, msg }) {
  if (!fromMe) return;
  messageStore.clear();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🗑️ Message cache cleared` });
}

// ============================================================================
// SYSTEM — RESTART
// ============================================================================
async function cmdRestart({ sock, jid, fromMe, msg }) {
  if (!fromMe) return;
  await setReaction(sock, msg, '🔄');
  await sock.sendMessage(jid, { text: '🔄 Restarting...' });
  process.exit(0);
}

// ============================================================================
// SYSTEM — LOGOUT
// ============================================================================
async function cmdLogout({ sock, jid, fromMe, msg }) {
  if (!fromMe) return;
  await setReaction(sock, msg, '🚪');
  await sock.sendMessage(jid, { text: '🚪 Logging out...' });
  await sock.logout();
  process.exit(0);
}

// ============================================================================
// EXPORTS
// ============================================================================
export { sendTyping, sendRecording, sendOnline, buildMenu };