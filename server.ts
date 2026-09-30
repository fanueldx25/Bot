import express from 'express';
import { createServer } from 'http';
import { 
  makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  makeCacheableSignalKeyStore,
  Browsers,
  useMultiFileAuthState,
  AuthenticationState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { usePostgresAuthState } from './src/lib/postgresAuthState.ts';
import { getConfig, addLog, getLogs, updateConfig } from './src/lib/config.ts';
import { getCommand, getAllCommands, CommandContext } from './src/lib/commandHandler.ts';
import { db, initDatabase, testDbConnection } from './src/db/index.ts';
import { baileysAuthCreds, baileysAuthKeys, botLogs } from './src/db/schema.ts';
import { eq } from 'drizzle-orm';
import './src/commands/general/general.ts';
import './src/commands/download/downloader.ts';
import './src/commands/utility/tools.ts';
import './src/commands/utility/tts.ts';
import './src/commands/utility/info.ts';
import './src/commands/utility/converter.ts';
import './src/commands/group/group.ts';
import './src/commands/owner/admin.ts';
import './src/commands/owner/anti.ts';
import './src/commands/owner/privacy.ts';
import './src/commands/utility/extra.ts';
import './src/commands/utility/voicemail.ts';
import {
  recordIncomingCall,
  generateVoicemailAudio,
  isExpectingVoicemail,
  recordVoicemailMessage,
  getVoicemailList,
  deleteVoicemail,
  clearAllVoicemails
} from './src/lib/voicemail.ts';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ level: 'silent' });
const app = express();
const server = createServer(app);
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

let sock: any = null;
let botStatus: 'connecting' | 'open' | 'close' | 'qr' = 'close';
let qrCode: string | null = null;
let pairingCode: string | null = null;
const startTime = Date.now();
(global as any).startTime = startTime;

let lastError: string | null = null;

