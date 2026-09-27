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

const AUTH_DIR = './auth_info_baileys';
const logger = pino({ level: 'silent' });

// ---------- Friendly disconnect reasons ----------
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

// ---------- Banner ----------
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

// ---------- Validation ----------
function validateNumber(raw) {
  const clean = (raw || '').replace(/\D/g, '');
  if (!clean) return { ok: false, error: 'Please enter a phone number.' };
  if (clean.length < 10) return { ok: false, error: 'Number is too short. Include country code (no +).' };
  if (clean.length > 15) return { ok: false, error: 'Number is too long. Maximum 15 digits.' };
  if (/^0+$/.test(clean)) return { ok: false, error: 'Number cannot be all zeros.' };
  return { ok: true, clean };
}
// ============================================================================
// SESSION EXPORT / IMPORT (works on Render free tier — no persistent disk)
// ============================================================================

/**
 * Bundle the auth_info_baileys folder into a single base64 JSON payload.
 * Returns { ok, filename, payload } or { ok: false, error }
 */
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
    
    return {
      ok: true,
      filename,
      payload: b64,
      size: totalSize,
      fileCount: Object.keys(bundle).length
    };
  } catch (e) {
    console.error('[Session] export failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Restore the auth_info_baileys folder from a base64 payload.
 * Overwrites existing auth folder. Requires restart to take effect.
 */
function importSession(base64Payload) {
  try {
    if (!base64Payload || typeof base64Payload !== 'string') {
      return { ok: false, error: 'No payload provided.' };
    }
    
    // Accept both raw base64 and the full JSON file content
    let inner;
    try {
      // Try to parse as JSON first (the file the user downloads)
      const parsed = JSON.parse(base64Payload);
      // The file format is { payload: "base64...", filename, version }
      if (parsed && typeof parsed.payload === 'string') {
        inner = JSON.parse(Buffer.from(parsed.payload, 'base64').toString('utf8'));
      } else if (parsed && parsed.files) {
        // Direct inner object
        inner = parsed;
      } else {
        throw new Error('Unrecognized JSON format.');
      }
    } catch (jsonErr) {
      // Not JSON — treat as raw base64
      try {
        inner = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'));
      } catch (b64Err) {
        return { ok: false, error: 'Invalid file: not JSON, not base64.' };
      }
    }
    
    if (!inner || !inner.files || typeof inner.files !== 'object') {
      return { ok: false, error: 'Missing "files" object in session payload.' };
    }
    
    // Wipe old auth folder
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    
    // Write each file back
    let written = 0;
    for (const [name, content] of Object.entries(inner.files)) {
      if (typeof content !== 'string') continue;
      // Safety: prevent path traversal
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

/**
 * Check if a session currently exists on disk.
 */
function hasStoredSession() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return false;
    const files = fs.readdirSync(AUTH_DIR);
    return files.length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// SENDER RESOLVER — handles @lid linked-device JIDs
// Returns the REAL phone number as a JID string, e.g. "237678899829@s.whatsapp.net"
// ============================================================================
function resolveSenderJid(msg, fallbackJid) {
  // 1. senderPn = real phone number (Baileys includes this for @lid messages)
  const pn = msg?.key?.senderPn || msg?.key?.participantPn;
  if (pn && typeof pn === 'string') {
    const num = pn.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }

  // 2. participantPn (older Baileys versions)
  const ppn = msg?.participantPn || msg?.key?.participantPn;
  if (ppn && typeof ppn === 'string') {
    const num = ppn.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }

  // 3. participant — may be @lid, but if it's @s.whatsapp.net it's fine
  const participant = msg?.key?.participant;
  if (participant && participant.endsWith('@s.whatsapp.net')) {
    const num = participant.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }

  // 4. fallback — DM chat JID
  if (fallbackJid) {
    const num = fallbackJid.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }

  return '';
}

// ---------- Scheduler (runs while socket is up) ----------
let schedulerTimer = null;

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(async () => {
    const sock = state.sock;
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

// ---------- Start ----------
async function startBot(rawNumber) {
  const v = validateNumber(rawNumber);
  if (!v.ok) {
    state.setState('error', { message: v.error });
    return { ok: false, error: v.error };
  }
  const phoneNumber = v.clean;

  stopScheduler();
  if (state.sock) {
    try { state.sock.end(undefined); } catch (e) {}
    state.sock = null;
  }

  state.currentNumber = phoneNumber;
  state.pairingCode = null;
  state.setState('connecting', {
    number: phoneNumber,
    message: 'Opening secure channel with WhatsApp...'
  });

  let authState, saveCreds, version;
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

  state.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  // ---------- Pairing code ----------
  if (!sock.authState.creds.registered) {
    state.setState('connecting', {
      number: phoneNumber,
      message: 'Requesting pairing code from WhatsApp...'
    });

    let attempt = 0;
    const requestCode = async () => {
      attempt++;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
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

    setTimeout(requestCode, 3500);
  }

  // ---------- Connection updates ----------
  sock.ev.on('connection.update', (update) => {
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
        setTimeout(() => startBot(state.currentNumber), 3000);
      } else {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
        state.sock = null;
        state.botJid = null;
        state.setState('error', {
          message: reason,
          hint: 'You will need to pair again.'
        });
      }
    }
  });

  // ---------- Messages ----------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleIncoming(msg);
      } catch (e) {
        console.error('[Message]', e.message);
      }
    }
  });

  // ---------- Group events ----------
  sock.ev.on('group-participants.update', async (update) => {
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
}

// ============================================================================
// INCOMING ROUTER
// ============================================================================
async function handleIncoming(msg) {
  if (!msg.message) return;
  const from = msg.key.remoteJid;
  if (!from || from === 'status@broadcast') return;

  // ✅ FIX: resolve the REAL sender JID (handles @lid linked-device JIDs)
  const senderJid = resolveSenderJid(msg, from);

  // pause check
  if (state.pausedChats.has('ALL') || state.pausedChats.has(from)) return;

  // ---------- Anti-link ----------
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

  // ---------- Reactions ----------
  try {
    const chatReactions =
      state.reactionsGlobal || state.reactionsEnabled.has(from);
    const chatMuted = state.reactionsDisabled.has(from);

    if (chatReactions && !chatMuted && !msg.key.fromMe) {
      const emojis = ['👍', '❤️', '😂', '🔥', '🎉', '👀', '💯', '🙌'];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      await state.sock.sendMessage(from, {
        react: { text: emoji, key: msg.key }
      });
    }
  } catch (e) {
    // silent
  }

  // ---------- View-once capture ----------
  if (state.viewOnceEnabled) {
    const captured = await handlers.tryCaptureViewOnce(msg, from);
    if (captured) return;
  }

  // ---------- Commands ----------
  const text = extractText(msg);
  if (!text || !text.startsWith('.')) return;

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

// ---------- Stop ----------
function stopBot() {
  stopScheduler();
  if (state.sock) {
    try { state.sock.end(undefined); } catch (e) {}
    state.sock = null;
  }
  state.botJid = null;
  state.pairingCode = null;
  state.setState('disconnected', { message: 'Stopped by user.' });
}

module.exports = {
  startBot,
  stopBot,
  loadBanner,
  validateNumber,
  resolveSenderJid
};