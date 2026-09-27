// Prefix config (can be overridden later via !setprefix)
let PREFIX = '!';

const commands = {
  // ----- access -----
  mode: handleMode,
  ping: handlePing,
  help: handleHelp,
  
  // ----- media -----
  v: handleViewOnce,
  vv: handleViewOnce,
  
  // ----- anti-delete -----
  antidelete: handleAntiDelete,
  antiedit: handleAntiEdit,
  
  // ----- group -----
  welcome: handleWelcome,
  kick: handleKick,
  tagall: handleTagAll,
  
  // ----- customization -----
  setbanner: handleSetBanner,
  menu: handleMenu,
  
  // ----- system -----
  status: handleStatus,
};

export async function handleMessage(payload, sock, state) {
  const { messages, type } = payload;
  if (type !== 'notify') return;
  
  for (const msg of messages) {
    if (!msg.message) continue;
    
    const jid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    const sender = fromMe ? state.ownerJid : (msg.key.participant || jid);
    
    // Private mode gate
    if (state.mode === 'private' && !fromMe && sender !== state.ownerJid) continue;
    
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';
    
    if (!text.startsWith(PREFIX)) continue;
    
    const [rawCmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
    const handler = commands[rawCmd.toLowerCase()];
    if (!handler) continue;
    
    try {
      await handler({ args, msg, sock, state, jid, sender, fromMe });
    } catch (err) {
      console.error(`Command "${rawCmd}" failed:`, err);
    }
  }
}

// ---- Handlers (stubs for now) ----
async function handleMode({ args, sock, jid, state, fromMe }) {
  if (!fromMe) return;
  const next = args[0]?.toLowerCase();
  if (!['private', 'public'].includes(next)) {
    return sock.sendMessage(jid, { text: 'Usage: !mode private|public' });
  }
  state.mode = next;
  await sock.sendMessage(jid, { text: `Mode set to *${next}*` });
}

async function handlePing({ sock, jid, state }) {
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  await sock.sendMessage(jid, { text: `🏓 Pong\nUptime: ${uptime}s` });
}

async function handleHelp({ sock, jid }) {
  await sock.sendMessage(jid, {
    text: [
      '*Available Commands*',
      '!mode private|public',
      '!ping',
      '!v (reply to view-once)',
      '!antidelete on|off',
      '!welcome on|off',
      '!menu',
    ].join('\n'),
  });
}

async function handleViewOnce() { /* TODO */ }
async function handleAntiDelete() { /* TODO */ }
async function handleAntiEdit() { /* TODO */ }
async function handleWelcome() { /* TODO */ }
async function handleKick() { /* TODO */ }
async function handleTagAll() { /* TODO */ }
async function handleSetBanner() { /* TODO */ }
async function handleMenu() { /* TODO */ }
async function handleStatus({ sock, jid, state }) {
  await sock.sendMessage(jid, {
    text: `Status: ${state.connected ? 'connected' : 'disconnected'}\nMode: ${state.mode}`,
  });
}

export function setPrefix(p) { PREFIX = p; }
export function getPrefix() { return PREFIX; }