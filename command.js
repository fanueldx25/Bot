import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { persistConfig, messageStore, scheduleAutoDelete } from './bot.js';
// ============================================================================
// OPTIONAL MODULE IMPORTS
// ============================================================================
let ttdl, ytdl, Sticker, sharp;
try {
  const ttdlMod = await import('@silent-tech-offc/ttdl');
  ttdl = ttdlMod.download;
} catch (e) { console.warn('ttdl not available'); }
try {
  const ytdlMod = await import('@slipknot/ytdl-core');
  ytdl = ytdlMod.default || ytdlMod;
} catch (e) { console.warn('ytdl not available'); }
try {
  const stickerMod = await import('wa-sticker-kit');
  Sticker = stickerMod.Sticker || stickerMod.default?.Sticker || stickerMod.default;
} catch (e) { console.warn('wa-sticker-kit not available'); }
try {
  sharp = (await import('sharp')).default;
} catch (e) { console.warn('sharp not available'); }

// ============================================================================
// CONFIG
// ============================================================================
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || ''; // openweathermap.org
const HARDCODED_BANNER = process.env.DEFAULT_BANNER_URL || '';

const logger = pino({ level: 'silent' });

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
// AUTO-DELETE HELPER (for "capture messages disappear after 1 hour")
// ============================================================================
const autoDeleteTimers = new Map();

