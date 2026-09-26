// ============================================================================
// handlers.js — Feature handlers + command router
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
// 6. FEATURE HANDLERS
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
      const senderNum = (msg.key.participant || from).split('@')[0];
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
// 7. COMMAND HANDLER
// ============================================================================

async function handleCommand(msg, from, senderJid, rawText) {
  const sockInstance = require('./state').sock;
  const text = rawText.trim();
  const cmd = text.toLowerCase();
  const parts = cmd.split(' ');
  const base = parts[0];
  const args = parts.slice(1);
  const admin = isAdmin(senderJid);
  const isGroup = from.endsWith('@g.us');

  const adminCmds = [
    '.status', '.backup', '.restore', '.logout', '.pause', '.resume', '.pausestatus',
    '.welcome', '.goodbye', '.setwelcome', '.tagall', '.hidetag', '.kick', '.promote', '.demote',
    '.mute', '.unmute', '.groupinfo', '.vo', '.admin', '.restart', '.poststatus', '.autodl'
  ];

  if (adminCmds.includes(base) && !admin) {
    await withTyping(from, () =>
      sockInstance.sendMessage(from, {
        text: `${UI.box('ACCESS DENIED', '🔒')}\n\nSorry, this command is restricted to the admin.`
      })
    );
    return;
  }

  if (base === '.help' || base === '.menu') {
    const help = `${UI.box('BOT MENU', '🤖')}

━━━━━━━━━━━━━━━━━━━━━━━
  📌  *GENERAL*
━━━━━━━━━━━━━━━━━━━━━━━
│ .help      • show menu
│ .ping      • check alive
│ .id        • your JID
│ .myid      • your number
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
  👮  *ADMIN ONLY*
━━━━━━━━━━━━━━━━━━━━━━━
│ .status    • bot status
│ .logout    • disconnect
│ .restart   • reboot bot

━━━━━━━━━━━━━━━━━━━━━━━
  ⏸️  *PAUSE CONTROL*
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

    await withTyping(from, () => sendWithBanner(from, help));
    return;
  }

  if (base === '.ping') {
    const start = Date.now();
    const txt = `${UI.box('PONG', '🏓')}

│ Status  : ✅ online
│ Latency : ${Date.now() - start} ms
│ Uptime  : ${Math.floor(process.uptime())} s

╰━━━━━━━━━━━━━━━━━━━━╯
   _Bot is healthy_`;
    await withTyping(from, () => sendWithBanner(from, txt));
    return;
  }

  if (base === '.id' || base === '.myid') {
    const num = senderJid.split('@')[0].split(':')[0];
    await withTyping(from, () =>
      sockInstance.sendMessage(from, {
        text: `${UI.box('YOUR INFO', '🆔')}

│ Number   : +${num}
│ User JID : ${senderJid}
│ Chat JID : ${from}`
      })
    );
    return;
  }

  if (base === '.time') {
    await withTyping(from, () =>
      sockInstance.sendMessage(from, {
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
    await withTyping(from, () =>
      sockInstance.sendMessage(from, {
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

━━━━━━━━━━━━━━━━━━━━━━━
  🕐  _Reported at_
  ${new Date().toUTCString()}`;

    await withTyping(from, () => sendWithBanner(from, txt));
    return;
  }

  // ---------- Sticker ----------
  if (base === '.sticker' || base === '.s') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) {
      await withTyping(from, () => sockInstance.sendMessage(from, { text: '❌ Reply to an image or video.' }));
      return;
    }
    const img = quoted.imageMessage;
    const vid = quoted.videoMessage;
    if (!img && !vid) {
      await withTyping(from, () => sockInstance.sendMessage(from, { text: '❌ Must be image or video.' }));
      return;
    }
    try {
      await withTyping(from, async () => {
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
        await sockInstance.sendMessage(from, { sticker: buf });
      });
    } catch (e) {
      await sockInstance.sendMessage(from, { text: '❌ Failed. Try a smaller file.' });
    }
    return;
  }

  if (base === '.toimg') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const stickerMsg = quoted?.stickerMessage;
    if (!stickerMsg) {
      await withTyping(from, () => sockInstance.sendMessage(from, { text: '❌ Reply to a sticker.' }));
      return;
    }
    try {
      await withTyping(from, async () => {
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
        await sockInstance.sendMessage(from, { image: buf, caption: '🎨 *Converted to image*' });
      });
    } catch (e) {
      await sockInstance.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }

  if (base === '.tts' || base === '.voice') {
    let targetText = args.join(' ');
    if (!targetText) {
      const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      targetText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    }
    if (!targetText) {
      await withTyping(from, () =>
        sockInstance.sendMessage(from, { text: '❌ Provide text or reply to a message.' })
      );
      return;
    }
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
        targetText
      )}&tl=en&client=tw-ob`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf || buf.length === 0) throw new Error('Empty audio buffer');
      await withRecording(from, () =>
        sockInstance.sendMessage(from, { audio: buf, mimetype: 'audio/mp4', ptt: true })
      );
    } catch (e) {
      console.error('[TTS]', e.message);
      await sockInstance.sendMessage(from, { text: '❌ TTS failed.' });
    }
    return;
  }

  if (base === '.getpp') {
    let target = from;
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (mentioned?.length) target = mentioned[0];
    try {
      const url = await sockInstance.profilePictureUrl(target, 'image');
      await sockInstance.sendMessage(from, { image: { url }, caption: '📷 *Profile picture*' });
    } catch (e) {
      await sockInstance.sendMessage(from, { text: '❌ No profile picture available.' });
    }
    return;
  }

  // ---------- Pause / Resume ----------
  if (base === '.pause') {
    if (args[0] === 'all') {
      pausedChats.add('ALL');
      saveState();
      await sockInstance.sendMessage(from, {
        text: `${UI.box('GLOBAL PAUSE', '⏸️')}\n\nBot is now silent everywhere.`
      });
      return;
    }
    pausedChats.add(from);
    saveState();
    await sockInstance.sendMessage(from, {
      text: `${UI.box('PAUSED', '⏸️')}\n\nBot is silent in this chat.`
    });
    return;
  }
  if (base === '.resume') {
    if (args[0] === 'all') {
      pausedChats.delete('ALL');
      saveState();
      await sockInstance.sendMessage(from, {
        text: `${UI.box('RESUMED', '▶️')}\n\nBot is active everywhere.`
      });
      return;
    }
    pausedChats.delete(from);
    saveState();
    await sockInstance.sendMessage(from, {
      text: `${UI.box('RESUMED', '▶️')}\n\nBot is active in this chat.`
    });
    return;
  }
  if (base === '.pausestatus') {
    const g = pausedChats.has('ALL');
    const l = pausedChats.has(from);
    const state = g ? '🌍 Global pause ON' : l ? '⏸️ This chat paused' : '▶️ Active';
    await sockInstance.sendMessage(from, {
      text: `${UI.box('PAUSE STATUS', '📋')}\n\n│ ${state}`
    });
    return;
  }

  // ---------- Welcome / Goodbye ----------
  if (base === '.welcome') {
    if (!isGroup) { await sockInstance.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') {
      welcomeEnabled.add(from);
      saveState();
      await sockInstance.sendMessage(from, { text: `${UI.box('WELCOME ON', '✅')}` });
    } else if (args[0] === 'off') {
      welcomeEnabled.delete(from);
      saveState();
      await sockInstance.sendMessage(from, { text: `${UI.box('WELCOME OFF', '❌')}` });
    } else {
      await sockInstance.sendMessage(from, { text: 'Usage: .welcome on/off' });
    }
    return;
  }
  if (base === '.goodbye') {
    if (!isGroup) { await sockInstance.sendMessage(from, { text: '❌ Groups only.' }); return; }
    if (args[0] === 'on') {
      goodbyeEnabled.add(from);
      saveState();
      await sockInstance.sendMessage(from, { text: `${UI.box('GOODBYE ON', '✅')}` });
    } else if (args[0] === 'off') {
      goodbyeEnabled.delete(from);
      saveState();
      await sockInstance.sendMessage(from, { text: `${UI.box('GOODBYE OFF', '❌')}` });
    } else {
      await sockInstance.sendMessage(from, { text: 'Usage: .goodbye on/off' });
    }
    return;
  }
  if (base === '.setwelcome') {
    if (!isGroup) { await sockInstance.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const custom = text.replace(/^\.setwelcome\s+/i, '');
    if (!custom) {
      await sockInstance.sendMessage(from, { text: 'Usage: .setwelcome <text>  (@user, @group)' });
      return;
    }
    customWelcome[from] = custom;
    saveState();
    await sockInstance.sendMessage(from, {
      text: `${UI.box('SAVED', '✅')}\n\nCustom welcome message set.`
    });
    return;
  }

  // ---------- Tag / Kick ----------
  if (base === '.tagall' || base === '.hidetag') {
    if (!isGroup) { await sockInstance.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      const meta = await sockInstance.groupMetadata(from);
      const mentions = meta.participants.map((p) => p.id);
      const msgText = args.join(' ') || '📢 Attention everyone!';
      if (base === '.hidetag') {
        await sockInstance.sendMessage(from, { text: msgText, mentions });
      } else {
        const list = mentions.map((j) => `│ @${j.split('@')[0]}`).join('\n');
        const txt = `${UI.box('ANNOUNCEMENT', '📢')}

