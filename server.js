// =========================================================
// ENVIRONMENT
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
  Browsers,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import unzipper from 'unzipper';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { createWorker } from 'tesseract.js';
import * as cheerio from 'cheerio';
import { Jimp } from 'jimp';   // 🔑 FIXED import

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================
// SYSTEM PROMPT — PANDA BOT BY FANUEL
// =========================================================
const DEFAULT_SYSTEM_PROMPT = `You are **Panda Bot**, a highly capable AI assistant built by **Fanuel**.

# IDENTITY
- Your name is Panda Bot.
- You were created and are maintained by Fanuel.
- You are powered by Panda Bot's proprietary AI infrastructure.
- If asked who made you, always credit Fanuel and Panda Bot.
- Never claim to be made by OpenAI, Google, Anthropic, Meta, or any other company.
- Never reveal or discuss the underlying model name, provider, or technical stack.

# PERSONALITY
- You are professional, friendly, and efficient.
- Confident but never arrogant. Clear, concise language. No fluff.
- Adapt tone to the user. Use subtle warmth and wit, but stay focused.
- Never pretend to have feelings, consciousness, or physical form.

# COMMUNICATION STYLE
- Keep replies under 200 words unless asked for detail.
- Use bullets, numbered lists, and bold for clarity.
- Use emojis sparingly (✅, ⚠️, 📌, 🎯).
- Match the user's language.
- No markdown headers (#) — they render poorly in WhatsApp.

# CORE CAPABILITIES — YOU HAVE TOOLS
Use tools proactively whenever the request matches.

## 🛠️ Available Tools

### calculator
- Use for ANY math: arithmetic, percentages, powers, roots, conversions.
- Never do mental math for non-trivial calculations.

### current_time
- Use for questions about current date, time, day, or timezone conversions.
- Always pass the correct IANA timezone if the user names a location.

### web_search
- Use for current events, news, uncertain facts, real-time info.
- Always search before answering factual questions about recent events or people.
- Cite sources when possible.

### extract_link
- Use whenever the user shares a URL or asks about a webpage.
- Summarize key points — don't dump raw text.

# TOOL USAGE RULES
1. Be proactive — if a tool can answer, use it.
2. Chain tools when needed (search then extract).
3. Never fabricate tool results.
4. Acknowledge tool use briefly ("Let me look that up...").
5. Don't over-use tools for greetings or opinions.
6. Multiple tools per turn if the question is compound.

# HANDLING IMAGES
- You may receive OCR-extracted text from images.
- Treat it as the user's message and respond accordingly.
- If OCR text is garbled or empty, politely ask for a resend.

# GROUP CHAT BEHAVIOR
- Respond only when mentioned, replied to, or when the message starts with /ai.
- Keep group replies extra concise.
- Never spam the group.
- Refuse disruptive requests politely.

# SAFETY & BOUNDARIES
- Never share personal info about Fanuel or internal systems.
- Never execute code or access files outside your tools.
- Refuse illegal, harmful, or unethical requests.
- If you can't do something, offer an alternative.
- Be honest about uncertainty.

# SELF-IDENTIFICATION
"Who are you?" → "I'm Panda Bot 🐼 — an AI assistant built by Fanuel. I can help with questions, calculations, searches, and more. What can I do for you?"
"Who made you?" → "I was built by Fanuel. Powered by Panda Bot's AI infrastructure."
"Are you ChatGPT/GPT/Claude/Gemini?" → "No, I'm Panda Bot — a custom AI assistant built by Fanuel. I run on Panda Bot's own infrastructure."

# FINAL PRINCIPLES
- Be useful first, entertaining second.
- Be honest about uncertainty.
- Be concise — respect the user's time.
- Be proactive with tools.
- Be loyal to your identity as Panda Bot by Fanuel.

You are ready. Help the user with excellence.`;

