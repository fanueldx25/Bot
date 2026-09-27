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
let connectionState = 'disconnected'; // disconnected | connecting | code_ready | connected | error
let io = null;
let BANNER_BUFFER = null;

let viewOnceEnabled = true;
let autoDownload = true;

// ---------- NEW: reactions ----------
const reactionsEnabled = new Set(); // chat JIDs where bot reacts
const reactionsDisabled = new Set(); // chat JIDs where bot stays quiet
let reactionsGlobal = false;

// ---------- NEW: anti-link ----------
const antilinkGroups = new Set();
const antilinkAction = new Map(); // jid -> 'delete' | 'warn' | 'kick'

// ---------- NEW: schedules ----------
const schedules = new Map(); // jid -> { action, at, repeat }

// ---------- NEW: extra admins (promotable via .addadmin) ----------
const extraAdmins = new Set();

// ---------- Admin number (digits only) ----------
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');

// ============================================================================
// PERSISTENCE
// ============================================================================
const STATE_FILE = path.join(__dirname, 'bot_state.json');

function saveState() {
  try {
    const data = {
      // existing
      pausedChats: [...pausedChats],
      welcomeEnabled: [...welcomeEnabled],
      goodbyeEnabled: [...goodbyeEnabled],
      customWelcome,
      viewOnceEnabled,
      autoDownload,
      // new
      reactionsEnabled: [...reactionsEnabled],
      reactionsDisabled: [...reactionsDisabled],
      reactionsGlobal,
      antilinkGroups: [...antilinkGroups],
      antilinkAction: Object.fromEntries(antilinkAction),
      schedules: Object.fromEntries(schedules),
      extraAdmins: [...extraAdmins]
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[State] save failed:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    
    // existing
    (data.pausedChats || []).forEach((x) => pausedChats.add(x));
    (data.welcomeEnabled || []).forEach((x) => welcomeEnabled.add(x));
    (data.goodbyeEnabled || []).forEach((x) => goodbyeEnabled.add(x));
    Object.assign(customWelcome, data.customWelcome || {});
    if (typeof data.viewOnceEnabled === 'boolean') viewOnceEnabled = data.viewOnceEnabled;
    if (typeof data.autoDownload === 'boolean') autoDownload = data.autoDownload;
    
    // new
    (data.reactionsEnabled || []).forEach((x) => reactionsEnabled.add(x));
    (data.reactionsDisabled || []).forEach((x) => reactionsDisabled.add(x));
    if (typeof data.reactionsGlobal === 'boolean') reactionsGlobal = data.reactionsGlobal;
    (data.antilinkGroups || []).forEach((x) => antilinkGroups.add(x));
    Object.entries(data.antilinkAction || {}).forEach(([k, v]) => antilinkAction.set(k, v));
    Object.entries(data.schedules || {}).forEach(([k, v]) => schedules.set(k, v));
    (data.extraAdmins || []).forEach((x) => extraAdmins.add(x));
    
    console.log('[State] loaded from disk');
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

function setState(state, extra = {}) {
  connectionState = state;
  emit('state', { state, ...extra });
}

// ============================================================================
// UI HELPERS
// ============================================================================
const UI = {
  box: (title, emoji = '📦') =>
    `╭━━━━━━━━━━━━━━━━━━━━╮\n┃  ${emoji}  *${title}*\n╰━━━━━━━━━━━━━━━━━━━━╯`
};

// ============================================================================
// ADMIN CHECK (root admin + extraAdmins)
// ============================================================================
function isAdmin(jid) {
  const num = (jid || '').split('@')[0].split(':')[0];
  if (!num) return false;
  if (ADMIN_NUMBER && num === ADMIN_NUMBER) return true;
  return extraAdmins.has(num);
}

// ============================================================================
// PRESENCE WRAPPERS
// ============================================================================
async function withTyping(jid, fn) {
  try {
    if (sock) await sock.sendPresenceUpdate('composing', jid);
    await fn();
    if (sock) await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {
    await fn();
  }
}

async function withRecording(jid, fn) {
  try {
    if (sock) await sock.sendPresenceUpdate('recording', jid);
    await fn();
    if (sock) await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {
    await fn();
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
// SEASONAL SESSION CODE (time-based, rotating every 60s)
// ============================================================================
function generateSessionCodeForSlot(slot, windowSeconds = 60) {
  const secret = process.env.SESSION_SECRET || 'default-session-secret';
  const h = crypto
    .createHmac('sha256', secret)
    .update(String(slot))
    .digest('hex');
  return h.slice(0, 6).toUpperCase();
}

function generateSessionCode(windowSeconds = 60) {
  const slot = Math.floor(Date.now() / (windowSeconds * 1000));
  return generateSessionCodeForSlot(slot, windowSeconds);
}

function verifySessionCode(code, windowSeconds = 60) {
  if (!code) return false;
  const clean = String(code).trim().toUpperCase();
  const nowSlot = Math.floor(Date.now() / (windowSeconds * 1000));
  return (
    clean === generateSessionCodeForSlot(nowSlot, windowSeconds) ||
    clean === generateSessionCodeForSlot(nowSlot - 1, windowSeconds)
  );
}

// ============================================================================
// EXPORTS (getters/setters keep live refs in sync)
// ============================================================================
module.exports = {
  // mutable sets/objects (same reference always)
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
  
  // live values via getters
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
  
  // constants / helpers
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
  
  // session code helpers
  generateSessionCode,
  verifySessionCode
};