// Message Queue System
const messageQueue: { m: any, config: any }[] = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  isProcessing = true;
  
  const item = messageQueue.shift();
  if (!item) {
    isProcessing = false;
    return;
  }

  const { m, config } = item;
  
  try {
    for (const msg of m.messages) {
      if (!msg.message) continue;

      const from = msg.key.remoteJid!;
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
      const pushName = msg.pushName || "User";

      // Auto Status Reaction Feature
      if (from === 'status@broadcast' && config.autoStatusReact && sock) {
        try {
          const emojis = ['💚', '🔥', '✨', '👍', '😎', '❤️', '🙌'];
          const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
          await sock.sendMessage('status@broadcast', { 
            react: { text: randomEmoji, key: msg.key } 
          }, { statusJidList: [msg.key.participant] });
        } catch (e) {}
        continue;
      }

      // Anti-Link Feature
      if (config.antiLink && from.endsWith('@g.us') && (body.includes('chat.whatsapp.com/') || body.includes('http://') || body.includes('https://'))) {
        try {
          // Check if sender is admin
          const metadata = await sock.groupMetadata(from);
          const participant = metadata.participants.find((p: any) => p.id === msg.key.participant);
          if (!participant?.admin) {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: `⚠️ @${msg.key.participant?.split('@')[0]} Links are not allowed in this group!`, mentions: [msg.key.participant] });
          }
        } catch {}
      }

      // View-Once Captor Logic
      const viewOnceMsg = msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message || msg.message?.viewOnceMessageV2Extension?.message;
      if (viewOnceMsg && sock) {
        try {
          const mediaType = Object.keys(viewOnceMsg)[0]; // imageMessage or videoMessage
          if (mediaType) {
            // React to indicate view-once captured
            await sock.sendMessage(from, { react: { text: '👀', key: msg.key } });

            const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(viewOnceMsg[mediaType], mediaType.replace('Message', '') as any);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk]);
            }
            
            if (mediaType === 'imageMessage') {
              await sock.sendMessage(from, { 
                image: buffer, 
                caption: viewOnceMsg.imageMessage?.caption || '' 
              }, { quoted: msg });
            } else if (mediaType === 'videoMessage') {
              await sock.sendMessage(from, { 
                video: buffer, 
                caption: viewOnceMsg.videoMessage?.caption || '' 
              }, { quoted: msg });
            }
          }
        } catch (e) {
          console.error('Error capturing view-once:', e);
        }
      }
      
      const isFromMe = msg.key.fromMe;
      const sender = msg.key.fromMe ? (sock?.user?.id || "") : (msg.key.participant || msg.key.remoteJid || "");
      const isOwner = msg.key.fromMe || (config.owner ? config.owner.split(',').some((o: string) => sender.includes(o.trim())) : false);

      // Do Not Disturb (DND): Drop non-owner messages silently
      if (config.dnd && !isOwner) {
        continue;
      }

      // Stealth Mode: disable read receipts if active
      if (!isFromMe && config.autoRead && !config.stealthMode) {
        const readDelay = Math.floor(Math.random() * 2000) + 2000;
        await new Promise(r => setTimeout(r, readDelay));
        if (sock) await sock.readMessages([msg.key]);
      }

      // Check if this sender was prompted to leave a voicemail!
      if (!isFromMe && isExpectingVoicemail(from) && !body.startsWith(config.prefix)) {
        const isAudio = !!msg.message?.audioMessage;
        const recordedText = isAudio ? '🎙️ [Voice Note / Audio Voicemail]' : (body || '📄 [Attachment / Message]');
        const res = await recordVoicemailMessage(from, recordedText, isAudio);
        if (res.success) {
          if (sock) {
            await sock.sendMessage(from, {
              text: `✅ *Voicemail Saved!* Thank you, your message has been safely recorded and delivered to the recipient. 📬`
            }, { quoted: msg });

            // Forward notification to owner if configured
            if (config.voicemailAutoForward !== false && config.owner) {
              const cleanOwner = config.owner.split(',')[0].replace(/[^0-9]/g, '');
              if (cleanOwner) {
                const ownerJid = `${cleanOwner}@s.whatsapp.net`;
                try {
                  const callerNum = from.split('@')[0];
                  const notice =
                    `📬 *NEW VOICEMAIL RECORDED!* 🎙️\n━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `👤 *Caller:* +${callerNum}\n` +
                    `⏰ *Time:* ${new Date().toLocaleTimeString()}\n` +
                    `📝 *Message:* ${recordedText}\n━━━━━━━━━━━━━━━━━━━━━━`;
                  await sock.sendMessage(ownerJid, { text: notice });
                  if (isAudio && msg.message?.audioMessage) {
                    // Forward audio message directly to owner
                    await sock.sendMessage(ownerJid, { forward: msg });
                  }
                } catch (fwdErr: any) {
                  console.warn('Could not forward voicemail notice to owner:', fwdErr.message);
                }
              }
            }
          }
        }
      }

      if (!body.startsWith(config.prefix)) continue;

      const args = body.slice(config.prefix.length).trim().split(/ +/);
      const commandName = args.shift()?.toLowerCase();
      if (!commandName) continue;
      const q = args.join(' ');

      const cmd = getCommand(commandName);
      if (cmd) {
        // Enforce private mode
        if (config.mode === 'private' && !isOwner) {
          continue;
        }

        // Response delays - only show typing if stealth mode is off
        if (!isFromMe) {
          const initialDelay = Math.floor(Math.random() * 2000) + 1500;
          await new Promise(r => setTimeout(r, initialDelay));

          if (sock && !config.stealthMode) await sock.sendPresenceUpdate('composing', from);
          
          const respondDelay = Math.floor(Math.random() * 2000) + 1500;
          await new Promise(r => setTimeout(r, respondDelay));
        } else {
          if (sock && !config.stealthMode) await sock.sendPresenceUpdate('composing', from);
        }
        
        addLog(`Executing: ${commandName} from ${pushName}`, 'in');
        try {
          const ctx: CommandContext = {
            sock, from, mek: msg, command: commandName, args, q, prefix: config.prefix, sender, isOwner, pushName
          };
          await cmd.execute(ctx);
        } catch (err: any) {
          addLog(`Error: ${err.message}`, 'error');
        } finally {
          if (sock) await sock.sendPresenceUpdate('paused', from);
        }
      }
    }
  } catch (err) {
    console.error('Queue processing error:', err);
  } finally {
    isProcessing = false;
    // Sequential delay between different people's commands (1-2s)
    setTimeout(processQueue, Math.floor(Math.random() * 1000) + 1000);
  }
}

async function connectToWhatsApp(forceMethod?: 'qr' | 'pairing') {
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.end(undefined);
    } catch (e) {}
  }

  const { version, isLatest } = await fetchLatestBaileysVersion();
  
  // Check if we have a registered session
  const { state, saveCreds } = await usePostgresAuthState('main');
  const isRegistered = state.creds && state.creds.registered;

  // If not forcing a method and not registered, don't auto-start
  if (!forceMethod && !isRegistered) {
    botStatus = 'close';
    addLog('No active session. Waiting for user choice.', 'info');
    return;
  }

  addLog(`Connecting...`, 'info');
  botStatus = 'connecting';

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async (key) => {
      return { conversation: '' };
    },
  });

  sock.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (update.lastDisconnect?.error) {
      lastError = update.lastDisconnect.error.message;
    }

    if (qr && (forceMethod === 'qr' || isRegistered)) {
      qrCode = qr;
      botStatus = 'qr';
      addLog('QR Code generated', 'info');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      addLog(`Connection closed. Code: ${statusCode}`, 'error');
      
      botStatus = 'close';
      qrCode = null;
      pairingCode = null;

      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => connectToWhatsApp(), 3000);
      }
    } else if (connection === 'open') {
      addLog('Connection opened!', 'info');
      botStatus = 'open';
      qrCode = null;
      pairingCode = null;
      lastError = null;

      if (sock.user?.id) {
        const ownerNumber = sock.user.id.split(':')[0];
        const currentConfig = await getConfig();
        if (!currentConfig.owner || currentConfig.owner === '') {
          await updateConfig({ owner: ownerNumber });
          addLog(`Auto-set bot owner to paired number: ${ownerNumber}`, 'info');
        }
      }
    }
  });

  sock.ev.on('creds.update', async () => {
    addLog('Auth creds updated (linking in progress or session refresh)', 'info');
    await saveCreds();
  });

  sock.ev.on('messages.upsert', async (m: any) => {
    if (m.type !== 'notify') return;
    const config = await getConfig();
    messageQueue.push({ m, config });
    processQueue();
  });

  sock.ev.on('call', async (calls: any[]) => {
    const config = await getConfig();
    const isVoicemailEnabled = config.voicemailEnabled !== false;

    for (const call of calls) {
      if (call.status === 'offer') {
        const callerNumber = call.from.split('@')[0];
        const isVideo = !!call.isVideo;

        if (isVoicemailEnabled) {
          try {
            addLog(`📞 Incoming ${isVideo ? 'video' : 'voice'} call from +${callerNumber}. Voicemail machine answering...`, 'info');
            
            // Brief 1.5s delay simulating 1-2 rings before answering machine picks up
            await new Promise(r => setTimeout(r, 1500));

            // Gracefully decline ringing so voicemail takes over
            await sock.rejectCall(call.id, call.from);

            // Record incoming call in voicemail history
            await recordIncomingCall(call.id, call.from, `+${callerNumber}`, isVideo);

            // Show audio recording status indicator
            await sock.sendPresenceUpdate('recording', call.from);

            // Generate greeting voice note
            const greeting =
              config.voicemailGreeting ||
              'Hello! You have reached my automated voicemail. I am unable to answer your call right now. Please leave your name and message right after this tone, and I will get back to you shortly.';
            const lang = config.voicemailLang || 'en';

            const audioBuffer = await generateVoicemailAudio(greeting, lang);

            // Send voice note greeting
            if (audioBuffer) {
              await sock.sendMessage(call.from, {
                audio: audioBuffer,
                mimetype: 'audio/mp4',
                ptt: true
              });
            }

            // Send interactive instructions card
            await sock.sendMessage(call.from, {
              text: `🎙️ *VOICEMAIL ANSWERING MACHINE* 🎙️\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `👋 *Hello +${callerNumber}!* We missed your call.\n` +
                    `📼 *Your voicemail greeting has been played above.*\n\n` +
                    `💬 *Please reply right here with your Voice Note or Message now.*\n` +
                    `Your message will be automatically saved and forwarded to the recipient! 📬\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━`
            });

            addLog(`Voicemail greeting played to +${callerNumber}`, 'out');
          } catch (e: any) {
            console.error('Voicemail call handling error:', e.message);
          }
        } else if (config.antiCall) {
          try {
            await sock.rejectCall(call.id, call.from);
            await sock.sendMessage(call.from, {
              text: '📵 *Privacy Shield:* Voice and video calls are not accepted on this number.'
            });
            addLog(`Rejected incoming call from +${callerNumber} (Anti-Call Shield)`, 'info');
          } catch (e: any) {
            console.error('Call reject error:', e.message);
          }
        }
      }
    }
  });
}

