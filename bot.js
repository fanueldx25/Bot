const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'auth')
  : path.join(__dirname, 'sessions', 'auth');

const PAUSED_FILE = process.env.SESSION_DIR
  ? path.join(process.env.SESSION_DIR, 'paused.json')
  : path.join(__dirname, 'sessions', 'paused.json');

let sock = null;
let callbacks = {};
let currentNumber = null;
let isStopping = false;
let hasRequestedCode = false;

// ===== PAUSE STATE =====
// pausedChats = Set of JIDs that are paused. 'ALL' pauses every chat.
let pausedChats = new Set();

function loadPaused() {
  try {
    if (fs.existsSync(PAUSED_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAUSED_FILE, 'utf8'));
      pausedChats = new Set(data);
    }
  } catch (e) {
    console.error('[Pause] Load error:', e.message);
  }
}

function savePaused() {
  try {
    fs.mkdirSync(path.dirname(PAUSED_FILE), { recursive: true });
    fs.writeFileSync(PAUSED_FILE, JSON.stringify([...pausedChats]), 'utf8');
  } catch (e) {
    console.error('[Pause] Save error:', e.message);
  }
}

function isPaused(jid) {
  return pausedChats.has('ALL') || pausedChats.has(jid);
}

// ===== TYPING INDICATOR HELPER =====
async function withTyping(jid, fn) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await fn();
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch (e) {}
  }
}

// ===== COMMAND HANDLER =====
async function handleCommand(msg, from, sender, text) {
  const isGroup = from.endsWith('@g.us');
  const cmd = text.trim().toLowerCase();

  // ---- .help ----
  if (cmd === '.help' || cmd === '.menu') {
    const help = `🤖 *Bot Commands*

📌 *General*
.help — Show this menu
.ping — Check if bot is alive
.sticker — Reply to an image/video with .sticker to convert it

⏸️ *Pause Control*
.pause — Silence bot in this chat
.resume — Unpause bot in this chat
.pause all — Silence bot everywhere
.resume all — Unpause everywhere
.pausestatus — Check current pause status

👋 *Group*
(welcome messages are automatic for new members)`;
    await withTyping(from, () => sock.sendMessage(from, { text: help }));
    return;
  }

  // ---- .ping ----
  if (cmd === '.ping') {
    await withTyping(from, () => sock.sendMessage(from, { text: '🏓 pong!' }));
    return;
  }

  // ---- .pause / .resume ----
  if (cmd === '.pause' || cmd === '.resume') {
    const isPause = cmd === '.pause';

    if (isPause) {
      pausedChats.add(from);
      savePaused();
      await withTyping(from, () =>
        sock.sendMessage(from, { text: '⏸️ Bot paused in this chat. Send *.resume* to wake me up.' })
      );
    } else {
      pausedChats.delete(from);
      savePaused();
      await withTyping(from, () =>
        sock.sendMessage(from, { text: '▶️ Bot resumed in this chat.' })
      );
    }
    return;
  }

  // ---- .pause all / .resume all ----
  if (cmd === '.pause all') {
    pausedChats.add('ALL');
    savePaused();
    await withTyping(from, () =>
      sock.sendMessage(from, { text: '⏸️ Bot paused *everywhere*. Send *.resume all* to wake up.' })
    );
    return;
  }
  if (cmd === '.resume all') {
    pausedChats.delete('ALL');
    savePaused();
    await withTyping(from, () =>
      sock.sendMessage(from, { text: '▶️ Bot resumed everywhere.' })
    );
    return;
  }

  // ---- .pausestatus ----
  if (cmd === '.pausestatus') {
    const globalPaused = pausedChats.has('ALL');
    const localPaused = pausedChats.has(from);
    const status = globalPaused
      ? '🌍 Global pause is ON (all chats silenced)'
      : localPaused
      ? '⏸️ This chat is paused'
      : '▶️ This chat is active';
    await withTyping(from, () => sock.sendMessage(from, { text: status }));
    return;
  }

  // ---- .sticker ----
  if (cmd === '.sticker' || cmd === '.s') {
    const quoted =
      msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

    if (!quoted) {
      await withTyping(from, () =>
        sock.sendMessage(from, { text: '❌ Reply to an *image* or *short video* with .sticker' })
      );
      return;
    }

    const imageMsg = quoted.imageMessage;
    const videoMsg = quoted.videoMessage;

    if (!imageMsg && !videoMsg) {
      await withTyping(from, () =>
        sock.sendMessage(from, { text: '❌ The quoted message must be an image or video.' })
      );
      return;
    }

    try {
      await withTyping(from, async () => {
        // Build a fake message object so downloadMediaMessage can read it
        const mediaType = imageMsg ? 'imageMessage' : 'videoMessage';
        const mediaContent = imageMsg || videoMsg;

        const fakeMsg = {
          key: {
            remoteJid: from,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            fromMe: false
          },
          message: { [mediaType]: mediaContent }
        };

        const buffer = await downloadMediaMessage(
          fakeMsg,
          'buffer',
          {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        );

        await sock.sendMessage(from, { sticker: buffer });
      });
    } catch (err) {
      console.error('[Sticker] Error:', err.message);
      await sock.sendMessage(from, { text: '❌ Failed to create sticker. Try a smaller file.' });
    }
    return;
  }
}

// ===== WELCOME MESSAGE =====
async function sendWelcome(groupJid, participants) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const text = `👋 Welcome to *${groupName}*, @${num}!

Glad to have you here. Type *.help* to see what I can do.`;

      await sock.sendMessage(groupJid, {
        text,
        mentions: [jid]
      });
    }
  } catch (e) {
    console.error('[Welcome] Error:', e.message);
  }
}

