import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
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
  mode: 'private',
  ownerJid: null,
  pairingCode: null,
  startedAt: Date.now(),
  lastDisconnect: null,
};

// ---- Render-aware paths ----
const IS_RENDER = !!process.env.RENDER;
const DATA_ROOT = IS_RENDER && process.env.PERSISTENT_DISK ? '/data' : '.';
const AUTH_DIR = path.join(DATA_ROOT, 'auth');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const OWNER_FILE = path.join(DATA_DIR, 'owner.json');

// ---- Custom in-memory message store (replaces missing MessageStore) ----
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
  sock.ev.on('group-participants.update', async (update) => {
    // Stub — welcome/goodbye later
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