import { getTempFile } from './src/lib/tempStorage.ts';

// ... (previous imports)

app.get('/api/download/:id', (req, res) => {
  const file = getTempFile(req.params.id);
  if (!file || !fs.existsSync(file.filePath)) {
    return res.status(404).send('File not found or expired.');
  }
  res.download(file.filePath, file.fileName);
});

// --- AUTHENTICATION SYSTEM ---
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'fanuel123';
const activeSessions = new Set<string>();

const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // If DASHBOARD_PASSWORD is explicitly set to empty, allow access
  if (process.env.DASHBOARD_PASSWORD === '') return next();

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-dashboard-token'] as string);
  const headerPass = req.headers['x-dashboard-password'] as string;

  if (headerPass && headerPass === DASHBOARD_PASSWORD) {
    return next();
  }

  if (token && activeSessions.has(token)) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Master Passkey required', requiresAuth: true });
};

// Auth endpoints
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  if (password === DASHBOARD_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.add(token);
    addLog('User successfully authenticated to dashboard', 'info');
    return res.json({ success: true, token });
  }

  addLog('Failed dashboard authentication attempt', 'error');
  return res.status(401).json({ error: 'Invalid master passkey' });
});

app.get('/api/auth/check', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-dashboard-token'] as string);
  const headerPass = req.headers['x-dashboard-password'] as string;

  const isPasswordConfigured = process.env.DASHBOARD_PASSWORD !== '';
  if (!isPasswordConfigured) {
    return res.json({ authenticated: true, requiresPassword: false });
  }

  const isValid = (token && activeSessions.has(token)) || (headerPass && headerPass === DASHBOARD_PASSWORD);
  return res.json({ authenticated: !!isValid, requiresPassword: true });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-dashboard-token'] as string);
  if (token) {
    activeSessions.delete(token);
  }
  res.json({ success: true });
});

