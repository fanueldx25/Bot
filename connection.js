// ============================================================================
// connection.js — Baileys socket + pairing code + rich error reporting
// ============================================================================
// Design:
//   1. Generation counter on every socket kills ghost reconnects.
//   2. stopBot() is async and fully awaited.
//   3. startBot() is re-entrant-safe.
//   4. DMs: reply to whatever remoteJid WhatsApp gave us. Try to normalize
//      @lid → @s.whatsapp.net via senderPn / remoteJidAlt / LID_MAP, but if
//      none of those resolve, KEEP the @lid and try anyway. Never drop.
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
// Best-effort resolution of the sender's phone-number JID. Falls back to the
// raw input if nothing better is found. Never returns null.
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
    if (c && typeof c === 'string' && c.endsWith('@s.whatsapp.net')) {
      const num = c.split('@')[0].split(':')[0];
      if (/^\d{7,15}$/.test(num)) return `${num}@s.whatsapp.net`;
    }
  }

  const participant = msg?.key?.participant;
  if (participant && participant.endsWith('@s.whatsapp.net')) {
    const num = participant.split('@')[0].split(':')[0];
    if (/^\d{7,15}$/.test(num)) return `${num}@s.whatsapp.net`;
  }

  if (fallbackJid) {
    const raw = fallbackJid.split('@')[0].split(':')[0];
    if (fallbackJid.endsWith('@lid')) {
      const pn = state.resolveLid && state.resolveLid(raw);
      if (pn) return `${pn}@s.whatsapp.net`;
      // Keep the raw @lid as the sender's identity. Do NOT fabricate.
      return fallbackJid;
    }
    if (/^\d{7,15}$/.test(raw)) return `${raw}@s.whatsapp.net`;
  }

  return fallbackJid || '';
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
        await sock.sendMessage(jid, {
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
      state.saveState();
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
      await teardownSocket(old);
    }

    state.currentNumber = phoneNumber;
    state.pairingCode = null;
    state.setState('connecting', {
      number: phoneNumber,
      message: 'Opening secure channel with WhatsApp...'
    });

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

    let version;
    try {
      const vres = await fetchLatestBaileysVersion();
      version = vres.version;
    } catch (e) {
      console.error('[Version] fetch failed, using default:', e.message);
      version = undefined;
    }

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
        keepAliveIntervalMs: 30000
      });
    } catch (e) {
      console.error('[Socket] creation failed:', e.message);
      state.setState('error', { message: 'Socket creation failed: ' + e.message });
      return { ok: false, error: e.message };
    }

    const myGen = ++currentGen;
    currentSock = sock;
    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

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
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.forbidden;

        stopScheduler();
        state.setState('disconnected', { code: statusCode, message: reason });

        if (shouldReconnect) {
          console.log('↻ Reconnecting in 3s...');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (myGen === currentGen) startBot(state.currentNumber);
          }, 3000);
        } else {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
          state.sock = null;
          state.botJid = null;
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
      // Accept 'append' — that's how Baileys delivers your own DMs to the
      // bot. Without this, first-time DMs from your own phone silently drop.
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        try {
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

  // Raw remoteJid as WhatsApp sent it. This is what we will reply to if
  // nothing better is available. NEVER drop the message just because the
  // JID looks unusual.
  const rawFrom = msg.key.remoteJid;
  if (!rawFrom || rawFrom === 'status@broadcast') return;

  // Best-effort normalization: try to rewrite @lid → @s.whatsapp.net using
  // whatever info Baileys gave us. If nothing resolves, keep the raw @lid
  // and try to reply anyway.
  let from = rawFrom;
  if (rawFrom.endsWith('@lid')) {
    const alt =
      msg.key?.senderPn ||
      msg.key?.participantPn ||
      msg.key?.remoteJidAlt ||
      msg.key?.participantAlt;

    if (alt && alt.endsWith('@s.whatsapp.net')) {
      from = alt;
      console.log('[LID] resolved via alt →', from);
    } else {
      const num = rawFrom.split('@')[0].split(':')[0];
      const pn = state.resolveLid && state.resolveLid(num);
      if (pn) {
        from = `${pn}@s.whatsapp.net`;
        console.log('[LID] resolved via map →', from);
      } else {
        // Learn if we can, but do NOT drop. Try the raw @lid.
        console.log('[LID] no mapping for', rawFrom, '— sending to raw @lid');
      }
    }
  }

  const senderJid = resolveSenderJid(msg, from);

  // Debug log — remove or leave, it's cheap.
  console.log('[in]', {
    rawFrom,
    from,
    senderJid,
    fromMe: msg.key.fromMe,
    text: extractText(msg).slice(0, 40)
  });

  // pause check
  if (state.pausedChats.has('ALL') || state.pausedChats.has(from)) {
    console.log('[in] dropped: chat paused');
    return;
  }

  // ---------- LID → PN learning ----------
  // Learn from every message where Baileys gave us both JIDs, in DMs too.
  try {
    const participant = msg.key?.participant || '';
    const pn =
      msg.key?.senderPn ||
      msg.key?.participantPn ||
      msg.key?.participantAlt ||
      msg.key?.remoteJidAlt;

    if (
      rawFrom.endsWith('@lid') &&
      pn &&
      pn.endsWith('@s.whatsapp.net') &&
      typeof state.registerLidMapping === 'function'
    ) {
      state.registerLidMapping(rawFrom, pn);
    }

    if (
      participant.endsWith('@lid') &&
      pn &&
      pn.endsWith('@s.whatsapp.net') &&
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

          try {
            await state.sock.sendMessage(from, { delete: msg.key });
          } catch (e) {
            console.error('[AntiLink delete]', e.message);
          }

          if (action === 'warn') {
            await state.sock.sendMessage(from, {
              text: `⚠️ @${senderJid.split('@')[0]}, links are not allowed here.`,
              mentions: [senderJid]
            });
          } else if (action === 'kick') {
            try {
              await state.sock.groupParticipantsUpdate(from, [senderJid], 'remove');
              await state.sock.sendMessage(from, {
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
        await state.sock.sendMessage(from, {
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
    if (stopped) return;
  } catch (e) {
    console.error('[hooks]', e.message);
  }

  // ---------- Commands ----------
  if (!text.startsWith('.') && !text.startsWith('!')) return;
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
  hasStoredSession
};