function scheduleAutoDelete(sock, chatJid, messageKey, delayMs = 60 * 60 * 1000) {
  const id = `${chatJid}:${messageKey.id}`;
  if (autoDeleteTimers.has(id)) clearTimeout(autoDeleteTimers.get(id));
  const timer = setTimeout(async () => {
    try {
      await sock.sendMessage(chatJid, { delete: messageKey });
    } catch (_) {}
    autoDeleteTimers.delete(id);
  }, delayMs);
  autoDeleteTimers.set(id, timer);
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
// COMMAND REGISTRY
// ============================================================================
const commands = {
  // Info
  menu: cmdMenu,
  list: cmdList,
  ping: cmdPing,
  owner: cmdOwner,
  uptime: cmdUptime,
  speed: cmdSpeed,
  status: cmdStatus,
  help: cmdHelp,
  // Access
  mode: cmdMode,
  prefix: cmdPrefix,
  token: cmdToken,
  // Media / view-once
  ops: cmdOps,
  save: cmdSaveMedia,
  // Downloaders
  yt: cmdYt,
  tiktok: cmdTiktok,
  ig: cmdIg,
  fb: cmdFb,
  play: cmdPlay,
  song: cmdSong,
  music: cmdPlay,
  // Media tools
  sticker: cmdSticker,
  toimg: cmdToImg,
  getpp: cmdGetPp,
  tts: cmdTts,
  tourl: cmdToUrl,
  img2url: cmdToUrl,
  url: cmdToUrl,
  // Utility
  lyrics: cmdLyrics,
  forward: cmdForward,
  weather: cmdWeather,
  w: cmdWeather,
  currency: cmdCurrency,
  convert: cmdCurrency,
  forex: cmdCurrency,
  google: cmdGoogle,
  search: cmdGoogle,
  g: cmdGoogle,
  calc: cmdCalc,
  qr: cmdQr,
  // Anti
  antidelete: cmdAntiDelete,
  antiedit: cmdAntiEdit,
  history: cmdHistory,
  lastdeleted: cmdLastDeleted,
  // Group
  welcome: cmdWelcome,
  setwelcome: cmdSetWelcome,
  goodbye: cmdGoodbye,
  setgoodbye: cmdSetGoodbye,
  kick: cmdKick,
  add: cmdAdd,
  promote: cmdPromote,
  demote: cmdDemote,
  mute: cmdMute,
  unmute: cmdUnmute,
  tagall: cmdTagAll,
  tag: cmdTagAll,
  ginfo: cmdGroupInfo,
  groupinfo: cmdGroupInfo,
  grouplink: cmdLink,
  link: cmdLink,
  setname: cmdSetName,
  setdesc: cmdSetDesc,
  setgcpp: cmdSetGcPp,
  admins: cmdAdmins,
  whois: cmdWhois,
  revoke: cmdRevoke,
  warn: cmdWarn,
  warnings: cmdWarnings,
  resetwarn: cmdResetWarn,
  // Owner
  setbanner: cmdSetBanner,
  setprefix: cmdSetPrefix,
  setbotname: cmdSetBotName,
  broadcast: cmdBroadcast,
  block: cmdBlock,
  unblock: cmdUnblock,
  // System
  restart: cmdRestart,
  logout: cmdLogout,
  cleartemp: cmdClearTemp,
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
    
    if (state.mode === 'private' && !fromMe && sender !== state.ownerJid) continue;
    
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption || '';
    
    if (!text.startsWith(state.prefix)) continue;
    const [rawCmd, ...args] = text.slice(state.prefix.length).trim().split(/\s+/);
    const handler = commands[rawCmd.toLowerCase()];
    if (!handler) continue;
    
    // Human-like: mark message as read, show online
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
    
    const content = original.message?.viewOnceMessageV2?.message || original.message?.viewOnceMessage?.message;
    if (!content) continue;
    
    await setReaction(sock, { key, ...original }, '⏳');
    
    try {
      const buffer = await downloadMediaMessage({ ...original, message: content },
        'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
      );
      const type = getContentType(content);
      const sendOpts = type === 'videoMessage' ? { video: buffer, caption: '📥 *View-once downloaded* (auto-deletes in 1h)' } : { image: buffer, caption: '📥 *View-once downloaded* (auto-deletes in 1h)' };
      const sent = await sock.sendMessage(state.ownerJid, sendOpts);
      await setReaction(sock, { key, ...original }, '✅');
      
      // Auto-delete after 1 hour
      if (sent?.key) {
        scheduleAutoDelete(sock, state.ownerJid, sent.key, 60 * 60 * 1000);
      }
    } catch (e) {
      console.error('view-once download failed:', e.message);
      await setReaction(sock, { key, ...original }, '❌');
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
  const h = Math.floor(uptime / 3600),
    m = Math.floor((uptime % 3600) / 60);
  
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
    '🎨 MEDIA TOOLS': ['ops', 'save', 'sticker', 'toimg', 'getpp', 'tts', 'tourl'],
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
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
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
  state.mode = next;
  persistConfig();
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
  state.prefix = p;
  persistConfig();
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
// 🌤️ WEATHER — gives detailed output
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
    // Current weather
    const wRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=metric`);
    const w = await wRes.json();
    if (w.cod !== 200) throw new Error(w.message || 'City not found');
    
    // Forecast (5-day / 3-hour)
    const fRes = await fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=metric&cnt=8`);
    const f = await fRes.json();
    
    const emojiMap = {
      Clear: '☀️',
      Clouds: '☁️',
      Rain: '🌧️',
      Drizzle: '🌦️',
      Thunderstorm: '⛈️',
      Snow: '❄️',
      Mist: '🌫️',
      Fog: '🌫️',
      Haze: '🌫️'
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
    
    // Send with map if coordinates available
    const mapUrl = `https://tile.openweathermap.org/map/temp_new/5/${Math.floor((w.coord.lon + 180) / 360 * Math.pow(2, 5))}/${Math.floor((1 - Math.log(Math.tan(w.coord.lat * Math.PI / 180) + 1 / Math.cos(w.coord.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, 5))}.png?appid=${WEATHER_API_KEY}`;
    
    try {
      await sock.sendMessage(jid, { image: { url: mapUrl }, caption: text });
    } catch (_) {
      await sock.sendMessage(jid, { text });
    }
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Weather error: ${e.message}` });
  }
}

// ============================================================================
// 💱 CURRENCY CALCULATOR
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
    // Use DuckDuckGo Instant Answer API (free, no key needed)
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
      const topics = data.RelatedTopics.slice(0, 5);
      for (const t of topics) {
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
  
  // Safe-ish evaluation — only allow numbers and operators
  if (!/^[\d\s+\-*/().,%^]+$/.test(expr)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: '❌ Only numbers and + - * / ( ) % ^ allowed' });
  }
  
  try {
    // Replace ^ with ** for JS
    const safe = expr.replace(/\^/g, '**');
    // eslint-disable-next-line no-new-func
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
// 📱 QR CODE GENERATOR
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
// 🎵 MUSIC — search & download
// ============================================================================
async function cmdPlay({ args, sock, jid, state, msg }) {
  const query = args.join(' ');
  if (!query) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}play <song name>\nExample: ${state.prefix}play Shape of You` });
  }
  
  await setReaction(sock, msg, '🔎');
  await sendRecording(sock, jid, 1500);
  
  try {
    // Search via YouTube (ytdl)
    if (!ytdl) {
      await setReaction(sock, msg, '❌');
      return sock.sendMessage(jid, { text: '❌ YouTube downloader not installed' });
    }
    
    // Use yt-search style via ytdl (search)
    const searchUrl = `ytsearch:${query}`;
    let info;
    try {
      info = await ytdl.getInfo(searchUrl);
    } catch (e) {
      // Fallback: search via YouTube search page
      const searchRes = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
      const html = await searchRes.text();
      const match = html.match(/"videoId":"([^"]+)"/);
      if (!match) throw new Error('No results');
      info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${match[1]}`);
    }
    
    const video = info.videoDetails;
    await sock.sendMessage(jid, {
      text: `${DIV}\n║  🎵 *Found:* ${video.title}\n║  ⏱ ${Math.floor(video.lengthSeconds / 60)}:${String(video.lengthSeconds % 60).padStart(2, '0')}\n║  👤 ${video.author.name}\n║  ⏳ Downloading audio...\n${DIV}`
    });
    
    // Download audio only
    const stream = ytdl(video.videoId, { quality: 'highestaudio', filter: 'audioonly' });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    
    if (buffer.length > 16 * 1024 * 1024) {
      await setReaction(sock, msg, '❌');
      return sock.sendMessage(jid, { text: '❌ Audio too large (max 16MB)' });
    }
    
    await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: 'audio/mp4',
      pttm: false,
      fileName: `${video.title}.mp4`,
      caption: `🎵 *${video.title}*`,
    });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Music error: ${e.message}` });
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
  if (!url || !url.includes('youtu')) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}yt <youtube-url>` });
  }
  if (!ytdl) {
    await setReaction(sock, msg, '❌');
    return sock.sendMessage(jid, { text: '❌ YouTube downloader not installed' });
  }
  
  await setReaction(sock, msg, '🔎');
  try {
    const info = await ytdl.getBasicInfo(url);
    await setReaction(sock, msg, '⏳');
    await sock.sendMessage(jid, { text: `${DIV}\n║  ⏳ *Processing YouTube video...*\n║  📹 ${info.videoDetails.title}\n║  ⏱ ${Math.floor(info.videoDetails.lengthSeconds / 60)}m ${info.videoDetails.lengthSeconds % 60}s\n${DIV}` });
    
    const stream = ytdl(url, { quality: 'highest', filter: 'audioandvideo' });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    
    if (buffer.length > 64 * 1024 * 1024) {
      await setReaction(sock, msg, '❌');
      return sock.sendMessage(jid, { text: '❌ Video too large (max 64MB)' });
    }
    
    await sock.sendMessage(jid, { video: buffer, caption: `📹 *${info.videoDetails.title}*` });
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
    const videoUrl = v.videoNoWatermark || v.video;
    const res = await fetch(videoUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    
    await sock.sendMessage(jid, { video: buffer, caption: `📹 *${v.title || 'TikTok video'}*\n👤 ${v.author || ''}` });
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
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to a view-once message with ${state.prefix}ops` });
  }
  const content = quoted.viewOnceMessageV2?.message || quoted.viewOnceMessage?.message || quoted;
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage({ key: msg.key, message: content },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const type = getContentType(content);
    const opts = type === 'videoMessage' ?
      { video: buffer, caption: '📥 Downloaded from view-once' } :
      { image: buffer, caption: '📥 Downloaded from view-once' };
    await sock.sendMessage(state.ownerJid, opts);
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` });
  }
}

async function cmdSaveMedia({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to media with ${state.prefix}save` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage({ key: msg.key, message: quoted },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const type = getContentType(quoted);
    const opts = type === 'videoMessage' ? { video: buffer } : { image: buffer };
    await sock.sendMessage(state.ownerJid, opts);
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// 🎨 IMAGE → STICKER (with sharp for quality)
// ============================================================================
async function cmdSticker({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted?.imageMessage && !quoted?.videoMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to an image or video with ${state.prefix}sticker` });
  }
  
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage({ key: msg.key, message: quoted },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
    
    let stickerBuffer;
    const isVideo = !!quoted.videoMessage;
    
    if (sharp && !isVideo) {
      // Resize to 512x512 with sharp (better quality)
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

async function cmdToImg({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted?.stickerMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to a sticker with ${state.prefix}toimg` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage({ key: msg.key, message: quoted },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
    await sock.sendMessage(jid, { image: buffer, caption: '🖼️ Converted from sticker' });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// 🖼️ IMAGE → URL (via ImgBB)
// ============================================================================
async function cmdToUrl({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
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
    const buffer = await downloadMediaMessage({ key: msg.key, message: quoted },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
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

async function cmdGetPp({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
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

async function cmdTts({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const text = args.join(' ');
  if (!text) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}tts <text>` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const buffer = Buffer.from(await res.arrayBuffer());
    await sock.sendMessage(jid, { audio: buffer, ptt: true, mimetype: 'audio/mp4' });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ TTS failed: ${e.message}` });
  }
}

// ============================================================================
// UTILITY
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

async function cmdForward({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to a message with ${state.prefix}forward <number>` });
  }
  const targetNum = msg.message?.extendedTextMessage?.text?.split(' ')[1];
  if (!targetNum) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}forward <number>` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const targetJid = `${targetNum.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(targetJid, { forward: { key: msg.key, message: quoted } });
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: '✅ Message forwarded' });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ============================================================================
// ANTI
// ============================================================================
async function cmdAntiDelete({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}antidelete on|off` });
  }
  state.antidelete = val === 'on';
  persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🛡️ Anti-delete: *${val.toUpperCase()}*` });
}

async function cmdAntiEdit({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}antiedit on|off` });
  }
  state.antiedit = val === 'on';
  persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✏️ Anti-edit: *${val.toUpperCase()}*` });
}

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

async function cmdLastDeleted({ sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  await setReaction(sock, msg, 'ℹ️');
  await sock.sendMessage(jid, { text: `Use ${state.prefix}history to view cached messages` });
}

// ============================================================================
// GROUP
// ============================================================================
async function cmdWelcome({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}welcome on|off` });
  }
  state.welcome = val === 'on';
  persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `👋 Welcome messages: *${val.toUpperCase()}*` });
}

