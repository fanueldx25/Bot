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
  // Pairing state
  pairing: {
    active: false,
    phone: null,
    code: null,
    requestedAt: null,
  },
};

// =========================================================
// EXPRESS SERVER
// =========================================================
const app = express();
app.use(express.json());

// ---- Serve frontend (must come before API routes) ----
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Root → dashboard
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
          <p>Dashboard not found at <code>public/index.html</code>.</p>
          <p>API endpoints available:</p>
          <ul>
            <li><a href="/health" style="color:#3b82f6">GET /health</a></li>
            <li>GET /history/:chatId</li>
            <li>DELETE /history/:chatId</li>
            <li>POST /send</li>
            <li>POST /pair</li>
          </ul>
        </body>
      </html>
    `);
  }
});

// ---- Health check ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: state.sock?.user ? true : false,
    user: state.sock?.user?.id || null,
    name: state.sock?.user?.name || null,
    model: CONFIG.OLLAMA_MODEL,
    host: CONFIG.OLLAMA_HOST,
    pairing: {
      active: state.pairing.active,
      phone: state.pairing.phone,
      code: state.pairing.code,
    },
  });
});

// ---- Get conversation history for a chat ----
app.get('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  const history = state.conversations.get(chatId) || [];
  res.json({ chatId, history });
});

// ---- List all known chats ----
app.get('/chats', (req, res) => {
  const chatIds = Array.from(state.conversations.keys());
  res.json({ chats: chatIds });
});

// ---- Clear conversation history for a chat ----
app.delete('/history/:chatId', (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  state.conversations.delete(chatId);
  res.json({ ok: true, cleared: chatId });
});

// ---- Send a message manually ----
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

// ---- Request pairing code (from frontend) ----
app.post('/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Missing "phone"' });
    if (!state.sock) return res.status(503).json({ error: 'WhatsApp socket not ready' });
    if (state.sock.authState?.creds?.registered) {
      return res.status(400).json({ error: 'Already registered' });
    }

    const cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.length < 8) {
      return res.status(400).json({ error: 'Phone number too short' });
    }

    const code = await state.sock.requestPairingCode(cleaned);

    state.pairing = {
      active: true,
      phone: cleaned,
      code,
      requestedAt: Date.now(),
    };

    console.log(`[WA] Pairing code for ${cleaned}: ${code}`);
    res.json({ ok: true, code, phone: cleaned });
  } catch (err) {
    console.error('[WA] Pairing request failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Reconnect endpoint ----
app.post('/reconnect', async (req, res) => {
  try {
    console.log('[WA] Manual reconnect requested');
    if (state.sock) {
      try { state.sock.end?.(); } catch {}
    }
    setTimeout(() => connectToWhatsApp().catch(console.error), 500);
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
  if (now - last < CONFIG.COOLDOWN_MS) {
    console.log(`[RateLimit] Cooldown active for ${chatId}`);
    return false;
  }

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

    // QR received → if not registered and no pairing code active, show QR in logs
    if (qr && !sock.authState.creds.registered) {
      console.log('\n[WA] QR received. Use the /pair endpoint or scan the QR below.');
      console.log('[WA] (Pairing code is the recommended flow on Render.)\n');

      // Optional: still allow terminal pairing if running locally
      if (process.stdin.isTTY && !state.pairing.active) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (text) => new Promise((resolve) => rl.question(text, resolve));

        const rawNumber = await question('Enter your phone number (digits only, with country code): ');
        const phoneNumber = rawNumber.replace(/\D/g, '');

        if (phoneNumber) {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            state.pairing = {
              active: true,
              phone: phoneNumber,
              code,
              requestedAt: Date.now(),
            };
            console.log(`\n>>> PAIRING CODE: ${code} <<<\n`);
            console.log('Enter this in WhatsApp > Settings > Linked Devices > Link with phone number\n');
          } catch (err) {
            console.error('[WA] Failed to request pairing code:', err.message);
          }
        }
        rl.close();
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[WA] Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('[WA] Logged out. Delete auth folder and restart.');
      }
    }

    if (connection === 'open') {
      console.log(`[WA] Connected as ${sock.user?.id}`);
      console.log(`[WA] Name: ${sock.user?.name}`);
      console.log(`[WA] Model: ${CONFIG.OLLAMA_MODEL}`);

      // Reset pairing state
      state.pairing = {
        active: false,
        phone: null,
        code: null,
        requestedAt: null,
      };
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

  console.log(
    `[Msg] ${isGroup ? 'GROUP' : 'DM'} | ${senderName} (${senderJid}): ${text.substring(0, 80)}`
  );

  // ---- Group mention check ----
  if (isGroup && CONFIG.ONLY_REPLY_TO_MENTIONS) {
    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const botJid = jidNormalizedUser(state.sock.user.id);

    const isMentioned =
      mentionedJids.some((jid) => jidNormalizedUser(jid) === botJid) ||
      CONFIG.MENTION_NAMES.some((name) => text.toLowerCase().includes(name.toLowerCase()));

    if (!isMentioned) {
      // Store in history silently but don't reply
      appendHistory(chatId, 'user', `${senderName}: ${text}`);
      return;
    }
  }

  // ---- Rate limit ----
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

    const messages = buildMessages(chatId, senderName, text);

    console.log(`[AI] Querying ${CONFIG.OLLAMA_MODEL}...`);
    const reply = await askOllama(messages);
    console.log(`[AI] Reply: ${reply.substring(0, 100)}...`);

    // Stop typing
    await state.sock.sendPresenceUpdate('paused', chatId);

    // Send reply
    await state.sock.sendMessage(chatId, { text: reply }, { quoted: msg });

    // Update history
    appendHistory(chatId, 'user', `${senderName}: ${text}`);
    appendHistory(chatId, 'assistant', reply);

    recordReply(chatId);
  } catch (err) {
    console.error('[Handler] AI error:', err.message);
    try {
      await state.sock.sendPresenceUpdate('paused', chatId);
      await state.sock.sendMessage(
        chatId,
        { text: `Sorry, I hit an error: ${err.message}` },
        { quoted: msg }
      );
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
  console.log('\n[Shutdown] SIGINT received');
  try { state.sock?.end?.(); } catch {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] SIGTERM received');
  try { state.sock?.end?.(); } catch {}
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});