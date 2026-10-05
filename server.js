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
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  isJidGroup,
  delay,
  Browsers
} from '@whiskeysockets/baileys';
import express from 'express';
import readline from 'readline';
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
  // Ollama Cloud / Local settings
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',

  // Bot behavior
  BOT_NAME: process.env.BOT_NAME || 'My AI Assistant',
  SYSTEM_PROMPT:
    'You are a helpful, concise AI assistant on WhatsApp. Keep replies short (under 200 words). If someone asks you to do a task, confirm what you will do.',

  // Group behavior
  ONLY_REPLY_TO_MENTIONS: process.env.ONLY_REPLY_TO_MENTIONS !== 'false',
  MENTION_NAMES: ['@ai', '@bot', 'assistant'],

  // Rate limiting
  MAX_HISTORY_PER_CHAT: 20,
  COOLDOWN_MS: parseInt(process.env.COOLDOWN_MS || '3000', 10),
  MAX_REPLIES_PER_MINUTE: parseInt(process.env.MAX_REPLIES_PER_MINUTE || '10', 10),

  // Session
  AUTH_FOLDER: process.env.AUTH_FOLDER || './auth_info_baileys',
  PORT: process.env.PORT || 3000,

  // Pairing
  PAIRING_TIMEOUT_MS: 120000, // 2 minutes to enter code
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
    requestedAt: null,
    error: null,
  },
  connectionStatus: 'disconnected', // 'connecting' | 'open' | 'close'
  lastQR: null,
};

// =========================================================
// EXPRESS SERVER
// =========================================================
const app = express();
app.use(express.json());

