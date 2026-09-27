// ============================================================================
// connection.js — Baileys socket + pairing code + rich error reporting
// ============================================================================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');

const state = require('./state');
const handlers = require('./handlers');
const { preCommandHooks } = handlers;

// ⚠️ Require engine lazily inside handleIncoming to avoid a circular import
// at module load time (engine.js requires state.js which is fine, but
// engine.js's install() is called by handlers.js — we don't want to trigger
// that ordering here).
function getEngine() {
  try { return require('./engine'); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const AUTH_DIR = './auth_info_baileys';
const logger = pino({ level: 'silent' });

let currentSock = null;
let currentGen = 0;
let reconnectTimer = null;
let starting = false;
let stopping = false;

// ---------------------------------------------------------------------------
// Friendly disconnect reasons
// ---------------------------------------------------------------------------
const DISCONNECT_MESSAGES = {
  [DisconnectReason.loggedOut]: 'Session logged out. You must link again.',
  [DisconnectReason.connectionClosed]: 'Connection closed. Reconnecting...',
  [DisconnectReason.connectionLost]: 'Network lost. Reconnecting...',
  [DisconnectReason.connectionReplaced]: 'Another session opened with this number.',
  [DisconnectReason.timedOut]: 'Connection timed out.',
  [DisconnectReason.badSession]: 'Bad session file. Delete auth_info_baileys and retry.',
  [DisconnectReason.restartRequired]: 'Restart required. Reconnecting...',
  [DisconnectReason.multideviceMismatch]: 'Multi-device mismatch.',
  [DisconnectReason.forbidden]: 'Number forbidden by WhatsApp.',
  [DisconnectReason.unavailableService]: 'WhatsApp service unavailable.'
};

// ============================================================================
// 🔧 FIX 1 — MESSAGE STORE for getMessage (retry / re-encryption)
// ============================================================================
// When a recipient can't decrypt a message (key desync, offline device coming
// online later, multi-device race), they send a retry receipt. Baileys calls
// `getMessage(key)` to fetch the original and re-encrypt it. Without this
// handler, Baileys silently drops the retry and the recipient is stuck on
// "Waiting for this message. This may take a while."
//
// This store caches every message (incoming + outgoing echoes) keyed by
// key.id so retries can be answered. Bounded by count + TTL to avoid leaks.
// ============================================================================
const MESSAGE_STORE = new Map();          // id -> WAMessage
const MESSAGE_STORE_MAX = 2000;
const MESSAGE_STORE_TTL = 30 * 60 * 1000; // 30 min

function rememberMessage(msg) {
  if (!msg?.key?.id) return;
  MESSAGE_STORE.set(msg.key.id, msg);

  if (MESSAGE_STORE.size > MESSAGE_STORE_MAX) {
    const cutoff = Date.now() - MESSAGE_STORE_TTL;
    for (const [id, m] of MESSAGE_STORE) {
      const ts = (m.messageTimestamp || 0) * 1000;
      if (ts && ts < cutoff) MESSAGE_STORE.delete(id);
      if (MESSAGE_STORE.size <= MESSAGE_STORE_MAX) break;
    }
    while (MESSAGE_STORE.size > MESSAGE_STORE_MAX) {
      const first = MESSAGE_STORE.keys().next().value;
      MESSAGE_STORE.delete(first);
    }
  }
}

async function getMessageForRetry(key) {
  if (!key?.id) return undefined;
  const cached = MESSAGE_STORE.get(key.id);
  if (cached) return cached;

  // Optional fallback: if you installed Baileys with the `store` helper.
  try {
    const baileys = require('@whiskeysockets/baileys');
    if (baileys?.store?.loadMessage) {
      return await baileys.store.loadMessage(key.remoteJid, key.id);
    }
  } catch (_) { /* optional */ }

  return undefined;
}

// ============================================================================
// 🔧 FIX 3a — SAFE SEND helper
// ============================================================================
// Retries transient E2EE / socket errors instead of letting them bubble up
// and trigger handler crashes or reconnect storms. Use this for anything
// that isn't a direct reply to an inbound message (automations, broadcasts,
// scheduled sends, welcome/goodbye, etc.).
// ============================================================================
async function safeSend(jid, content, options = {}, retries = 2) {
  const sock = currentSock;
  if (!sock) throw new Error('Socket not ready');

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const sent = await sock.sendMessage(jid, content, options);
      // Cache outgoing messages so getMessage can answer retry receipts.
      try { rememberMessage(sent); } catch (_) {}
      return sent;
    } catch (e) {
      const msg = e?.message || String(e);
      const transient =
        /Connection Closed|Connection Terminated|Timed Out|EPIPE|ECONNRESET|Stream Errored|not connected|Socket closed|Bad MAC|decrypt/i
          .test(msg);

      if (!transient || attempt === retries) {
        console.error(`[safeSend] giving up (${attempt + 1}/${retries + 1}):`, msg);
        throw e;
      }
      console.warn(`[safeSend] transient error, retry ${attempt + 1}/${retries}:`, msg);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// ============================================================================
// 🔧 FIX 2a — Serialize creds.update saves
// ============================================================================
// Rapid creds.update events (common during pairing + initial sync) can race
// each other in the multi-file store and corrupt creds.json / app-state-sync
// keys. Chaining the writes prevents that.
// ============================================================================
let credsSaveChain = Promise.resolve();
function queueSaveCreds(saveCreds) {
  credsSaveChain = credsSaveChain
    .then(() => saveCreds())
    .catch((e) => console.error('[Creds] save failed:', e.message));
  return credsSaveChain;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------
function loadBanner() {
  try {
    const p = path.join(__dirname, 'assets', 'banner.jpg');
    if (fs.existsSync(p)) {
      state.BANNER_BUFFER = fs.readFileSync(p);
      console.log('[Banner] loaded');
    }
  } catch (e) {
    console.error('[Banner]', e.message);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateNumber(raw) {
  const clean = (raw || '').replace(/\D/g, '');
  if (!clean) return { ok: false, error: 'Please enter a phone number.' };
  if (clean.length < 10) return { ok: false, error: 'Number is too short. Include country code (no +).' };
  if (clean.length > 15) return { ok: false, error: 'Number is too long. Maximum 15 digits.' };
  if (/^0+$/.test(clean)) return { ok: false, error: 'Number cannot be all zeros.' };
  return { ok: true, clean };
}

// ============================================================================
// SENDER RESOLVER
// ============================================================================
function resolveSenderJid(msg, fallbackJid) {
  const candidates = [
    msg?.key?.senderPn,
    msg?.key?.participantPn,
    msg?.key?.participantAlt,
    msg?.key?.remoteJidAlt,
    msg?.senderPn,
    msg?.participantPn
  ];

  for (const c of candidates) {
    if (c && typeof c === 'string' && c.includes('@')) {
      const num = c.split('@')[0].split(':')[0];
      if (/^\d{7,15}$/.test(num)) return `${num}@s.whatsapp.net`;
    }
  }

  const participant = msg?.key?.participant;
  if (participant && participant.endsWith('@s.whatsapp.net')) {
    const num = participant.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }

  if (fallbackJid) {
    const raw = fallbackJid.split('@')[0].split(':')[0];
    if (fallbackJid.endsWith('@lid')) {
      const pn = state.resolveLid && state.resolveLid(raw);
      if (pn) return `${pn}@s.whatsapp.net`;
    }
    if (/^\d{7,15}$/.test(raw)) return `${raw}@s.whatsapp.net`;
  }

  return participant || fallbackJid || '';
}

// ============================================================================
// SESSION EXPORT / IMPORT
// ============================================================================
function exportSession() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      return { ok: false, error: 'No auth folder found. Pair the bot first.' };
    }

    const files = fs.readdirSync(AUTH_DIR);
    const bundle = {};
    let totalSize = 0;

    for (const f of files) {
      const fullPath = path.join(AUTH_DIR, f);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      bundle[f] = content;
      totalSize += content.length;
    }

    if (Object.keys(bundle).length === 0) {
      return { ok: false, error: 'Auth folder is empty.' };
    }

    const inner = {
      version: 1,
      exportedAt: new Date().toISOString(),
      number: state.currentNumber || null,
      jid: state.botJid || null,
      files: bundle
    };

    const b64 = Buffer.from(JSON.stringify(inner)).toString('base64');
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `wa-session-${stamp}.json`;

    return { ok: true, filename, payload: b64, size: totalSize, fileCount: Object.keys(bundle).length };
  } catch (e) {
    console.error('[Session] export failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function importSession(base64Payload) {
  try {
    if (!base64Payload || typeof base64Payload !== 'string') {
      return { ok: false, error: 'No payload provided.' };
    }

    let inner;
    try {
      const parsed = JSON.parse(base64Payload);
      if (parsed && typeof parsed.payload === 'string') {
        inner = JSON.parse(Buffer.from(parsed.payload, 'base64').toString('utf8'));
      } else if (parsed && parsed.files) {
        inner = parsed;
      } else {
        throw new Error('Unrecognized JSON format.');
      }
    } catch (_) {
      try {
        inner = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'));
      } catch (_) {
        return { ok: false, error: 'Invalid file: not JSON, not base64.' };
      }
    }

    if (!inner || !inner.files || typeof inner.files !== 'object') {
      return { ok: false, error: 'Missing "files" object in session payload.' };
    }

    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    let written = 0;
    for (const [name, content] of Object.entries(inner.files)) {
      if (typeof content !== 'string') continue;
      if (name.includes('/') || name.includes('\\') || name.includes('..')) continue;
      fs.writeFileSync(path.join(AUTH_DIR, name), content, 'utf8');
      written++;
    }

    if (written === 0) {
      return { ok: false, error: 'No valid session files were found.' };
    }

    console.log(`[Session] restored ${written} file(s) from import`);
    return {
      ok: true,
      written,
      number: inner.number || null,
      exportedAt: inner.exportedAt || null,
      message: 'Session imported. Restarting bot...'
    };
  } catch (e) {
    console.error('[Session] import failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function hasStoredSession() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return false;
    return fs.readdirSync(AUTH_DIR).length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// SCHEDULER
// ============================================================================
let schedulerTimer = null;

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(async () => {
    const sock = currentSock;
    if (!sock) return;

    const now = Date.now();
    for (const [jid, s] of state.schedules.entries()) {
      if (s.at > now) continue;
      try {
        await sock.groupSettingUpdate(
          jid,
          s.action === 'open' ? 'not_announcement' : 'announcement'
        );
        // 🔧 FIX 3b — safeSend for scheduled broadcasts
        await safeSend(jid, {
          text:
            s.action === 'open'
              ? '🔓 *Group opened on schedule*'
              : '🔒 *Group closed on schedule*'
        });
        console.log(`[Schedule] ${s.action} → ${jid}`);
      } catch (e) {
        console.error('[Schedule]', e.message);
      }

      if (s.repeat === 'daily') {
        s.at += 24 * 60 * 60 * 1000;
      } else {
        state.schedules.delete(jid);
      }
      state.saveState();  // debounced in state.js
    }
  }, 30 * 1000);
  console.log('[Schedule] ticker started');
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ============================================================================
// INTERNAL: tear down a socket cleanly
// ============================================================================
async function teardownSocket(sock) {
  if (!sock) return;

  try { sock.ev.removeAllListeners('connection.update'); } catch (_) {}
  try { sock.ev.removeAllListeners('creds.update'); } catch (_) {}
  try { sock.ev.removeAllListeners('messages.upsert'); } catch (_) {}
  try { sock.ev.removeAllListeners('group-participants.update'); } catch (_) {}

  try { await sock.end(undefined); } catch (_) {}

  await new Promise((r) => setImmediate(r));
}

// ============================================================================
// START
// ============================================================================
async function startBot(rawNumber) {
  const v = validateNumber(rawNumber);
  if (!v.ok) {
    state.setState('error', { message: v.error });
    return { ok: false, error: v.error };
  }
  const phoneNumber = v.clean;

  if (starting) {
    console.log('[Bot] startBot already in progress — ignoring duplicate call');
    return { ok: false, error: 'Already starting' };
  }
  starting = true;

  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    stopScheduler();

    if (currentSock) {
      const old = currentSock;
      currentSock = null;
      state.sock = null;
      if (typeof state.setSafeSend === 'function') state.setSafeSend(null);
      await teardownSocket(old);
    }

    state.currentNumber = phoneNumber;
    state.pairingCode = null;
    state.setState('connecting', {
      number: phoneNumber,
      message: 'Opening secure channel with WhatsApp...'
    });

    // ---------- auth ----------
    let authState, saveCreds;
    try {
      const auth = await useMultiFileAuthState(AUTH_DIR);
      authState = auth.state;
      saveCreds = auth.saveCreds;
    } catch (e) {
      console.error('[Auth] init failed:', e.message);
      state.setState('error', {
        message: 'Failed to initialize auth storage: ' + e.message,
        hint: 'Try deleting the auth_info_baileys folder and retry.'
      });
      return { ok: false, error: e.message };
    }

    // ---------- version ----------
    let version;
    try {
      const vres = await fetchLatestBaileysVersion();
      version = vres.version;
    } catch (e) {
      console.error('[Version] fetch failed, using default:', e.message);
      version = undefined;
    }

    // ---------- socket ----------
    let sock;
    try {
      sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, logger)
        },
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,

        // 🔧 FIX 1 — required so Baileys can answer retry receipts by
        // re-encrypting and re-sending the original message.
        getMessage: getMessageForRetry,

        // 🔧 FIX 1b — bounded, faster retry handling for key renegotiation.
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
      });
    } catch (e) {
      console.error('[Socket] creation failed:', e.message);
      state.setState('error', { message: 'Socket creation failed: ' + e.message });
      return { ok: false, error: e.message };
    }

    const myGen = ++currentGen;
    currentSock = sock;
    state.sock = sock;

    // 🔧 FIX 2c — wire state.js's banner sender to our safeSend so banner
    // replies get the same E2EE retry treatment as everything else.
    if (typeof state.setSafeSend === 'function') state.setSafeSend(safeSend);

    // 🔧 FIX 2b — serialize creds.saveCreds to avoid multi-file write races
    sock.ev.on('creds.update', () => queueSaveCreds(saveCreds));

    // ---------- pairing code ----------
    if (!sock.authState.creds.registered) {
      state.setState('connecting', {
        number: phoneNumber,
        message: 'Requesting pairing code from WhatsApp...'
      });

      let attempt = 0;
      const requestCode = async () => {
        if (myGen !== currentGen) return false;

        attempt++;
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          if (myGen !== currentGen) return false;
          if (!code || typeof code !== 'string') throw new Error('Empty code returned');

          state.pairingCode = code;
          state.setState('code_ready', {
            number: phoneNumber,
            code,
            message: 'Enter this code in WhatsApp → Linked Devices'
          });
          console.log('📱 PAIRING CODE:', code);
          return true;
        } catch (err) {
          if (myGen !== currentGen) return false;
          console.error(`[Pairing attempt ${attempt}]`, err.message);
          if (attempt < 3) {
            state.setState('connecting', {
              number: phoneNumber,
              message: `Code request failed, retrying (${attempt}/3)...`
            });
            await new Promise((r) => setTimeout(r, 2500));
            return requestCode();
          }
          state.setState('error', {
            message: 'Could not get pairing code: ' + err.message,
            hint: 'Make sure the number is correct, has country code, and is registered on WhatsApp.'
          });
          return false;
        }
      };

      setTimeout(() => {
        if (myGen === currentGen) requestCode();
      }, 3500);
    }

    // ---------- connection.update ----------
    sock.ev.on('connection.update', (update) => {
      if (myGen !== currentGen) return;

      const { connection, lastDisconnect, isNewLogin } = update;

      if (connection === 'open') {
        state.botJid = sock.user.id;
        state.setState('connected', {
          number: sock.user.id.split(':')[0],
          name: sock.user.name || sock.user.verifiedName || '',
          message: 'Successfully linked!'
        });
        console.log('✅ Connected as', sock.user.id);
        startScheduler();
      }

      if (connection === 'connecting') {
        state.setState('connecting', {
          number: phoneNumber,
          message: isNewLogin ? 'Completing login...' : 'Handshaking...'
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DISCONNECT_MESSAGES[statusCode] || 'Unknown disconnect.';

        // 🔧 FIX 3c — don't reconnect on terminal states, and don't wipe auth
        // except on truly fatal ones. This prevents restart storms when a
        // key exchange failure triggers a socket close.
        const NO_RECONNECT = new Set([
          DisconnectReason.loggedOut,
          DisconnectReason.forbidden,
          DisconnectReason.badSession,
          DisconnectReason.multideviceMismatch,
          DisconnectReason.connectionReplaced,
        ]);
        const shouldReconnect = !NO_RECONNECT.has(statusCode);

        stopScheduler();
        state.setState('disconnected', { code: statusCode, message: reason });

        // Stale close (a newer socket already exists) — ignore.
        if (myGen !== currentGen) return;

        if (shouldReconnect) {
          console.log('↻ Reconnecting in 3s...');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (myGen === currentGen) startBot(state.currentNumber);
          }, 3000);
        } else {
          if (
            statusCode === DisconnectReason.loggedOut ||
            statusCode === DisconnectReason.badSession ||
            statusCode === DisconnectReason.forbidden
          ) {
            try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
          }
          state.sock = null;
          state.botJid = null;
          if (typeof state.setSafeSend === 'function') state.setSafeSend(null);
          state.setState('error', {
            message: reason,
            hint: 'You will need to pair again.'
          });
        }
      }
    });

    // ---------- messages ----------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (myGen !== currentGen) return;
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        try {
          // 🔧 FIX 1c — cache every message so retries can be answered.
          rememberMessage(msg);
          await handleIncoming(msg);
        } catch (e) {
          console.error('[Message]', e.message);
        }
      }
    });

    // ---------- group participants ----------
    sock.ev.on('group-participants.update', async (update) => {
      if (myGen !== currentGen) return;
      const { id, participants, action } = update;
      try {
        if (action === 'add' && state.welcomeEnabled.has(id)) {
          await handlers.sendWelcome(id, participants);
        } else if (action === 'remove' && state.goodbyeEnabled.has(id)) {
          await handlers.sendGoodbye(id, participants);
        }
      } catch (e) {
        console.error('[Group]', e.message);
      }
    });

    return { ok: true };
  } finally {
    starting = false;
  }
}

