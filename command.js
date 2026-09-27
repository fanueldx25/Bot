import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';
import pino from 'pino';
import { persistConfig, messageStore } from './bot.js';

const logger = pino({ level: 'silent' });

// ---- Command registry ----
const commands = {
  // Access
  mode: cmdMode, ping: cmdPing, help: cmdHelp, menu: cmdMenu, owner: cmdOwner,
  // Media / view-once
  v: cmdViewOnce, vv: cmdViewOnce, save: cmdSaveMedia,
  // Anti-delete / anti-edit
  antidelete: cmdAntiDelete, antiedit: cmdAntiEdit,
  history: cmdHistory, lastdeleted: cmdLastDeleted,
  // Group
  welcome: cmdWelcome, setwelcome: cmdSetWelcome,
  goodbye: cmdGoodbye, setgoodbye: cmdSetGoodbye,
  kick: cmdKick, add: cmdAdd, promote: cmdPromote, demote: cmdDemote,
  mute: cmdMute, unmute: cmdUnmute, tagall: cmdTagAll, groupinfo: cmdGroupInfo, link: cmdLink,
  // Customization
  setbanner: cmdSetBanner, setprefix: cmdSetPrefix, setname: cmdSetName,
  // System
  status: cmdStatus, restart: cmdRestart, logout: cmdLogout,
};

export async function handleMessage(payload, sock, state) {
  const { messages, type } = payload;
  if (type !== 'notify') return;

  for (const msg of messages) {
    if (!msg.message) continue;
    const jid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    const sender = fromMe ? state.ownerJid : (msg.key.participant || jid);
    const isGroup = jid.endsWith('@g.us');

    if (state.mode === 'private' && !fromMe && sender !== state.ownerJid) continue;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption || '';

    if (!text.startsWith(state.prefix)) continue;
    const [rawCmd, ...args] = text.slice(state.prefix.length).trim().split(/\s+/);
    const handler = commands[rawCmd.toLowerCase()];
    if (!handler) continue;

    try {
      await handler({ args, msg, sock, state, jid, sender, fromMe, isGroup });
    } catch (err) {
      console.error(`Command "${rawCmd}" failed:`, err.message);
      await sock.sendMessage(jid, { text: `❌ Error: ${err.message}` });
    }
  }
}