// Serve frontend
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head><title>WhatsApp AI Bot</title></head>
        <body style="font-family: system-ui; background: #0a0e1a; color: #e5e9f0; padding: 40px;">
          <h1>WhatsApp AI Bot</h1>
          <p>Dashboard not found. Create <code>public/index.html</code>.</p>
          <p>API: <a href="/health" style="color:#3b82f6">/health</a> | /pair | /send | /chats | /history/:id</p>
        </body>
      </html>
    `);
  }
});

// ---- Health check ----
app.get('/health', (req, res) => {
  const isRegistered = state.sock?.authState?.creds?.registered || false;
  res.json({
    status: 'ok',
    connected: state.sock?.user ? true : false,
    user: state.sock?.user?.id || null,
    name: state.sock?.user?.name || null,
    model: CONFIG.OLLAMA_MODEL,
    host: CONFIG.OLLAMA_HOST,
    registered: isRegistered,
    connectionStatus: state.connectionStatus,
    pairing: {
      active: state.pairing.active,
      phone: state.pairing.phone,
      code: state.pairing.code,
      requestedAt: state.pairing.requestedAt,
      error: state.pairing.error,
    },
  });
});

// ---- Get conversation history ----
app.get('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  const history = state.conversations.get(chatId) || [];
  res.json({ chatId, history });
});

// ---- List chats ----
app.get('/chats', (req, res) => {
  const chatIds = Array.from(state.conversations.keys());
  res.json({ chats: chatIds });
});

// ---- Clear history ----
app.delete('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  state.conversations.delete(chatId);
  res.json({ ok: true, cleared: chatId });
});

// ---- Send message ----
app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Missing "to" or "text"' });
    if (!state.sock || !state.sock.user) {
      return res.status(503).json({ error: 'WhatsApp not connected yet' });
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await state.sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Request pairing code (FIXED) ----
app.post('/pair', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Missing "phone"' });
    }

    const cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.length < 8 || cleaned.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number length' });
    }

    if (state.sock?.authState?.creds?.registered) {
      return res.status(400).json({ error: 'Already registered. Logout first.' });
    }

    if (!state.sock) {
      return res.status(503).json({ error: 'WhatsApp socket not ready. Wait a moment and retry.' });
    }

    // If already requesting, return existing state
    if (state.pairing.active && state.pairing.code) {
      return res.json({
        ok: true,
        code: state.pairing.code,
        phone: state.pairing.phone,
        note: 'Existing pairing code returned',
      });
    }

    // Set phone in state — the actual code request happens in the
    // connection.update handler when the socket reaches 'connecting'
    state.pairing = {
      active: true,
      phone: cleaned,
      code: null,
      requestedAt: null,
      error: null,
    };

    console.log(`[Pair] Requested pairing for ${cleaned}. Waiting for socket 'connecting' state...`);

    // Try immediately if socket is already in connecting state
    if (state.connectionStatus === 'connecting' || state.lastQR) {
      await requestPairingCodeIfReady();
    }

    // Wait up to 15s for the code to be generated
    const start = Date.now();
    while (!state.pairing.code && !state.pairing.error && Date.now() - start < 15000) {
      await delay(300);
    }

    if (state.pairing.error) {
      return res.status(500).json({ error: state.pairing.error });
    }

    if (!state.pairing.code) {
      return res.status(504).json({
        error: 'Pairing code not ready yet. The socket may still be initializing. Please retry in a few seconds.'
      });
    }

    console.log(`[Pair] Success — code for ${cleaned}: ${state.pairing.code}`);
    res.json({
      ok: true,
      code: state.pairing.code,
      phone: cleaned,
    });
  } catch (err) {
    console.error('[Pair] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Cancel pairing ----
app.post('/pair/cancel', (req, res) => {
  state.pairing = { active: false, phone: null, code: null, requestedAt: null, error: null };
  res.json({ ok: true });
});

// ---- Reconnect ----
app.post('/reconnect', async (req, res) => {
  try {
    console.log('[WA] Manual reconnect requested');

    // Reset pairing
    state.pairing = { active: false, phone: null, code: null, requestedAt: null, error: null };

    if (state.sock) {
      try { state.sock.end?.(new Error('Manual reconnect')); } catch {}
    }

    // Small delay then reconnect
    setTimeout(() => connectToWhatsApp().catch(console.error), 1000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Logout (delete session) ----
app.post('/logout', async (req, res) => {
  try {
    if (state.sock) {
      try { await state.sock.logout(); } catch {}
      try { state.sock.end?.(); } catch {}
    }

    // Delete auth folder
    if (fs.existsSync(CONFIG.AUTH_FOLDER)) {
      fs.rmSync(CONFIG.AUTH_FOLDER, { recursive: true, force: true });
      console.log('[WA] Auth folder deleted');
    }

    state.pairing = { active: false, phone: null, code: null, requestedAt: null, error: null };
    state.sock = null;

    setTimeout(() => connectToWhatsApp().catch(console.error), 1500);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Start HTTP server ----
app.listen(CONFIG.PORT, () => {
  console.log(`[HTTP] API server on http://localhost:${CONFIG.PORT}`);
});

