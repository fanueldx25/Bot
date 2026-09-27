// ============================================================================
// handlers.js — Feature handlers + command router (full working version)
// ============================================================================

const {
  sock,
  botJid,
  currentNumber,
  ADMIN_NUMBER,
  BANNER_BUFFER,
  UI,
  isAdmin,
  withTyping,
  withRecording,
  sendWithBanner,
  pausedChats,
  welcomeEnabled,
  goodbyeEnabled,
  customWelcome,
  viewOnceEnabled,
  autoDownload,
  saveState
} = require('./state');

const {
  downloadMediaMessage,
  getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// JID HELPERS
// ============================================================================

/**
 * Resolve the real sender JID (handles @lid linked-device JIDs).
 * Returns "23xxxxxxxx@s.whatsapp.net" whenever possible.
 */
function resolveSenderJid(msg, fallbackJid) {
  const pn =
    msg?.key?.senderPn ||
    msg?.key?.participantPn ||
    msg?.key?.participantAlt ||
    msg?.key?.remoteJidAlt;
  if (pn && typeof pn === 'string' && pn.includes('@')) {
    const num = pn.split('@')[0].split(':')[0];
    if (/^\d{7,15}$/.test(num)) return `${num}@s.whatsapp.net`;
  }
  const participant = msg?.key?.participant;
  if (participant && participant.endsWith('@s.whatsapp.net')) {
    const num = participant.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }
  if (fallbackJid && !fallbackJid.endsWith('@g.us')) {
    const num = fallbackJid.split('@')[0].split(':')[0];
    if (/^\d{7,15}$/.test(num)) return `${num}@s.whatsapp.net`;
  }
  return participant || fallbackJid || '';
}

/**
 * ✅ CRITICAL FIX: When sending a reply, always use a real JID.
 * If `from` is a @lid, resolve it via the mapping. If not mapped, fall back to `from`.
 * In groups (@g.us), `from` is always valid.
 */
function resolveReplyJid(from) {
  if (!from) return from;
  if (from.endsWith('@g.us')) return from;
  if (from.endsWith('@s.whatsapp.net')) return from;

  if (from.endsWith('@lid')) {
    const num = from.split('@')[0].split(':')[0];
    const st = require('./state');
    const mapped = st.lidToPn?.get(num);
    if (mapped) {
      console.log(`[Reply] resolved LID ${num} → ${mapped}`);
      return `${mapped}@s.whatsapp.net`;
    }
    console.log(`[Reply] LID ${num} has no mapping — sending to raw JID (may fail)`);
    return from; // WhatsApp sometimes still accepts this
  }

  return from;
}

/**
 * Resolve a mention JID to a real one. Falls back to a WhatsApp mention-friendly form.
 */
function resolveMentionJid(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@s.whatsapp.net')) return jid;
  if (jid.endsWith('@lid')) {
    const num = jid.split('@')[0].split(':')[0];
    const st = require('./state');
    const mapped = st.lidToPn?.get(num);
    if (mapped) return `${mapped}@s.whatsapp.net`;
  }
  return jid;
}

// ============================================================================
// FEATURE HANDLERS
// ============================================================================

async function tryCaptureViewOnce(msg, from) {
  try {
    const content = msg.message;
    const wrappers = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    let inner = null;
    for (const w of wrappers) {
      if (content?.[w]?.message) {
        inner = content[w].message;
        break;
      }
    }
    if (!inner) return false;

    const mediaType = inner.imageMessage
      ? 'imageMessage'
      : inner.videoMessage
      ? 'videoMessage'
      : inner.audioMessage
      ? 'audioMessage'
      : null;
    if (!mediaType) return false;

    const sockInstance = require('./state').sock;
    const fakeMsg = { key: msg.key, message: { [mediaType]: inner[mediaType] } };
    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sockInstance.updateMediaMessage
    });

    if (ADMIN_NUMBER) {
      const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;
      const senderJid = resolveSenderJid(msg, from);
      const senderNum = senderJid.split('@')[0];
      const caption = `📸 View-Once Captured\nFrom: +${senderNum}\nType: ${mediaType}`;
      if (mediaType === 'imageMessage') {
        await sockInstance.sendMessage(adminJid, { image: buffer, caption });
      } else if (mediaType === 'videoMessage') {
        await sockInstance.sendMessage(adminJid, { video: buffer, caption });
      } else {
        await sockInstance.sendMessage(adminJid, {
          audio: buffer,
          mimetype: 'audio/ogg',
          ptt: true
        });
      }
    }
    return true;
  } catch (e) {
    console.error('[VO] Error:', e.message);
    return false;
  }
}