async function cmdSetWelcome({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const txt = args.join(' ');
  if (!txt) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}setwelcome <text>\nPlaceholders: {user} {group}` });
  }
  state.welcomeText = txt;
  persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Welcome text updated' });
}

async function cmdGoodbye({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}goodbye on|off` });
  }
  state.goodbye = val === 'on';
  persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `👋 Goodbye messages: *${val.toUpperCase()}*` });
}

async function cmdSetGoodbye({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const txt = args.join(' ');
  if (!txt) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}setgoodbye <text>` });
  }
  state.goodbyeText = txt;
  persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Goodbye text updated' });
}

async function cmdKick({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
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

async function cmdAdd({ args, sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const num = args[0]?.replace(/\D/g, '');
  if (!num) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}add <number>` });
  }
  await sock.groupParticipantsUpdate(jid, [`${num}@s.whatsapp.net`], 'add');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '✅ Member added' });
}

async function cmdPromote({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const targets = ctxInfo?.mentionedJid?.length ? ctxInfo.mentionedJid : (ctxInfo?.participant ? [ctxInfo.participant] : []);
  if (!targets.length) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await sock.groupParticipantsUpdate(jid, targets, 'promote');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '🛡️ Member promoted' });
}

async function cmdDemote({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const targets = ctxInfo?.mentionedJid?.length ? ctxInfo.mentionedJid : (ctxInfo?.participant ? [ctxInfo.participant] : []);
  if (!targets.length) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await sock.groupParticipantsUpdate(jid, targets, 'demote');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '📉 Member demoted' });
}

