import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  Browsers,
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
  mode: 'private',
  ownerJid: null,
  pairingCode: null,
  startedAt: Date.now(),
  lastDisconnect: null,
  isInitialConnection: true, // FIX: prevents premature reconnect loop
};

// ---- Render-aware paths ----
const IS_RENDER = !!process.env.RENDER;
const PERSISTENT = process.env.PERSISTENT_DISK === 'true';

// On Render, if PERSISTENT_DISK is not set, we still try /data but warn
const DATA_ROOT = IS_RENDER ? (PERSISTENT ? '/data' : '/tmp') : '.';
const AUTH_DIR = path.join(DATA_ROOT, 'auth');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const OWNER_FILE = path.join(DATA_DIR, 'owner.json');

// ---- Custom in-memory message store ----
export const messageStore = new Map();

export function createMessageStoreHandler(store) {
  return (payload) => {
    for (const msg of payload.messages || []) {
      if (msg.key.id && msg.key.remoteJid) {
        store.set(`${msg.key.remoteJid}:${msg.key.id}`, msg);
      }
    }
  };
}

export function createAntiDeleteHandler(store) {
  return (updates) => {
    const deleted = [];
    for (const { key, update } of updates) {
      const protocolMsg = update?.message?.protocolMessage;
      if (protocolMsg?.type === 'REVOKE') {
        const originalKey = protocolMsg.key;
        if (originalKey) {
          const original = store.get(`${originalKey.remoteJid}:${originalKey.id}`);
          if (original) deleted.push({ key, originalMessage: original });
        }
      }
    }
    return deleted;
  };
}

// ---- Helpers ----
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
    browser: Browsers.macOS('Chrome'), // FIX: pairing code needs proper browser format
    markOnlineOnConnect: false,
    syncFullHistory: false,
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
    for (const { key, reaction } of reactions) {
      if (reaction.text !== '🐼' || !state.ownerJid) continue;
      const original = messageStore.get(`${key.remoteJid}:${key.id}`);
      if (original?.message?.viewOnceMessageV2) {
        try {
          const buffer = await downloadMediaMessage(original, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
          });
          await sock.sendMessage(state.ownerJid, {
            image: buffer,
            caption: '📥 Downloaded from view-once',
          });
        } catch (e) {
          console.error('view-once download failed', e.message);
        }
      }
    }
  });
  
  // ---- Group participants ----
  sock.ev.on('group-participants.update', async () => {
    // Stub
  });
  
  // ---- Connection lifecycle ----
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    // FIX: Request pairing code only when connection is 'connecting' and QR is available
    if (qr && !authState.creds.registered && !state.pairingCode) {
      // Wait a tick to ensure socket is ready
      setTimeout(async () => {
        try {
          const phone = process.env.PAIRING_PHONE || '';
          if (!phone) {
            console.log('⚠️  Set PAIRING_PHONE env var to auto-request pairing code');
            return;
          }
          const cleaned = phone.replace(/\D/g, '');
          const code = await sock.requestPairingCode(cleaned);
          state.pairingCode = code;
          console.log('🔑 Pairing code:', code);
        } catch (e) {
          console.error('Pairing code request failed:', e.message);
        }
      }, 3000); // 3s delay to let WhatsApp connect
    }
    
    if (connection === 'open') {
      state.connected = true;
      state.isInitialConnection = false; // FIX: now reconnects are safe
      state.pairingCode = null;
      const jid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (!state.ownerJid) saveOwner(jid);
      console.log('✅ Connected as', jid);
    }
    
    if (connection === 'close') {
      state.connected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      state.lastDisconnect = code;
      
      // FIX: Do NOT reconnect if this was the initial connection and we're not registered yet
      if (state.isInitialConnection && !authState.creds.registered) {
        console.log('⏸️  Initial connection closed — waiting for pairing, not reconnecting');
        return;
      }
      
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...');
        state.isInitialConnection = false;
        startBot();
      } else {
        console.log('🚪 Logged out. Delete auth dir and restart.');
      }
    }
  });
  
  return sock;
}

// ---- Manual pairing request (from UI) ----
export async function requestPairing(phoneNumber) {
  if (!state.sock) throw new Error('Socket not initialized');
  if (state.sock.authState.creds.registered) {
    throw new Error('Already registered');
  }
  if (state.pairingCode) {
    return state.pairingCode; // Return existing code
  }
  const cleaned = phoneNumber.replace(/\D/g, '');
  const code = await state.sock.requestPairingCode(cleaned);
  state.pairingCode = code;
  return code;
}