async function postToStatus(quotedMsg) {
  try {
    const sockInstance = require('./state').sock;
    const statusJid = 'status@broadcast';
    const content = quotedMsg.message;
    const type = getContentType(content);

    let payload = {};
    if (type === 'conversation' || type === 'extendedTextMessage') {
      payload = {
        text: content.conversation || content.extendedTextMessage?.text || '',
        backgroundColor: '#1F2C33',
        font: 2
      };
    } else if (type === 'imageMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sockInstance.updateMediaMessage
      });
      payload = { image: buf, caption: content.imageMessage?.caption || '' };
    } else if (type === 'videoMessage') {
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sockInstance.updateMediaMessage
      });
      payload = { video: buf, caption: content.videoMessage?.caption || '' };
    } else {
      return false;
    }

    await sockInstance.sendMessage(statusJid, payload, {
      broadcast: true,
      statusJidList: []
    });
    return true;
  } catch (e) {
    console.error('[Status] Error:', e.message);
    return false;
  }
}

async function sendWelcome(groupJid, participants) {
  try {
    const sockInstance = require('./state').sock;
    const meta = await sockInstance.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    if (BANNER_BUFFER) {
      try {
        await sockInstance.sendMessage(groupJid, {
          image: BANNER_BUFFER,
          caption: `╭━━━━━━━━━━━━━━━━━━━━╮
┃   👋  *NEW MEMBER*   ┃
╰━━━━━━━━━━━━━━━━━━━━╯

_Welcome to the family!_`
        });
      } catch (e) {
        console.error('[Welcome] Banner failed:', e.message);
      }
    }

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const custom = customWelcome[groupJid];
      const text = custom
        ? custom.replace(/@user/g, `@${num}`).replace(/@group/g, groupName)
        : `╭────────────────────
│ 📌 *${groupName}*
╰────────────────────

Hello @${num}!
You've joined the group.

*Please:*
│ ✅ Read the rules
│ ✅ Be respectful
│ ✅ No spam or links

━━━━━━━━━━━━━━━━━━━━━━━
  _Type *.help* to see commands_`;

      await sockInstance.sendMessage(groupJid, { text, mentions: [jid] });
    }
  } catch (e) {
    console.error('[Welcome] Error:', e.message);
  }
}

async function sendGoodbye(groupJid, participants) {
  try {
    const sockInstance = require('./state').sock;
    const meta = await sockInstance.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    if (BANNER_BUFFER) {
      try {
        await sockInstance.sendMessage(groupJid, {
          image: BANNER_BUFFER,
          caption: `╭━━━━━━━━━━━━━━━━━━━━╮
┃   👋  *MEMBER LEFT*   ┃
╰━━━━━━━━━━━━━━━━━━━━╯

_We'll miss you._`
        });
      } catch (e) {}
    }

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const text = `╭────────────────────
│ 📌 *${groupName}*
╰────────────────────

@${num} has left the group.

━━━━━━━━━━━━━━━━━━━━━━━
  _Wishing you the best!_`;

      await sockInstance.sendMessage(groupJid, { text, mentions: [jid] });
    }
  } catch (e) {
    console.error('[Goodbye] Error:', e.message);
  }
}

// ============================================================================
// COMMAND HANDLER
// ============================================================================

