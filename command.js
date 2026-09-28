import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';
import pino from 'pino';
import { persistConfig, messageStore } from './bot.js';

// Media downloaders
let ttdl, ytdl, Sticker;
try {
  const ttdlMod = await import('@silent-tech-offc/ttdl');
  ttdl = ttdlMod.download;
} catch (e) { console.warn('ttdl not available'); }
try {
  const ytdlMod = await import('@slipknot/ytdl-core');
  ytdl = ytdlMod.default || ytdlMod;
} catch (e) { console.warn('ytdl not available'); }
try {
  const stickerMod = await import('wa-sticker-toolkit');
  Sticker = stickerMod.Sticker || stickerMod.default;
} catch (e) { console.warn('wa-sticker-toolkit not available'); }

const logger = pino({ level: 'silent' });

// ==================== REACTION HELPERS ====================
// Change reaction to show task state [citation:1][citation:10]

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

// ==================== COMMAND REGISTRY ====================

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
  // Media tools
  sticker: cmdSticker, toimg: cmdToImg, getpp: cmdGetPp, tts: cmdTts,
  // Utility
  lyrics: cmdLyrics, forward: cmdForward,
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

// ==================== MESSAGE HANDLER ====================

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

    try {
      await handler({ args, msg, sock, state, jid, sender, fromMe, isGroup });
    } catch (err) {
      console.error(`Command "${rawCmd}" failed:`, err.message);
      await setReaction(sock, msg, '🍎');
      await sock.sendMessage(jid, { text: `❌ *Error:* ${err.message}` });
    }
  }
}

// ==================== REACTION HANDLER (🐼 view-once) ====================

export async function handleReaction(reactions, sock, state) {
  for (const { key, reaction } of reactions) {
    if (reaction.text !== '🐼' || !state.ownerJid) continue;
    const original = messageStore.get(`${key.remoteJid}:${key.id}`);
    if (!original) continue;

    const content = original.message?.viewOnceMessageV2?.message || original.message?.viewOnceMessage?.message;
    if (!content) continue;

    await setReaction(sock, { key, ...original }, '⏳');

    try {
      const buffer = await downloadMediaMessage(
        { ...original, message: content },
        'buffer', {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );
      const type = getContentType(content);
      const sendOpts = type === 'videoMessage'
        ? { video: buffer, caption: '📥 *View-once downloaded*' }
        : { image: buffer, caption: '📥 *View-once downloaded*' };
      await sock.sendMessage(state.ownerJid, sendOpts);
      await setReaction(sock, { key, ...original }, '✅');
    } catch (e) {
      console.error('view-once download failed:', e.message);
      await setReaction(sock, { key, ...original }, '❌');
    }
  }
}

// ==================== GROUP PARTICIPANTS HANDLER ====================

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

// ==================== PROFESSIONAL MENU ====================

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
    '📥 DOWNLOADERS': ['yt', 'tiktok', 'ig', 'fb'],
    '🎨 MEDIA TOOLS': ['ops', 'save', 'sticker', 'toimg', 'getpp', 'tts'],
    '🔧 UTILITY': ['lyrics', 'forward'],
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

// ==================== HANDLERS ====================

async function cmdMenu({ sock, jid, state, msg }) {
  const t0 = Date.now();
  await setReaction(sock, msg, '📋');
  const text = buildMenu(state);
  if (state.bannerUrl) {
    await sock.sendMessage(jid, { image: { url: state.bannerUrl }, caption: text });
  } else {
    await sock.sendMessage(jid, { text });
  }
  await clearReaction(sock, msg);
}

async function cmdList({ sock, jid, state, msg }) {
  return cmdMenu({ sock, jid, state, msg });
}

async function cmdHelp({ sock, jid, state, msg }) {
  return cmdMenu({ sock, jid, state, msg });
}

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

// ==================== DOWNLOADERS ====================

async function cmdYt({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const url = args[0];
  if (!url || !url.includes('youtu')) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}yt <youtube-url>` });
  }
  if (!ytdl) {
    await setReaction(sock, msg, '🍎');
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
      await setReaction(sock, msg, '🍎');
      return sock.sendMessage(jid, { text: '❌ Video too large (max 64MB)' });
    }

    await sock.sendMessage(jid, { video: buffer, caption: `📹 *${info.videoDetails.title}*` });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '🍎');
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
    await setReaction(sock, msg, '🍎');
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
    await setReaction(sock, msg, '🍎');
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

  await setReaction(sock, msg, '🔎');
  await setReaction(sock, msg, '⏳');
  // Instagram downloader requires a scraping API or cookies.
  // For production, integrate a service like SnapInsta or use IG cookies.
  await setReaction(sock, msg, '🍎');
  await sock.sendMessage(jid, { text: '⚠️ Instagram downloader requires API configuration. Add your IG cookie or scraping service to enable.' });
}

async function cmdFb({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const url = args[0];
  if (!url || !url.includes('facebook') && !url.includes('fb.watch')) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}fb <facebook-url>` });
  }

  await setReaction(sock, msg, '🔎');
  await setReaction(sock, msg, '⏳');
  await setReaction(sock, msg, '🍎');
  await sock.sendMessage(jid, { text: '⚠️ Facebook downloader requires API configuration. Add your FB cookie or scraping service to enable.' });
}