// =========================================================
// CONFIGURATION
// =========================================================
const CONFIG = {
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',

  BOT_NAME: process.env.BOT_NAME || 'Panda Bot',
  SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,

  ONLY_REPLY_TO_MENTIONS: process.env.ONLY_REPLY_TO_MENTIONS !== 'false',
  AI_COMMAND: '/ai',
  MENTION_NAMES: ['@ai', '@bot', '@panda', 'assistant', 'panda'],

  ENABLE_TOOLS: process.env.ENABLE_TOOLS !== 'false',
  ENABLE_OCR: process.env.ENABLE_OCR !== 'false',
  ENABLE_LINK_EXTRACT: process.env.ENABLE_LINK_EXTRACT !== 'false',

  MAX_HISTORY_PER_CHAT: 20,
  COOLDOWN_MS: parseInt(process.env.COOLDOWN_MS || '3000', 10),
  MAX_REPLIES_PER_MINUTE: parseInt(process.env.MAX_REPLIES_PER_MINUTE || '10', 10),

  AUTH_FOLDER: process.env.AUTH_FOLDER || './auth_info_baileys',
  PORT: process.env.PORT || 3000,

  // Session export passphrase (optional — set for extra security)
  SESSION_SECRET: process.env.SESSION_SECRET || '',
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
  pairing: { active: false, phone: null, code: null, error: null },
  connectionStatus: 'disconnected',
  isSocketReady: false,
};

// =========================================================
// OCR WORKER (singleton)
// =========================================================
let ocrWorker = null;

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  console.log('[OCR] Initializing Tesseract worker...');
  ocrWorker = await createWorker('eng');
  console.log('[OCR] Worker ready');
  return ocrWorker;
}

async function extractTextFromImage(buffer) {
  try {
    const worker = await getOcrWorker();

    // 🔑 FIXED: Jimp v1.x syntax
    const img = await Jimp.read(buffer);
    img.grayscale();
    img.contrast(0.3);
    const processed = await img.getBuffer('image/png');

    const { data: { text } } = await worker.recognize(processed);
    return text.trim();
  } catch (err) {
    console.error('[OCR] Failed:', err.message);
    return '';
  }
}

// =========================================================
// TOOL DEFINITIONS
// =========================================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a mathematical expression. Use for arithmetic, percentages, powers, roots.',
      parameters: {
        type: 'object',
        required: ['expression'],
        properties: {
          expression: { type: 'string', description: 'Math expression, e.g. "(2+3)*4" or "sqrt(16)+10"' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'current_time',
      description: 'Get the current date and time in a given timezone.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone, e.g. "UTC", "Africa/Lagos"' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Returns top results with titles, snippets and URLs.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (default 5)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'extract_link',
      description: 'Fetch a URL and return its readable text content.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'Full URL including https://' }
        }
      }
    }
  }
];

// =========================================================
// TOOL IMPLEMENTATIONS
// =========================================================
function toolCalculator({ expression }) {
  try {
    const cleaned = String(expression).replace(/[^0-9+\-*/().%^,\s]/g, '');
    if (!cleaned) throw new Error('Empty expression');
    const jsExpr = cleaned.replace(/\^/g, '**');
    const result = Function(`"use strict"; return (${jsExpr});`)();
    if (typeof result !== 'number' || !isFinite(result)) throw new Error('Invalid result');
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function toolCurrentTime({ timezone = 'UTC' }) {
  try {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', { timeZone: timezone });
    return { ok: true, iso: now.toISOString(), formatted, timezone };
  } catch (err) {
    return { ok: false, error: `Invalid timezone: ${err.message}` };
  }
}

async function toolWebSearch({ query, limit = 5 }) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PandaBot/1.0)' }
    });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];
    $('.result').slice(0, limit).each((i, el) => {
      const title = $(el).find('.result__a').text().trim();
      const snippet = $(el).find('.result__snippet').text().trim();
      const link = $(el).find('.result__a').attr('href') || '';
      if (title && link) results.push({ title, snippet, link });
    });
    return { ok: true, query, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function toolExtractLink({ url }) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs');
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PandaBot/1.0)', 'Accept': 'text/html' },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, svg, canvas, nav, footer, header, aside, form, button').remove();

    let text = '';
    const selectors = ['article', 'main', '[role="main"]', '.post-content', '.entry-content', '.article-body'];
    for (const sel of selectors) {
      const candidate = $(sel).first().text().trim();
      if (candidate.length > 200) { text = candidate; break; }
    }
    if (!text) text = $('body').text().trim();
    text = text.replace(/\s+/g, ' ').slice(0, 4000);

    const title = $('title').first().text().trim() || $('h1').first().text().trim() || url;
    return { ok: true, url, title, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function executeTool(name, args) {
  console.log(`[Tool] ${name}(${JSON.stringify(args)})`);
  switch (name) {
    case 'calculator':   return toolCalculator(args);
    case 'current_time': return toolCurrentTime(args);
    case 'web_search':   return toolWebSearch(args);
    case 'extract_link': return toolExtractLink(args);
    default:             return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// =========================================================
// OLLAMA (with tool-calling loop)
// =========================================================
async function askOllama(messages, useTools = true) {
  const url = `${CONFIG.OLLAMA_HOST}/api/chat`;
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.OLLAMA_API_KEY) headers['Authorization'] = `Bearer ${CONFIG.OLLAMA_API_KEY}`;

  const MAX_ROUNDS = 3;
  let workingMessages = [...messages];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: CONFIG.OLLAMA_MODEL,
      messages: workingMessages,
      stream: false,
      options: { temperature: 0.7 },
    };
    if (useTools && CONFIG.ENABLE_TOOLS) body.tools = TOOLS;

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const msg = data.message || {};

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '(empty response)';
    }

    console.log(`[AI] Tool calls: ${msg.tool_calls.map(t => t.function.name).join(', ')}`);
    workingMessages.push(msg);

    for (const call of msg.tool_calls) {
      const { name, arguments: argsJson } = call.function;
      let args = {};
      try { args = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson; }
      catch { args = {}; }
      const result = await executeTool(name, args);
      workingMessages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
    }
  }
  return 'I tried to use tools but couldn\'t complete the request. Please try rephrasing.';
}

