// bot.js

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Use env var if set (Render disk), else local folder
const SESSION_DIR = process.env.SESSION_DIR ?
  path.join(process.env.SESSION_DIR, 'auth') :
  path.join(__dirname, 'sessions', 'auth');

let sock = null;
let callbacks = {};
let currentNumber = null;
let isStopping = false;
let hasRequestedCode = false; // <-- ADDED: Lock to prevent spam

async function startBot(phoneNumber, cbs) {
  callbacks = cbs || {};
  currentNumber = phoneNumber;
  isStopping = false;
  hasRequestedCode = false; // <-- ADDED: Reset lock on new start
  
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
    generateHighQualityLinkPreview: true
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    // ===== THE FIX: Only request code when the socket is ready (qr event) =====
    // We use `qr` as the readiness trigger for pairing code mode.
    // The `hasRequestedCode` flag ensures we only do this ONCE per session start.
    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
      hasRequestedCode = true; // Lock it immediately
      console.log('[Bot] Socket is ready. Requesting pairing code...');
      try {
        // Add a tiny delay just to be safe (Baileys can be picky)
        await new Promise(r => setTimeout(r, 500));
        
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('[Bot] Pairing code:', code);
        callbacks.onPairingCode?.(code);
      } catch (err) {
        console.error('[Bot] Failed to get pairing code:', err.message);
        hasRequestedCode = false; // Allow retry if it truly failed
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
  
  // ===== MESSAGE HANDLER =====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const from = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';
      
      console.log(`[Message] ${from}: ${text}`);
      
      try {
        if (text.toLowerCase() === 'ping') {
          await sock.sendMessage(from, { text: 'pong 🏓' });
        } else if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello') {
          await sock.sendMessage(from, { text: 'Hey there! 👋 I am a bot.' });
        } else if (text) {
          await sock.sendMessage(from, { text: `You said: ${text}` });
        }
      } catch (e) {
        console.error('[Bot] Send error:', e.message);
      }
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