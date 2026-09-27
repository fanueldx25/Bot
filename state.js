// ============================================================================
// state.js — shared mutable state (prevents circular imports)
// ============================================================================
// Owns all cross-cutting state: feature toggles, the live socket ref, the
// Socket.IO handle, and the LID → PN mapping. Both server.js and
// connection.js require this, so it must NOT require either of them back.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Feature state (in-memory, mirrored to bot_state.json on save)
// ---------------------------------------------------------------------------
const pausedChats = new Set();
const welcomeEnabled = new Set();
const goodbyeEnabled = new Set();
const customWelcome = {};

// Live runtime refs
let sock = null;
let botJid = null;
let currentNumber = null;
let pairingCode = null;
let connectionState = 'disconnected';
let io = null;
let BANNER_BUFFER = null;

let viewOnceEnabled = true;
let autoDownload = true;

// Reactions
const reactionsEnabled = new Set();
const reactionsDisabled = new Set();
let reactionsGlobal = false;

// Anti-link
const antilinkGroups = new Set();
const antilinkAction = new Map();

// Schedules
const schedules = new Map();

// Extra admins (JIDs without @server, digits only)
const extraAdmins = new Set();

// Warnings
const warnings = new Map();

// Auto-correct
const autoCorrectEnabled = new Set();   // chat JIDs with auto-correct ON
const dictionary = new Map();           // "wrong" → "right"

// Anti-mention
const antimentionGroups = new Set();    // group JIDs with anti-mention ON
const antimentionAction = new Map();    // groupJid → 'warn' | 'kick'
const antimentionWarnings = new Map();  // groupJid → { userJid: [reason, ...] }

// ============================================================================
// LID → PN MAPPING
// ============================================================================
// WhatsApp now hands out @lid (linked-device identifier) JIDs for many
// senders instead of phone-number JIDs. Replying to an unmapped @lid silently
// fails (typing shows, message never arrives) and admin checks can't match.
//
// We keep a map from LID digits → phone digits, populated from three sources:
//   1. LID_MAP env var at boot  (authoritative, survives redeploys)
//   2. EXTRA_ADMINS env var     (admins get mapped to themselves)
//   3. automatic learning when Baileys shows us both JIDs in one message
//      (this is the fallback; it only fires in groups)
// ============================================================================
const lidToPn = new Map();

// 🔧 Parse LID_MAP env var. Format: "lid:phone,lid:phone,..."
// Example: LID_MAP=232057586356242:237651858408,219683986915532:237678899829
(function loadLidMapFromEnv() {
  const raw = (process.env.LID_MAP || '').trim();
  if (!raw) {
    console.log('[LID] LID_MAP env not set — using only learned mappings');
    return;
  }
  let count = 0;
  for (const pair of raw.split(',')) {
    const [lid, pn] = pair.split(':').map((s) => (s || '').trim());
    const lidDigits = (lid || '').replace(/\D/g, '');
    const pnDigits = (pn || '').replace(/\D/g, '');
    if (!lidDigits || !pnDigits) continue;
    lidToPn.set(lidDigits, pnDigits);
    count++;
  }
  console.log(`[LID] loaded ${count} mapping(s) from LID_MAP env`);
})();

// ---------------------------------------------------------------------------
// Admin numbers
// ---------------------------------------------------------------------------
// ADMIN_NUMBER = the primary admin (env: ADMIN_NUMBER)
// extraAdmins  = additional admins (env: EXTRA_ADMINS + learned at runtime
//                via .addadmin)
// ---------------------------------------------------------------------------
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');

(function loadExtraAdminsFromEnv() {
  const raw = (process.env.EXTRA_ADMINS || '').trim();
  if (!raw) return;
  let count = 0;
  for (const n of raw.split(',')) {
    const digits = (n || '').replace(/\D/g, '');
    if (digits) {
      extraAdmins.add(digits);
      count++;
    }
  }
  if (count) console.log(`[Admins] loaded ${count} extra admin(s) from env`);
})();

// ---------------------------------------------------------------------------
// LID helpers
// ---------------------------------------------------------------------------
function registerLidMapping(lidJid, pnJid) {
  if (!lidJid || !pnJid) return;
  const lidNum = String(lidJid).split('@')[0].split(':')[0];
  const pnNum = String(pnJid).split('@')[0].split(':')[0];
  if (!lidNum || !pnNum) return;
  if (lidNum === pnNum) return;
  if (!/^\d{7,15}$/.test(lidNum) || !/^\d{7,15}$/.test(pnNum)) return;
  if (lidToPn.get(lidNum) === pnNum) return;
  lidToPn.set(lidNum, pnNum);
  console.log(`[LID] mapped ${lidNum} → ${pnNum}`);
  saveState();
}