async function cmdMute({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  await sock.groupSettingUpdate(jid, 'announcement');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '🔇 Group muted (admins only)' });
}

async function cmdUnmute({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  await sock.groupSettingUpdate(jid, 'not_announcement');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: '🔊 Group unmuted' });
}

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

async function cmdGroupInfo({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const m = await sock.groupMetadata(jid);
  const admins = m.participants.filter(p => p.admin).length;
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, {
    text: `${DIV}\n║  📊 *Group Info*\n${SUB}\n║  📛 Name: ${m.subject}\n║  👥 Members: ${m.participants.length}\n║  🛡️ Admins: ${admins}\n║  📅 Created: ${new Date(m.creation * 1000).toLocaleDateString()}\n${DIV}`
  });
}

async function cmdLink({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const code = await sock.groupInviteCode(jid);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🔗 https://chat.whatsapp.com/${code}` });
}

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

async function cmdSetGcPp({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted?.imageMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to an image with setgcpp` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage({ key: msg.key, message: quoted },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
    await sock.updateProfilePicture(jid, buffer);
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: '✅ Group picture updated' });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

async function cmdAdmins({ sock, jid, fromMe, msg }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const m = await sock.groupMetadata(jid);
  const admins = m.participants.filter(p => p.admin);
  const list = admins.map(a => `@${a.id.split('@')[0].split(':')[0]}`).join('\n');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🛡️ *Admins (${admins.length}):*\n${list}`, mentions: admins.map(a => a.id) });
}

