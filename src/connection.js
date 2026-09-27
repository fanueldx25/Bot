import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import EventEmitter from 'events';
import { handleMessage } from './handler.js';

export const botEvents = new EventEmitter();
let sock = null;

export const getSocket = () => sock;

export async function startConnection() {
  const { state, saveCreds } = await useMultiFileAuthState('./src/auth/creds');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: true,
  });

  botEvents.on('request-pairing', async (phoneNumber) => {
    try {
      if (sock.authState.creds.registered) {
        botEvents.emit('pairing', { error: 'Already registered.' });
        return;
      }
      const code = await sock.requestPairingCode(phoneNumber);
      botEvents.emit('pairing', { code, phoneNumber });
    } catch (err) {
      botEvents.emit('pairing', { error: err.message });
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) botEvents.emit('qr', qr);
    if (connection === 'open') {
      botEvents.emit('open', { user: sock.user });
      console.log('✅ Bot connected:', sock.user?.id);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      botEvents.emit('close', { code, shouldReconnect });
      if (shouldReconnect) startConnection();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      try { await handleMessage(sock, msg); }
      catch (err) { console.error('handler error:', err); }
    }
  });

  sock.ev.on('group-participants.update', async (ev) => {
    const { handleGroupEvent } = await import('./events/groupEvents.js');
    await handleGroupEvent(sock, ev);
  });

  return sock;
}

export async function logout() {
  if (!sock) return;
  try { await sock.logout(); sock = null; botEvents.emit('logout'); }
  catch (e) { console.error('logout error:', e); }
}

export async function restart() {
  await logout();
  await startConnection();
}

export const requestPairingCode = (phone) => botEvents.emit('request-pairing', phone);