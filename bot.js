import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { usePostgresAuthState, clearAuthState } from './auth.js';
import { setStatus, log } from './db.js';
import { isOwner, isCommandEnabled } from './commands/access.js';
import { handleViewOnce } from './view.js';
import { runAutomations } from './engine.js';
import { antiCheck } from './commands/anti.js';

/* ═══════════════════════════════════════════════
   Global handler — silence benign Baileys noise
   ═══════════════════════════════════════════════ */
const BENIGN_ERRORS = [
  'Timed Out',
  'Connection Closed',
  'Connection Terminated',
  'Connection Failure',
  'Bad MAC',
  'decrypt',
  'Stream Errored',
  'Socket Errored',
  'EPIPE',
  'ECONNRESET',
];

process.on('unhandledRejection', (err) => {
  const msg = err?.message || String(err);
  if (BENIGN_ERRORS.some((e) => msg.includes(e))) {
    console.log('⚠️  Baileys non-fatal:', msg);
    return;
  }
  console.error('Unhandled rejection:', err);
});

const SESSION_ID = 'owner';
const logger = pino({ level: 'silent' });

let sock = null;
let ioRef = null;
const commands = new Map();

export const setIO = (io) => { ioRef = io; };
export const getSock = () => sock;
export const getIO = () => ioRef;
export const registerCommand = (name, handler) => commands.set(name, handler);

/* ---------------- Human-like helpers ---------------- */
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESENCE_JITTER = { min: 500, max: 1800 };
const TYPING_RATE = { min: 20, max: 55 };

async function humanTyping(jid, text = '') {
  if (!sock) return;
  try {
    await sock.sendPresenceUpdate('available', jid);
    await sock.sendPresenceUpdate('composing', jid);
    const cps = rand(TYPING_RATE.min, TYPING_RATE.max);
    const ms = Math.min(9000, Math.max(900, (text.length / cps) * 1000));
    await sleep(ms + rand(PRESENCE_JITTER.min, PRESENCE_JITTER.max));
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
}

export async function humanSend(jid, content, opts = {}) {
  if (!sock) throw new Error('Socket not connected');
  const text = content?.text || content?.caption || '';
  await humanTyping(jid, text);
  return sock.sendMessage(jid, content, opts);
}

/* ---------------- Connect ---------------- */
export async function startBot({ phoneNumber = null, mode = 'qr' } = {}) {
  const { state, saveCreds } = await usePostgresAuthState(SESSION_ID);
  const { version } = await fetchLatestBaileysVersion();
  
  const hasCreds = !!state.creds?.me;
  const usePairing = mode === 'pair' && !!phoneNumber && !hasCreds;
  const useQR = !usePairing;
  
  console.log(`🚀 startBot mode=${mode} usePairing=${usePairing} useQR=${useQR}`);
  
  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Ubuntu', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    getMessage: async () => ({ conversation: '' }),
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  if (usePairing && !sock.authState.creds.registered) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cleaned);
        console.log('🔑 Pairing code:', code);
        ioRef?.emit('pairing-code', { code, phone: cleaned });
        await log(SESSION_ID, 'info', `Pairing code issued for ${cleaned}: ${code}`);
      } catch (e) {
        console.error('pairing code failed:', e);
        ioRef?.emit('pairing-code-error', { error: e.message });
        await log(SESSION_ID, 'error', `Pairing code failed: ${e.message}`);
      }
    }, 3000);
  }
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && useQR) {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
      ioRef?.emit('qr', { qr: dataUrl, expiresIn: 20000 });
      await setStatus(SESSION_ID, 'qr');
    }
    
    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || null;
      await setStatus(SESSION_ID, 'connected', phone);
      ioRef?.emit('status', { status: 'connected', phone });
      await log(SESSION_ID, 'info', `Connected as ${phone}`);
      console.log('✅ Connected:', phone);
    }
    
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      await setStatus(SESSION_ID, shouldReconnect ? 'reconnecting' : 'disconnected');
      ioRef?.emit('status', {
        status: shouldReconnect ? 'reconnecting' : 'disconnected',
      });
      if (shouldReconnect) {
        console.log('🔄 Reconnecting in 3s...');
        setTimeout(() => startBot({ mode }), 3000);
      } else {
        console.log('❌ Logged out');
        await clearAuthState(SESSION_ID);
      }
    }
  });
  
  /* ════════════════════════════════════════════════
     MESSAGE HANDLER
     ════════════════════════════════════════════════ */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    
    const jid = jidNormalizedUser(msg.key.remoteJid);
    if (jid === 'status@broadcast') return;
    
    const m = msg.message;
    const text =
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.buttonsResponseMessage?.selectedButtonId ||
      m.listResponseMessage?.singleSelectReply?.selectedRowId ||
      '';
    
    // Diagnostic — log every incoming message
    console.log(`📩 [${jid.endsWith('@g.us') ? 'GROUP' : 'DM'}] ${jid.split('@')[0]}: "${text.slice(0, 60)}"`);
    
    // 1️⃣ View-once
    try {
      await handleViewOnce({ sock, msg, jid });
    } catch (e) {
      console.error('view-once handler error:', e.message);
    }
    
    // 2️⃣ Anti-check
    if (text) {
      try {
        const blocked = await antiCheck({ sock, msg, jid, text });
        if (blocked) return;
      } catch (e) {
        console.error('antiCheck error:', e.message);
      }
    }
    
    // 3️⃣ Automations
    if (text) {
      try {
        await runAutomations({ sock, msg, jid, text });
      } catch (e) {
        console.error('automation error:', e.message);
      }
    }
    
    // 4️⃣ Command parsing
    if (!text) return;
    const prefix = text[0];
    if (prefix !== '.' && prefix !== '!') return;
    
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const handler = commands.get(cmd);
    if (!handler) {
      console.log(`❓ Unknown command: .${cmd}`);
      return;
    }
    
    // 5️⃣ Command enabled check (dashboard toggle)
    if (!(await isCommandEnabled(cmd))) {
      console.log(`⏸️  Command .${cmd} is disabled`);
      return;
    }
    
    // 6️⃣ Permission check
    if (handler.ownerOnly && !isOwner(jid)) {
      return humanSend(jid, { text: '🔒 Owner only command.' }, { quoted: msg });
    }
    
    const ctx = {
      sock,
      msg,
      jid,
      text,
      args,
      isGroup: jid.endsWith('@g.us'),
      sender: jidNormalizedUser(msg.key.participant || jid),
      reply: (content, opts) => humanSend(jid, content, { quoted: msg, ...opts }),
      react: (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }),
    };
    
    console.log(`▶️  Executing .${cmd}`);
    try {
      await handler(ctx);
      console.log(`✅ .${cmd} completed`);
    } catch (err) {
      console.error(`❌ Command .${cmd} failed:`, err);
      await humanSend(jid, { text: `❌ Error: ${err.message}` }, { quoted: msg });
    }
  });
  
  return sock;
}

export async function logout() {
  if (sock) {
    try { await sock.logout(); } catch {}
    sock = null;
  }
  await clearAuthState(SESSION_ID);
}