// ============================================================================
// INCOMING ROUTER
// ============================================================================
async function handleIncoming(msg) {
  if (!msg.message) return;

  let from = msg.key.remoteJid;
  if (!from || from === 'status@broadcast') return;

  // ---- LID → PN resolution ----
  if (from.endsWith('@lid')) {
    const alt =
      msg.key?.senderPn ||
      msg.key?.participantPn ||
      msg.key?.remoteJidAlt ||
      msg.key?.participantAlt;

    let resolved = null;
    if (alt && alt.endsWith('@s.whatsapp.net')) {
      resolved = alt;
    } else {
      const num = from.split('@')[0].split(':')[0];
      const pn = state.resolveLid && state.resolveLid(num);
      if (pn) resolved = `${pn}@s.whatsapp.net`;
    }

    if (!resolved) {
      console.error(
        '[LID] DM cannot be routed — reply would silently fail.\n' +
        '  remoteJid      = ' + from + '\n' +
        '  senderPn       = ' + (msg.key?.senderPn || 'undefined') + '\n' +
        '  participantPn  = ' + (msg.key?.participantPn || 'undefined') + '\n' +
        '  remoteJidAlt   = ' + (msg.key?.remoteJidAlt || 'undefined') + '\n' +
        '  participantAlt = ' + (msg.key?.participantAlt || 'undefined') + '\n' +
        '  -> Add a mapping in state.js: lidToPn.set(\'<lid-digits>\', \'<phone-digits>\')'
      );
      return;
    }
    from = resolved;
  }

  const senderJid = resolveSenderJid(msg, from);

  console.log('[in]', {
    from,
    senderJid,
    fromMe: msg.key.fromMe,
    participant: msg.key.participant || null,
    text: extractText(msg).slice(0, 40)
  });

  if (state.pausedChats.has('ALL') || state.pausedChats.has(from)) {
    console.log('[in] dropped: chat paused');
    return;
  }

  // ---- LID → PN learning ----
  try {
    const participant = msg.key?.participant || '';
    const pn =
      msg.key?.senderPn ||
      msg.key?.participantPn ||
      msg.key?.participantAlt ||
      msg.key?.remoteJidAlt;

    if (
      participant.endsWith('@lid') &&
      pn &&
      pn.includes('@s.whatsapp.net') &&
      typeof state.registerLidMapping === 'function'
    ) {
      state.registerLidMapping(participant, pn);
    }
  } catch (_) { /* silent */ }

  // ---------- Anti-link (group only) ----------
  if (from.endsWith('@g.us')) {
    try {
      if (
        state.antilinkGroups.has(from) &&
        !state.isAdmin(senderJid) &&
        !msg.key.fromMe
      ) {
        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';

        const linkRegex =
          /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9-]+\.(com|net|org|io|gg|xyz|me|co|cm|fr|ru)(\/[^\s]*)?)/i;

        if (linkRegex.test(body)) {
          const action = state.antilinkAction.get(from) || 'delete';

          // Delete must be immediate; safeSend retry semantics don't apply.
          try {
            await state.sock.sendMessage(from, { delete: msg.key });
          } catch (e) {
            console.error('[AntiLink delete]', e.message);
          }

          if (action === 'warn') {
            await safeSend(from, {
              text: `⚠️ @${senderJid.split('@')[0]}, links are not allowed here.`,
              mentions: [senderJid]
            });
          } else if (action === 'kick') {
            try {
              await state.sock.groupParticipantsUpdate(from, [senderJid], 'remove');
              await safeSend(from, {
                text: `🚫 @${senderJid.split('@')[0]} was removed for posting a link.`,
                mentions: [senderJid]
              });
            } catch (e) {
              console.error('[AntiLink kick]', e.message);
            }
          }
          return;
        }
      }
    } catch (e) {
      console.error('[AntiLink]', e.message);
    }
  }

  // ---------- Reactions (group only) ----------
  if (from.endsWith('@g.us')) {
    try {
      const chatReactions = state.reactionsGlobal || state.reactionsEnabled.has(from);
      const chatMuted = state.reactionsDisabled.has(from);

      if (chatReactions && !chatMuted && !msg.key.fromMe) {
        const emojis = ['👍', '❤️', '😂', '🔥', '🎉', '👀', '💯', '🙌'];
        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        await safeSend(from, {
          react: { text: emoji, key: msg.key }
        });
      }
    } catch (_) { /* silent */ }
  }

  // ---------- View-once capture ----------
  if (state.viewOnceEnabled) {
    const captured = await handlers.tryCaptureViewOnce(msg, from);
    if (captured) return;
  }

  // ---------- Extract text ----------
  const text = extractText(msg);
  if (!text) return;

  // ---------- Pre-command hooks ----------
  try {
    const stopped = await preCommandHooks(msg, from, senderJid, text);
    console.log('[hook] stopped =', stopped);
    if (stopped) return;
  } catch (e) {
    console.error('[hooks]', e.message);
  }

  // ---------- Commands ----------
  // 🔧 FIX 4 — accept both '.' and '!' prefixes via engine.isCommand.
  // Falls back to '.'-only if engine isn't loadable (defensive).
  const engine = getEngine();
  const isCmd = engine && typeof engine.isCommand === 'function'
    ? engine.isCommand(text)
    : text.startsWith('.');

  if (!isCmd) return;

  console.log('[cmd] dispatching', text.split(' ')[0], 'from', senderJid, 'chat', from);
  await handlers.handleCommand(msg, from, senderJid, text);
}

function extractText(msg) {
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

// ============================================================================
// STOP
// ============================================================================
async function stopBot() {
  if (stopping) return;
  stopping = true;

  try {
    stopScheduler();

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    currentGen++;

    const old = currentSock;
    currentSock = null;
    state.sock = null;

    // 🔧 FIX 2d — unhook the safeSend bridge — the socket is going away.
    if (typeof state.setSafeSend === 'function') state.setSafeSend(null);

    await teardownSocket(old);

    state.botJid = null;
    state.pairingCode = null;
    state.setState('disconnected', { message: 'Stopped by user.' });
  } finally {
    stopping = false;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  startBot,
  stopBot,
  loadBanner,
  validateNumber,
  resolveSenderJid,
  exportSession,
  importSession,
  hasStoredSession,
  safeSend,
  rememberMessage,
};