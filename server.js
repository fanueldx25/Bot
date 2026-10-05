// =========================================================
// ENVIRONMENT (must be first)
// =========================================================
import 'dotenv/config';

// =========================================================
// IMPORTS
// =========================================================
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  isJidGroup,
  delay,
  Browsers
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================
// CONFIGURATION
// =========================================================
const CONFIG = {
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',
  BOT_NAME: process.env.BOT_NAME || 'My AI Assistant',
  SYSTEM_PROMPT: 'You are a helpful, concise AI assistant on WhatsApp. Keep replies short (under 200 words).',
  ONLY_REPLY_TO_MENTIONS: process.env.ONLY_REPLY_TO_MENTIONS !== 'false',
  MENTION_NAMES: ['@ai', '@bot', 'assistant'],
  MAX_HISTORY_PER_CHAT: 20,
  COOLDOWN_MS: parseInt(process.env.COOLDOWN_MS || '3000', 10),
  MAX_REPLIES_PER_MINUTE: parseInt(process.env.MAX_REPLIES_PER_MINUTE || '10', 10),
  AUTH_FOLDER: process.env.AUTH_FOLDER || './auth_info_baileys',
  PORT: process.env.PORT || 3000,
};

// =========================================================
// STATE
// =========================================================
const state = {
  sock: null,
  conversations: new Map(),
  lastReplyTime: new Map(),
  replyTimestamps: new Map(),
  processing: new Set(),
  pairing: {
    active: false,
    phone: null,
    code: null,
    error: null,
  },
  connectionStatus: 'disconnected', // 'connecting' | 'open' | 'close'
  isSocketReady: false, // 🔑 Tracks if socket is ready for pairing
};

// =========================================================
// EXPRESS SERVER
// =========================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Health check ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: !!state.sock?.user,
    user: state.sock?.user?.id || null,
    model: CONFIG.OLLAMA_MODEL,
    host: CONFIG.OLLAMA_HOST,
    registered: state.sock?.authState?.creds?.registered || false,
    connectionStatus: state.connectionStatus,
    isSocketReady: state.isSocketReady,
    pairing: state.pairing,
  });
});

// ---- Pairing endpoint ----
app.post('/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Missing "phone"' });

    const cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.length < 8) return res.status(400).json({ error: 'Invalid phone number' });

    if (state.sock?.authState?.creds?.registered) {
      return res.status(400).json({ error: 'Already registered. Logout first.' });
    }

    if (!state.sock) {
      return res.status(503).json({ error: 'Socket not initialized. Please wait.' });
    }

    // 🔑 CRITICAL: Wait for socket to be ready before requesting code
    if (!state.isSocketReady) {
      return res.status(409).json({
        error: 'Socket is not ready yet. Please wait a moment and try again.',
        ready: false
      });
    }

    // If code already exists, return it
    if (state.pairing.active && state.pairing.code) {
      return res.json({ ok: true, code: state.pairing.code, phone: state.pairing.phone });
    }

    state.pairing = { active: true, phone: cleaned, code: null, error: null };

    console.log(`[Pair] Requesting code for ${cleaned}...`);
    const code = await state.sock.requestPairingCode(cleaned);
    state.pairing.code = code;

    console.log(`[Pair] ✅ Code generated: ${code}`);
    res.json({ ok: true, code, phone: cleaned });
  } catch (err) {
    state.pairing.error = err.message;
    console.error('[Pair] ❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Other API endpoints (send, chats, history) ----
app.get('/chats', (req, res) => {
  res.json({ chats: Array.from(state.conversations.keys()) });
});

app.get('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  res.json({ chatId, history: state.conversations.get(chatId) || [] });
});

app.delete('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  state.conversations.delete(chatId);
  res.json({ ok: true, cleared: chatId });
});

app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Missing "to" or "text"' });
    if (!state.sock?.user) return res.status(503).json({ error: 'Not connected' });
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await state.sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/reconnect', async (req, res) => {
  state.isSocketReady = false;
  state.pairing = { active: false, phone: null, code: null, error: null };
  if (state.sock) { try { state.sock.end(new Error('Manual reconnect')); } catch {} }
  setTimeout(() => connectToWhatsApp().catch(console.error), 1000);
  res.json({ ok: true });
});

app.post('/logout', async (req, res) => {
  try {
    if (state.sock) { try { await state.sock.logout(); } catch {} }
    if (fs.existsSync(CONFIG.AUTH_FOLDER)) {
      fs.rmSync(CONFIG.AUTH_FOLDER, { recursive: true, force: true });
    }
    state.pairing = { active: false, phone: null, code: null, error: null };
    state.isSocketReady = false;
    state.sock = null;
    setTimeout(() => connectToWhatsApp().catch(console.error), 1500);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`[HTTP] Server on http://localhost:${CONFIG.PORT}`);
});