// ---- Reaction handler (🐼) ----
export async function handleReaction(reactions, sock, state) {
  for (const { key, reaction } of reactions) {
    if (reaction.text !== '🐼' || !state.ownerJid) continue;
    const original = messageStore.get(`${key.remoteJid}:${key.id}`);
    if (!original) continue;

    const content = original.message?.viewOnceMessageV2?.message || original.message?.viewOnceMessage?.message;
    if (!content) continue;

    try {
      const buffer = await downloadMediaMessage(
        { ...original, message: content },
        'buffer', {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );
      const type = getContentType(content);
      const sendOpts = type === 'videoMessage'
        ? { video: buffer, caption: '📥 *View-once downloaded*' }
        : { image: buffer, caption: '📥 *View-once downloaded*' };
      await sock.sendMessage(state.ownerJid, sendOpts);
    } catch (e) { console.error('view-once download failed:', e.message); }
  }
}

// ---- Group participants handler ----
export async function handleGroupParticipants(update, sock, state) {
  const { id, participants, action } = update;
  if (!state.connected) return;

  let metadata;
  try { metadata = await sock.groupMetadata(id); } catch { metadata = { subject: 'the group' }; }
  const groupName = metadata.subject || 'the group';

  for (const p of participants) {
    const userJid = p.id || p;
    const userTag = userJid.split('@')[0];

    if (action === 'add' && state.welcome) {
      const txt = state.welcomeText.replace('{group}', groupName).replace('{user}', userTag);
      await sock.sendMessage(id, { text: txt, mentions: [userJid] });
    }
    if (action === 'remove' && state.goodbye) {
      const txt = state.goodbyeText.replace('{group}', groupName).replace('{user}', userTag);
      await sock.sendMessage(id, { text: txt, mentions: [userJid] });
    }
    if (action === 'promote') {
      await sock.sendMessage(id, { text: `🛡️ @${userTag} promoted to admin.`, mentions: [userJid] });
    }
    if (action === 'demote') {
      await sock.sendMessage(id, { text: `📉 @${userTag} demoted.`, mentions: [userJid] });
    }
  }
}

// ============ HANDLERS ============

async function cmdMode({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const next = args[0]?.toLowerCase();
  if (!['private', 'public'].includes(next)) return sock.sendMessage(jid, { text: 'Usage: !mode private|public' });
  state.mode = next; persistConfig();
  await sock.sendMessage(jid, { text: `✅ Mode set to *${next}*` });
}

async function cmdPing({ sock, jid, state }) {
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  await sock.sendMessage(jid, { text: `🏓 Pong\nUptime: ${uptime}s\nMode: ${state.mode}` });
}

async function cmdOwner({ sock, jid, state }) {
  await sock.sendMessage(jid, { text: `👑 Owner: ${state.ownerJid || 'not set'}` });
}

async function cmdHelp({ sock, jid, state }) {
  const p = state.prefix;
  const text = `*📋 Commands*\n\n*Access*\n${p}mode private|public\n${p}ping\n${p}help\n${p}menu\n${p}owner\n\n*Media*\n${p}v (reply view-once)\n${p}vv\n${p}save\n\n*Anti*\n${p}antidelete on|off\n${p}antiedit on|off\n${p}history [n]\n${p}lastdeleted\n\n*Group*\n${p}welcome on|off\n${p}setwelcome <text>\n${p}goodbye on|off\n${p}setgoodbye <text>\n${p}kick\n${p}add <num>\n${p}promote\n${p}demote\n${p}mute / ${p}unmute\n${p}tagall\n${p}groupinfo\n${p}link\n\n*Custom*\n${p}setbanner (reply image)\n${p}setprefix <char>\n${p}setname <name>\n\n*System*\n${p}status\n${p}restart\n${p}logout\n\n🐼 React to view-once to download`;
  if (state.bannerUrl) {
    await sock.sendMessage(jid, { image: { url: state.bannerUrl }, caption: text });
  } else {
    await sock.sendMessage(jid, { text });
  }
}

async function cmdMenu({ sock, jid, state }) {
  return cmdHelp({ sock, jid, state });
}

async function cmdViewOnce({ args, msg, sock, jid, fromMe, state }) {
  if (!fromMe || !state.ownerJid) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted) return sock.sendMessage(jid, { text: '↩️ Reply to a view-once message with !v' });

  const content = quoted.viewOnceMessageV2?.message || quoted.viewOnceMessage?.message || quoted;
  try {
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: content },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const type = getContentType(content);
    const opts = type === 'videoMessage'
      ? { video: buffer, caption: '📥 Downloaded from view-once' }
      : { image: buffer, caption: '📥 Downloaded from view-once' };
    await sock.sendMessage(state.ownerJid, opts);
    await sock.sendMessage(jid, { text: '✅ Sent to your DM' });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ Failed: ${e.message}` });
  }
}

async function cmdSaveMedia({ args, msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted) return sock.sendMessage(jid, { text: '↩️ Reply to media with !save' });
  try {
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: quoted },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const type = getContentType(quoted);
    const opts = type === 'videoMessage' ? { video: buffer } : { image: buffer };
    await sock.sendMessage(state.ownerJid, opts);
    await sock.sendMessage(jid, { text: '✅ Saved to your DM' });
  } catch (e) {
    await sock.sendMessage(jid, { text: `❌ ${e.message}` });
  }
}

async function cmdAntiDelete({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) return sock.sendMessage(jid, { text: `Usage: ${state.prefix}antidelete on|off` });
  state.antidelete = val === 'on'; persistConfig();
  await sock.sendMessage(jid, { text: `Anti-delete: *${val.toUpperCase()}*` });
}

async function cmdAntiEdit({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) return sock.sendMessage(jid, { text: `Usage: ${state.prefix}antiedit on|off` });
  state.antiedit = val === 'on'; persistConfig();
  await sock.sendMessage(jid, { text: `Anti-edit: *${val.toUpperCase()}*` });
}

async function cmdHistory({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const n = Math.min(parseInt(args[0]) || 10, 50);
  const items = [...messageStore.values()].slice(-n);
  if (!items.length) return sock.sendMessage(jid, { text: 'No cached messages' });
  const lines = items.map((m, i) => {
    const t = m.message?.conversation || m.message?.extendedTextMessage?.text || '[media]';
    return `${i + 1}. ${t.slice(0, 60)}`;
  });
  await sock.sendMessage(jid, { text: `*Last ${items.length} messages:*\n${lines.join('\n')}` });
}

async function cmdLastDeleted({ sock, jid, fromMe, state }) {
  if (!fromMe) return;
  await sock.sendMessage(jid, { text: 'Use !history to view cached messages' });
}

async function cmdWelcome({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) return sock.sendMessage(jid, { text: `Usage: ${state.prefix}welcome on|off` });
  state.welcome = val === 'on'; persistConfig();
  await sock.sendMessage(jid, { text: `Welcome messages: *${val.toUpperCase()}*` });
}

async function cmdSetWelcome({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const txt = args.join(' ');
  if (!txt) return sock.sendMessage(jid, { text: 'Usage: !setwelcome <text>\nPlaceholders: {user} {group}' });
  state.welcomeText = txt; persistConfig();
  await sock.sendMessage(jid, { text: '✅ Welcome text updated' });
}

async function cmdGoodbye({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const val = args[0]?.toLowerCase();
  if (!['on', 'off'].includes(val)) return sock.sendMessage(jid, { text: `Usage: ${state.prefix}goodbye on|off` });
  state.goodbye = val === 'on'; persistConfig();
  await sock.sendMessage(jid, { text: `Goodbye messages: *${val.toUpperCase()}*` });
}

async function cmdSetGoodbye({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const txt = args.join(' ');
  if (!txt) return sock.sendMessage(jid, { text: 'Usage: !setgoodbye <text>' });
  state.goodbyeText = txt; persistConfig();
  await sock.sendMessage(jid, { text: '✅ Goodbye text updated' });
}

async function cmdKick({ msg, sock, jid, fromMe, state }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const mentioned = ctxInfo?.mentionedJid || [];
  const quoted = ctxInfo?.participant;
  const targets = mentioned.length ? mentioned : (quoted ? [quoted] : []);
  if (!targets.length) return sock.sendMessage(jid, { text: 'Mention or reply to a user' });
  await sock.groupParticipantsUpdate(jid, targets, 'remove');
  await sock.sendMessage(jid, { text: '✅ Removed' });
}

async function cmdAdd({ args, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const num = args[0]?.replace(/\D/g, '');
  if (!num) return sock.sendMessage(jid, { text: 'Usage: !add <number>' });
  await sock.groupParticipantsUpdate(jid, [`${num}@s.whatsapp.net`], 'add');
  await sock.sendMessage(jid, { text: '✅ Added' });
}

async function cmdPromote({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const targets = ctxInfo?.mentionedJid?.length ? ctxInfo.mentionedJid : (ctxInfo?.participant ? [ctxInfo.participant] : []);
  if (!targets.length) return sock.sendMessage(jid, { text: 'Mention a user' });
  await sock.groupParticipantsUpdate(jid, targets, 'promote');
  await sock.sendMessage(jid, { text: '✅ Promoted' });
}

async function cmdDemote({ msg, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const targets = ctxInfo?.mentionedJid?.length ? ctxInfo.mentionedJid : (ctxInfo?.participant ? [ctxInfo.participant] : []);
  if (!targets.length) return sock.sendMessage(jid, { text: 'Mention a user' });
  await sock.groupParticipantsUpdate(jid, targets, 'demote');
  await sock.sendMessage(jid, { text: '✅ Demoted' });
}

async function cmdMute({ sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  await sock.groupSettingUpdate(jid, 'announcement');
  await sock.sendMessage(jid, { text: '🔇 Group muted (admins only)' });
}

async function cmdUnmute({ sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  await sock.groupSettingUpdate(jid, 'not_announcement');
  await sock.sendMessage(jid, { text: '🔊 Group unmuted' });
}

async function cmdTagAll({ args, sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const metadata = await sock.groupMetadata(jid);
  const mentions = metadata.participants.map(p => p.id);
  const msg = args.join(' ') || 'Attention everyone!';
  await sock.sendMessage(jid, { text: `📢 ${msg}\n\n${mentions.map(m => `@${m.split('@')[0]}`).join(' ')}`, mentions });
}

async function cmdGroupInfo({ sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const m = await sock.groupMetadata(jid);
  const admins = m.participants.filter(p => p.admin).length;
  await sock.sendMessage(jid, {
    text: `*📊 Group Info*\nName: ${m.subject}\nMembers: ${m.participants.length}\nAdmins: ${admins}\nCreated: ${new Date(m.creation * 1000).toLocaleDateString()}\nID: ${jid}`
  });
}

async function cmdLink({ sock, jid, fromMe }) {
  if (!fromMe || !jid.endsWith('@g.us')) return;
  const code = await sock.groupInviteCode(jid);
  await sock.sendMessage(jid, { text: `🔗 https://chat.whatsapp.com/${code}` });
}

async function cmdSetBanner({ msg, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted?.imageMessage) return sock.sendMessage(jid, { text: '↩️ Reply to an image with !setbanner' });
  try {
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: quoted },
      'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const b64 = buffer.toString('base64');
    state.bannerUrl = `data:image/jpeg;base64,${b64}`;
    persistConfig();
    await sock.sendMessage(jid, { text: '✅ Banner set' });
  } catch (e) { await sock.sendMessage(jid, { text: `❌ ${e.message}` }); }
}