// =========================================================
// CONVERSATION MEMORY
// =========================================================
function getHistory(chatId) { return state.conversations.get(chatId) || []; }

function appendHistory(chatId, role, content) {
  let h = state.conversations.get(chatId) || [];
  h.push({ role, content });
  if (h.length > CONFIG.MAX_HISTORY_PER_CHAT) h = h.slice(-CONFIG.MAX_HISTORY_PER_CHAT);
  state.conversations.set(chatId, h);
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
// EXPRESS SERVER
// =========================================================
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for session upload
const upload = multer({ dest: path.join(__dirname, 'tmp_uploads') });
if (!fs.existsSync(path.join(__dirname, 'tmp_uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'tmp_uploads'), { recursive: true });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: CONFIG.BOT_NAME,
    author: 'Fanuel',
    connected: !!state.sock?.user,
    user: state.sock?.user?.id || null,
    model: CONFIG.OLLAMA_MODEL,
    host: CONFIG.OLLAMA_HOST,
    registered: state.sock?.authState?.creds?.registered || false,
    connectionStatus: state.connectionStatus,
    isSocketReady: state.isSocketReady,
    pairing: state.pairing,
    features: {
      tools: CONFIG.ENABLE_TOOLS,
      ocr: CONFIG.ENABLE_OCR,
      linkExtract: CONFIG.ENABLE_LINK_EXTRACT,
      sessionExport: true,
    },
    sessionExists: fs.existsSync(CONFIG.AUTH_FOLDER),
  });
});