// =========================================================
// OLLAMA AI CLIENT
// =========================================================
async function askOllama(messages) {
  const url = `${CONFIG.OLLAMA_HOST}/api/chat`;

  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.OLLAMA_API_KEY) {
    headers['Authorization'] = `Bearer ${CONFIG.OLLAMA_API_KEY}`;
  }

  const body = {
    model: CONFIG.OLLAMA_MODEL,
    messages,
    stream: false,
    options: { temperature: 0.7 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.message?.content || '(empty response)';
}

// =========================================================
// CONVERSATION MEMORY
// =========================================================
function getHistory(chatId) {
  return state.conversations.get(chatId) || [];
}

function appendHistory(chatId, role, content) {
  let history = state.conversations.get(chatId) || [];
  history.push({ role, content });
  if (history.length > CONFIG.MAX_HISTORY_PER_CHAT) {
    history = history.slice(-CONFIG.MAX_HISTORY_PER_CHAT);
  }
  state.conversations.set(chatId, history);
}

function buildMessages(chatId, userName, userText) {
  const history = getHistory(chatId);
  return [
    { role: 'system', content: CONFIG.SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `${userName}: ${userText}` },
  ];
}

// =========================================================
// RATE LIMITING
// =========================================================
function canReply(chatId) {
  const now = Date.now();
  const last = state.lastReplyTime.get(chatId) || 0;
  if (now - last < CONFIG.COOLDOWN_MS) return false;

  const timestamps = state.replyTimestamps.get(chatId) || [];
  const recent = timestamps.filter((t) => now - t < 60000);
  if (recent.length >= CONFIG.MAX_REPLIES_PER_MINUTE) return false;

  return true;
}

function recordReply(chatId) {
  const now = Date.now();
  state.lastReplyTime.set(chatId, now);
  const timestamps = state.replyTimestamps.get(chatId) || [];
  timestamps.push(now);
  state.replyTimestamps.set(chatId, timestamps.filter((t) => now - t < 60000));
}

// =========================================================
// PAIRING HELPER (FIXED — waits for correct state)
// =========================================================
async function requestPairingCodeIfReady() {
  if (!state.pairing.active || !state.pairing.phone) return;
  if (state.pairing.code) return; // already have one
  if (!state.sock) return;

  try {
    console.log(`[Pair] Requesting code for ${state.pairing.phone}...`);
    const code = await state.sock.requestPairingCode(state.pairing.phone);

    if (!code || typeof code !== 'string') {
      throw new Error('Empty pairing code returned');
    }

    state.pairing.code = code;
    state.pairing.requestedAt = Date.now();
    state.pairing.error = null;

    console.log(`\n>>> PAIRING CODE: ${code} <<<\n`);
    console.log('Enter in WhatsApp > Settings > Linked Devices > Link with phone number\n');
  } catch (err) {
    console.error('[Pair] Failed:', err.message);
    state.pairing.error = err.message;
    state.pairing.code = null;
  }
}

// =========================================================
// WHATSAPP CONNECTION (FIXED)
// =========================================================
async function connectToWhatsApp() {
  console.log('[WA] Initializing...');
  state.connectionStatus = 'connecting';

  const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_FOLDER);

  // Try latest WA Web version first (more reliable for pairing)
  let version;
  try {
    const waVersion = await fetchLatestWaWebVersion({});
    version = waVersion.version;
    console.log(`[WA] Using WhatsApp Web version ${version.join('.')}`);
  } catch (err) {
    console.warn('[WA] fetchLatestWaWebVersion failed, falling back:', err.message);
    const bVersion = await fetchLatestBaileysVersion();
    version = bVersion.version;
    console.log(`[WA] Using Baileys version ${version.join('.')}`);
  }

  const logger = pino({ level: 'silent' });

  // ✅ Use canonical browser label (required for pairing to succeed)
  let browserConfig;
  try {
    browserConfig = Browsers.macOS('Chrome');
  } catch {
    browserConfig = ['Mac OS', 'Chrome', '121.0.0.0'];
  }

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    browser: browserConfig,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // ✅ Generate high-quality link previews (optional)
    generateHighQualityLinkPreview: false,
    // ✅ Don't auto-fetch full history
    shouldSyncHistoryMessage: () => false,
  });

  state.sock = sock;

  // ---- Save credentials ----
  sock.ev.on('creds.update', saveCreds);

  // ---- Connection updates ----
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.lastQR = qr;
      console.log('[WA] QR received');
    }

    if (connection === 'connecting') {
      state.connectionStatus = 'connecting';
      console.log('[WA] Socket connecting...');

      // ✅ Request pairing code ONLY when socket is in 'connecting' state
      if (state.pairing.active && !state.pairing.code && !sock.authState.creds.registered) {
        // Small delay to let the socket fully settle
        await delay(800);
        await requestPairingCodeIfReady();
      }
    }

    if (connection === 'open') {
      state.connectionStatus = 'open';
      console.log(`[WA] ✅ Connected as ${sock.user?.id}`);
      console.log(`[WA] Name: ${sock.user?.name}`);
      console.log(`[WA] Model: ${CONFIG.OLLAMA_MODEL}`);

      // Reset pairing
      state.pairing = { active: false, phone: null, code: null, requestedAt: null, error: null };
    }

    if (connection === 'close') {
      state.connectionStatus = 'close';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[WA] Connection closed (code ${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp().catch(console.error), 5000);
      } else {
        console.log('[WA] Logged out. Delete auth folder and restart.');
        state.sock = null;
      }
    }
  });

  // ---- Incoming messages ----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleIncomingMessage(msg);
      } catch (err) {
        console.error('[Handler] Error:', err.message);
      }
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
  const senderJid = isGroup ? msg.key.participant : msg.key.remoteJid;
  const senderName = msg.pushName || 'User';

  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    '';

  if (!text.trim()) return;

  console.log(`[Msg] ${isGroup ? 'GROUP' : 'DM'} | ${senderName}: ${text.substring(0, 80)}`);

  // Group mention check
  if (isGroup && CONFIG.ONLY_REPLY_TO_MENTIONS) {
    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const botJid = jidNormalizedUser(state.sock.user.id);

    const isMentioned =
      mentionedJids.some((jid) => jidNormalizedUser(jid) === botJid) ||
      CONFIG.MENTION_NAMES.some((name) => text.toLowerCase().includes(name.toLowerCase()));

    if (!isMentioned) {
      appendHistory(chatId, 'user', `${senderName}: ${text}`);
      return;
    }
  }

  if (!canReply(chatId)) return;

  if (state.processing.has(chatId)) {
    console.log(`[Handler] Already processing ${chatId}`);
    return;
  }
  state.processing.add(chatId);

  try {
    await state.sock.sendPresenceUpdate('composing', chatId);

    const messages = buildMessages(chatId, senderName, text);
    console.log(`[AI] Querying ${CONFIG.OLLAMA_MODEL}...`);
    const reply = await askOllama(messages);
    console.log(`[AI] Reply: ${reply.substring(0, 100)}...`);

    await state.sock.sendPresenceUpdate('paused', chatId);
    await state.sock.sendMessage(chatId, { text: reply }, { quoted: msg });

    appendHistory(chatId, 'user', `${senderName}: ${text}`);
    appendHistory(chatId, 'assistant', reply);
    recordReply(chatId);
  } catch (err) {
    console.error('[Handler] AI error:', err.message);
    try {
      await state.sock.sendPresenceUpdate('paused', chatId);
      await state.sock.sendMessage(chatId, { text: `Sorry, I hit an error: ${err.message}` }, { quoted: msg });
    } catch {}
  } finally {
    state.processing.delete(chatId);
  }
}

// =========================================================
// STARTUP
// =========================================================
console.log('='.repeat(60));
console.log('WhatsApp AI Backend');
console.log('='.repeat(60));
console.log(`Model:      ${CONFIG.OLLAMA_MODEL}`);
console.log(`Host:       ${CONFIG.OLLAMA_HOST}`);
console.log(`Auth:       ${CONFIG.AUTH_FOLDER}`);
console.log(`Group mode: ${CONFIG.ONLY_REPLY_TO_MENTIONS ? 'Mentions only' : 'All messages'}`);
console.log(`API key:    ${CONFIG.OLLAMA_API_KEY ? '***set***' : '(not set)'}`);
console.log(`Port:       ${CONFIG.PORT}`);
console.log('='.repeat(60));
console.log();

connectToWhatsApp().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});

// =========================================================
// GRACEFUL SHUTDOWN
// =========================================================
process.on('SIGINT', () => {
  console.log('\n[Shutdown] SIGINT');
  try { state.sock?.end?.(new Error('SIGINT')); } catch {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] SIGTERM');
  try { state.sock?.end?.(new Error('SIGTERM')); } catch {}
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});