// =========================================================
// OLLAMA
// =========================================================
async function askOllama(messages) {
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.OLLAMA_API_KEY) headers['Authorization'] = `Bearer ${CONFIG.OLLAMA_API_KEY}`;
  const res = await fetch(`${CONFIG.OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: CONFIG.OLLAMA_MODEL, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).message?.content || '(empty)';
}

// =========================================================
// CONVERSATION & RATE LIMITING
// =========================================================
function appendHistory(chatId, role, content) {
  let h = state.conversations.get(chatId) || [];
  h.push({ role, content });
  if (h.length > CONFIG.MAX_HISTORY_PER_CHAT) h = h.slice(-CONFIG.MAX_HISTORY_PER_CHAT);
  state.conversations.set(chatId, h);
}

function canReply(chatId) {
  const now = Date.now();
  if (now - (state.lastReplyTime.get(chatId) || 0) < CONFIG.COOLDOWN_MS) return false;
  const ts = (state.replyTimestamps.get(chatId) || []).filter(t => now - t < 60000);
  if (ts.length >= CONFIG.MAX_REPLIES_PER_MINUTE) return false;
  return true;
}

function recordReply(chatId) {
  const now = Date.now();
  state.lastReplyTime.set(chatId, now);
  const ts = (state.replyTimestamps.get(chatId) || []).filter(t => now - t < 60000);
  ts.push(now);
  state.replyTimestamps.set(chatId, ts);
}

// =========================================================
// WHATSAPP CONNECTION
// =========================================================
async function connectToWhatsApp() {
  console.log('[WA] Initializing...');
  state.connectionStatus = 'connecting';
  state.isSocketReady = false;

  const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_FOLDER);

  // 🔑 FIX 1: Use fetchLatestWaWebVersion instead of fetchLatestBaileysVersion
  let version;
  try {
    const waVersion = await fetchLatestWaWebVersion({});
    version = waVersion.version;
    console.log(`[WA] Using WA Web version ${version.join('.')}`);
  } catch (err) {
    console.warn('[WA] Version fetch failed, using fallback');
    version = [2, 3000, 1035194821];
  }

  const logger = pino({ level: 'silent' });

  // 🔑 FIX 2: Use canonical browser config
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    browser: Browsers.macOS('Chrome'), // 🔑 Canonical browser
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  state.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  // 🔑 FIX 3: Only set isSocketReady when connection is 'connecting' or qr is received
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // The socket is ready for pairing when it's 'connecting' OR when a QR is received
    if (connection === 'connecting' || qr) {
      if (!state.isSocketReady) {
        console.log('[WA] Socket is now ready for pairing');
        state.isSocketReady = true;
      }
    }

    if (connection === 'open') {
      console.log(`[WA] ✅ Connected as ${sock.user?.id}`);
      state.connectionStatus = 'open';
      state.isSocketReady = true;
      state.pairing = { active: false, phone: null, code: null, error: null };
    }

    if (connection === 'close') {
      state.connectionStatus = 'close';
      state.isSocketReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[WA] Closed (code ${code}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp().catch(console.error), 5000);
      }
    }
  });

  // ---- Handle incoming messages ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await handleIncomingMessage(msg); } catch (err) { console.error(err); }
    }
  });

  return sock;
}

// =========================================================
// MESSAGE HANDLER
// =========================================================
async function handleIncomingMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const chatId = msg.key.remoteJid;
  const isGroup = isJidGroup(chatId);
  const senderName = msg.pushName || 'User';
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

  if (!text.trim()) return;

  // Group mention check
  if (isGroup && CONFIG.ONLY_REPLY_TO_MENTIONS) {
    const mentions = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const botJid = jidNormalizedUser(state.sock.user.id);
    const isMentioned = mentions.some(j => jidNormalizedUser(j) === botJid) ||
      CONFIG.MENTION_NAMES.some(n => text.toLowerCase().includes(n.toLowerCase()));
    if (!isMentioned) { appendHistory(chatId, 'user', `${senderName}: ${text}`); return; }
  }

  if (!canReply(chatId) || state.processing.has(chatId)) return;
  state.processing.add(chatId);

  try {
    await state.sock.sendPresenceUpdate('composing', chatId);
    const messages = [
      { role: 'system', content: CONFIG.SYSTEM_PROMPT },
      ...(state.conversations.get(chatId) || []),
      { role: 'user', content: `${senderName}: ${text}` }
    ];
    const reply = await askOllama(messages);
    await state.sock.sendPresenceUpdate('paused', chatId);
    await state.sock.sendMessage(chatId, { text: reply }, { quoted: msg });
    appendHistory(chatId, 'user', `${senderName}: ${text}`);
    appendHistory(chatId, 'assistant', reply);
    recordReply(chatId);
  } catch (err) {
    console.error('[Handler] Error:', err.message);
  } finally {
    state.processing.delete(chatId);
  }
}

// =========================================================
// STARTUP
// =========================================================
connectToWhatsApp().catch(err => { console.error('[Fatal]', err); process.exit(1); });

process.on('SIGINT', () => { try { state.sock?.end?.(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { state.sock?.end?.(); } catch {} process.exit(0); });