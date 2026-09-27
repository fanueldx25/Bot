import { commands } from './commands.js';
import { config, runtime } from './config.js';

const lookup = new Map();
for (const c of commands) {
  lookup.set(c.name.toLowerCase(), c);
  for (const a of c.aliases || []) lookup.set(a.toLowerCase(), c);
}

const isAdminNumber = (sender) => runtime.admins.has(sender.split('@')[0]);
const isOwner = (sender) => sender.split('@')[0] === config.ownerNumber;

function parsePrefix(text) {
  for (const p of config.prefixes) {
    if (text.startsWith(p)) return { prefix: p, body: text.slice(p.length) };
  }
  return null;
}

export const commandCount = commands.length;

export async function handleMessage(sock, msg) {
  const from = msg.key.remoteJid;
  if (!from || from === 'status@broadcast') return;

  const isGroup = from.endsWith('@g.us');
  const sender = isGroup ? msg.key.participant : from;
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';
  if (!text) return;

  // ---- Auto-correct (before command parsing) ----
  if (runtime.autoCorrect.get(from)) {
    const dict = (await import('./lib/database.js')).db.get('dict') || {};
    let newText = text;
    let changed = false;
    for (const [wrong, right] of Object.entries(dict)) {
      const re = new RegExp(`\\b${wrong}\\b`, 'gi');
      if (re.test(newText)) { newText = newText.replace(re, right); changed = true; }
    }
    if (changed) await sock.sendMessage(from, { text: `🤖 _Did you mean:_ ${newText}` });
  }

  // ---- Antilink ----
  if (isGroup && runtime.antilink.has(from) && /chat\.whatsapp\.com|https?:\/\//i.test(text)) {
    const mode = runtime.antilink.get(from);
    const senderIsAdmin = isOwner(sender) || isAdminNumber(sender);
    if (!senderIsAdmin) {
      try { await sock.sendMessage(from, { delete: msg.key }); } catch {}
      if (mode === 'kick') {
        await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
      } else if (mode === 'warn') {
        await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} no links!`, mentions: [sender] });
      }
    }
    return;
  }

  // ---- Antimention ----
  if (isGroup && runtime.antimention.has(from)) {
    const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentions.length >= 5) {
      try { await sock.sendMessage(from, { delete: msg.key }); } catch {}
      return;
    }
  }

  // ---- Pause ----
  if (runtime.paused || runtime.pausedChats.has(from)) {
    if (!text.startsWith('.') && !text.startsWith('!')) return;
  }

  const parsed = parsePrefix(text);
  if (!parsed) return;

  const [rawCmd, ...args] = parsed.body.trim().split(/\s+/);
  const cmd = lookup.get(rawCmd.toLowerCase());
  if (!cmd) return;

  // ---- Admin gate ----
  if (cmd.adminOnly && !isOwner(sender) && !isAdminNumber(sender)) {
    return sock.sendMessage(from, { text: '❌ Admin only.' }, { quoted: msg });
  }

  const ctx = {
    sock, msg, from, sender, isGroup, args,
    text: args.join(' '),
    prefix: parsed.prefix,
    command: rawCmd.toLowerCase(),
    config,
    reply: (t, opts = {}) => sock.sendMessage(from, { text: t, ...opts }, { quoted: msg }),
  };

  // ---- Auto reactions ----
  if (runtime.reactions.has(from)) react(ctx, '👀').catch(() => {});

  try {
    await cmd.run(ctx);
  } catch (err) {
    console.error(`❌ ${cmd.name}:`, err);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
}

async function react(ctx, emoji) {
  try {
    await ctx.sock.sendMessage(ctx.from, { react: { text: emoji, key: ctx.msg.key } });
  } catch {}
}