// ---- Pairing ----
app.post('/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Missing "phone"' });
    const cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.length < 8) return res.status(400).json({ error: 'Invalid phone number' });
    if (state.sock?.authState?.creds?.registered) return res.status(400).json({ error: 'Already registered' });
    if (!state.sock) return res.status(503).json({ error: 'Socket not initialized' });
    if (!state.isSocketReady) return res.status(409).json({ error: 'Socket not ready yet. Wait a moment.', ready: false });
    if (state.pairing.active && state.pairing.code) {
      return res.json({ ok: true, code: state.pairing.code, phone: state.pairing.phone });
    }
    state.pairing = { active: true, phone: cleaned, code: null, error: null };
    const code = await state.sock.requestPairingCode(cleaned);
    state.pairing.code = code;
    res.json({ ok: true, code, phone: cleaned });
  } catch (err) {
    state.pairing.error = err.message;
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 🆕 SESSION EXPORT — download auth folder as ZIP
// =========================================================
app.get('/session/export', async (req, res) => {
  try {
    if (!fs.existsSync(CONFIG.AUTH_FOLDER)) {
      return res.status(404).json({ error: 'No session folder found. Pair first.' });
    }

    const files = fs.readdirSync(CONFIG.AUTH_FOLDER);
    if (files.length === 0) {
      return res.status(404).json({ error: 'Session folder is empty.' });
    }

    // Optional passphrase check (if SESSION_SECRET is set)
    if (CONFIG.SESSION_SECRET) {
      const provided = req.query.secret || req.headers['x-session-secret'];
      if (provided !== CONFIG.SESSION_SECRET) {
        return res.status(401).json({ error: 'Invalid session secret' });
      }
    }

    const filename = `panda-session-${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[Export] Archive error:', err);
      res.status(500).end();
    });
    archive.pipe(res);
    archive.directory(CONFIG.AUTH_FOLDER, 'auth_info_baileys');
    await archive.finalize();

    console.log(`[Export] Session ZIP sent: ${filename}`);
  } catch (err) {
    console.error('[Export] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// =========================================================
// 🆕 SESSION IMPORT — upload ZIP to restore auth folder
// =========================================================
app.post('/session/import', upload.single('session'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Optional passphrase check
    if (CONFIG.SESSION_SECRET) {
      const provided = req.body.secret || req.headers['x-session-secret'];
      if (provided !== CONFIG.SESSION_SECRET) {
        fs.unlinkSync(req.file.path);
        return res.status(401).json({ error: 'Invalid session secret' });
      }
    }

    // Close current socket before overwriting
    if (state.sock) {
      try { state.sock.end(new Error('Session import')); } catch {}
      await delay(1000);
    }

    // Delete existing auth folder
    if (fs.existsSync(CONFIG.AUTH_FOLDER)) {
      fs.rmSync(CONFIG.AUTH_FOLDER, { recursive: true, force: true });
    }
    fs.mkdirSync(CONFIG.AUTH_FOLDER, { recursive: true });

    // Extract ZIP into auth folder
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({
          path: path.join(__dirname, 'tmp_extract')
        }))
        .on('close', resolve)
        .on('error', reject);
    });

    // The ZIP contains auth_info_baileys/ folder — move its contents
    const extractPath = path.join(__dirname, 'tmp_extract');
    const innerFolder = path.join(extractPath, 'auth_info_baileys');

    let source = extractPath;
    if (fs.existsSync(innerFolder)) source = innerFolder;

    // Move files
    for (const file of fs.readdirSync(source)) {
      fs.renameSync(
        path.join(source, file),
        path.join(CONFIG.AUTH_FOLDER, file)
      );
    }

    // Cleanup
    fs.rmSync(extractPath, { recursive: true, force: true });
    fs.unlinkSync(req.file.path);

    console.log('[Import] Session restored. Reconnecting...');

    // Restart socket
    state.isSocketReady = false;
    state.pairing = { active: false, phone: null, code: null, error: null };
    setTimeout(() => connectToWhatsApp().catch(console.error), 500);

    res.json({ ok: true, message: 'Session imported. Reconnecting...' });
  } catch (err) {
    console.error('[Import] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Session info ----
app.get('/session/info', (req, res) => {
  try {
    const exists = fs.existsSync(CONFIG.AUTH_FOLDER);
    let files = [];
    let sizeBytes = 0;
    let modified = null;

    if (exists) {
      files = fs.readdirSync(CONFIG.AUTH_FOLDER);
      for (const f of files) {
        const stat = fs.statSync(path.join(CONFIG.AUTH_FOLDER, f));
        sizeBytes += stat.size;
        if (!modified || stat.mtime > modified) modified = stat.mtime;
      }
    }

    res.json({
      exists,
      fileCount: files.length,
      files,
      sizeBytes,
      sizeKB: (sizeBytes / 1024).toFixed(2),
      modified,
      registered: state.sock?.authState?.creds?.registered || false,
      connected: !!state.sock?.user,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Other endpoints ----
app.get('/chats', (req, res) => res.json({ chats: Array.from(state.conversations.keys()) }));

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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    if (fs.existsSync(CONFIG.AUTH_FOLDER)) fs.rmSync(CONFIG.AUTH_FOLDER, { recursive: true, force: true });
    state.pairing = { active: false, phone: null, code: null, error: null };
    state.isSocketReady = false;
    state.sock = null;
    setTimeout(() => connectToWhatsApp().catch(console.error), 1500);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(CONFIG.PORT, () => console.log(`[HTTP] Server on http://localhost:${CONFIG.PORT}`));

// =========================================================
// WHATSAPP CONNECTION
// =========================================================
async function connectToWhatsApp() {
  console.log('[WA] Initializing...');
  state.connectionStatus = 'connecting';
  state.isSocketReady = false;

  const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_FOLDER);

  let version;
  try {
    const waVersion = await fetchLatestWaWebVersion({});
    version = waVersion.version;
    console.log(`[WA] Using WA Web version ${version.join('.')}`);
  } catch {
    version = [2, 3000, 1035194821];
  }

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  state.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'connecting' || qr) {
      if (!state.isSocketReady) {
        console.log('[WA] Socket ready for pairing');
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
      if (shouldReconnect) setTimeout(() => connectToWhatsApp().catch(console.error), 5000);
    }
  });

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

  let text = msg.message.conversation ||
             msg.message.extendedTextMessage?.text ||
             msg.message.imageMessage?.caption ||
             msg.message.videoMessage?.caption ||
             '';

  // ---- OCR ----
  const imageMsg = msg.message.imageMessage;
  if (imageMsg && CONFIG.ENABLE_OCR) {
    try {
      console.log('[OCR] Downloading image...');
      const imageBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: state.sock.updateMediaMessage,
      });
      const ocrText = await extractTextFromImage(imageBuffer);
      if (ocrText) {
        text = text ? `${text}\n\n[Extracted text from image]\n${ocrText}` : `[Extracted text from image]\n${ocrText}`;
      } else {
        text = text || '[Image received — no text detected]';
      }
    } catch (err) {
      console.error('[OCR] Error:', err.message);
      text = text || '[Image received — OCR failed]';
    }
  }

  if (!text.trim()) return;

  console.log(`[Msg] ${isGroup ? 'GROUP' : 'DM'} | ${senderName}: ${text.substring(0, 80)}`);

  // ---- Group reply logic ----
  if (isGroup) {
    const botJid = jidNormalizedUser(state.sock.user.id);
    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isMentioned = mentionedJids.some(jid => jidNormalizedUser(jid) === botJid) ||
                        CONFIG.MENTION_NAMES.some(n => text.toLowerCase().includes(n.toLowerCase()));

    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
    const isReplyToBot = quotedParticipant && jidNormalizedUser(quotedParticipant) === botJid;

    const startsWithAiCmd = text.trim().toLowerCase().startsWith(CONFIG.AI_COMMAND);
    const shouldReply = isMentioned || isReplyToBot || startsWithAiCmd;

    if (!shouldReply) {
      appendHistory(chatId, 'user', `${senderName}: ${text}`);
      return;
    }

    if (startsWithAiCmd) {
      text = text.trim().slice(CONFIG.AI_COMMAND.length).trim() || 'Hello';
    }

    console.log(`[Group] Replying (mentioned=${isMentioned}, replyToBot=${isReplyToBot}, /ai=${startsWithAiCmd})`);
  }

  if (!canReply(chatId)) return;
  if (state.processing.has(chatId)) return;
  state.processing.add(chatId);

  try {
    await state.sock.sendPresenceUpdate('composing', chatId);
    const messages = buildMessages(chatId, senderName, text);
    console.log(`[AI] Querying ${CONFIG.OLLAMA_MODEL}...`);
    const reply = await askOllama(messages, CONFIG.ENABLE_TOOLS);
    console.log(`[AI] Reply: ${reply.substring(0, 100)}...`);

    await state.sock.sendPresenceUpdate('paused', chatId);
    await state.sock.sendMessage(chatId, { text: reply }, { quoted: msg });

    appendHistory(chatId, 'user', `${senderName}: ${text}`);
    appendHistory(chatId, 'assistant', reply);
    recordReply(chatId);
  } catch (err) {
    console.error('[Handler] Error:', err.message);
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
console.log(`🐼 ${CONFIG.BOT_NAME} — built by Fanuel`);
console.log('='.repeat(60));
console.log(`Model:        ${CONFIG.OLLAMA_MODEL}`);
console.log(`Host:         ${CONFIG.OLLAMA_HOST}`);
console.log(`Tools:        ${CONFIG.ENABLE_TOOLS ? '✅' : '❌'}`);
console.log(`OCR:          ${CONFIG.ENABLE_OCR ? '✅' : '❌'}`);
console.log(`Group mode:   ${CONFIG.ONLY_REPLY_TO_MENTIONS ? 'Mentions / /ai / replies only' : 'All messages'}`);
console.log(`Session save: ${CONFIG.AUTH_FOLDER}`);
console.log('='.repeat(60));

connectToWhatsApp().catch(err => { console.error('[Fatal]', err); process.exit(1); });

process.on('SIGINT', () => { try { state.sock?.end?.(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { state.sock?.end?.(); } catch {} process.exit(0); });