let cachedIsRegistered: boolean | null = null;
let lastRegisteredCheck = 0;

async function checkIsRegistered(): Promise<boolean> {
  const now = Date.now();
  if (cachedIsRegistered !== null && now - lastRegisteredCheck < 15000) {
    return cachedIsRegistered;
  }
  try {
    const { state } = await usePostgresAuthState('main');
    cachedIsRegistered = !!(state.creds && state.creds.registered);
  } catch (e) {
    cachedIsRegistered = botStatus === 'open';
  }
  lastRegisteredCheck = now;
  return cachedIsRegistered;
}

// Protected API Routes
app.get('/api/status', async (req, res) => {
  try {
    const config = await getConfig();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const isRegistered = await checkIsRegistered();

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers['x-dashboard-token'] as string);
    const headerPass = req.headers['x-dashboard-password'] as string;
    const isAuth = !process.env.DASHBOARD_PASSWORD || 
                   (token && activeSessions.has(token)) || 
                   (headerPass && headerPass === DASHBOARD_PASSWORD);

    let logs: any[] = [];
    try {
      logs = isAuth 
        ? await getLogs(40) 
        : [{ id: 0, message: '🔒 Authenticate with Master Passkey to view live server logs', type: 'info', timestamp: new Date() }];
    } catch {
      logs = [];
    }

    const safeConfig = isAuth ? config : {
      ...config,
      owner: config?.owner ? `${config.owner.slice(0, 3)}••••••${config.owner.slice(-2)}` : '',
    };

    res.json({
      status: botStatus,
      qr: isAuth ? qrCode : null,
      pairingCode: isAuth ? pairingCode : null,
      logs,
      uptime,
      config: safeConfig,
      isRegistered,
      lastError: isAuth ? lastError : null,
      isAuthenticated: isAuth
    });
  } catch (err: any) {
    console.error('Error fetching bot status:', err);
    res.json({
      status: botStatus || 'close',
      qr: null,
      pairingCode: null,
      logs: [],
      uptime: Math.floor((Date.now() - startTime) / 1000),
      config: {
        owner: "",
        prefix: ".",
        mode: "public",
        botName: "Fanuel Bot",
        autoRead: true,
        alwaysTyping: false,
        alwaysRecording: false,
        shortDelay: true,
        bannerUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1000&auto=format&fit=crop",
        antiLink: false,
        antiDelete: false,
        autoStatusReact: true
      },
      isRegistered: false,
      lastError: err.message || 'Server error',
      isAuthenticated: false
    });
  }
});

