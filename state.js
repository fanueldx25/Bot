// ============================================================================
// state.js — shared mutable state (prevents circular imports)
// ============================================================================

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

const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');

// ---------- Simple persistence ----------
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, 'bot_state.json');

function saveState() {
  try {
    const data = {
      pausedChats: [...pausedChats],
      welcomeEnabled: [...welcomeEnabled],
      goodbyeEnabled: [...goodbyeEnabled],
      customWelcome,
      viewOnceEnabled,
      autoDownload
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
    (data.pausedChats || []).forEach((x) => pausedChats.add(x));
    (data.welcomeEnabled || []).forEach((x) => welcomeEnabled.add(x));
    (data.goodbyeEnabled || []).forEach((x) => goodbyeEnabled.add(x));
    Object.assign(customWelcome, data.customWelcome || {});
    if (typeof data.viewOnceEnabled === 'boolean') viewOnceEnabled = data.viewOnceEnabled;
    if (typeof data.autoDownload === 'boolean') autoDownload = data.autoDownload;
    console.log('[State] loaded from disk');
  } catch (e) {
    console.error('[State] load failed:', e.message);
  }
}

// ---------- Socket.io emit helper ----------
function emit(event, data) {
  if (io) io.emit(event, data);
}

function setState(state, extra = {}) {
  connectionState = state;
  emit('state', { state, ...extra });
}

// ---------- UI helpers ----------
const UI = {
  box: (title, emoji = '📦') =>
    `╭━━━━━━━━━━━━━━━━━━━━╮\n┃  ${emoji}  *${title}*\n╰━━━━━━━━━━━━━━━━━━━━╯`
};

function isAdmin(jid) {
  if (!ADMIN_NUMBER) return false;
  return jid.split('@')[0].split(':')[0] === ADMIN_NUMBER;
}

// ---------- Presence wrappers ----------
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

// ---------- Exports (getters keep live refs in sync) ----------
module.exports = {
  // mutable sets/objects (same reference always)
  pausedChats,
  welcomeEnabled,
  goodbyeEnabled,
  customWelcome,
  
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
  
  ADMIN_NUMBER,
  UI,
  isAdmin,
  withTyping,
  withRecording,
  sendWithBanner,
  saveState,
  loadState,
  emit,
  setState
};