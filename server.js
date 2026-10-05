import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  isJidGroup,
  delay
} from '@whiskeysockets/baileys';
import express from 'express';
import readline from 'readline';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// =========================================================
// CONFIGURATION
// =========================================================
const CONFIG = {
  // Ollama Cloud / Local settings
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',

  // Bot behavior
  BOT_NAME: 'My AI Assistant',
  SYSTEM_PROMPT: 'You are a helpful, concise AI assistant on WhatsApp. Keep replies short (under 200 words). If someone asks you to do a task, confirm what you will do.',

  // Group behavior
  ONLY_REPLY_TO_MENTIONS: true,
  MENTION_NAMES: ['@ai', '@bot', 'assistant'],

  // Rate limiting
  MAX_HISTORY_PER_CHAT: 20,
  COOLDOWN_MS: 3000, // Min time between replies per chat
  MAX_REPLIES_PER_MINUTE: 10,

  // Session
  AUTH_FOLDER: './auth_info_baileys',
  PORT: process.env.PORT || 3000,
};

// =========================================================
// STATE (In-Memory Storage)
// =========================================================
const state = {
  sock: null,
  // { chatId: [{ role: 'user'|'assistant', content: string }] }
  conversations: new Map(),
  // { chatId: timestamp }
  lastReplyTime: new Map(),
  // { chatId: [timestamps] }
  replyTimestamps: new Map(),
  // Prevent concurrent processing per chat
  processing: new Set(),
};

// =========================================================
// EXPRESS SERVER (Minimal API)
// =========================================================
const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: state.sock?.user ? true : false,
    user: state.sock?.user?.id || null,
    model: CONFIG.OLLAMA_MODEL,
  });
});

// Get conversation history for a chat
app.get('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  const history = state.conversations.get(chatId) || [];
  res.json({ chatId, history });
});

// Clear conversation history for a chat
app.delete('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  state.conversations.delete(chatId);
  res.json({ ok: true, cleared: chatId });
});

// Send a message manually (useful for testing)
app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Missing "to" or "text"' });
    if (!state.sock) return res.status(503).json({ error: 'WhatsApp not connected yet' });

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await state.sock.sendMessage(jid, { text });
    res.json({ ok: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    options: {
      temperature: 0.7,
    },
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

  // Trim to max size
  if (history.length > CONFIG.MAX_HISTORY_PER_CHAT) {
    history = history.slice(-CONFIG.MAX_HISTORY_PER_CHAT);
  }
  state.conversations.set(chatId, history);
}

function buildMessages(chatId, userName, userText) {
  const history = getHistory(chatId);
  const messages = [
    { role: 'system', content: CONFIG.SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `${userName}: ${userText}` },
  ];
  return messages;
}

// =========================================================
// RATE LIMITING
// =========================================================
function canReply(chatId) {
  const now = Date.now();

  // Cooldown check
  const last = state.lastReplyTime.get(chatId) || 0;
  if (now - last < CONFIG.COOLDOWN_MS) {
    console.log(`[RateLimit] Cooldown active for ${chatId}`);
    return false;
  }

  // Per-minute cap
  const timestamps = state.replyTimestamps.get(chatId) || [];
  const recent = timestamps.filter((t) => now - t < 60000);
  if (recent.length >= CONFIG.MAX_REPLIES_PER_MINUTE) {
    console.log(`[RateLimit] Minute cap reached for ${chatId}`);
    return false;
  }

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
// WHATSAPP CONNECTION
// =========================================================
async function connectToWhatsApp() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_FOLDER);

  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WA] Using WhatsApp version ${version.join('.')}`);

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  state.sock = sock;

  // ---- Save credentials ----
  sock.ev.on('creds.update', saveCreds);

  // ---- Connection updates ----
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Pairing code flow
    if (qr && !sock.authState.creds.registered) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const question = (text) => new Promise((resolve) => rl.question(text, resolve));

      console.log('\n[WA] QR received but pairing code mode is active.');
      const rawNumber = await question('Enter your phone number (digits only, with country code): ');
      const phoneNumber = rawNumber.replace(/\D/g, '');

      if (!phoneNumber) {
        console.log('[WA] Invalid phone number. Restart and try again.');
        process.exit(1);
      }

      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n>>> PAIRING CODE: ${code} <<<\n`);
        console.log('Enter this in WhatsApp > Settings > Linked Devices > Link with phone number\n');
      } catch (err) {
        console.error('[WA] Failed to request pairing code:', err.message);
      }

      rl.close();
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[WA] Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('[WA] Logged out. Delete auth folder and restart.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log(`[WA] Connected as ${sock.user?.id}`);
      console.log(`[WA] Name: ${sock.user?.name}`);
      console.log(`[WA] Model: ${CONFIG.OLLAMA_MODEL}`);
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
  // Ignore if no content or sent by us
  if (!msg.message || msg.key.fromMe) return;

  const chatId = msg.key.remoteJid;
  const isGroup = isJidGroup(chatId);
  const senderJid = isGroup ? msg.key.participant : msg.key.remoteJid;
  const senderName = msg.pushName || 'User';

  // Extract text content
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    '';

  if (!text.trim()) return;

  console.log(`[Msg] ${isGroup ? 'GROUP' : 'DM'} | ${senderName} (${senderJid}): ${text.substring(0, 80)}`);

  // ---- Group mention check ----
  if (isGroup && CONFIG.ONLY_REPLY_TO_MENTIONS) {
    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const botJid = jidNormalizedUser(state.sock.user.id);

    const isMentioned =
      mentionedJids.some((jid) => jidNormalizedUser(jid) === botJid) ||
      CONFIG.MENTION_NAMES.some((name) => text.toLowerCase().includes(name.toLowerCase()));

    if (!isMentioned) {
      // Store message in history silently but don't reply
      appendHistory(chatId, 'user', `${senderName}: ${text}`);
      return;
    }
  }

  // ---- Rate limit check ----
  if (!canReply(chatId)) return;

  // ---- Prevent concurrent processing ----
  if (state.processing.has(chatId)) {
    console.log(`[Handler] Already processing ${chatId}, skipping`);
    return;
  }
  state.processing.add(chatId);

  try {
    // Typing indicator
    await state.sock.sendPresenceUpdate('composing', chatId);

    // Build messages with history
    const messages = buildMessages(chatId, senderName, text);

    // Ask Ollama
    console.log(`[AI] Querying ${CONFIG.OLLAMA_MODEL}...`);
    const reply = await askOllama(messages);
    console.log(`[AI] Reply: ${reply.substring(0, 100)}...`);

    // Send reply
    await state.sock.sendMessage(chatId, { text: reply }, { quoted: msg });

    // Update history
    appendHistory(chatId, 'user', `${senderName}: ${text}`);
    appendHistory(chatId, 'assistant', reply);

    // Record rate limit
    recordReply(chatId);
  } catch (err) {
    console.error('[Handler] AI error:', err.message);
    try {
      await state.sock.sendMessage(chatId, {
        text: `Sorry, I hit an error: ${err.message}`,
      }, { quoted: msg });
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
console.log('='.repeat(60));
console.log();

connectToWhatsApp().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});