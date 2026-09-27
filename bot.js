import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  getContentType,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { handleMessage, handleReaction, handleGroupParticipants } from './command.js';

export const state = {
  sock: null,
  connected: false,
  mode: 'private',
  ownerJid: null,
  pairingCode: null,
  startedAt: Date.now(),
  lastDisconnect: null,
  isInitialConnection: true,
  // Command toggles
  antidelete: true,
  antiedit: true,
  welcome: true,
  goodbye: true,
  welcomeText: 'Welcome to *{group}*, @{user}! 👋',
  goodbyeText: 'Goodbye @{user}! 👋',
  prefix: '!',
  bannerUrl: null,
  botName: 'WA Bot',
};

const IS_RENDER = !!process.env.RENDER;
const PERSISTENT = process.env.PERSISTENT_DISK === 'true';
const DATA_ROOT = IS_RENDER ? (PERSISTENT ? '/data' : '/tmp') : '.';
const AUTH_DIR = path.join(DATA_ROOT, 'auth');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const OWNER_FILE = path.join(DATA_DIR, 'owner.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// In-memory message store
export const messageStore = new Map();
const MAX_STORE = 500;

function addToStore(msg) {
  if (!msg.key?.id || !msg.key?.remoteJid) return;
  const k = `${msg.key.remoteJid}:${msg.key.id}`;
  messageStore.set(k, msg);
  if (messageStore.size > MAX_STORE) {
    const first = messageStore.keys().next().value;
    messageStore.delete(first);
  }
}

function ensureDirs() {
  for (const d of [DATA_DIR, AUTH_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    Object.assign(state, cfg);
  }
  if (fs.existsSync(OWNER_FILE)) {
    const { jid } = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf-8'));
    state.ownerJid = jid;
  }
}

function saveConfig() {
  const { antidelete, antiedit, welcome, goodbye, welcomeText, goodbyeText, prefix, bannerUrl, botName, mode } = state;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    antidelete, antiedit, welcome, goodbye, welcomeText, goodbyeText, prefix, bannerUrl, botName, mode
  }, null, 2));
}

function saveOwner(jid) {
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ jid }, null, 2));
  state.ownerJid = jid;
}

export async function startBot() {
  ensureDirs();
  loadConfig();

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
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  state.sock = sock;

  // Store every message
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.message) addToStore(msg);
    }
  });

  // Command handler
  sock.ev.on('messages.upsert', (payload) => handleMessage(payload, sock, state));

  // Anti-delete + anti-edit (both via messages.upsert protocolMessage)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const proto = msg.message?.protocolMessage;
      if (!proto) continue;

      if (proto.type === 'REVOKE' && state.antidelete && state.ownerJid) {
        const origKey = proto.key;
        if (!origKey) continue;
        const original = messageStore.get(`${origKey.remoteJid}:${origKey.id}`);
        if (original) {
          try {
            await sock.sendMessage(state.ownerJid, {
              forward: original,
              text: `⚠️ *Deleted message recovered*\nChat: ${origKey.remoteJid}`,
            });
          } catch (e) { console.error('anti-delete forward failed', e.message); }
        }
      }

      if (proto.type === 'MESSAGE_EDIT' && state.antiedit && state.ownerJid) {
        const origKey = proto.key;
        const edited = proto.editedMessage;
        if (!origKey || !edited) continue;
        const original = messageStore.get(`${origKey.remoteJid}:${origKey.id}`);
        const editedText = edited.conversation || edited.extendedTextMessage?.text || '[media]';
        const originalText = original?.message?.conversation || original?.message?.extendedTextMessage?.text || '[media]';
        try {
          await sock.sendMessage(state.ownerJid, {
            text: `✏️ *Message edited*\nChat: ${origKey.remoteJid}\n\n*Original:*\n${originalText}\n\n*Edited:*\n${editedText}`,
          });
        } catch (e) { console.error('anti-edit forward failed', e.message); }
      }
    }
  });

  // Reaction handler (🐼 view-once)
  sock.ev.on('messages.reaction', (reactions) => handleReaction(reactions, sock, state));

  // Group participants
  sock.ev.on('group-participants.update', (update) => handleGroupParticipants(update, sock, state));

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !authState.creds.registered && !state.pairingCode) {
      setTimeout(async () => {
        try {
          const phone = process.env.PAIRING_PHONE || '';
          if (!phone) return;
          const cleaned = phone.replace(/\D/g, '');
          const code = await sock.requestPairingCode(cleaned);
          state.pairingCode = code;
          console.log('🔑 Pairing code:', code);
        } catch (e) { console.error('Pairing failed:', e.message); }
      }, 3000);
    }

    if (connection === 'open') {
      state.connected = true;
      state.isInitialConnection = false;
      state.pairingCode = null;
      const jid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (!state.ownerJid) saveOwner(jid);
      console.log('✅ Connected as', jid);
    }

    if (connection === 'close') {
      state.connected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (state.isInitialConnection && !authState.creds.registered) return;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...');
        state.isInitialConnection = false;
        startBot();
      }
    }
  });

  return sock;
}

export async function requestPairing(phoneNumber) {
  if (!state.sock) throw new Error('Socket not initialized');
  if (state.sock.authState.creds.registered) throw new Error('Already registered');
  if (state.pairingCode) return state.pairingCode;
  const cleaned = phoneNumber.replace(/\D/g, '');
  const code = await state.sock.requestPairingCode(cleaned);
  state.pairingCode = code;
  return code;
}

export function persistConfig() { saveConfig(); }