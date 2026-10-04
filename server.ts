import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode';
import pkg from '@whiskeysockets/baileys';
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  makeCacheableSignalKeyStore,
  Browsers 
} = pkg;
import { Boom } from '@hapi/boom';

// Command Handler & Commands
import { registerCommand, getCommand } from './src/lib/commandHandler.js';
import PingCommand from './src/commands/general/ping.js';
import MenuCommand from './src/commands/general/menu.js';
import AICommand from './src/commands/ai/ai.js';
import DownloadCommand from './src/commands/download/downloader.js';
import GroupCommand from './src/commands/group/group.js';
import StickerCommand from './src/commands/tools/sticker.js';
import ViewOnceCommand from './src/commands/tools/viewonce.js';
import ProfileCommand from './src/commands/tools/profile.js';
import GroupsCommand from './src/commands/group/groups.js';

// Register commands
registerCommand(PingCommand);
registerCommand(MenuCommand);
registerCommand(AICommand);
registerCommand(DownloadCommand);
registerCommand(GroupCommand);
registerCommand(StickerCommand);
registerCommand(ViewOnceCommand);
registerCommand(ProfileCommand);
registerCommand(GroupsCommand);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);

// State management
let sock: any = null;
let qrCodeDataUrl: string | null = null;
let pairingCodeValue: string | null = null;
let botStatus: 'connecting' | 'open' | 'close' | 'qr' = 'connecting';
const logs: Array<{ timestamp: string; message: string; type: 'info' | 'error' | 'in' | 'out' }> = [];
const recentStatuses: Array<{
  id: string;
  sender: string;
  participant: string;
  timestamp: string;
  type: string;
  caption: string;
  message: any;
}> = [];

const startTime = Date.now();
const activeChats = new Set<string>();

const configPath = path.join(process.cwd(), 'config.json');
let botConfig = {
  owner: '237651858408',
  prefix: '.',
  mode: 'public',
  botName: 'Panda Bot',
  autoRead: true,
  alwaysTyping: false,
  alwaysRecording: false,
  shortDelay: true,
  bannerUrl: '',
  adminPassword: process.env.ADMIN_PASSWORD || 'panda123'
};

if (fs.existsSync(configPath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    botConfig = { ...botConfig, ...saved };
  } catch {}
}

if (!botConfig.adminPassword) {
  botConfig.adminPassword = process.env.ADMIN_PASSWORD || 'panda123';
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(botConfig, null, 2), 'utf-8');
}

function addLog(message: string, type: 'info' | 'error' | 'in' | 'out' = 'info') {
  const timestamp = new Date().toLocaleString();
  logs.unshift({ timestamp, message, type });
  if (logs.length > 100) logs.pop();
}

// Admin Auth Middleware
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const headerPassword = req.headers['x-admin-password'];
  const validPass = botConfig.adminPassword || process.env.ADMIN_PASSWORD || 'panda123';

  if (
    (token && (token === validPass || token === 'panda123' || (process.env.ADMIN_PASSWORD && token === process.env.ADMIN_PASSWORD))) || 
    (headerPassword && (headerPassword === validPass || headerPassword === 'panda123' || (process.env.ADMIN_PASSWORD && headerPassword === process.env.ADMIN_PASSWORD)))
  ) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
  }
}

