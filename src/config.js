import 'dotenv/config';

export const config = {
  botName: process.env.BOT_NAME || 'Command Center',
  prefixes: (process.env.PREFIX || '.,!').split(',').map(p => p.trim()),
  ownerNumber: process.env.OWNER_NUMBER,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 3000,
  sessionSecret: process.env.SESSION_SECRET,
  adminUser: process.env.ADMIN_USER,
  adminPassHash: process.env.ADMIN_PASS_HASH,
};

export const runtime = {
  paused: false,
  pausedChats: new Set(),
  startedAt: Date.now(),
  admins: new Set([process.env.OWNER_NUMBER]),
  autoCorrect: new Map(), // chatId -> true
  antilink: new Map(), // chatId -> 'off'|'warn'|'delete'|'kick'
  antimention: new Set(),
  reactions: new Set(), // chats where bot reacts
  autodl: new Set(),
  warnings: new Map(), // chatId -> { jid: count }
  welcome: new Map(),
  goodbye: new Map(),
  customWelcome: new Map(),
  customGoodbye: new Map(),
};