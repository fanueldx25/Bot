import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  getContentType,
  Browsers,
  BufferJSON,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { handleMessage, handleReaction, handleGroupParticipants } from './command.js';

// ---- Shared state ----
export const state = {
  sock: null,
  connected: false,
  mode: 'private',
  ownerJid: null,
  pairingCode: null,
  sessionToken: null,
  startedAt: Date.now(),
  lastDisconnect: null,
  isInitialConnection: true,
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

// ---- Paths ----
const IS_RENDER = !!process.env.RENDER;
const PERSISTENT = process.env.PERSISTENT_DISK === 'true';
const DATA_ROOT = IS_RENDER ? (PERSISTENT ? '/data' : '/tmp') : '.';
const AUTH_DIR = path.join(DATA_ROOT, 'auth');
const DATA_DIR = path.join(DATA_ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bot-data.json');

// ---- In-memory message store ----
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

// ---- JSON file storage ----
function ensureDirs() {
  for (const d of [DATA_DIR, AUTH_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      Object.keys(data).forEach(k => { if (k in state) state[k] = data[k]; });
    } catch (e) {
      console.error('Failed to load bot-data.json:', e.message);
    }
  }
}

function saveData() {
  const data = {};
  const fields = [
    'ownerJid', 'sessionToken', 'mode', 'antidelete', 'antiedit',
    'welcome', 'goodbye', 'welcomeText', 'goodbyeText', 'prefix',
    'bannerUrl', 'botName'
  ];
  fields.forEach(f => { data[f] = state[f]; });
  data.savedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateToken() {
  const token = crypto.randomBytes(24).toString('hex');
  state.sessionToken = token;
  saveData();
  return token;
}

// ============================================================================
// SESSION PACKAGE EXPORT / IMPORT
// ============================================================================

/**
 * Reads all files in the auth folder and packages them into a single JSON.
 * Uses BufferJSON to safely serialize any binary content.
 */
export function exportSessionPackage() {
  const pkg = {
    version: 1,
    createdAt: new Date().toISOString(),
    files: {},
  };

  if (!fs.existsSync(AUTH_DIR)) {
    throw new Error('Auth folder does not exist');
  }

  const files = fs.readdirSync(AUTH_DIR);
  for (const file of files) {
    const fullPath = path.join(AUTH_DIR, file);
    if (!fs.statSync(fullPath).isFile()) continue;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      // Validate it's parseable JSON, then re-stringify cleanly
      JSON.parse(content);
      pkg.files[file] = content;
    } catch (e) {
      console.error(`Skipping non-JSON file: ${file}`, e.message);
    }
  }

  return pkg;
}

/**
 * Writes all files from a session package back to the auth folder.
 * Clears sender-key-memory entries to force fresh SKDM distribution.
 */
export function importSessionPackage(pkg) {
  if (!pkg || pkg.version !== 1 || !pkg.files) {
    throw new Error('Invalid session package format');
  }

  ensureDirs();

  // Clear existing auth folder first
  if (fs.existsSync(AUTH_DIR)) {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      fs.unlinkSync(path.join(AUTH_DIR, f));
    }
  }

  let written = 0;
  for (const [filename, content] of Object.entries(pkg.files)) {
    // Security: prevent path traversal
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      console.warn(`Skipping suspicious filename: ${filename}`);
      continue;
    }
    fs.writeFileSync(path.join(AUTH_DIR, filename), content);
    written++;
  }

  console.log(`📦 Imported ${written} auth files from session package`);
  return written;
}

/**
 * Clears sender-key-memory entries from all sender-key-*.json files.
 * This forces Baileys to redistribute SKDMs on the next group send.
 * This is the verified workaround for "Waiting for this message" [citation:7][citation:13].
 */
export function clearSenderKeyMemory() {
  const files = fs.readdirSync(AUTH_DIR).filter(f => f.startsWith('sender-key-memory-'));
  let cleared = 0;

  for (const file of files) {
    const fullPath = path.join(AUTH_DIR, file);
    try {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      // sender-key-memory files are JID → bool maps
      // Resetting to null forces fresh distribution
      if (content && typeof content === 'object') {
        for (const jid of Object.keys(content)) {
          content[jid] = null;
        }
        fs.writeFileSync(fullPath, JSON.stringify(content));
        cleared++;
      }
    } catch (e) {
      console.error(`Failed to clear ${file}:`, e.message);
    }
  }

  console.log(`🔑 Cleared sender-key-memory in ${cleared} files`);
  return cleared;
}

// ============================================================================
// BOT LIFECYCLE
// ============================================================================

export async function startBot(options = {}) {
  ensureDirs();
  if (!options.skipLoad) loadData();

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

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.message) addToStore(msg);
    }
  });

  sock.ev.on('messages.upsert', (payload) => handleMessage(payload, sock, state));

  // Anti-delete + anti-edit
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
          } catch (e) { console.error('anti-delete failed', e.message); }
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
        } catch (e) { console.error('anti-edit failed', e.message); }
      }
    }
  });

  sock.ev.on('messages.reaction', (reactions) => handleReaction(reactions, sock, state));
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
      if (!state.ownerJid) {
        state.ownerJid = jid;
        saveData();
      }
      if (!state.sessionToken) generateToken();
      console.log('✅ Connected as', jid);
    }

    if (connection === 'close') {
      state.connected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (state.isInitialConnection && !authState.creds.registered) return;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...');
        state.isInitialConnection = false;
        startBot({ skipLoad: true });
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

/**
 * Restart the bot: close current socket, import session (if provided),
 * clear sender-key-memory, and start fresh.
 */
export async function restartBot(sessionPkg = null) {
  console.log('🔄 Restarting bot...');

  // Close existing socket
  if (state.sock) {
    try { state.sock.end(undefined); } catch (e) { /* ignore */ }
    state.sock = null;
  }

  state.connected = false;
  state.isInitialConnection = true;
  state.pairingCode = null;

  // Import session package if provided
  if (sessionPkg) {
    importSessionPackage(sessionPkg);
  }

  // Clear sender-key-memory to force fresh SKDM distribution
  // This is the verified fix for "Waiting for this message" [citation:7][citation:13]
  clearSenderKeyMemory();

  // Start fresh
  await startBot({ skipLoad: true });
  return true;
}

export function persistConfig() { saveData(); }
export function getToken() { return state.sessionToken; }
export function regenerateToken() { return generateToken(); }
export function getBotData() {
  const data = {};
  const fields = [
    'ownerJid', 'sessionToken', 'mode', 'antidelete', 'antiedit',
    'welcome', 'goodbye', 'welcomeText', 'goodbyeText', 'prefix',
    'bannerUrl', 'botName'
  ];
  fields.forEach(f => { data[f] = state[f]; });
  return data;
}