async function handleCommand(msg, from, senderJid, rawText) {
  const sockInstance = require('./state').sock;
  const st = require('./state');
  const text = rawText.trim();
  const cmd = text.toLowerCase();
  const parts = cmd.split(' ');
  const base = parts[0];
  const args = parts.slice(1);
  const admin = isAdmin(senderJid);
  const isGroup = from.endsWith('@g.us');

  // ✅ Resolve the reply target once — this is what fixes "typing but nothing comes"
  const replyJid = resolveReplyJid(from);

  // Small helper: send to the correct JID
  const send = (payload, opts) =>
    opts ? sockInstance.sendMessage(replyJid, payload, opts) : sockInstance.sendMessage(replyJid, payload);

  const adminCmds = [
    '.status', '.backup', '.restore', '.logout', '.pause', '.resume', '.pausestatus',
    '.welcome', '.goodbye', '.setwelcome', '.tagall', '.hidetag', '.kick', '.promote', '.demote',
    '.mute', '.unmute', '.groupinfo', '.vo', '.admin', '.restart', '.poststatus', '.autodl',
    '.reactions', '.schedule', '.antilink', '.pair', '.addadmin', '.deladmin'
  ];

  if (adminCmds.includes(base) && !admin) {
    await withTyping(replyJid, () =>
      send({
        text: `${UI.box('ACCESS DENIED', '🔒')}\n\nSorry, this command is restricted to the admin.`
      })
    );
    return;
  }

  // ---------- MENU ----------
  if (base === '.help' || base === '.menu') {
    const help = `${UI.box('BOT MENU', '🤖')}

━━━━━━━━━━━━━━━━━━━━━━━
  📌  *GENERAL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .help      • show menu
│ .ping      • check alive
│ .id        • your JID
│ .myid      • your number
│ .whoami    • admin check
│ .time      • server time
│ .uptime    • bot uptime

━━━━━━━━━━━━━━━━━━━━━━━
  🎨  *MEDIA*
━━━━━━━━━━━━━━━━━━━━━━━
│ .sticker   • img → sticker
│ .toimg     • sticker → img
│ .tts       • text → voice
│ .voice     • reply → voice
│ .getpp     • profile pic

━━━━━━━━━━━━━━━━━━━━━━━
  🎲  *FUN*
━━━━━━━━━━━━━━━━━━━━━━━
│ .roll      • dice
│ .flip      • coin
│ .8ball     • ask
│ .joke      • random joke
│ .quote     • random quote

━━━━━━━━━━━━━━━━━━━━━━━
  🛠️  *TOOLS*
━━━━━━━━━━━━━━━━━━━━━━━
│ .echo      • repeat text
│ .calc      • calculator
│ .shorten   • short URL
│ .weather   • weather

━━━━━━━━━━━━━━━━━━━━━━━
  👮  *ADMIN ONLY*
━━━━━━━━━━━━━━━━━━━━━━━
│ .status    • bot status
│ .logout    • disconnect
│ .restart   • reboot bot
│ .pair      • re-pair

━━━━━━━━━━━━━━━━━━━━━━━
  ⏸️  *PAUSE*
━━━━━━━━━━━━━━━━━━━━━━━
│ .pause / .resume / .pausestatus

━━━━━━━━━━━━━━━━━━━━━━━
  👥  *GROUP CONTROL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .welcome on/off
│ .goodbye on/off
│ .setwelcome <text>
│ .tagall / .hidetag
│ .kick / .promote / .demote
│ .mute / .unmute
│ .groupinfo

━━━━━━━━━━━━━━━━━━━━━━━
  🛡️  *MODERATION*
━━━━━━━━━━━━━━━━━━━━━━━
│ .antilink on/off
│ .antilink action delete|warn|kick
│ .reactions on/off [global]
│ .schedule open|close HH:MM [daily]

━━━━━━━━━━━━━━━━━━━━━━━
  📸  *SPECIAL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .vo on/off       • view-once
│ .autodl on/off   • auto DL
│ .poststatus      • → my status

━━━━━━━━━━━━━━━━━━━━━━━
  ⚙️  *INFO*
━━━━━━━━━━━━━━━━━━━━━━━
│ Admin  : ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set'}
│ Uptime : ${Math.floor(process.uptime() / 60)} min
│ Prefix : .

╰━━━━━━━━━━━━━━━━━━━━╯
   _Powered by Baileys_`;

    await withTyping(replyJid, () => sendWithBanner(replyJid, help));
    return;
  }

  // ---------- BASIC ----------
  if (base === '.ping') {
    const start = Date.now();
    const txt = `${UI.box('PONG', '🏓')}

│ Status  : ✅ online
│ Latency : ${Date.now() - start} ms
│ Uptime  : ${Math.floor(process.uptime())} s`;
    await withTyping(replyJid, () => send({ text: txt }));
    return;
  }

  if (base === '.id' || base === '.myid') {
    const num = senderJid.split('@')[0].split(':')[0];
    await withTyping(replyJid, () =>
      send({
        text: `${UI.box('YOUR INFO', '🆔')}

│ Number   : +${num}
│ User JID : ${senderJid}
│ Chat JID : ${from}
│ Reply JID: ${replyJid}`
      })
    );
    return;
  }

  // ---------- WHOAMI ----------
  if (base === '.whoami') {
    const num = senderJid.split('@')[0].split(':')[0];
    const raw = msg.key.participant || msg.key.remoteJid || '';
    const pn = msg.key.senderPn || 'none';
    const ppn = msg.key.participantPn || 'none';
    const lidNum = raw.includes('@lid') ? raw.split('@')[0].split(':')[0] : null;
    const mapped = lidNum ? st.lidToPn?.get(lidNum) : null;

    await send({
      text: `${UI.box('WHO AM I', '👤')}

│ Your number   : +${num}
│ Resolved JID  : ${senderJid}
│ Reply JID     : ${replyJid}
│ Raw participant: ${raw}
│ senderPn      : ${pn}
│ participantPn : ${ppn}
│ LID mapping   : ${mapped ? lidNum + ' → ' + mapped : 'none'}
│ Admin number  : ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'NOT SET'}
│ You are admin : ${isAdmin(senderJid) ? '✅ YES' : '❌ NO'}`
    });
    return;
  }

  if (base === '.time') {
    await withTyping(replyJid, () =>
      send({
        text: `${UI.box('SERVER TIME', '🕐')}

│ ${new Date().toUTCString()}`
      })
    );
    return;
  }

  if (base === '.uptime') {
    const s = process.uptime();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    await withTyping(replyJid, () =>
      send({
        text: `${UI.box('UPTIME', '⏱️')}

│ Running : ${h}h ${m}m
│ Status  : ${require('./state').botJid ? '✅ connected' : '❌ offline'}`
      })
    );
    return;
  }

  if (base === '.status') {
    const s = process.uptime();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const txt = `${UI.box('BOT STATUS', '📊')}

━━━━━━━━━━━━━━━━━━━━━━━
  🔌  *CONNECTION*
━━━━━━━━━━━━━━━━━━━━━━━
│ Status   : ${require('./state').botJid ? '✅ online' : '❌ offline'}
│ Number   : +${currentNumber || 'N/A'}
│ Uptime   : ${h}h ${m}m

━━━━━━━━━━━━━━━━━━━━━━━
  ⚙️  *FEATURES*
━━━━━━━━━━━━━━━━━━━━━━━
│ Paused     : ${pausedChats.size} chat(s)
│ View-once  : ${require('./state').viewOnceEnabled ? '✅ ON' : '❌ OFF'}
│ Auto-DL    : ${require('./state').autoDownload ? '✅ ON' : '❌ OFF'}
│ Welcome    : ${welcomeEnabled.size} group(s)
│ Anti-link  : ${st.antilinkGroups.size} group(s)
│ Reactions  : ${st.reactionsGlobal ? '✅ global' : st.reactionsEnabled.size + ' chat(s)'}
│ Schedules  : ${st.schedules.size}

━━━━━━━━━━━━━━━━━━━━━━━
  🕐  _Reported at_
  ${new Date().toUTCString()}`;

    await withTyping(replyJid, () => sendWithBanner(replyJid, txt));
    return;
  }

  // ---------- ECHO ----------
  if (base === '.echo') {
    const t = args.join(' ');
    if (!t) { await send({ text: '❌ Usage: .echo <text>' }); return; }
    await send({ text: t });
    return;
  }

  // ---------- FUN ----------
  if (base === '.roll') {
    const spec = args[0] || '1d6';
    const m = spec.match(/^(\d+)d(\d+)$/i);
    if (!m) { await send({ text: '❌ Usage: .roll 1d6' }); return; }
    const [, n, faces] = m;
    const rolls = Array.from({ length: Math.min(+n, 20) }, () =>
      1 + Math.floor(Math.random() * +faces)
    );
    await send({
      text: `🎲 *${spec}* → ${rolls.join(' + ')} = *${rolls.reduce((a, b) => a + b, 0)}*`
    });
    return;
  }

  if (base === '.flip') {
    const r = Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
    await send({ text: r });
    return;
  }

  if (base === '.8ball') {
    const answers = [
      'Yes.', 'No.', 'Maybe.', 'Ask again later.', 'Definitely.',
      'Absolutely not.', 'I wouldn\'t bet on it.', 'Signs point to yes.'
    ];
    const a = answers[Math.floor(Math.random() * answers.length)];
    await send({ text: `🎱 ${a}` });
    return;
  }

  if (base === '.joke') {
    const jokes = [
      'Why don\'t scientists trust atoms? They make up everything.',
      'I told my Wi-Fi we needed space. Now it won\'t connect.',
      'Why did the developer go broke? He used up all his cache.'
    ];
    await send({
      text: '😂 ' + jokes[Math.floor(Math.random() * jokes.length)]
    });
    return;
  }

  if (base === '.quote') {
    try {
      const r = await fetch('https://api.quotable.io/random');
      const d = await r.json();
      await send({
        text: `💬 _"${d.content}"_\n— ${d.author}`
      });
    } catch {
      await send({ text: '❌ Quote fetch failed.' });
    }
    return;
  }

  // ---------- TOOLS ----------
  if (base === '.calc') {
    const expr = text.replace(/^\.calc\s+/i, '').replace(/[^0-9+\-*/(). ]/g, '');
    try {
      const result = Function(`"use strict"; return (${expr})`)();
      await send({ text: `🧮 ${expr} = *${result}*` });
    } catch {
      await send({ text: '❌ Invalid expression.' });
    }
    return;
  }

  if (base === '.shorten') {
    const url = args[0];
    if (!url || !/^https?:\/\//.test(url)) {
      await send({ text: '❌ Usage: .shorten https://...' });
      return;
    }
    try {
      const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
      const short = await r.text();
      await send({ text: `🔗 ${short}` });
    } catch {
      await send({ text: '❌ Shorten failed.' });
    }
    return;
  }

  if (base === '.weather') {
    const city = args.join(' ');
    if (!city) { await send({ text: '❌ Usage: .weather <city>' }); return; }
    try {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
      const txt = await r.text();
      await send({ text: `🌤️ ${txt}` });
    } catch {
      await send({ text: '❌ Weather lookup failed.' });
    }
    return;
  }

  // ---------- STICKER ----------
  if (base === '.sticker' || base === '.s') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) {
      await withTyping(replyJid, () => send({ text: '❌ Reply to an image or video.' }));
      return;
    }
    const img = quoted.imageMessage;
    const vid = quoted.videoMessage;
    if (!img && !vid) {
      await withTyping(replyJid, () => send({ text: '❌ Must be image or video.' }));
      return;
    }
    try {
      await withTyping(replyJid, async () => {
        const mType = img ? 'imageMessage' : 'videoMessage';
        const mContent = img || vid;
        const fakeMsg = {
          key: {
            remoteJid: from,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            fromMe: false
          },
          message: { [mType]: mContent }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sockInstance.updateMediaMessage
        });
        await send({ sticker: buf });
      });
    } catch (e) {
      await send({ text: '❌ Failed. Try a smaller file.' });
    }
    return;
  }

  if (base === '.toimg') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const stickerMsg = quoted?.stickerMessage;
    if (!stickerMsg) {
      await withTyping(replyJid, () => send({ text: '❌ Reply to a sticker.' }));
      return;
    }
    try {
      await withTyping(replyJid, async () => {
        const fakeMsg = {
          key: {
            remoteJid: from,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            fromMe: false
          },
          message: { stickerMessage: stickerMsg }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sockInstance.updateMediaMessage
        });
        await send({ image: buf, caption: '🎨 *Converted to image*' });
      });
    } catch (e) {
      await send({ text: '❌ Failed.' });
    }
    return;
  }

  // ==========================================================================
  // TTS — uses StreamElements (works from Render/Replit/cloud IPs)
  // ==========================================================================
  if (base === '.tts' || base === '.voice') {
    let targetText = args.join(' ');
    let voice = 'Brian'; // default male voice

    // Allow: .tts Amy hello world  → voice = Amy
    const VOICES = ['Brian', 'Amy', 'Emma', 'Joanna', 'Matthew', 'Salli', 'Kimberly', 'Russell', 'Nicole', 'Ivy'];
    if (targetText && VOICES.includes(args[0])) {
      voice = args[0];
      targetText = args.slice(1).join(' ');
    }

    if (!targetText) {
      const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      targetText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    }
    if (!targetText) {
      await withTyping(replyJid, () =>
        send({ text: '❌ Usage: .tts [voice] <text>  or reply to a message.\nVoices: Brian, Amy, Emma, Joanna, Matthew, Salli, Kimberly, Russell, Nicole, Ivy' })
      );
      return;
    }

    // Cap length (free endpoint)
    if (targetText.length > 500) targetText = targetText.slice(0, 500);

    try {
      const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(targetText)}`;

      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
          'Referer': 'https://streamelements.com/'
        }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf || buf.length < 200) throw new Error('Empty audio response');

      await withRecording(replyJid, () =>
        send({
          audio: buf,
          mimetype: 'audio/mpeg',
          ptt: true
        })
      );
    } catch (e) {
      console.error('[TTS]', e.message);
      await send({ text: '❌ TTS failed: ' + e.message });
    }
    return;
  }

  // ---------- GETPP ----------
  if (base === '.getpp') {
    let target = replyJid;
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (mentioned?.length) target = resolveMentionJid(mentioned[0]);
    try {
      const url = await sockInstance.profilePictureUrl(target, 'image');
      await send({ image: { url }, caption: '📷 *Profile picture*' });
    } catch (e) {
      await send({ text: '❌ No profile picture available.' });
    }
    return;
  }

  // ---------- PAUSE / RESUME ----------
  if (base === '.pause') {
    if (args[0] === 'all') {
      pausedChats.add('ALL');
      saveState();
      await send({
        text: `${UI.box('GLOBAL PAUSE', '⏸️')}\n\nBot is now silent everywhere.`
      });
      return;
    }
    pausedChats.add(from);
    saveState();
    await send({
      text: `${UI.box('PAUSED', '⏸️')}\n\nBot is silent in this chat.`
    });
    return;
  }
  if (base === '.resume') {
    if (args[0] === 'all') {
      pausedChats.delete('ALL');
      saveState();
      await send({
        text: `${UI.box('RESUMED', '▶️')}\n\nBot is active everywhere.`
      });
      return;
    }
    pausedChats.delete(from);
    saveState();
    await send({
      text: `${UI.box('RESUMED', '▶️')}\n\nBot is active in this chat.`
    });
    return;
  }
  if (base === '.pausestatus') {
    const g = pausedChats.has('ALL');
    const l = pausedChats.has(from);
    const state = g ? '🌍 Global pause ON' : l ? '⏸️ This chat paused' : '▶️ Active';
    await send({
      text: `${UI.box('PAUSE STATUS', '📋')}\n\n│ ${state}`
    });
    return;
  }

  // ---------- WELCOME / GOODBYE ----------
  if (base === '.welcome') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') {
      welcomeEnabled.add(from);
      saveState();
      await send({ text: `${UI.box('WELCOME ON', '✅')}` });
    } else if (args[0] === 'off') {
      welcomeEnabled.delete(from);
      saveState();
      await send({ text: `${UI.box('WELCOME OFF', '❌')}` });
    } else {
      await send({ text: 'Usage: .welcome on/off' });
    }
    return;
  }
  if (base === '.goodbye') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') {
      goodbyeEnabled.add(from);
      saveState();
      await send({ text: `${UI.box('GOODBYE ON', '✅')}` });
    } else if (args[0] === 'off') {
      goodbyeEnabled.delete(from);
      saveState();
      await send({ text: `${UI.box('GOODBYE OFF', '❌')}` });
    } else {
      await send({ text: 'Usage: .goodbye on/off' });
    }
    return;
  }
  if (base === '.setwelcome') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    const custom = text.replace(/^\.setwelcome\s+/i, '');
    if (!custom) {
      await send({ text: 'Usage: .setwelcome <text>  (@user, @group)' });
      return;
    }
    customWelcome[from] = custom;
    saveState();
    await send({
      text: `${UI.box('SAVED', '✅')}\n\nCustom welcome message set.`
    });
    return;
  }

  // ---------- TAG / KICK ----------
  if (base === '.tagall' || base === '.hidetag') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    try {
      const meta = await sockInstance.groupMetadata(from);
      const mentions = meta.participants.map((p) => p.id);
      const msgText = args.join(' ') || '📢 Attention everyone!';
      if (base === '.hidetag') {
        await send({ text: msgText, mentions });
      } else {
        const list = mentions.map((j) => `│ @${j.split('@')[0]}`).join('\n');
        const txt = `${UI.box('ANNOUNCEMENT', '📢')}

${msgText}

━━━━━━━━━━━━━━━━━━━━━━━
${list}
╰━━━━━━━━━━━━━━━━━━━━╯`;
        await send({ text: txt, mentions });
      }
    } catch (e) {
      await send({ text: '❌ Failed.' });
    }
    return;
  }
  if (base === '.kick' || base === '.promote' || base === '.demote') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned?.length) {
      await send({ text: `❌ Mention someone to ${base.slice(1)}.` });
      return;
    }
    try {
      const action = base === '.kick' ? 'remove' : base === '.promote' ? 'promote' : 'demote';
      const targets = mentioned.map((j) => resolveMentionJid(j));
      await sockInstance.groupParticipantsUpdate(from, targets, action);
      await send({
        text: `${UI.box(action.toUpperCase(), '✅')}`
      });
    } catch (e) {
      await send({ text: '❌ Failed. Bot must be admin.' });
    }
    return;
  }
  if (base === '.mute' || base === '.unmute') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    try {
      await sockInstance.groupSettingUpdate(from, base === '.mute' ? 'announcement' : 'not_announcement');
      await send({
        text: base === '.mute' ? '🔇 *Group muted*' : '🔊 *Group unmuted*'
      });
    } catch (e) {
      await send({ text: '❌ Failed.' });
    }
    return;
  }
  if (base === '.groupinfo') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    try {
      const meta = await sockInstance.groupMetadata(from);
      const admins = meta.participants
        .filter((p) => p.admin)
        .map((p) => `│ +${p.id.split('@')[0]}`)
        .join('\n');
      const txt = `${UI.box('GROUP INFO', '📋')}

│ Name    : ${meta.subject}
│ ID      : ${meta.id}
│ Members : ${meta.participants.length}
│ Admins  : ${meta.participants.filter((p) => p.admin).length}
│ Created : ${new Date(meta.creation * 1000).toUTCString().split(',')[0]}

━━━━━━━━━━━━━━━━━━━━━━━
  👑  *ADMINS*
━━━━━━━━━━━━━━━━━━━━━━━
${admins}`;
      await send({ text: txt });
    } catch (e) {
      await send({ text: '❌ Failed.' });
    }
    return;
  }

  // ---------- ANTI-LINK ----------
  if (base === '.antilink') {
    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }
    const sub = args[0];

    if (sub === 'on') {
      st.antilinkGroups.add(from);
      st.saveState();
      await send({
        text: `${UI.box('ANTILINK ON', '🛡️')}\n\n│ Action : ${st.antilinkAction.get(from) || 'delete'}`
      });
    } else if (sub === 'off') {
      st.antilinkGroups.delete(from);
      st.saveState();
      await send({ text: `${UI.box('ANTILINK OFF', '🚫')}` });
    } else if (sub === 'action') {
      const a = args[1];
      if (!['delete', 'warn', 'kick'].includes(a)) {
        await send({ text: '❌ Usage: .antilink action delete|warn|kick' });
        return;
      }
      st.antilinkAction.set(from, a);
      st.saveState();
      await send({
        text: `${UI.box('ANTILINK ACTION', '⚙️')}\n\n│ ${a}`
      });
    } else {
      const enabled = st.antilinkGroups.has(from);
      await send({
        text: `${UI.box('ANTILINK', '🛡️')}

│ Status : ${enabled ? '✅ ON' : '❌ OFF'}
│ Action : ${st.antilinkAction.get(from) || 'delete'}

Usage:
│ .antilink on|off
│ .antilink action delete|warn|kick`
      });
    }
    return;
  }

  // ---------- REACTIONS ----------
  if (base === '.reactions') {
    const scope = args[0];
    const mode = args[1];

    if (scope === 'on') {
      if (mode === 'global') {
        st.reactionsGlobal = true;
        st.saveState();
        await send({ text: `${UI.box('REACTIONS GLOBAL ON', '😄')}` });
      } else {
        st.reactionsEnabled.add(from);
        st.reactionsDisabled.delete(from);
        st.saveState();
        await send({ text: `${UI.box('REACTIONS ON HERE', '😄')}` });
      }
    } else if (scope === 'off') {
      if (mode === 'global') {
        st.reactionsGlobal = false;
        st.saveState();
        await send({ text: `${UI.box('REACTIONS GLOBAL OFF', '🚫')}` });
      } else {
        st.reactionsDisabled.add(from);
        st.reactionsEnabled.delete(from);
        st.saveState();
        await send({ text: `${UI.box('REACTIONS OFF HERE', '🚫')}` });
      }
    } else {
      const local = st.reactionsEnabled.has(from)
        ? 'ON'
        : st.reactionsDisabled.has(from)
        ? 'OFF'
        : 'inherit';
      await send({
        text: `${UI.box('REACTIONS STATUS', '📋')}

│ This chat : ${local}
│ Global    : ${st.reactionsGlobal ? 'ON' : 'OFF'}

Usage: .reactions on|off [global]`
      });
    }
    return;
  }

  // ---------- SCHEDULE ----------
  if (base === '.schedule') {
    const action = args[0];
    const timeArg = args[1];
    const repeat = args[2];

    if (!isGroup) { await send({ text: '❌ Groups only.' }); return; }

    if (action === 'list') {
      const entries = [...st.schedules.entries()].filter(([j]) => j === from);
      if (!entries.length) {
        await send({ text: '📋 No schedules for this group.' });
        return;
      }
      const txt = entries
        .map(([, s]) => {
          const t = new Date(s.at).toISOString().replace('T', ' ').slice(0, 16);
          return `│ ${s.action.toUpperCase()} @ ${t} UTC (${s.repeat || 'once'})`;
        })
        .join('\n');
      await send({
        text: `${UI.box('SCHEDULES', '🕒')}\n\n${txt}`
      });
      return;
    }

    if (action === 'cancel') {
      st.schedules.delete(from);
      st.saveState();
      await send({ text: `${UI.box('SCHEDULE CLEARED', '🗑️')}` });
      return;
    }

    if (action !== 'open' && action !== 'close') {
      await send({
        text: 'Usage: .schedule open|close <HH:MM|30m|2h> [daily]'
      });
      return;
    }

    let at;
    if (/^\d+m$/.test(timeArg)) {
      at = Date.now() + parseInt(timeArg) * 60 * 1000;
    } else if (/^\d+h$/.test(timeArg)) {
      at = Date.now() + parseInt(timeArg) * 3600 * 1000;
    } else if (/^\d{1,2}:\d{2}$/.test(timeArg)) {
      const [h, m] = timeArg.split(':').map(Number);
      const d = new Date();
      d.setUTCHours(h, m, 0, 0);
      if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1);
      at = d.getTime();
    } else {
      await send({ text: '❌ Invalid time. Use HH:MM (UTC) or 30m / 2h.' });
      return;
    }

    st.schedules.set(from, {
      action,
      at,
      repeat: repeat === 'daily' ? 'daily' : 'once'
    });
    st.saveState();

    const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    await send({
      text: `${UI.box('SCHEDULED', '🕒')}\n\n│ Action : ${action.toUpperCase()}\n│ At     : ${when}\n│ Repeat : ${repeat === 'daily' ? 'daily' : 'once'}`
    });
    return;
  }

  // ---------- SPECIAL ----------
  if (base === '.vo') {
    if (args[0] === 'on') {
      st.viewOnceEnabled = true;
      saveState();
      await send({
        text: `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ✅ ON`
      });
    } else if (args[0] === 'off') {
      st.viewOnceEnabled = false;
      saveState();
      await send({
        text: `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ❌ OFF`
      });
    } else {
      await send({ text: 'Usage: .vo on/off' });
    }
    return;
  }

  if (base === '.autodl') {
    if (args[0] === 'on') {
      st.autoDownload = true;
      saveState();
      await send({
        text: `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ✅ ON`
      });
    } else if (args[0] === 'off') {
      st.autoDownload = false;
      saveState();
      await send({
        text: `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ❌ OFF`
      });
    } else {
      await send({ text: 'Usage: .autodl on/off' });
    }
    return;
  }

  if (base === '.poststatus') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedKey = msg.message.extendedTextMessage?.contextInfo;
    if (!quoted || !quotedKey) {
      await withTyping(replyJid, () =>
        send({
          text: `${UI.box('POST STATUS', '📤')}

Reply to a message with *.poststatus* to publish it to your WhatsApp status.`
        })
      );
      return;
    }
    try {
      const fakeQuoted = {
        key: {
          remoteJid: from,
          id: quotedKey.stanzaId,
          fromMe: quotedKey.participant === require('./state').botJid,
          participant: quotedKey.participant
        },
        message: quoted
      };
      const ok = await postToStatus(fakeQuoted);
      if (ok) {
        await withTyping(replyJid, () =>
          send({
            text: `${UI.box('POSTED', '✅')}\n\nVisible on your status for the next 24 hours.`
          })
        );
      } else {
        await withTyping(replyJid, () =>
          send({ text: '❌ Only text, images, videos supported.' })
        );
      }
    } catch (e) {
      console.error('[Status]', e);
      await send({ text: '❌ Status post failed.' });
    }
    return;
  }

  if (base === '.logout') {
    await send({ text: '🚪 *Logging out...*' });
    try { await sockInstance.logout(); } catch (e) {}
    return;
  }

  if (base === '.restart') {
    await send({ text: '🔄 *Restarting...*' });
    const conn = require('./connection');
    conn.stopBot();
    setTimeout(() => conn.startBot(currentNumber), 2000);
    return;
  }

  // ---------- ADD / DEL ADMIN ----------
  if (base === '.addadmin' || base === '.deladmin') {
    if (!isAdmin(senderJid)) {
      await send({ text: '❌ Only root admin can do this.' });
      return;
    }
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned?.length) {
      await send({ text: '❌ Mention someone.' });
      return;
    }
    for (const jid of mentioned) {
      const num = jid.split('@')[0].split(':')[0];
      if (base === '.addadmin') st.extraAdmins.add(num);
      else st.extraAdmins.delete(num);
    }
    st.saveState();
    await send({
      text: `${UI.box(base === '.addadmin' ? 'ADMIN ADDED' : 'ADMIN REMOVED', '✅')}`
    });
    return;
  }

  // ---------- PAIR ----------
  if (base === '.pair') {
    const num = args[0] || currentNumber;
    if (!num) { await send({ text: '❌ Usage: .pair <number>' }); return; }
    await send({ text: `⏳ Requesting code for +${num}...` });
    const conn = require('./connection');
    try { if (sockInstance) sockInstance.end(undefined); } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
    await conn.startBot(num);
    await send({
      text: `📱 Code sent to dashboard. Open the web UI to see it.`
    });
    return;
  }
}

module.exports = {
  tryCaptureViewOnce,
  postToStatus,
  sendWelcome,
  sendGoodbye,
  handleCommand,
  resolveSenderJid,
  resolveReplyJid,
  resolveMentionJid
};