function resolveLid(num) {
  const clean = String(num || '').split('@')[0].split(':')[0];
  return lidToPn.get(clean) || null;
}

// ============================================================================
// PERSISTENCE
// ============================================================================
const STATE_FILE = path.join(__dirname, 'bot_state.json');

function saveState() {
  try {
    const data = {
      pausedChats: [...pausedChats],
      welcomeEnabled: [...welcomeEnabled],
      goodbyeEnabled: [...goodbyeEnabled],
      customWelcome,
      viewOnceEnabled,
      autoDownload,
      reactionsEnabled: [...reactionsEnabled],
      reactionsDisabled: [...reactionsDisabled],
      reactionsGlobal,
      antilinkGroups: [...antilinkGroups],
      antilinkAction: Object.fromEntries(antilinkAction),
      schedules: Object.fromEntries(schedules),
      extraAdmins: [...extraAdmins],
      lidMappings: Object.fromEntries(lidToPn),
      warnings: Object.fromEntries(
        [...warnings.entries()].map(([g, u]) => [g, u])
      ),
      autoCorrectEnabled: [...autoCorrectEnabled],
      dictionary: Object.fromEntries(dictionary),
      antimentionGroups: [...antimentionGroups],
      antimentionAction: Object.fromEntries(antimentionAction),
      antimentionWarnings: Object.fromEntries(
        [...antimentionWarnings.entries()].map(([g, u]) => [g, u])
      )
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[State] save failed:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('[State] no saved state — starting fresh');
      return;
    }
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    (data.pausedChats || []).forEach((x) => pausedChats.add(x));
    (data.welcomeEnabled || []).forEach((x) => welcomeEnabled.add(x));
    (data.goodbyeEnabled || []).forEach((x) => goodbyeEnabled.add(x));
    Object.assign(customWelcome, data.customWelcome || {});
    if (typeof data.viewOnceEnabled === 'boolean') viewOnceEnabled = data.viewOnceEnabled;
    if (typeof data.autoDownload === 'boolean') autoDownload = data.autoDownload;

    (data.reactionsEnabled || []).forEach((x) => reactionsEnabled.add(x));
    (data.reactionsDisabled || []).forEach((x) => reactionsDisabled.add(x));
    if (typeof data.reactionsGlobal === 'boolean') reactionsGlobal = data.reactionsGlobal;

    (data.antilinkGroups || []).forEach((x) => antilinkGroups.add(x));
    Object.entries(data.antilinkAction || {}).forEach(([k, v]) => antilinkAction.set(k, v));

    Object.entries(data.schedules || {}).forEach(([k, v]) => schedules.set(k, v));

    (data.extraAdmins || []).forEach((x) => extraAdmins.add(x));

    // Learned LID mappings merge with env-loaded ones.
    // Env wins if there's a conflict (already set from LID_MAP).
    Object.entries(data.lidMappings || {}).forEach(([k, v]) => {
      if (!lidToPn.has(k)) lidToPn.set(k, v);
    });

    Object.entries(data.warnings || {}).forEach(([g, users]) => {
      warnings.set(g, users || {});
    });

    (data.autoCorrectEnabled || []).forEach((x) => autoCorrectEnabled.add(x));
    Object.entries(data.dictionary || {}).forEach(([k, v]) => dictionary.set(k, v));

    (data.antimentionGroups || []).forEach((x) => antimentionGroups.add(x));
    Object.entries(data.antimentionAction || {}).forEach(([k, v]) => antimentionAction.set(k, v));
    Object.entries(data.antimentionWarnings || {}).forEach(([g, users]) => {
      antimentionWarnings.set(g, users || {});
    });

    console.log(
      `[State] loaded from disk (${lidToPn.size} LID mappings, ${extraAdmins.size} extra admins)`
    );
  } catch (e) {
    console.error('[State] load failed:', e.message);
  }
}

// ============================================================================
// SOCKET.IO EMIT
// ============================================================================
function emit(event, data) {
  if (io) io.emit(event, data);
}

function setState(newState, extra = {}) {
  if (!newState) return;

  const hasExtra = Object.keys(extra).length > 0;
  const same = connectionState === newState;

  connectionState = newState;

  // Always emit if there's extra info; skip no-op transitions.
  if (!same || hasExtra) {
    emit('state', { state: newState, ...extra });
  }
}

// ============================================================================
// UI HELPERS
// ============================================================================
const UI = {
  box: (title, emoji = '📦') =>
    `╭━━━━━━━━━━━━━━━━━━━━╮\n┃  ${emoji}  *${title}*\n╰━━━━━━━━━━━━━━━━━━━━╯`
};