${msgText}

━━━━━━━━━━━━━━━━━━━━━━━
${list}
╰━━━━━━━━━━━━━━━━━━━━╯`;
        await sockInstance.sendMessage(from, { text: txt, mentions });
      }
    } catch (e) {
      await sockInstance.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }
  if (base === '.kick' || base === '.promote' || base === '.demote') {
    if (!isGroup) { await sockInstance.sendMessage(from, { text: '❌ Groups only.' }); return; }
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned?.length) {
      await sockInstance.sendMessage(from, { text: `❌ Mention someone to ${base.slice(1)}.` });
      return;
    }
    try {
      const action = base === '.kick' ? 'remove' : base === '.promote' ? 'promote' : 'demote';
      await sockInstance.groupParticipantsUpdate(from, mentioned, action);
      await sockInstance.sendMessage(from, {
        text: `${UI.box(action.toUpperCase(), '✅')}`
      });
    } catch (e) {
      await sockInstance.sendMessage(from, { text: '❌ Failed. Bot must be admin.' });
    }
    return;
  }
  if (base === '.mute' || base === '.unmute') {
    if (!isGroup) { await sockInstance.sendMessage(from, { text: '❌ Groups only.' }); return; }
    try {
      await sockInstance.groupSettingUpdate(from, base === '.mute' ? 'announcement' : 'not_announcement');
      await sockInstance.sendMessage(from, {
        text: base === '.mute' ? '🔇 *Group muted*' : '🔊 *Group unmuted*'
      });
    } catch (e) {
      await sockInstance.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }
  if (base === '.groupinfo') {
    if (!isGroup) { await sockInstance.sendMessage(from, { text: '❌ Groups only.' }); return; }
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
      await sockInstance.sendMessage(from, { text: txt });
    } catch (e) {
      await sockInstance.sendMessage(from, { text: '❌ Failed.' });
    }
    return;
  }

  // ---------- Special ----------
  if (base === '.vo') {
    const state = require('./state');
    if (args[0] === 'on') {
      state.viewOnceEnabled = true;
      saveState();
      await sockInstance.sendMessage(from, {
        text: `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ✅ ON`
      });
    } else if (args[0] === 'off') {
      state.viewOnceEnabled = false;
      saveState();
      await sockInstance.sendMessage(from, {
        text: `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ❌ OFF`
      });
    } else {
      await sockInstance.sendMessage(from, { text: 'Usage: .vo on/off' });
    }
    return;
  }
  if (base === '.autodl') {
    const state = require('./state');
    if (args[0] === 'on') {
      state.autoDownload = true;
      saveState();
      await sockInstance.sendMessage(from, {
        text: `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ✅ ON`
      });
    } else if (args[0] === 'off') {
      state.autoDownload = false;
      saveState();
      await sockInstance.sendMessage(from, {
        text: `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ❌ OFF`
      });
    } else {
      await sockInstance.sendMessage(from, { text: 'Usage: .autodl on/off' });
    }
    return;
  }
  if (base === '.poststatus') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedKey = msg.message.extendedTextMessage?.contextInfo;
    if (!quoted || !quotedKey) {
      await withTyping(from, () =>
        sockInstance.sendMessage(from, {
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
        await withTyping(from, () =>
          sockInstance.sendMessage(from, {
            text: `${UI.box('POSTED', '✅')}\n\nVisible on your status for the next 24 hours.`
          })
        );
      } else {
        await withTyping(from, () =>
          sockInstance.sendMessage(from, { text: '❌ Only text, images, videos supported.' })
        );
      }
    } catch (e) {
      console.error('[Status]', e);
      await sockInstance.sendMessage(from, { text: '❌ Status post failed.' });
    }
    return;
  }
  if (base === '.logout') {
    await sockInstance.sendMessage(from, { text: '🚪 *Logging out...*' });
    try { await sockInstance.logout(); } catch (e) {}
    return;
  }
  if (base === '.restart') {
    await sockInstance.sendMessage(from, { text: '🔄 *Restarting...*' });
    const conn = require('./connection');
    conn.stopBot();
    setTimeout(() => conn.startBot(currentNumber), 2000);
    return;
  }
}

module.exports = {
  tryCaptureViewOnce,
  postToStatus,
  sendWelcome,
  sendGoodbye,
  handleCommand
};