app.get('/api/health', async (req, res) => {
  const dbHealth = await testDbConnection();
  res.json({
    status: 'ok',
    database: dbHealth.ok ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - (global as any).startTime) / 1000)
  });
});

app.get('/api/commands', (req, res) => {
  const all = getAllCommands();
  res.json({
    commands: all.map(c => ({
      name: c.name,
      aliases: c.aliases || [],
      category: c.category,
      description: c.description
    }))
  });
});

app.post('/api/clear-logs', requireAuth, async (req, res) => {
  try {
    await db.delete(botLogs);
    addLog('Logs cleared by admin', 'info');
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/start-connection', requireAuth, async (req, res) => {
  const { method } = req.body;
  if (!['qr', 'pairing'].includes(method)) {
    return res.status(400).json({ error: 'Invalid method' });
  }
  
  await connectToWhatsApp(method);
  res.json({ success: true });
});

app.post('/api/reconnect', requireAuth, async (req, res) => {
  try {
    addLog('Manual reconnection requested...', 'info');
    await connectToWhatsApp();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/disconnect', requireAuth, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      botStatus = 'close';
      qrCode = null;
      pairingCode = null;
      addLog('Bot disconnected via dashboard', 'info');
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      botStatus = 'close';
      qrCode = null;
      pairingCode = null;
      addLog('User logged out via dashboard', 'info');
      setTimeout(connectToWhatsApp, 3000);
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/request-pairing', requireAuth, async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
  
  try {
    if (botStatus === 'open') {
      return res.status(400).json({ error: 'Bot is already connected. Please disconnect first.' });
    }
    
    addLog('Initializing fresh session for pairing...', 'info');
    
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.end(undefined);
      } catch (e) {}
    }

    await db.delete(baileysAuthCreds).where(eq(baileysAuthCreds.id, 'main'));
    await db.delete(baileysAuthKeys).where(eq(baileysAuthKeys.id, 'main'));
    
    await connectToWhatsApp('pairing');
    
    let retry = 0;
    while (!sock && retry < 20) {
      await new Promise(r => setTimeout(r, 500));
      retry++;
    }

    if (!sock) throw new Error('Socket failed to initialize');
    await new Promise(r => setTimeout(r, 2000));

    const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
    addLog(`Requesting pairing code for ${cleanedNumber}...`, 'info');
    
    const code = await sock.requestPairingCode(cleanedNumber);
    pairingCode = code;
    addLog(`Pairing code generated: ${code}`, 'info');
    res.json({ code });
  } catch (error: any) {
    console.error('Pairing code error:', error);
    let msg = error.message;
    if (msg === 'Connection Closed') msg = 'Connection was interrupted. Please try again.';
    if (msg === 'Precondition Required') msg = 'Session conflict cleared. Please click request code again.';
    res.status(500).json({ error: msg });
  }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    const newConfig = await updateConfig(req.body);
    addLog('Bot configuration updated via dashboard', 'info');
    res.json(newConfig);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- VOICEMAIL API ROUTES ---
app.get('/api/voicemails', async (req, res) => {
  try {
    const list = await getVoicemailList(50);
    res.json({ voicemails: list });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/voicemails/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const success = await deleteVoicemail(id);
    res.json({ success });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/voicemails/clear', requireAuth, async (req, res) => {
  try {
    const success = await clearAllVoicemails();
    addLog('Voicemail history cleared via dashboard', 'info');
    res.json({ success });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/voicemails/preview-greeting', async (req, res) => {
  try {
    const { text, lang } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Greeting text is required' });
    }
    const audioBuffer = await generateVoicemailAudio(text, lang || 'en');
    if (!audioBuffer) {
      return res.status(500).json({ error: 'Failed to synthesize voicemail audio' });
    }
    const audioBase64 = `data:audio/mp3;base64,${audioBuffer.toString('base64')}`;
    res.json({ audioBase64 });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend
async function startServer() {
  // 1. Open port immediately so Render health check passes instantly
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening immediately on port ${PORT}`);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const allowedHosts = ['.onrender.com', '.render.com', 'localhost', '127.0.0.1'];
    if (process.env.RENDER_EXTERNAL_URL) {
      try { allowedHosts.push(new URL(process.env.RENDER_EXTERNAL_URL).hostname); } catch (e) {}
    }
    if (process.env.APP_URL) {
      try { allowedHosts.push(new URL(process.env.APP_URL).hostname); } catch (e) {}
    }
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // SPA fallback: transform and serve index.html for all non-API paths (including /dashboard)
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      if (url.startsWith('/api')) return next();
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    const altDistPath = path.join(__dirname, 'dist');
    const finalDist = fs.existsSync(distPath) ? distPath : (fs.existsSync(altDistPath) ? altDistPath : null);

    if (finalDist) {
      app.use(express.static(finalDist));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        const indexPath = path.join(finalDist, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          res.status(404).send('Dashboard index.html not found');
        }
      });
    } else {
      console.warn('⚠️ Warning: dist folder not found in production mode. Serving fallback index.html.');
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        const indexHtml = path.resolve(__dirname, 'index.html');
        if (fs.existsSync(indexHtml)) {
          res.sendFile(indexHtml);
        } else {
          res.send('Fanuel Bot Server is running.');
        }
      });
    }
  }

  // Self-ping interval to keep server alive on free hosting tiers (Render, etc.)
  app.get('/ping', (req, res) => {
    res.json({ status: 'online', uptime: Date.now() - startTime, timestamp: new Date().toISOString() });
  });

  // Self-ping interval every 4 minutes
  setInterval(() => {
    const pingUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/ping` : `http://127.0.0.1:${PORT}/ping`;
    fetch(pingUrl).catch(() => {});
  }, 240000);

  // Background DB & WhatsApp initialization
  setTimeout(async () => {
    try {
      const dbStatus = await testDbConnection();
      if (dbStatus.ok) {
        console.log('✅ PostgreSQL connected successfully');
        await initDatabase();
      } else {
        console.warn('⚠️ PostgreSQL connection status:', dbStatus.error || 'not reachable');
      }
    } catch (e: any) {
      console.warn('⚠️ PostgreSQL initialization warning:', e.message);
    }
    connectToWhatsApp();
  }, 500);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
