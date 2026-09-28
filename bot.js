import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
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
  pairingPhone: null,
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
  msgCount: 0,  // ← NEW: message counter for stats
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
    'bannerUrl', 'botName', 'msgCount'
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
      JSON.parse(content);
      pkg.files[file] = content;
    } catch (e) {
      console.error(`Skipping non-JSON file: ${file}`, e.message);
    }
  }

  return pkg;
}

export function importSessionPackage(pkg) {
  if (!pkg || pkg.version !== 1 || !pkg.files) {
    throw new Error('Invalid session package format');
  }

  ensureDirs();

  if (fs.existsSync(AUTH_DIR)) {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      fs.unlinkSync(path.join(AUTH_DIR, f));
    }
  }

  let written = 0;
  for (const [filename, content] of Object.entries(pkg.files)) {
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

export function clearSenderKeyMemory() {
  if (!fs.existsSync(AUTH_DIR)) return 0;
  const files = fs.readdirSync(AUTH_DIR).filter(f => f.startsWith('sender-key-memory-'));
  let cleared = 0;

  for (const file of files) {
    const fullPath = path.join(AUTH_DIR, file);
    try {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
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
// AUTH FOLDER HELPERS (for fresh pairing requests)
// ============================================================================

/**
 * Wipes the entire auth folder. Used when we need a clean pairing attempt
 * (e.g. user requests a new pairing code with a different number, or the
 * cached code needs to be invalidated).
 */
function wipeAuthFolder() {
  if (fs.existsSync(AUTH_DIR)) {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      try { fs.unlinkSync(path.join(AUTH_DIR, f)); } catch (_) {}
    }
  }
  ensureDirs();
}

// ============================================================================
// BOT LIFECYCLE
// ============================================================================

let activeSocket = null; // separate ref so we always end the right one

export async function startBot(options = {}) {
  ensureDirs();
  if (!options.skipLoad) loadData();

  // Always end any previous socket before creating a new one
  if (activeSocket) {
    try { activeSocket.end(undefined); } catch (_) {}
    activeSocket = null;
  }

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

  activeSocket = sock;
  state.sock = sock;

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.message) {
        addToStore(msg);
        state.msgCount = (state.msgCount || 0) + 1;
      }
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
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      state.connected = true;
      state.isInitialConnection = false;
      state.pairingCode = null;
      state.pairingPhone = null;
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
        // Small delay to avoid tight reconnect loops
        setTimeout(() => startBot({ skipLoad: true }).catch(e => console.error('reconnect failed', e)), 2000);
      }
    }
  });

  return sock;
}

/**
 * Request a FRESH pairing code.
 *
 * The key insight: Baileys caches the pairing code per socket. To get a new one
 * you must:
 *   1. End the current socket.
 *   2. Wipe the auth folder (partial creds confuse the next request).
 *   3. Start a brand-new socket.
 *   4. Wait for the socket to be ready, THEN call requestPairingCode.
 *
 * If `force` is true (default), it will always regenerate — even if a code
 * already exists. Pass force=false to reuse an existing code.
 */
export async function requestPairing(phoneNumber, force = true) {
  const cleaned = String(phoneNumber).replace(/\D/g, '');
  if (!cleaned || cleaned.length < 7) {
    throw new Error('Invalid phone number');
  }

  // If same number AND same unexpired code AND not forcing, return cached
  if (!force && state.pairingCode && state.pairingPhone === cleaned) {
    return state.pairingCode;
  }

  console.log(`📱 Requesting fresh pairing code for ${cleaned}...`);

  // 1. Tear down any existing socket
  if (activeSocket) {
    try { activeSocket.end(undefined); } catch (_) {}
    activeSocket = null;
  }
  state.sock = null;
  state.connected = false;
  state.pairingCode = null;
  state.pairingPhone = null;

  // 2. Wipe auth folder so Baileys starts from scratch
  wipeAuthFolder();

  // 3. Build a fresh socket
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

  activeSocket = sock;
  state.sock = sock;
  state.isInitialConnection = true;

  // Re-attach the same event handlers (use startBot for full features;
  // here we only need creds + connection for pairing).
  sock.ev.on('creds.update', saveCreds);

  // 4. Wait for the socket to be ready to accept a pairing request.
  //    Baileys emits a QR / connection.update when ready; we poll the ws
  //    readyState as a fallback.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    sock.ev.on('connection.update', (u) => {
      if (u.qr || u.connection === 'connecting' || u.connection === 'open') finish();
    });
    // Fallback timeout — Baileys is usually ready in <1s
    setTimeout(finish, 4000);
  });

  // 5. Request the code
  let code;
  try {
    code = await sock.requestPairingCode(cleaned);
  } catch (e) {
    throw new Error(`Pairing request failed: ${e.message}`);
  }

  state.pairingCode = code;
  state.pairingPhone = cleaned;
  console.log(`🔑 Fresh pairing code for ${cleaned}: ${code}`);

  // 6. Keep listening — once the user enters the code on their phone,
  //    'creds.update' will fire with registered=true, then 'connection: open'.
  //    We wire up the full bot handlers here so the bot becomes live.
  attachFullHandlers(sock, authState, saveCreds);

  return code;
}

/**
 * Attach the full message-handling pipeline to a socket that was created
 * inside requestPairing(). This makes the bot fully functional the moment
 * pairing succeeds.
 */
function attachFullHandlers(sock, authState, saveCreds) {
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.message) {
        addToStore(msg);
        state.msgCount = (state.msgCount || 0) + 1;
      }
    }
  });

  sock.ev.on('messages.upsert', (payload) => handleMessage(payload, sock, state));

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

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      state.connected = true;
      state.isInitialConnection = false;
      state.pairingCode = null;
      state.pairingPhone = null;
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
        setTimeout(() => startBot({ skipLoad: true }).catch(e => console.error('reconnect failed', e)), 2000);
      }
    }
  });
}

export async function restartBot(sessionPkg = null) {
  console.log('🔄 Restarting bot...');

  if (activeSocket) {
    try { activeSocket.end(undefined); } catch (_) {}
    activeSocket = null;
  }
  state.sock = null;
  state.connected = false;
  state.isInitialConnection = true;
  state.pairingCode = null;
  state.pairingPhone = null;

  if (sessionPkg) {
    importSessionPackage(sessionPkg);
  }

  clearSenderKeyMemory();

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
    'bannerUrl', 'botName', 'msgCount'
  ];
  fields.forEach(f => { data[f] = state[f]; });
  return data;
}