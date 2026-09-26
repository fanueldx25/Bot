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

const SESSION_DIR = path.join(__dirname, 'sessions', 'auth');

let sock = null;
let callbacks = {};

async function startBot(phoneNumber, cbs) {
  callbacks = cbs;
  
  // Clear any existing session dir (fresh pairing)
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
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
  
  // Request pairing code if not registered
  if (!sock.authState.creds.registered) {
    // Wait a beat to ensure socket is ready
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('[Bot] Pairing code:', code);
        callbacks.onPairingCode?.(code);
      } catch (err) {
        console.error('[Bot] Failed to get pairing code:', err);
      }
    }, 3000);
  }
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'open') {
      console.log('[Bot] Connected!');
      callbacks.onConnected?.();
    }
    
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[Bot] Connection closed. Code:', code, 'Reconnect:', shouldReconnect);
      
      if (shouldReconnect) {
        setTimeout(() => startBot(phoneNumber, callbacks), 3000);
      } else {
        callbacks.onDisconnected?.('logged_out');
      }
    }
  });
  
  // ===== HANDLE MESSAGES =====
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
      
      // Simple echo bot — customize this!
      if (text.toLowerCase() === 'ping') {
        await sock.sendMessage(from, { text: 'pong 🏓' });
      } else if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello') {
        await sock.sendMessage(from, { text: 'Hey there! 👋 I am a bot.' });
      } else if (text) {
        await sock.sendMessage(from, { text: `You said: ${text}` });
      }
    }
  });
}

function stopBot() {
  try {
    if (sock) {
      sock.end(undefined);
      sock = null;
    }
  } catch (e) {}
}

module.exports = { startBot, stopBot };