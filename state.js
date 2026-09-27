// ============================================================================
// state.js — shared mutable state (prevents circular imports)
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Feature state
// ---------------------------------------------------------------------------
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

const reactionsEnabled = new Set();
const reactionsDisabled = new Set();
let reactionsGlobal = false;

const antilinkGroups = new Set();
const antilinkAction = new Map();

const schedules = new Map();

const extraAdmins = new Set();
const warnings = new Map();

const autoCorrectEnabled = new Set();
const dictionary = new Map();

const antimentionGroups = new Set();
const antimentionAction = new Map();
const antimentionWarnings = new Map();

// ============================================================================
// LID → PN MAP  (in-memory + file-backed)
// ============================================================================
const LID_FILE = path.join(__dirname, 'lid-mappings.json');

const lidToPn = new Map();   // in-memory fast lookup
let lidMap = {};             // file-backed object mirror

function loadLidMap() {
  try {
    if (fs.existsSync(LID_FILE)) {
      lidMap = JSON.parse(fs.readFileSync(LID_FILE, 'utf8'));
      // hydrate the in-memory Map from the file
      for (const [lid, pn] of Object.entries(lidMap)) {
        if (!lidToPn.has(lid)) lidToPn.set(lid, pn);
      }
      console.log(`[LID] loaded ${Object.keys(lidMap).length} mapping(s) from ${LID_FILE}`);
    } else {
      console.log('[LID] no lid-mappings.json found — starting fresh');
    }
  } catch (e) {
    console.error('[LID] Load error:', e.message);
  }
}

function saveLidMap() {
  try {
    fs.writeFileSync(LID_FILE, JSON.stringify(lidMap, null, 2));
  } catch (e) {
    console.error('[LID] Save error:', e.message);
  }
}

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
    lidMap[lidDigits] = pnDigits;
    count++;
  }
  console.log(`[LID] loaded ${count} mapping(s) from LID_MAP env`);
  if (count) saveLidMap();
})();

// Load file-backed map on startup (fills in anything not from env)
loadLidMap();

// ---------------------------------------------------------------------------
// Admin numbers
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
  const pnNum  = String(pnJid).split('@')[0].split(':')[0];
  if (!lidNum || !pnNum) return;
  if (lidNum === pnNum) return;
  if (!/^\d{7,15}$/.test(lidNum) || !/^\d{7,15}$/.test(pnNum)) return;
  if (lidToPn.get(lidNum) === pnNum) return;

  lidToPn.set(lidNum, pnNum);
  lidMap[lidNum] = pnNum;
  console.log(`[LID] mapped ${lidNum} → ${pnNum}`);

  saveLidMap();   // persist to lid-mappings.json
  saveState();    // keep bot_state.json in sync too
}

function resolveLid(num) {
  const clean = String(num || '').split('@')[0].split(':')[0];
  return lidToPn.get(clean) || lidMap[clean] || null;
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

    Object.entries(data.lidMappings || {}).forEach(([k, v]) => {
      if (!lidToPn.has(k)) lidToPn.set(k, v);
      if (!lidMap[k]) lidMap[k] = v;
    });
    saveLidMap();

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
// ADMIN CHECK — accepts phone JIDs AND @lid JIDs by their raw digits
// ============================================================================
function isAdmin(jid) {
  if (!jid) return false;
  const num = String(jid).split('@')[0].split(':')[0];
  if (!num) return false;

  if (ADMIN_NUMBER && num === ADMIN_NUMBER) return true;
  if (extraAdmins.has(num)) return true;

  if (num.length >= 10) {
    if (ADMIN_NUMBER && ADMIN_NUMBER.length >= 10 &&
        num.slice(-10) === ADMIN_NUMBER.slice(-10)) return true;
    for (const e of extraAdmins) {
      if (e.length >= 10 && num.slice(-10) === e.slice(-10)) return true;
    }
  }

  const pn = lidToPn.get(num) || lidMap[num];
  if (pn) {
    if (ADMIN_NUMBER && pn === ADMIN_NUMBER) return true;
    if (extraAdmins.has(pn)) return true;
    if (pn.length >= 10) {
      if (ADMIN_NUMBER && ADMIN_NUMBER.length >= 10 &&
          pn.slice(-10) === ADMIN_NUMBER.slice(-10)) return true;
      for (const e of extraAdmins) {
        if (e.length >= 10 && pn.slice(-10) === e.slice(-10)) return true;
      }
    }
  }

  return false;
}

// ============================================================================
// PRESENCE WRAPPERS
// ============================================================================
async function withTyping(jid, fn) {
  try {
    if (sock) await sock.sendPresenceUpdate('composing', jid);
  } catch (_) {}
  try {
    return await fn();
  } finally {
    try {
      if (sock) await sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}
  }
}

async function withRecording(jid, fn) {
  try {
    if (sock) await sock.sendPresenceUpdate('recording', jid);
  } catch (_) {}
  try {
    return await fn();
  } finally {
    try {
      if (sock) await sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}
  }
}

async function sendWithBanner(jid, text) {
  try {
    if (BANNER_BUFFER && sock) {
      await sock.sendMessage(jid, { image: BANNER_BUFFER, caption: text });
      return;
    }
  } catch (e) {}
  if (sock) await sock.sendMessage(jid, { text });
}

// ============================================================================
// SESSION CODES
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
  resolveLid,
  loadLidMap,
  saveLidMap
};