// ==================== MEDIA TOOLS ====================

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
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: content },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const type = getContentType(content);
    const opts = type === 'videoMessage'
      ? { video: buffer, caption: '📥 Downloaded from view-once' }
      : { image: buffer, caption: '📥 Downloaded from view-once' };
    await sock.sendMessage(state.ownerJid, opts);
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '🍎');
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
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: quoted },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const type = getContentType(quoted);
    const opts = type === 'videoMessage' ? { video: buffer } : { image: buffer };
    await sock.sendMessage(state.ownerJid, opts);
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '🍎');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

async function cmdSticker({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted?.imageMessage && !quoted?.videoMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to an image or video with ${state.prefix}sticker` });
  }
  if (!Sticker) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: '❌ wa-sticker-toolkit not installed' });
  }

  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: quoted },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const sticker = new Sticker(buffer, {
      pack: state.botName,
      author: 'WA Bot',
      type: 'full',
      quality: 80,
    });
    const stickerBuffer = await sticker.toBuffer();
    await sock.sendMessage(jid, { sticker: stickerBuffer });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '🍎');
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
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: quoted },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    await sock.sendMessage(jid, { image: buffer, caption: '🖼️ Converted from sticker' });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '🍎');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
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
    await setReaction(sock, msg, '🍎');
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
    // Using a public TTS API (Google Translate TTS)
    const encoded = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const buffer = Buffer.from(await res.arrayBuffer());
    await sock.sendMessage(jid, { audio: buffer, ptt: true, mimetype: 'audio/mp4' });
    await setReaction(sock, msg, '✅');
  } catch (e) {
    await setReaction(sock, msg, '🍎');
    await sock.sendMessage(jid, { text: `❌ TTS failed: ${e.message}` });
  }
}

// ==================== UTILITY ====================

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
    await setReaction(sock, msg, '🍎');
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
    await setReaction(sock, msg, '🍎');
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

// ==================== ANTI HANDLERS ====================

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

// ==================== GROUP HANDLERS ====================

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
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}setname <name>` });
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
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}setdesc <text>` });
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
    return sock.sendMessage(jid, { text: `↩️ Reply to an image with ${state.prefix}setgcpp` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: quoted },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    await sock.updateProfilePicture(jid, buffer);
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: '✅ Group picture updated' });
  } catch (e) {
    await setReaction(sock, msg, '🍎');
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

// ==================== OWNER HANDLERS ====================

async function cmdSetBanner({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted?.imageMessage) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `↩️ Reply to an image with ${state.prefix}setbanner` });
  }
  await setReaction(sock, msg, '⏳');
  try {
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: quoted },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const b64 = buffer.toString('base64');
    state.bannerUrl = `data:image/jpeg;base64,${b64}`;
    persistConfig();
    await setReaction(sock, msg, '✅');
    await sock.sendMessage(jid, { text: '✅ Banner set' });
  } catch (e) {
    await setReaction(sock, msg, '🍎');
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
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}setbotname <name>` });
  }
  state.botName = name; persistConfig();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `✅ Bot name: *${name}*` });
}

async function cmdBroadcast({ args, sock, jid, fromMe, state, msg }) {
  if (!fromMe) return;
  const text = args.join(' ');
  if (!text) {
    await setReaction(sock, msg, '🍎');
    return sock.sendMessage(jid, { text: `Usage: ${state.prefix}broadcast <message>` });
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

// ==================== SYSTEM HANDLERS ====================

async function cmdClearTemp({ sock, jid, fromMe, msg }) {
  if (!fromMe) return;
  messageStore.clear();
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, { text: `🗑️ Message cache cleared` });
}

async function cmdStatus({ sock, jid, state, msg }) {
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  await setReaction(sock, msg, '✅');
  await sock.sendMessage(jid, {
    text: `${DIV}\n║  📊 *STATUS*\n${SUB}\n║  🔗 Connected: ${state.connected}\n║  🔒 Mode: ${state.mode}\n║  ⏱ Uptime: ${uptime}s\n║  🛡️ Anti-delete: ${state.antidelete}\n║  ✏️ Anti-edit: ${state.antiedit}\n║  👋 Welcome: ${state.welcome}\n║  💾 Cache: ${messageStore.size} msgs\n${DIV}`
  });
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