// ============================================================================
// ADMIN CHECK
// ============================================================================
// Matches on full digits OR last 10 digits (handles country-code variations).
// Also resolves via the LID map so users whose JID is @lid still work.
function isAdmin(jid) {
  if (!jid) return false;
  const num = String(jid).split('@')[0].split(':')[0];
  if (!num) return false;

  if (ADMIN_NUMBER && num === ADMIN_NUMBER) return true;

  if (ADMIN_NUMBER && ADMIN_NUMBER.length >= 10 && num.length >= 10) {
    if (num.slice(-10) === ADMIN_NUMBER.slice(-10)) return true;
  }

  const pn = lidToPn.get(num);
  if (pn) {
    if (pn === ADMIN_NUMBER) return true;
    if (ADMIN_NUMBER && ADMIN_NUMBER.length >= 10 && pn.length >= 10) {
      if (pn.slice(-10) === ADMIN_NUMBER.slice(-10)) return true;
    }
  }

  if (extraAdmins.has(num)) return true;
  if (pn && extraAdmins.has(pn)) return true;

  return false;
}

// ============================================================================
// PRESENCE WRAPPERS
// ============================================================================
async function withTyping(jid, fn) {
  try {
    if (sock) await sock.sendPresenceUpdate('composing', jid);
  } catch (_) { /* ignore */ }
  try {
    return await fn();
  } finally {
    try {
      if (sock) await sock.sendPresenceUpdate('paused', jid);
    } catch (_) { /* ignore */ }
  }
}

async function withRecording(jid, fn) {
  try {
    if (sock) await sock.sendPresenceUpdate('recording', jid);
  } catch (_) { /* ignore */ }
  try {
    return await fn();
  } finally {
    try {
      if (sock) await sock.sendPresenceUpdate('paused', jid);
    } catch (_) { /* ignore */ }
  }
}

async function sendWithBanner(jid, text) {
  try {
    if (BANNER_BUFFER && sock) {
      await sock.sendMessage(jid, { image: BANNER_BUFFER, caption: text });
      return;
    }
  } catch (e) { /* fall through to text */ }
  if (sock) await sock.sendMessage(jid, { text });
}

// ============================================================================
// SESSION CODES (HMAC-based, time-windowed)
// ============================================================================
// UI-level code, unrelated to WhatsApp pairing. Don't confuse with
// `pairingCode`, which comes from Baileys.
function generateSessionCodeForSlot(slot) {
  const secret = process.env.SESSION_SECRET || 'default-session-secret';
  return crypto
    .createHmac('sha256', secret)
    .update(String(slot))
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
}

function generateSessionCode(windowSeconds = 60) {
  const slot = Math.floor(Date.now() / (windowSeconds * 1000));
  return generateSessionCodeForSlot(slot);
}

function verifySessionCode(code, windowSeconds = 60) {
  if (!code) return false;
  const clean = String(code).trim().toUpperCase();
  const nowSlot = Math.floor(Date.now() / (windowSeconds * 1000));
  return (
    clean === generateSessionCodeForSlot(nowSlot) ||
    clean === generateSessionCodeForSlot(nowSlot - 1)
  );
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  // collections / maps
  pausedChats,
  welcomeEnabled,
  goodbyeEnabled,
  customWelcome,
  reactionsEnabled,
  reactionsDisabled,
  antilinkGroups,
  antilinkAction,
  schedules,
  extraAdmins,
  lidToPn,
  warnings,

  // new stores
  autoCorrectEnabled,
  dictionary,
  antimentionGroups,
  antimentionAction,
  antimentionWarnings,

  // getters/setters for primitives
  get sock() { return sock; },
  set sock(v) { sock = v; },
  get botJid() { return botJid; },
  set botJid(v) { botJid = v; },
  get currentNumber() { return currentNumber; },
  set currentNumber(v) { currentNumber = v; },
  get pairingCode() { return pairingCode; },
  set pairingCode(v) { pairingCode = v; },
  get connectionState() { return connectionState; },
  get io() { return io; },
  set io(v) { io = v; },
  get BANNER_BUFFER() { return BANNER_BUFFER; },
  set BANNER_BUFFER(v) { BANNER_BUFFER = v; },
  get viewOnceEnabled() { return viewOnceEnabled; },
  set viewOnceEnabled(v) { viewOnceEnabled = v; },
  get autoDownload() { return autoDownload; },
  set autoDownload(v) { autoDownload = v; },
  get reactionsGlobal() { return reactionsGlobal; },
  set reactionsGlobal(v) { reactionsGlobal = v; },

  // constants & helpers
  ADMIN_NUMBER,
  UI,
  isAdmin,
  withTyping,
  withRecording,
  sendWithBanner,
  saveState,
  loadState,
  emit,
  setState,
  generateSessionCode,
  verifySessionCode,

  registerLidMapping,
  resolveLid
};