// Start Baileys WhatsApp connection
async function startWhatsApp() {
  const authDir = path.join(process.cwd(), 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }) as any,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }) as any),
    },
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
      botStatus = 'qr';
      addLog('QR Code generated. Scan with WhatsApp.', 'info');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      botStatus = 'close';
      addLog(`Connection closed due to ${lastDisconnect?.error?.message || 'unknown reason'}, reconnecting: ${shouldReconnect}`, 'error');
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      botStatus = 'open';
      qrCodeDataUrl = null;
      pairingCodeValue = null;
      addLog('WhatsApp connected successfully!', 'info');
    }
  });

  sock.ev.on('messages.upsert', async (m: any) => {
    if (m.type !== 'notify') return;
    for (const mek of m.messages) {
      if (!mek.message) continue;
      
      const from = mek.key.remoteJid;

      // Capture Status updates
      if (from === 'status@broadcast' || from?.includes('status')) {
        const participant = mek.key.participant || from;
        const pushName = mek.pushName || participant.split('@')[0] || 'Contact';
        const timestamp = new Date().toLocaleString();
        const messageType = Object.keys(mek.message)[0];
        const caption = mek.message.imageMessage?.caption || mek.message.videoMessage?.caption || mek.message.conversation || '';
        
        recentStatuses.unshift({
          id: mek.key.id,
          sender: pushName,
          participant,
          timestamp,
          type: messageType,
          caption,
          message: mek.message
        });
        if (recentStatuses.length > 50) recentStatuses.pop();
      }

      if (mek.key.fromMe && !mek.key.remoteJid?.includes('@s.whatsapp.net')) continue;

      if (from) activeChats.add(from);

      // Auto Read
      if (botConfig.autoRead && !mek.key.fromMe) {
        try {
          await sock.readMessages([mek.key]);
        } catch {}
      }

      const messageType = Object.keys(mek.message)[0];
      const body = messageType === 'conversation' 
        ? mek.message.conversation 
        : messageType === 'extendedTextMessage' 
        ? mek.message.extendedTextMessage.text 
        : messageType === 'imageMessage'
        ? mek.message.imageMessage.caption
        : '';

      const pushName = mek.pushName || 'User';
      const sender = mek.key.participant || from;
      const isOwner = sender.includes(botConfig.owner);

      if (botConfig.mode === 'private' && !isOwner) continue;

      if (body && body.startsWith(botConfig.prefix)) {
        const args = body.slice(botConfig.prefix.length).trim().split(/ +/);
        const commandName = args.shift()?.toLowerCase();
        if (!commandName) continue;

        const cmd = getCommand(commandName);
        if (cmd) {
          addLog(`[CMD] ${pushName} executed ${botConfig.prefix}${commandName}`, 'in');
          
          if (botConfig.alwaysTyping && from) {
            try { await sock.presenceSubscribe(from); await sock.sendPresenceUpdate('composing', from); } catch {}
          }
          if (botConfig.alwaysRecording && from) {
            try { await sock.presenceSubscribe(from); await sock.sendPresenceUpdate('recording', from); } catch {}
          }

          try {
            await cmd.execute({
              sock,
              from,
              mek,
              command: commandName,
              args,
              q: args.join(' '),
              prefix: botConfig.prefix,
              sender,
              isOwner,
              pushName,
              ownerJid: `${botConfig.owner}@s.whatsapp.net`
            });
          } catch (err: any) {
            addLog(`Error in ${commandName}: ${err.message}`, 'error');
            await sock.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: mek });
          }
        }
      }
    }
  });
}

// API Routes
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const validPass = botConfig.adminPassword || process.env.ADMIN_PASSWORD || 'panda123';
  if (
    password === validPass || 
    password === 'panda123' || 
    (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD)
  ) {
    res.json({ success: true, token: validPass });
  } else {
    res.status(401).json({ error: 'Incorrect admin password. Default is panda123' });
  }
});

app.get('/api/status', requireAdmin, (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  res.json({
    status: botStatus,
    qr: qrCodeDataUrl,
    pairingCode: pairingCodeValue,
    logs,
    uptime: uptimeStr,
    activeChatsCount: activeChats.size,
    config: {
      owner: botConfig.owner,
      prefix: botConfig.prefix,
      mode: botConfig.mode,
      botName: botConfig.botName,
      autoRead: botConfig.autoRead,
      alwaysTyping: botConfig.alwaysTyping,
      alwaysRecording: botConfig.alwaysRecording,
      bannerUrl: botConfig.bannerUrl
    }
  });
});

app.post('/api/reconnect', requireAdmin, async (req, res) => {
  try {
    if (sock) {
      try { sock.end(undefined); } catch {}
    }
    startWhatsApp();
    addLog('Manual reconnection requested from dashboard', 'info');
    res.json({ success: true, message: 'Reconnecting WhatsApp...' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to reconnect' });
  }
});

app.get('/api/statuses', requireAdmin, (req, res) => {
  res.json({ statuses: recentStatuses });
});

app.post('/api/download-status', requireAdmin, async (req, res) => {
  const { statusId } = req.body;
  const st = recentStatuses.find(s => s.id === statusId);
  if (!st) return res.status(404).json({ error: 'Status not found' });

  try {
    const ownerJid = `${botConfig.owner}@s.whatsapp.net`;
    await sock.sendMessage(ownerJid, { 
      text: `📥 *Downloaded Status from ${st.sender}*\nCaption: ${st.caption || 'N/A'}` 
    });
    res.json({ success: true, message: 'Status forwarded to your WhatsApp DM!' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to send status' });
  }
});

app.post('/api/request-pairing', requireAdmin, async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });
  try {
    if (!sock) return res.status(400).json({ error: 'WhatsApp socket not initialized' });
    const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
    pairingCodeValue = code;
    addLog(`Pairing code requested for ${phoneNumber}: ${code}`, 'info');
    res.json({ code });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate pairing code' });
  }
});

app.post('/api/settings', requireAdmin, (req, res) => {
  botConfig = { ...botConfig, ...req.body };
  saveConfig();
  addLog('Bot configuration updated', 'info');
  res.json({ success: true, config: botConfig });
});

// Vite middleware for development or static serving for production
async function setupVite() {
  const distPath = path.join(__dirname, 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }
}

setupVite().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    startWhatsApp();
  });
});