async function cmdWhois({ msg, sock, jid, fromMe }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `👤 *User Info*\nJID: ${target}\nNumber: ${target.split('@')[0].split(':')[0]}` });
}

async function cmdRevoke({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const code = await sock.groupRevokeInvite(jid);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🔄 Link revoked. New: https://chat.whatsapp.com/${code}` });
}

const warnings = new Map();

async function cmdWarn({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
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

async function cmdWarnings({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  const count = warnings.get(`${jid}:${target}`) || 0;
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `📊 @${target.split('@')[0]}: ${count} warning(s)`, mentions: [target] });
}

async function cmdResetWarn({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
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
// OWNER
// ============================================================================
async function cmdSetBanner({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  
  // Support both image reply AND url argument
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
  
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage({ key: msg.key, message: quoted },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
    
    // If ImgBB is configured, upload there (persists across deploys)
    if (IMGBB_API_KEY) {
      const url = await uploadToImgBB(buffer, 'banner.jpg');
      state.bannerUrl = url;
      persistConfig();
      await setReaction(sock, msg, '✅');
      return sock.sendMessage(jid, { text: `✅ Banner uploaded:\n${url}` });
    }
    
    // Fallback: base64 data URI (won't survive restarts on Render)
    const b64 = buffer.toString('base64');
    state.bannerUrl = `data:image/jpeg;base64,${b64}`;
    persistConfig();
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: '✅ Banner set (in-memory only — set IMGBB_API_KEY for persistence)' });
  } catch (e) {
    await setReaction(sock, msg, '❌');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

async function cmdSetPrefix({ args, sock, jid, fromMe, state, msg }) {
  return cmdPrefix({ args, sock, jid, fromMe, state, msg });
}

async function cmdSetBotName({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const name = args.join(' ');
  if (!name) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: setbotname <name>` });
  }
  state.botName = name;
  persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✅ Bot name: *${name}*` });
}

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

async function cmdBlock({ msg, sock, jid, fromMe }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const target = ctxInfo?.mentionedJid?.[0] || ctxInfo?.participant;
  if (!target) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: 'Mention a user' });
  }
  await sock.updateBlockStatus(target, 'block');
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🚫 Blocked @${target.split('@')[0]}`, mentions: [target] });
}

async function cmdUnblock({ msg, sock, jid, fromMe }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
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
// SYSTEM
// ============================================================================
async function cmdClearTemp({ sock, jid, fromMe, msg }) {
  if (!fromMe) return;
  messageStore.clear();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🗑️ Message cache cleared` });
}

async function cmdRestart({ sock, jid, fromMe, msg }) {
  if (!fromMe) return;
  await setReaction(sock, msg, '🔄');
  await sock.sendMessage(jid, { text: '🔄 Restarting...' });
  process.exit(0);
}

async function cmdLogout({ sock, jid, fromMe, msg }) {
  if (!fromMe) return;
  await setReaction(sock, msg, '🚪');
  await sock.sendMessage(jid, { text: '🚪 Logging out...' });
  await sock.logout();
  process.exit(0);
}

// ============================================================================
// EXPORT for bot.js to schedule auto-delete
// ============================================================================
export { scheduleAutoDelete, sendTyping, sendRecording, sendOnline };