// ===== MAIN BOT =====
async function startBot(phoneNumber, cbs) {
  callbacks = cbs || {};
  currentNumber = phoneNumber;
  isStopping = false;
  hasRequestedCode = false;

  loadPaused();
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
    // Ensure we receive read receipts and presence updates
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  // ===== CONNECTION UPDATE (fixed pairing code logic) =====
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
      hasRequestedCode = true;
      console.log('[Bot] Socket ready. Requesting pairing code...');
      try {
        await new Promise((r) => setTimeout(r, 500));
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('[Bot] Pairing code:', code);
        callbacks.onPairingCode?.(code);
      } catch (err) {
        console.error('[Bot] Pairing code error:', err.message);
        hasRequestedCode = false;
      }
    }

    if (connection === 'open') {
      console.log('[Bot] Connected!');
      callbacks.onConnected?.();
    }

    if (connection === 'close') {
      if (isStopping) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[Bot] Closed. Code:', code, 'Reconnect:', shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => startBot(currentNumber, callbacks), 3000);
      } else {
        callbacks.onDisconnected?.('logged_out');
      }
    }
  });

  // ===== BLUE TICKS: mark every incoming message as read =====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      if (!from) continue;

      // Read receipt (blue ticks)
      try {
        await sock.readMessages([msg.key]);
      } catch (e) {}

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      console.log(`[Message] ${from}: ${text}`);

      // ----- Handle commands even when paused (so .resume works) -----
      if (text.startsWith('.')) {
        try {
          await handleCommand(msg, from, msg.key.participant || from, text);
        } catch (e) {
          console.error('[Command] Error:', e.message);
        }
        continue;
      }

      // ----- Skip normal replies if this chat is paused -----
      if (isPaused(from)) {
        console.log('[Pause] Skipped reply in paused chat:', from);
        continue;
      }

      // ----- Default replies -----
      try {
        if (text.toLowerCase() === 'ping') {
          await withTyping(from, () => sock.sendMessage(from, { text: 'pong 🏓' }));
        } else if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello') {
          await withTyping(from, () =>
            sock.sendMessage(from, { text: 'Hey there! 👋 Type *.help* to see commands.' })
          );
        } else if (text) {
          await withTyping(from, () =>
            sock.sendMessage(from, { text: `You said: ${text}` })
          );
        }
      } catch (e) {
        console.error('[Bot] Send error:', e.message);
      }
    }
  });

  // ===== WELCOME NEW GROUP MEMBERS =====
  sock.ev.on('group-participants.update', async (event) => {
    try {
      const { id, participants, action } = event;
      if (action === 'add' && participants && participants.length) {
        await sendWelcome(id, participants);
      }
    } catch (e) {
      console.error('[Group] Welcome error:', e.message);
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