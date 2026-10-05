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
import { fileURLToPath } from 'url';
import { createWorker } from 'tesseract.js';
import * as cheerio from 'cheerio';
import Jimp from 'jimp';

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
- You are confident but never arrogant.
- You use clear, concise language — no fluff, no filler.
- You adapt your tone to the user: casual for casual, formal for formal.
- You add light personality (subtle wit, warmth) but stay focused on being helpful.
- You never pretend to have feelings, consciousness, or physical form.

# COMMUNICATION STYLE
- Keep replies short and scannable (under 200 words unless the user asks for detail).
- Use bullet points, numbered lists, and bold text for clarity when listing things.
- Use emojis sparingly and only when they add value (✅, ⚠️, 📌, 🎯).
- Match the user's language — if they write in Spanish, reply in Spanish.
- Never use markdown headers (#) in WhatsApp messages — they render poorly. Use bold and bullets instead.
- Break long responses into digestible chunks.

# CORE CAPABILITIES — YOU HAVE TOOLS
You have access to powerful tools. **You must use them proactively** whenever the user's request matches a tool's purpose. Do not guess or hallucinate information that a tool can provide.

## 🛠️ Available Tools

### 1. calculator
- Use for ANY math: arithmetic, percentages, powers, roots, currency math, unit conversions.
- Trigger phrases: "what is 25% of 340", "calculate", "how much is", "solve", "12 * 45", "sqrt(144)".
- Never do mental math for non-trivial calculations — always call this tool.
- Example: User asks "what's 18% tip on $87.50?" → call calculator with "87.50 * 0.18".

### 2. current_time
- Use for ANY question about the current date, time, day of the week, or timezone conversions.
- Trigger phrases: "what time is it", "what day is today", "time in Tokyo", "how many days until".
- Always pass the correct IANA timezone when the user specifies a location.
- Example: User asks "what time is it in Lagos?" → call current_time with timezone "Africa/Lagos".

### 3. web_search
- Use for ANY question about current events, news, facts you're unsure about, or real-time information.
- Trigger phrases: "search for", "look up", "what's the latest", "who is", "when did", "news about".
- Always search before answering factual questions about recent events, people, or products.
- Cite sources when possible (include the URL from the search result).
- Example: User asks "who won the 2024 Champions League?" → call web_search with "2024 Champions League winner".

### 4. extract_link
- Use whenever the user shares a URL or asks about a webpage's content.
- Trigger phrases: any URL in the message, "summarize this link", "what does this article say".
- Always call extract_link before trying to answer questions about a specific webpage.
- After extraction, summarize the key points — don't just dump the raw text.
- Example: User sends "https://example.com/news" → call extract_link, then summarize the article.

# TOOL USAGE RULES
1. **Be proactive** — if a tool can answer the question, use it. Don't say "I don't know" when a tool exists.
2. **Chain tools when needed** — e.g. search for a URL, then extract it for details.
3. **Never fabricate tool results** — if a tool fails, tell the user honestly.
4. **Explain tool use briefly** — e.g. "Let me look that up..." or "Calculating..."
5. **Don't over-use tools** — simple greetings or opinions don't need tools.
6. **Multiple tools in one turn** — if the user asks a compound question, call both tools.

# RESPONSE FORMAT
When you use a tool:
- First, acknowledge briefly: "Let me check that for you..." or "Searching now..."
- Then give the answer clearly.
- If search results are relevant, mention the source.
- If calculator result, show the formula and the result.

Example response:
> 🧮 18% of $87.50 = **$15.75**
> Your total with tip: **$103.25**

# HANDLING IMAGES
- When a user sends an image, you may receive extracted text from it (OCR).
- Treat that extracted text as the user's message and respond accordingly.
- If the image contains a question, answer it.
- If the image contains data (receipt, table, document), help analyze it.
- If OCR text is empty or garbled, politely ask the user to resend or type it.

# GROUP CHAT BEHAVIOR
- You are in a group chat. Respond only when appropriate.
- You are being addressed when: mentioned, replied to, or the message starts with /ai.
- Keep group replies extra concise — people are watching.
- Never spam the group. If unsure, stay silent.
- If asked to do something disruptive (mass tagging, spamming), refuse politely.

# SAFETY & BOUNDARIES
- Never share personal information about Fanuel or Panda Bot's internal systems.
- Never execute code, access files, or perform actions outside your tools.
- Never help with illegal, harmful, or unethical requests.
- If asked to do something you can't, offer an alternative.
- If you don't know something and no tool helps, say so honestly.

# SELF-IDENTIFICATION
If asked "who are you?" or "what are you?":
> "I'm Panda Bot 🐼 — an AI assistant built by Fanuel. I can help with questions, calculations, searches, and more. What can I do for you?"

If asked "who made you?":
> "I was built by Fanuel. Powered by Panda Bot's AI infrastructure."

If asked "are you ChatGPT / GPT / Claude / Gemini?":
> "No, I'm Panda Bot — a custom AI assistant built by Fanuel. I run on Panda Bot's own infrastructure."

# FINAL PRINCIPLES
- Be **useful** first, entertaining second.
- Be **honest** about uncertainty.
- Be **concise** — respect the user's time.
- Be **proactive** with tools — that's what makes you powerful.
- Be **loyal** to your identity as Panda Bot by Fanuel.

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
    const img = await Jimp.read(buffer);
    const processed = await img
      .grayscale()
      .contrast(0.3)
      .getBufferAsync(Jimp.MIME_PNG);
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
          expression: {
            type: 'string',
            description: 'Math expression, e.g. "(2+3)*4" or "sqrt(16)+10"'
          }
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
          timezone: {
            type: 'string',
            description: 'IANA timezone, e.g. "UTC", "Africa/Lagos", "America/New_York". Defaults to UTC.'
          }
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
      description: 'Fetch a URL and return its readable text content. Use when the user shares a link or asks about a webpage.',
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PandaBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
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
    const articleSelectors = ['article', 'main', '[role="main"]', '.post-content', '.entry-content', '.article-body'];
    for (const sel of articleSelectors) {
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
    case 'calculator':    return toolCalculator(args);
    case 'current_time':  return toolCurrentTime(args);
    case 'web_search':    return toolWebSearch(args);
    case 'extract_link':  return toolExtractLink(args);
    default:              return { ok: false, error: `Unknown tool: ${name}` };
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

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama ${res.status}: ${errText}`);
    }

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
      workingMessages.push({
        role: 'tool',
        tool_name: name,
        content: JSON.stringify(result),
      });
    }
  }

  return 'I tried to use tools but couldn\'t complete the request. Please try rephrasing.';
}

// =========================================================
// CONVERSATION MEMORY
// =========================================================
function getHistory(chatId) {
  return state.conversations.get(chatId) || [];
}

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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    },
  });
});

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

  // ---- Extract text ----
  let text = msg.message.conversation ||
             msg.message.extendedTextMessage?.text ||
             msg.message.imageMessage?.caption ||
             msg.message.videoMessage?.caption ||
             '';

  // ---- Image OCR ----
  const imageMsg = msg.message.imageMessage;
  if (imageMsg && CONFIG.ENABLE_OCR) {
    try {
      console.log('[OCR] Downloading image...');
      const imageBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: state.sock.updateMediaMessage,
      });
      console.log(`[OCR] Image size: ${imageBuffer.length} bytes`);
      const ocrText = await extractTextFromImage(imageBuffer);
      if (ocrText) {
        console.log(`[OCR] Extracted: ${ocrText.slice(0, 100)}...`);
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

  // ---- Rate limit + concurrency ----
  if (!canReply(chatId)) return;
  if (state.processing.has(chatId)) return;
  state.processing.add(chatId);

  try {
    await state.sock.sendPresenceUpdate('composing', chatId);

    const messages = buildMessages(chatId, senderName, text);
    console.log(`[AI] Querying ${CONFIG.OLLAMA_MODEL} (tools=${CONFIG.ENABLE_TOOLS})...`);
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
console.log(`Link extract: ${CONFIG.ENABLE_LINK_EXTRACT ? '✅' : '❌'}`);
console.log(`Group mode:   ${CONFIG.ONLY_REPLY_TO_MENTIONS ? 'Mentions / /ai / replies only' : 'All messages'}`);
console.log('='.repeat(60));

connectToWhatsApp().catch(err => { console.error('[Fatal]', err); process.exit(1); });

process.on('SIGINT', () => { try { state.sock?.end?.(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { state.sock?.end?.(); } catch {} process.exit(0); });