async function cmdSetPrefix({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const p = args[0];
  if (!p || p.length > 2) return sock.sendMessage(jid, { text: 'Usage: !setprefix <char>' });
  state.prefix = p; persistConfig();
  await sock.sendMessage(jid, { text: `✅ Prefix set to "${p}"` });
}

async function cmdSetName({ args, sock, jid, fromMe, state }) {
  if (!fromMe) return;
  const name = args.join(' ');
  if (!name) return sock.sendMessage(jid, { text: 'Usage: !setname <name>' });
  state.botName = name; persistConfig();
  await sock.sendMessage(jid, { text: `✅ Bot name: ${name}` });
}

async function cmdStatus({ sock, jid, state }) {
  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  await sock.sendMessage(jid, {
    text: `*📊 Status*\nConnected: ${state.connected}\nMode: ${state.mode}\nUptime: ${uptime}s\nAnti-delete: ${state.antidelete}\nAnti-edit: ${state.antiedit}\nWelcome: ${state.welcome}\nCache: ${messageStore.size} msgs`
  });
}

async function cmdRestart({ sock, jid, fromMe }) {
  if (!fromMe) return;
  await sock.sendMessage(jid, { text: '🔄 Restarting...' });
  process.exit(0);
}

async function cmdLogout({ sock, jid, fromMe }) {
  if (!fromMe) return;
  await sock.sendMessage(jid, { text: '🚪 Logging out...' });
  await sock.logout();
  process.exit(0);
}