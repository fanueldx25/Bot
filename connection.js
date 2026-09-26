// ============================================================================
// connection.js — Baileys socket + pairing code + rich error reporting
// ============================================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');

const state = require('./state');
const handlers = require('./handlers');

const AUTH_DIR = './auth_info_baileys';
const logger = pino({ level: 'silent' });

// ---------- Friendly disconnect reasons ----------
const DISCONNECT_MESSAGES = {
  [DisconnectReason.loggedOut]: 'Session logged out. You must link again.',
  [DisconnectReason.connectionClosed]: 'Connection closed. Reconnecting...',
  [DisconnectReason.connectionLost]: 'Network lost. Reconnecting...',
  [DisconnectReason.connectionReplaced]: 'Another session opened with this number.',
  [DisconnectReason.timedOut]: 'Connection timed out.',
  [DisconnectReason.badSession]: 'Bad session file. Delete auth_info_baileys and retry.',
  [DisconnectReason.restartRequired]: 'Restart required. Reconnecting...',
  [DisconnectReason.multideviceMismatch]: 'Multi-device mismatch.',
  [DisconnectReason.forbidden]: 'Number forbidden by WhatsApp.',
  [DisconnectReason.unavailableService]: 'WhatsApp service unavailable.'
};

// ---------- Banner ----------
function loadBanner() {
  try {
    const p = path.join(__dirname, 'assets', 'banner.jpg');
    if (fs.existsSync(p)) {
      state.BANNER_BUFFER = fs.readFileSync(p);
      console.log('[Banner] loaded');
    }
  } catch (e) {
    console.error('[Banner]', e.message);
  }
}

// ---------- Validation ----------
function validateNumber(raw) {
  const clean = (raw || '').replace(/\D/g, '');
  if (!clean) return { ok: false, error: 'Please enter a phone number.' };
  if (clean.length < 10) return { ok: false, error: 'Number is too short. Include country code (no +).' };
  if (clean.length > 15) return { ok: false, error: 'Number is too long. Maximum 15 digits.' };
  if (/^0+$/.test(clean)) return { ok: false, error: 'Number cannot be all zeros.' };
  return { ok: true, clean };
}

// ---------- Start ----------
async function startBot(rawNumber) {
  // validate
  const v = validateNumber(rawNumber);
  if (!v.ok) {
    state.setState('error', { message: v.error });
    return { ok: false, error: v.error };
  }
  const phoneNumber = v.clean;
  
  // stop old socket
  if (state.sock) {
    try { state.sock.end(undefined); } catch (e) {}
    state.sock = null;
  }
  
  state.currentNumber = phoneNumber;
  state.pairingCode = null;
  state.setState('connecting', {
    number: phoneNumber,
    message: 'Opening secure channel with WhatsApp...'
  });
  
  let authState, version;
  try {
    ({ state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    ({ version } = await fetchLatestBaileysVersion());
    state._saveCreds = saveCreds; // stash for later
  } catch (e) {
    state.setState('error', { message: 'Failed to init auth: ' + e.message });
    return { ok: false, error: e.message };
  }
  
  let sock;
  try {
    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });
  } catch (e) {
    state.setState('error', { message: 'Socket creation failed: ' + e.message });
    return { ok: false, error: e.message };
  }
  
  state.sock = sock;
  sock.ev.on('creds.update', authState.saveCreds);
  
  // ---------- Pairing code request ----------
  if (!sock.authState.creds.registered) {
    state.setState('connecting', {
      number: phoneNumber,
      message: 'Requesting pairing code from WhatsApp...'
    });
    
    // retry up to 3 times — WhatsApp sometimes drops the first request
    let attempt = 0;
    const requestCode = async () => {
      attempt++;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        if (!code || typeof code !== 'string') throw new Error('Empty code returned');
        
        state.pairingCode = code;
        state.setState('code_ready', {
          number: phoneNumber,
          code,
          message: 'Enter this code in WhatsApp → Linked Devices'
        });
        console.log('📱 PAIRING CODE:', code);
        return true;
      } catch (err) {
        console.error(`[Pairing attempt ${attempt}]`, err.message);
        if (attempt < 3) {
          state.setState('connecting', {
            number: phoneNumber,
            message: `Code request failed, retrying (${attempt}/3)...`
          });
          await new Promise((r) => setTimeout(r, 2500));
          return requestCode();
        }
        state.setState('error', {
          message: 'Could not get pairing code: ' + err.message,
          hint: 'Make sure the number is correct, has country code, and is registered on WhatsApp.'
        });
        return false;
      }
    };
    
    // small delay — socket needs to be ready
    setTimeout(requestCode, 3500);
  }
  
  // ---------- Connection updates ----------
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, isNewLogin, qr } = update;
    
    if (qr) {
      // shouldn't happen (printQRInTerminal=false) but keep for safety
      console.log('[QR] received (ignored — using pairing code)');
    }
    
    if (connection === 'open') {
      state.botJid = sock.user.id;
      state.setState('connected', {
        number: sock.user.id.split(':')[0],
        name: sock.user.name || sock.user.verifiedName || '',
        message: 'Successfully linked!'
      });
      console.log('✅ Connected as', sock.user.id);
    }
    
    if (connection === 'connecting') {
      state.setState('connecting', {
        number: phoneNumber,
        message: isNewLogin ? 'Completing login...' : 'Handshaking...'
      });
    }
    
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DISCONNECT_MESSAGES[statusCode] || 'Unknown disconnect.';
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.forbidden;
      
      state.setState('disconnected', { code: statusCode, message: reason });
      
      if (shouldReconnect) {
        console.log('↻ Reconnecting in 3s...');
        setTimeout(() => startBot(state.currentNumber), 3000);
      } else {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
        state.sock = null;
        state.botJid = null;
        state.setState('error', {
          message: reason,
          hint: 'You will need to pair again.'
        });
      }
    }
  });
  
  // ---------- Messages ----------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleIncoming(msg);
      } catch (e) {
        console.error('[Message]', e.message);
      }
    }
  });
  
  // ---------- Group events ----------
  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;
    try {
      if (action === 'add' && state.welcomeEnabled.has(id)) {
        await handlers.sendWelcome(id, participants);
      } else if (action === 'remove' && state.goodbyeEnabled.has(id)) {
        await handlers.sendGoodbye(id, participants);
      }
    } catch (e) {
      console.error('[Group]', e.message);
    }
  });
  
  return { ok: true };
}

// ---------- Incoming router ----------
async function handleIncoming(msg) {
  if (!msg.message) return;
  const from = msg.key.remoteJid;
  if (!from || from === 'status@broadcast') return;
  
  const senderJid = msg.key.participant || from;
  
  if (state.pausedChats.has('ALL') || state.pausedChats.has(from)) return;
  
  if (state.viewOnceEnabled) {
    const captured = await handlers.tryCaptureViewOnce(msg, from);
    if (captured) return;
  }
  
  const text = extractText(msg);
  if (!text || !text.startsWith('.')) return;
  
  await handlers.handleCommand(msg, from, senderJid, text);
}

function extractText(msg) {
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

// ---------- Stop ----------
function stopBot() {
  if (state.sock) {
    try { state.sock.end(undefined); } catch (e) {}
    state.sock = null;
  }
  state.botJid = null;
  state.pairingCode = null;
  state.setState('disconnected', { message: 'Stopped by user.' });
}

module.exports = {
  startBot,
  stopBot,
  loadBanner,
  validateNumber
};