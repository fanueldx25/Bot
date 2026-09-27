import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  MessageStore,
  createMessageStoreHandler,
  createAntiDeleteHandler,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { handleMessage } from './command.js';

// ---- Shared state ----
export const state = {
  sock: null,
  connected: false,
  mode: 'private', // 'private' | 'public'
  ownerJid: null,
  pairingCode: null,
  startedAt: Date.now(),
  lastDisconnect: null,
};

// ---- Message store (anti-delete / anti-edit) ----
export const messageStore = new MessageStore({
  maxMessagesPerChat: 100,
  ttl: 60 * 60 * 1000, // 1 hour
});

// ---- Helpers ----
const DATA_DIR = path.resolve('./data');
const AUTH_DIR = path.resolve('./auth');
const OWNER_FILE = path.join(DATA_DIR, 'owner.json');

function ensureDirs() {
  for (const d of [DATA_DIR, AUTH_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadOwner() {
  if (fs.existsSync(OWNER_FILE)) {
    const { jid } = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf-8'));
    state.ownerJid = jid;
  }
}

function saveOwner(jid) {
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ jid }, null, 2));
  state.ownerJid = jid;
}

// ---- Start socket ----
export async function startBot() {
  ensureDirs();
  loadOwner();
  
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WA Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
  });
  
  state.sock = sock;
  
  // ---- Wire message store ----
  sock.ev.on('messages.upsert', createMessageStoreHandler(messageStore));
  sock.ev.on('messages.upsert', (payload) => handleMessage(payload, sock, state));
  
  // ---- Anti-delete ----
  const antiDelete = createAntiDeleteHandler(messageStore);
  sock.ev.on('messages.update', async (updates) => {
    const deleted = antiDelete(updates);
    for (const item of deleted) {
      if (!state.ownerJid) continue;
      try {
        await sock.sendMessage(state.ownerJid, {
          forward: item.originalMessage,
          text: `⚠️ Deleted in ${item.key.remoteJid}`,
        });
      } catch (e) {
        console.error('anti-delete forward failed', e.message);
      }
    }
  });
  
  // ---- Reactions (🐼 view-once capture) ----
  sock.ev.on('messages.reaction', async (reactions) => {
    // stub — implement later in command.js
  });
  
  // ---- Group participants ----
  sock.ev.on('group-participants.update', async (update) => {
    // stub — welcome/goodbye later
  });
  
  // ---- Connection lifecycle ----
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'open') {
      state.connected = true;
      state.pairingCode = null;
      const jid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (!state.ownerJid) saveOwner(jid);
      console.log('✅ Connected as', jid);
    }
    
    if (connection === 'close') {
      state.connected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      state.lastDisconnect = code;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...');
        startBot();
      } else {
        console.log('🚪 Logged out. Delete ./auth and restart.');
      }
    }
  });
  
  return sock;
}

// ---- Pairing code request ----
export async function requestPairing(phoneNumber) {
  if (!state.sock) throw new Error('Socket not initialized');
  if (state.sock.authState.creds.registered) {
    throw new Error('Already registered');
  }
  const cleaned = phoneNumber.replace(/\D/g, '');
  const code = await state.sock.requestPairingCode(cleaned);
  state.pairingCode = code;
  return code;
}