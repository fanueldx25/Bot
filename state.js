// ============================================================================
// state.js — shared mutable state (prevents circular imports)
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Existing state ----------
const pausedChats = new Set();
const welcomeEnabled = new Set();
const goodbyeEnabled = new Set();
const customWelcome = {};

let sock = null;
let botJid = null;
let currentNumber = null;
let pairingCode = null;
let connectionState = 'disconnected';
let io = null;
let BANNER_BUFFER = null;

let viewOnceEnabled = true;
let autoDownload = true;

// ---------- Reactions ----------
const reactionsEnabled = new Set();
const reactionsDisabled = new Set();
let reactionsGlobal = false;

// ---------- Anti-link ----------
const antilinkGroups = new Set();
const antilinkAction = new Map();

// ---------- Schedules ----------
const schedules = new Map();

// ---------- Extra admins ----------
const extraAdmins = new Set();

// ---------- Warnings ----------
const warnings = new Map();

// 🆕 ---------- Auto-correct ----------
const autoCorrectEnabled = new Set();   // chat JIDs with auto-correct ON
const dictionary = new Map();           // "wrong" → "right"

// 🆕 ---------- Anti-mention ----------
const antimentionGroups = new Set();    // group JIDs with anti-mention ON
const antimentionAction = new Map();    // groupJid → 'warn' | 'kick'
const antimentionWarnings = new Map();  // groupJid → { userJid: [reason, ...] }

// ============================================================================
// LID → PN MAPPING
// (WhatsApp sends @lid identifiers; we map them to real phone numbers)
// ============================================================================
const lidToPn = new Map();

// 🔧 TEMPORARY MANUAL MAPPING
// Remove this line once Baileys 6.7.18+ auto-resolves LIDs for your account.
// NOTE: even after removing it here, the mapping will be re-added on boot
// from bot_state.json → delete its "lidMappings" entry too.
lidToPn.set('219683986915532', '237678899829');

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

// ---------- Admin number (digits only) ----------
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');

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
      // 🆕 auto-correct
      autoCorrectEnabled: [...autoCorrectEnabled],
      dictionary: Object.fromEntries(dictionary),
      // 🆕 anti-mention
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
    Object.entries(data.lidMappings || {}).forEach(([k, v]) => lidToPn.set(k, v));

    Object.entries(data.warnings || {}).forEach(([g, users]) => {
      warnings.set(g, users || {});
    });

    // 🆕 restore auto-correct
    (data.autoCorrectEnabled || []).forEach((x) => autoCorrectEnabled.add(x));
    Object.entries(data.dictionary || {}).forEach(([k, v]) => dictionary.set(k, v));

    // 🆕 restore anti-mention
    (data.antimentionGroups || []).forEach((x) => antimentionGroups.add(x));
    Object.entries(data.antimentionAction || {}).forEach(([k, v]) => antimentionAction.set(k, v));
    Object.entries(data.antimentionWarnings || {}).forEach(([g, users]) => {
      antimentionWarnings.set(g, users || {});
    });

    console.log('[State] loaded from disk');
  } catch (e) {
    console.error('[State] load failed:', e.message);
  }
}

// ============================================================================
// SOCKET.IO
// ============================================================================
function emit(event, data) {
  if (io) io.emit(event, data);
}

function setState(state, extra = {}) {
  connectionState = state;
  emit('state', { state, ...extra });
}

// ============================================================================
// UI
// ============================================================================
const UI = {
  box: (title, emoji = '📦') =>
    `╭━━━━━━━━━━━━━━━━━━━━╮\n┃  ${emoji}  *${title}*\n╰━━━━━━━━━━━━━━━━━━━━╯`
};

// ============================================================================
// ADMIN CHECK
// ============================================================================
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
  } catch (e) { /* fall through */ }
  if (sock) await sock.sendMessage(jid, { text });
}

// ============================================================================
// SEASONAL SESSION CODE
// ============================================================================
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

  // 🆕 new stores
  autoCorrectEnabled,
  dictionary,
  antimentionGroups,
  antimentionAction,
  antimentionWarnings,

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