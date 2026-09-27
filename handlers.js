// ============================================================================
// handlers.js — Feature handlers + command router (extensible version)
// ============================================================================

const state = require('./state');
const {
  UI,
  isAdmin,
  withTyping,
  withRecording,
  sendWithBanner,
  pausedChats,
  saveState
} = state;

// ⚠️ Do NOT destructure sock / botJid / currentNumber here.
// They are getters that resolve at load time → null. Always use state.sock.

const {
  downloadMediaMessage,
  getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ADMIN_NUMBER = state.ADMIN_NUMBER;

// ============================================================================
// SENDER RESOLVER
// ============================================================================
function resolveSenderJid(msg, fallbackJid) {
  const pn = msg?.key?.senderPn || msg?.key?.participantPn;
  if (pn && typeof pn === 'string') {
    const num = pn.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }
  const participant = msg?.key?.participant;
  if (participant && participant.endsWith('@s.whatsapp.net')) {
    const num = participant.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }
  if (fallbackJid) {
    const num = fallbackJid.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }
  return '';
}

// ============================================================================
// SHARED HELPERS (used by every command)
// ============================================================================
const helpers = {
  /** Send a plain text reply in the chat the command came from. */
  async reply(from, text, opts = {}) {
    const sock = state.sock;
    if (!sock) return;
    return sock.sendMessage(from, { text, ...opts });
  },

  /** Reply with the banner image + text (falls back to text). */
  async replyWithBanner(from, text) {
    return sendWithBanner(from, text);
  },

  /** Reply while showing the "typing…" presence. */
  async replyTyping(from, text, opts = {}) {
    return withTyping(from, () => helpers.reply(from, text, opts));
  },

  /** Reply with the standard "denied" box. */
  async denied(from) {
    return helpers.replyTyping(
      from,
      `${UI.box('ACCESS DENIED', '🔒')}\n\nSorry, this command is restricted to the admin.`
    );
  },

  /** Throw a user-facing error inside a handler. */
  fail(message) {
    const err = new Error(message);
    err.userFacing = true;
    throw err;
  },

  /** Verify the chat is a group, else fail with a friendly message. */
  requireGroup(from) {
    if (!from.endsWith('@g.us')) helpers.fail('❌ This command only works in groups.');
  },

  /** Extract mentioned JIDs from the current message. */
  mentions(msg) {
    return (
      msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
      msg?.message?.imageMessage?.contextInfo?.mentionedJid ||
      msg?.message?.videoMessage?.contextInfo?.mentionedJid ||
      []
    );
  },

  /** Extract quoted message from the current message. */
  quoted(msg) {
    return msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
  },

  /** Extract the contextInfo of the current message. */
  contextInfo(msg) {
    return msg?.message?.extendedTextMessage?.contextInfo || null;
  },

  /** Require at least one mention, else fail. */
  requireMention(msg, usage) {
    const m = helpers.mentions(msg);
    if (!m.length) helpers.fail(`❌ Usage: ${usage}`);
    return m;
  },

  /** Format a duration in seconds to "Xh Ym". */
  humanDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
};

// ============================================================================
// FEATURE HANDLERS (non-command, event-driven)
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

    const sockInstance = state.sock;
    if (!sockInstance) return false;

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
    const sockInstance = state.sock;
    if (!sockInstance) return false;

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
    const sockInstance = state.sock;
    if (!sockInstance) return;

    const meta = await sockInstance.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    if (state.BANNER_BUFFER) {
      try {
        await sockInstance.sendMessage(groupJid, {
          image: state.BANNER_BUFFER,
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
      const custom = state.customWelcome[groupJid];
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
    const sockInstance = state.sock;
    if (!sockInstance) return;

    const meta = await sockInstance.groupMetadata(groupJid);
    const groupName = meta.subject || 'the group';

    if (state.BANNER_BUFFER) {
      try {
        await sockInstance.sendMessage(groupJid, {
          image: state.BANNER_BUFFER,
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
// COMMAND REGISTRY
// ----------------------------------------------------------------------------
// Each command object:
// {
//   name:     '.ping',              // primary trigger
//   aliases:  ['.p'],               // optional alternative triggers
//   admin:    false,                // true = admin-only
//   category: 'general',            // used by menu grouping
//   usage:    '.ping',              // optional usage hint
//   desc:     'Check bot alive',    // used by menu
//   handler:  async (ctx) => {}     // required
// }
//
// `ctx` = { msg, from, senderJid, args, text, base, isGroup, admin, sock, state }
//
// To add a command:
//   1) Drop a new object into the COMMANDS array below.
//   2) Done. The menu auto-updates, admin gate auto-applies.
// ============================================================================

const COMMANDS = [
  // ========================================================================
  // 📌 GENERAL
  // ========================================================================
  {
    name: '.help',
    aliases: ['.menu'],
    category: 'general',
    desc: 'Show this menu',
    handler: async ({ from }) => {
      const uptimeMin = Math.floor(process.uptime() / 60);
      const help = buildMenu(uptimeMin);
      await helpers.replyWithBanner(from, help);
    }
  },
  {
    name: '.ping',
    category: 'general',
    desc: 'Check bot alive',
    handler: async ({ from }) => {
      const start = Date.now();
      const txt = `${UI.box('PONG', '🏓')}

│ Status  : ✅ online
│ Latency : ${Date.now() - start} ms
│ Uptime  : ${Math.floor(process.uptime())} s`;
      await helpers.replyTyping(from, txt);
    }
  },
  {
    name: '.id',
    aliases: ['.myid'],
    category: 'general',
    desc: 'Your JID / number',
    handler: async ({ from, senderJid }) => {
      const num = senderJid.split('@')[0].split(':')[0];
      await helpers.replyTyping(
        from,
        `${UI.box('YOUR INFO', '🆔')}

│ Number   : +${num}
│ User JID : ${senderJid}
│ Chat JID : ${from}`
      );
    }
  },
  {
    name: '.whoami',
    category: 'general',
    desc: 'Check admin status',
    handler: async ({ msg, from, senderJid, admin }) => {
      const num = senderJid.split('@')[0].split(':')[0];
      const raw = msg.key.participant || msg.key.remoteJid || '';
      const pn = msg.key.senderPn || 'none';
      const ppn = msg.key.participantPn || 'none';
      await helpers.reply(
        from,
        `${UI.box('WHO AM I', '👤')}

│ Your number   : +${num}
│ Resolved JID  : ${senderJid}
│ Raw participant: ${raw}
│ senderPn      : ${pn}
│ participantPn : ${ppn}
│ Admin number  : ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'NOT SET'}
│ You are admin : ${admin ? '✅ YES' : '❌ NO'}`
      );
    }
  },
  {
    name: '.time',
    category: 'general',
    desc: 'Server time',
    handler: async ({ from }) => {
      await helpers.replyTyping(from, `${UI.box('SERVER TIME', '🕐')}\n\n│ ${new Date().toUTCString()}`);
    }
  },
  {
    name: '.uptime',
    category: 'general',
    desc: 'Bot uptime',
    handler: async ({ from }) => {
      const s = process.uptime();
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      await helpers.replyTyping(
        from,
        `${UI.box('UPTIME', '⏱️')}

│ Running : ${h}h ${m}m
│ Status  : ${state.botJid ? '✅ connected' : '❌ offline'}`
      );
    }
  },
  {
    name: '.echo',
    category: 'general',
    desc: 'Repeat text',
    usage: '.echo <text>',
    handler: async ({ from, args }) => {
      const t = args.join(' ');
      if (!t) helpers.fail('❌ Usage: .echo <text>');
      await helpers.reply(from, t);
    }
  },
  {
    name: '.calc',
    category: 'general',
    desc: 'Safe calculator',
    usage: '.calc <expression>',
    handler: async ({ from, text }) => {
      const expr = text.replace(/^\.calc\s+/i, '').replace(/[^0-9+\-*/(). ]/g, '');
      try {
        const result = Function(`"use strict"; return (${expr})`)();
        await helpers.reply(from, `🧮 ${expr} = *${result}*`);
      } catch {
        helpers.fail('❌ Invalid expression.');
      }
    }
  },

  // ========================================================================
  // 🎨 MEDIA
  // ========================================================================
  {
    name: '.sticker',
    aliases: ['.s'],
    category: 'media',
    desc: 'Image/video → sticker',
    handler: async ({ msg, from }) => {
      const quoted = helpers.quoted(msg);
      if (!quoted) helpers.fail('❌ Reply to an image or video.');
      const img = quoted.imageMessage;
      const vid = quoted.videoMessage;
      if (!img && !vid) helpers.fail('❌ Must be image or video.');

      await withTyping(from, async () => {
        const mType = img ? 'imageMessage' : 'videoMessage';
        const mContent = img || vid;
        const ctx = helpers.contextInfo(msg);
        const fakeMsg = {
          key: { remoteJid: from, id: ctx.stanzaId, fromMe: false },
          message: { [mType]: mContent }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: state.sock.updateMediaMessage
        });
        await state.sock.sendMessage(from, { sticker: buf });
      }).catch(() => helpers.reply(from, '❌ Failed. Try a smaller file.'));
    }
  },
  {
    name: '.toimg',
    category: 'media',
    desc: 'Sticker → image',
    handler: async ({ msg, from }) => {
      const quoted = helpers.quoted(msg);
      const stickerMsg = quoted?.stickerMessage;
      if (!stickerMsg) helpers.fail('❌ Reply to a sticker.');

      await withTyping(from, async () => {
        const ctx = helpers.contextInfo(msg);
        const fakeMsg = {
          key: { remoteJid: from, id: ctx.stanzaId, fromMe: false },
          message: { stickerMessage: stickerMsg }
        };
        const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: state.sock.updateMediaMessage
        });
        await state.sock.sendMessage(from, { image: buf, caption: '🎨 *Converted to image*' });
      }).catch(() => helpers.reply(from, '❌ Failed.'));
    }
  },
  {
    name: '.tts',
    aliases: ['.voice'],
    category: 'media',
    desc: 'Text → voice',
    usage: '.tts <text>',
    handler: async ({ msg, from, args }) => {
      let targetText = args.join(' ');
      if (!targetText) {
        const quoted = helpers.quoted(msg);
        targetText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
      }
      if (!targetText) helpers.fail('❌ Provide text or reply to a message.');

      const url =
        'https://translate.google.com/translate_tts?ie=UTF-8' +
        `&q=${encodeURIComponent(targetText.slice(0, 200))}` +
        '&tl=en&client=tw-ob';

      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://translate.google.com/'
        }
      });
      if (!res.ok) helpers.fail(`❌ TTS HTTP ${res.status}`);
      const mp3 = Buffer.from(await res.arrayBuffer());
      if (!mp3 || mp3.length < 100) helpers.fail('❌ Empty audio');

      // Try ffmpeg for real voice note; fall back to mp3 document
      let ogg = null;
      try {
        const ffmpeg = require('fluent-ffmpeg');
        const tmpIn = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);
        const tmpOut = path.join(os.tmpdir(), `tts-${Date.now()}.ogg`);
        fs.writeFileSync(tmpIn, mp3);
        await new Promise((resolve, reject) => {
          ffmpeg(tmpIn)
            .audioCodec('libopus')
            .format('ogg')
            .on('end', resolve)
            .on('error', reject)
            .save(tmpOut);
        });
        ogg = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
      } catch (convErr) {
        console.log('[TTS] ffmpeg unavailable, sending mp3:', convErr.message);
      }

      await withRecording(from, () => {
        if (ogg) {
          return state.sock.sendMessage(from, {
            audio: ogg,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
          });
        }
        return state.sock.sendMessage(from, {
          audio: mp3,
          mimetype: 'audio/mpeg',
          ptt: false,
          fileName: 'tts.mp3'
        });
      });
    }
  },
  {
    name: '.getpp',
    category: 'media',
    desc: 'Get profile picture',
    handler: async ({ msg, from }) => {
      let target = from;
      const mentioned = helpers.mentions(msg);
      if (mentioned.length) target = mentioned[0];
      try {
        const url = await state.sock.profilePictureUrl(target, 'image');
        await state.sock.sendMessage(from, { image: { url }, caption: '📷 *Profile picture*' });
      } catch {
        helpers.fail('❌ No profile picture available.');
      }
    }
  },
  {
    name: '.vv',
    category: 'special',
    desc: 'Reveal a view-once message',
    handler: async ({ msg, from }) => {
      const quoted = helpers.quoted(msg);
      if (!quoted) helpers.fail('❌ Reply to a view-once message with *.vv*.');

      const wrappers = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
      let inner = quoted;
      for (const w of wrappers) {
        if (quoted[w]?.message) { inner = quoted[w].message; break; }
      }
      const type = inner.imageMessage
        ? 'imageMessage'
        : inner.videoMessage
        ? 'videoMessage'
        : inner.audioMessage
        ? 'audioMessage'
        : null;
      if (!type) helpers.fail('❌ Not a view-once media message.');

      const ctx = helpers.contextInfo(msg);
      const fakeMsg = {
        key: { remoteJid: from, id: ctx.stanzaId, fromMe: false },
        message: { [type]: inner[type] }
      };
      const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: state.sock.updateMediaMessage
      });
      const caption = '👁️ *View-once revealed*';
      if (type === 'imageMessage') {
        await state.sock.sendMessage(from, { image: buf, caption });
      } else if (type === 'videoMessage') {
        await state.sock.sendMessage(from, { video: buf, caption });
      } else {
        await state.sock.sendMessage(from, {
          audio: buf,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      }
    }
  },

  // ========================================================================
  // 🎲 FUN
  // ========================================================================
  {
    name: '.roll',
    category: 'fun',
    desc: 'Roll dice (e.g. 2d6)',
    usage: '.roll [NdN]',
    handler: async ({ from, args }) => {
      const spec = args[0] || '1d6';
      const m = spec.match(/^(\d+)d(\d+)$/i);
      if (!m) helpers.fail('❌ Usage: .roll 1d6');
      const [, n, faces] = m;
      const rolls = Array.from({ length: Math.min(+n, 20) }, () =>
        1 + Math.floor(Math.random() * +faces)
      );
      await helpers.reply(
        from,
        `🎲 *${spec}* → ${rolls.join(' + ')} = *${rolls.reduce((a, b) => a + b, 0)}*`
      );
    }
  },
  {
    name: '.flip',
    category: 'fun',
    desc: 'Flip a coin',
    handler: async ({ from }) => {
      await helpers.reply(from, Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails');
    }
  },
  {
    name: '.8ball',
    category: 'fun',
    desc: 'Magic 8-ball',
    usage: '.8ball <question>',
    handler: async ({ from }) => {
      const answers = [
        'Yes.', 'No.', 'Maybe.', 'Ask again later.', 'Definitely.',
        'Absolutely not.', 'I wouldn\'t bet on it.', 'Signs point to yes.'
      ];
      await helpers.reply(from, '🎱 ' + answers[Math.floor(Math.random() * answers.length)]);
    }
  },
  {
    name: '.joke',
    category: 'fun',
    desc: 'Random joke',
    handler: async ({ from }) => {
      const jokes = [
        'Why don\'t scientists trust atoms? They make up everything.',
        'I told my Wi-Fi we needed space. Now it won\'t connect.',
        'Why did the developer go broke? He used up all his cache.'
      ];
      await helpers.reply(from, '😂 ' + jokes[Math.floor(Math.random() * jokes.length)]);
    }
  },
  {
    name: '.quote',
    category: 'fun',
    desc: 'Random quote',
    handler: async ({ from }) => {
      try {
        const r = await fetch('https://api.quotable.io/random');
        const d = await r.json();
        await helpers.reply(from, `💬 _"${d.content}"_\n— ${d.author}`);
      } catch {
        helpers.fail('❌ Quote fetch failed.');
      }
    }
  },
  {
    name: '.trivia',
    category: 'fun',
    desc: 'Play a trivia question',
    handler: async ({ from }) => {
      const QUESTIONS = [
        { q: 'What is the capital of Australia?', a: ['canberra'] },
        { q: 'How many continents are there?', a: ['7', 'seven'] },
        { q: 'What planet is known as the Red Planet?', a: ['mars'] },
        { q: 'What is the largest ocean on Earth?', a: ['pacific', 'pacific ocean'] },
        { q: 'Who wrote "Romeo and Juliet"?', a: ['shakespeare', 'william shakespeare'] }
      ];
      const pick = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
      await helpers.reply(
        from,
        `${UI.box('TRIVIA', '🧠')}\n\n${pick.q}\n\n_Reply with your answer — you have 30s._`
      );

      const sock = state.sock;
      const listener = async (m) => {
        try {
          const mtext = (
            m.message?.conversation || m.message?.extendedTextMessage?.text || ''
          ).toLowerCase().trim();
          if (!mtext) return;
          if (pick.a.includes(mtext)) {
            await sock.sendMessage(from, { text: '✅ Correct!' });
            sock.ev.off('messages.upsert', listener);
          }
        } catch {}
      };
      sock.ev.on('messages.upsert', listener);
      setTimeout(() => sock.ev.off('messages.upsert', listener), 30000);
    }
  },
  {
    name: '.truth',
    category: 'fun',
    desc: 'Truth question',
    handler: async ({ from }) => {
      const TRUTHS = [
        'What is your biggest fear?',
        'What is the most embarrassing thing you have done?',
        'Who was your first crush?',
        'What is a secret you have never told anyone?'
      ];
      const pick = TRUTHS[Math.floor(Math.random() * TRUTHS.length)];
      await helpers.reply(from, `${UI.box('TRUTH', '🤔')}\n\n${pick}`);
    }
  },
  {
    name: '.dare',
    category: 'fun',
    desc: 'Dare challenge',
    handler: async ({ from }) => {
      const DARES = [
        'Send the last photo in your gallery.',
        'Type your name with your eyes closed.',
        'Send a voice note singing your favourite song.',
        'Change your profile picture to a random meme for 1 hour.'
      ];
      const pick = DARES[Math.floor(Math.random() * DARES.length)];
      await helpers.reply(from, `${UI.box('DARE', '🎯')}\n\n${pick}`);
    }
  },
  {
    name: '.ship',
    category: 'fun',
    desc: 'Ship two users',
    usage: '.ship @a @b',
    handler: async ({ msg, from }) => {
      const mentioned = helpers.requireMention(msg, '.ship @user1 @user2');
      if (mentioned.length < 2) helpers.fail('❌ Usage: .ship @user1 @user2');
      const [a, b] = mentioned;
      const seed = [a, b].sort().join('|');
      let h = 0;
      for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
      const pct = Math.abs(h) % 101;
      const filled = Math.round(pct / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      await helpers.reply(
        from,
        `${UI.box('SHIP', '💞')}\n\n│ @${a.split('@')[0]}  ❤️  @${b.split('@')[0]}\n│ ${bar}  *${pct}%*`,
        { mentions: [a, b] }
      );
    }
  },

  // ========================================================================
  // 🛠️ TOOLS
  // ========================================================================
  {
    name: '.shorten',
    category: 'tools',
    desc: 'Shorten URL',
    usage: '.shorten <url>',
    handler: async ({ from, args }) => {
      const url = args[0];
      if (!url || !/^https?:\/\//.test(url)) helpers.fail('❌ Usage: .shorten https://...');
      try {
        const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
        const short = await r.text();
        await helpers.reply(from, `🔗 ${short}`);
      } catch {
        helpers.fail('❌ Shorten failed.');
      }
    }
  },
  {
    name: '.weather',
    category: 'tools',
    desc: 'Weather lookup',
    usage: '.weather <city>',
    handler: async ({ from, args }) => {
      const city = args.join(' ');
      if (!city) helpers.fail('❌ Usage: .weather <city>');
      try {
        const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
        const txt = await r.text();
        await helpers.reply(from, `🌤️ ${txt}`);
      } catch {
        helpers.fail('❌ Weather lookup failed.');
      }
    }
  },
  {
    name: '.translate',
    category: 'tools',
    desc: 'Translate text',
    usage: '.translate <lang> <text>',
    handler: async ({ msg, from, args }) => {
      const lang = args[0];
      let textToTranslate = args.slice(1).join(' ');
      if (!textToTranslate) {
        const quoted = helpers.quoted(msg);
        textToTranslate =
          quoted?.conversation || quoted?.extendedTextMessage?.text || '';
      }
      if (!lang || !textToTranslate) {
        helpers.fail('❌ Usage: .translate <lang> <text>\nExample: .translate es Hello world');
      }
      try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(textToTranslate)}`;
        const r = await fetch(url);
        const j = await r.json();
        const out = (j[0] || []).map((x) => x[0]).join('');
        await helpers.reply(from, `🌐 *${lang}*\n\n${out}`);
      } catch {
        helpers.fail('❌ Translation failed.');
      }
    }
  },
  {
    name: '.lyrics',
    category: 'tools',
    desc: 'Fetch song lyrics',
    usage: '.lyrics <song>',
    handler: async ({ from, args }) => {
      const query = args.join(' ');
      if (!query) helpers.fail('❌ Usage: .lyrics <song or artist>');

      await withTyping(from, async () => {
        try {
          const r = await fetch(`https://api.lyrics.ovh/suggest/${encodeURIComponent(query)}`);
          const j = await r.json();
          const hit = j?.data?.[0];
          if (!hit) {
            await helpers.reply(from, '❌ No lyrics found.');
            return;
          }
          const r2 = await fetch(
            `https://api.lyrics.ovh/v1/${encodeURIComponent(hit.artist.name)}/${encodeURIComponent(hit.title)}`
          );
          const j2 = await r2.json();
          const lyrics = (j2.lyrics || '').trim().slice(0, 3500);
          if (!lyrics) {
            await helpers.reply(from, '❌ No lyrics found.');
            return;
          }
          await helpers.reply(
            from,
            `${UI.box('LYRICS', '🎵')}\n\n*${hit.title}* — ${hit.artist.name}\n\n${lyrics}`
          );
        } catch (e) {
          console.error('[lyrics]', e.message);
          await helpers.reply(from, '❌ Lyrics fetch failed.');
        }
      });
    }
  },

  // ========================================================================
  // 👮 ADMIN
  // ========================================================================
  {
    name: '.status',
    admin: true,
    category: 'admin',
    desc: 'Bot status',
    handler: async ({ from }) => {
      const s = process.uptime();
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const txt = `${UI.box('BOT STATUS', '📊')}

━━━━━━━━━━━━━━━━━━━━━━━
  🔌  *CONNECTION*
━━━━━━━━━━━━━━━━━━━━━━━
│ Status   : ${state.botJid ? '✅ online' : '❌ offline'}
│ Number   : +${state.currentNumber || 'N/A'}
│ Uptime   : ${h}h ${m}m

━━━━━━━━━━━━━━━━━━━━━━━
  ⚙️  *FEATURES*
━━━━━━━━━━━━━━━━━━━━━━━
│ Paused     : ${pausedChats.size} chat(s)
│ View-once  : ${state.viewOnceEnabled ? '✅ ON' : '❌ OFF'}
│ Auto-DL    : ${state.autoDownload ? '✅ ON' : '❌ OFF'}
│ Welcome    : ${state.welcomeEnabled.size} group(s)
│ Anti-link  : ${state.antilinkGroups.size} group(s)
│ Reactions  : ${state.reactionsGlobal ? '✅ global' : state.reactionsEnabled.size + ' chat(s)'}
│ Schedules  : ${state.schedules.size}

━━━━━━━━━━━━━━━━━━━━━━━
  🕐  _Reported at_
  ${new Date().toUTCString()}`;
      await helpers.replyWithBanner(from, txt);
    }
  },
  {
    name: '.logout',
    admin: true,
    category: 'admin',
    desc: 'Disconnect session',
    handler: async ({ from }) => {
      await helpers.reply(from, '🚪 *Logging out...*');
      try { await state.sock.logout(); } catch (e) {}
    }
  },
  {
    name: '.restart',
    admin: true,
    category: 'admin',
    desc: 'Restart bot',
    handler: async ({ from }) => {
      await helpers.reply(from, '🔄 *Restarting...*');
      const conn = require('./connection');
      conn.stopBot();
      setTimeout(() => conn.startBot(state.currentNumber), 2000);
    }
  },
  {
    name: '.pair',
    admin: true,
    category: 'admin',
    desc: 'Re-pair bot',
    usage: '.pair <number>',
    handler: async ({ from, args }) => {
      const num = args[0] || state.currentNumber;
      if (!num) helpers.fail('❌ Usage: .pair <number>');
      await helpers.reply(from, `⏳ Requesting code for +${num}...`);
      const conn = require('./connection');
      try { if (state.sock) state.sock.end(undefined); } catch (e) {}
      await new Promise((r) => setTimeout(r, 1000));
      await conn.startBot(num);
      await helpers.reply(from, '📱 Code sent to dashboard. Open the web UI to see it.');
    }
  },
  {
    name: '.addadmin',
    admin: true,
    category: 'admin',
    desc: 'Promote user to admin',
    handler: async ({ msg, from }) => {
      const mentioned = helpers.requireMention(msg, '.addadmin @user');
      for (const jid of mentioned) {
        const num = jid.split('@')[0].split(':')[0];
        state.extraAdmins.add(num);
      }
      saveState();
      await helpers.reply(from, `${UI.box('ADMIN ADDED', '✅')}`);
    }
  },
  {
    name: '.deladmin',
    admin: true,
    category: 'admin',
    desc: 'Demote admin',
    handler: async ({ msg, from }) => {
      const mentioned = helpers.requireMention(msg, '.deladmin @user');
      for (const jid of mentioned) {
        const num = jid.split('@')[0].split(':')[0];
        state.extraAdmins.delete(num);
      }
      saveState();
      await helpers.reply(from, `${UI.box('ADMIN REMOVED', '✅')}`);
    }
  },

  // ========================================================================
  // ⏸️ PAUSE
  // ========================================================================
  {
    name: '.pause',
    admin: true,
    category: 'pause',
    desc: 'Pause bot',
    usage: '.pause [all]',
    handler: async ({ from, args }) => {
      if (args[0] === 'all') {
        pausedChats.add('ALL');
        saveState();
        await helpers.reply(from, `${UI.box('GLOBAL PAUSE', '⏸️')}\n\nBot is now silent everywhere.`);
        return;
      }
      pausedChats.add(from);
      saveState();
      await helpers.reply(from, `${UI.box('PAUSED', '⏸️')}\n\nBot is silent in this chat.`);
    }
  },
  {
    name: '.resume',
    admin: true,
    category: 'pause',
    desc: 'Resume bot',
    usage: '.resume [all]',
    handler: async ({ from, args }) => {
      if (args[0] === 'all') {
        pausedChats.delete('ALL');
        saveState();
        await helpers.reply(from, `${UI.box('RESUMED', '▶️')}\n\nBot is active everywhere.`);
        return;
      }
      pausedChats.delete(from);
      saveState();
      await helpers.reply(from, `${UI.box('RESUMED', '▶️')}\n\nBot is active in this chat.`);
    }
  },
  {
    name: '.pausestatus',
    admin: true,
    category: 'pause',
    desc: 'Pause status',
    handler: async ({ from }) => {
      const g = pausedChats.has('ALL');
      const l = pausedChats.has(from);
      const status = g ? '🌍 Global pause ON' : l ? '⏸️ This chat paused' : '▶️ Active';
      await helpers.reply(from, `${UI.box('PAUSE STATUS', '📋')}\n\n│ ${status}`);
    }
  },

  // ========================================================================
  // 👥 GROUP
  // ========================================================================
  {
    name: '.welcome',
    admin: true,
    category: 'group',
    desc: 'Welcome on/off',
    usage: '.welcome on|off',
    handler: async ({ from, args }) => {
      helpers.requireGroup(from);
      if (args[0] === 'on') {
        state.welcomeEnabled.add(from);
        saveState();
        await helpers.reply(from, `${UI.box('WELCOME ON', '✅')}`);
      } else if (args[0] === 'off') {
        state.welcomeEnabled.delete(from);
        saveState();
        await helpers.reply(from, `${UI.box('WELCOME OFF', '❌')}`);
      } else {
        helpers.fail('Usage: .welcome on/off');
      }
    }
  },
  {
    name: '.goodbye',
    admin: true,
    category: 'group',
    desc: 'Goodbye on/off',
    usage: '.goodbye on|off',
    handler: async ({ from, args }) => {
      helpers.requireGroup(from);
      if (args[0] === 'on') {
        state.goodbyeEnabled.add(from);
        saveState();
        await helpers.reply(from, `${UI.box('GOODBYE ON', '✅')}`);
      } else if (args[0] === 'off') {
        state.goodbyeEnabled.delete(from);
        saveState();
        await helpers.reply(from, `${UI.box('GOODBYE OFF', '❌')}`);
      } else {
        helpers.fail('Usage: .goodbye on/off');
      }
    }
  },
  {
    name: '.setwelcome',
    admin: true,
    category: 'group',
    desc: 'Custom welcome',
    usage: '.setwelcome <text>',
    handler: async ({ from, text }) => {
      helpers.requireGroup(from);
      const custom = text.replace(/^\.setwelcome\s+/i, '');
      if (!custom) helpers.fail('Usage: .setwelcome <text>  (@user, @group)');
      state.customWelcome[from] = custom;
      saveState();
      await helpers.reply(from, `${UI.box('SAVED', '✅')}\n\nCustom welcome message set.`);
    }
  },
  {
    name: '.tagall',
    admin: true,
    category: 'group',
    desc: 'Tag everyone',
    handler: async ({ from, args }) => {
      helpers.requireGroup(from);
      const meta = await state.sock.groupMetadata(from);
      const mentions = meta.participants.map((p) => p.id);
      const msgText = args.join(' ') || '📢 Attention everyone!';
      const list = mentions.map((j) => `│ @${j.split('@')[0]}`).join('\n');
      const txt = `${UI.box('ANNOUNCEMENT', '📢')}

${msgText}

━━━━━━━━━━━━━━━━━━━━━━━
${list}
╰━━━━━━━━━━━━━━━━━━━━╯`;
      await state.sock.sendMessage(from, { text: txt, mentions });
    }
  },
  {
    name: '.hidetag',
    admin: true,
    category: 'group',
    desc: 'Hidden tag',
    handler: async ({ from, args }) => {
      helpers.requireGroup(from);
      const meta = await state.sock.groupMetadata(from);
      const mentions = meta.participants.map((p) => p.id);
      const msgText = args.join(' ') || '📢 Attention everyone!';
      await state.sock.sendMessage(from, { text: msgText, mentions });
    }
  },
  {
    name: '.kick',
    admin: true,
    category: 'group',
    desc: 'Kick user',
    usage: '.kick @user',
    handler: async ({ msg, from }) => {
      helpers.requireGroup(from);
      const mentioned = helpers.requireMention(msg, '.kick @user');
      await state.sock.groupParticipantsUpdate(from, mentioned, 'remove');
      await helpers.reply(from, `${UI.box('KICKED', '✅')}`);
    }
  },
  {
    name: '.promote',
    admin: true,
    category: 'group',
    desc: 'Promote user',
    usage: '.promote @user',
    handler: async ({ msg, from }) => {
      helpers.requireGroup(from);
      const mentioned = helpers.requireMention(msg, '.promote @user');
      await state.sock.groupParticipantsUpdate(from, mentioned, 'promote');
      await helpers.reply(from, `${UI.box('PROMOTED', '✅')}`);
    }
  },
  {
    name: '.demote',
    admin: true,
    category: 'group',
    desc: 'Demote user',
    usage: '.demote @user',
    handler: async ({ msg, from }) => {
      helpers.requireGroup(from);
      const mentioned = helpers.requireMention(msg, '.demote @user');
      await state.sock.groupParticipantsUpdate(from, mentioned, 'demote');
      await helpers.reply(from, `${UI.box('DEMOTED', '✅')}`);
    }
  },
  {
    name: '.mute',
    admin: true,
    category: 'group',
    desc: 'Mute group',
    handler: async ({ from }) => {
      helpers.requireGroup(from);
      await state.sock.groupSettingUpdate(from, 'announcement');
      await helpers.reply(from, '🔇 *Group muted*');
    }
  },
  {
    name: '.unmute',
    admin: true,
    category: 'group',
    desc: 'Unmute group',
    handler: async ({ from }) => {
      helpers.requireGroup(from);
      await state.sock.groupSettingUpdate(from, 'not_announcement');
      await helpers.reply(from, '🔊 *Group unmuted*');
    }
  },
  {
    name: '.groupinfo',
    admin: true,
    category: 'group',
    desc: 'Group info',
    handler: async ({ from }) => {
      helpers.requireGroup(from);
      const meta = await state.sock.groupMetadata(from);
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
      await helpers.reply(from, txt);
    }
  },

  // ========================================================================
  // 🛡️ MODERATION
  // ========================================================================
  {
    name: '.antilink',
    admin: true,
    category: 'moderation',
    desc: 'Anti-link on/off/action',
    handler: async ({ from, args }) => {
      helpers.requireGroup(from);
      const sub = args[0];
      if (sub === 'on') {
        state.antilinkGroups.add(from);
        saveState();
        await helpers.reply(
          from,
          `${UI.box('ANTILINK ON', '🛡️')}\n\n│ Action : ${state.antilinkAction.get(from) || 'delete'}`
        );
      } else if (sub === 'off') {
        state.antilinkGroups.delete(from);
        saveState();
        await helpers.reply(from, `${UI.box('ANTILINK OFF', '🚫')}`);
      } else if (sub === 'action') {
        const a = args[1];
        if (!['delete', 'warn', 'kick'].includes(a)) {
          helpers.fail('❌ Usage: .antilink action delete|warn|kick');
        }
        state.antilinkAction.set(from, a);
        saveState();
        await helpers.reply(from, `${UI.box('ANTILINK ACTION', '⚙️')}\n\n│ ${a}`);
      } else {
        const enabled = state.antilinkGroups.has(from);
        await helpers.reply(
          from,
          `${UI.box('ANTILINK', '🛡️')}

│ Status : ${enabled ? '✅ ON' : '❌ OFF'}
│ Action : ${state.antilinkAction.get(from) || 'delete'}

Usage:
│ .antilink on|off
│ .antilink action delete|warn|kick`
        );
      }
    }
  },
  {
    name: '.reactions',
    admin: true,
    category: 'moderation',
    desc: 'Toggle bot reactions',
    handler: async ({ from, args }) => {
      const scope = args[0];
      const mode = args[1];
      if (scope === 'on') {
        if (mode === 'global') {
          state.reactionsGlobal = true;
          saveState();
          await helpers.reply(from, `${UI.box('REACTIONS GLOBAL ON', '😄')}`);
        } else {
          state.reactionsEnabled.add(from);
          state.reactionsDisabled.delete(from);
          saveState();
          await helpers.reply(from, `${UI.box('REACTIONS ON HERE', '😄')}`);
        }
      } else if (scope === 'off') {
        if (mode === 'global') {
          state.reactionsGlobal = false;
          saveState();
          await helpers.reply(from, `${UI.box('REACTIONS GLOBAL OFF', '🚫')}`);
        } else {
          state.reactionsDisabled.add(from);
          state.reactionsEnabled.delete(from);
          saveState();
          await helpers.reply(from, `${UI.box('REACTIONS OFF HERE', '🚫')}`);
        }
      } else {
        const local = state.reactionsEnabled.has(from)
          ? 'ON'
          : state.reactionsDisabled.has(from)
          ? 'OFF'
          : 'inherit';
        await helpers.reply(
          from,
          `${UI.box('REACTIONS STATUS', '📋')}

│ This chat : ${local}
│ Global    : ${state.reactionsGlobal ? 'ON' : 'OFF'}

Usage: .reactions on|off [global]`
        );
      }
    }
  },
  {
    name: '.schedule',
    admin: true,
    category: 'moderation',
    desc: 'Schedule group open/close',
    handler: async ({ from, args }) => {
      helpers.requireGroup(from);
      const action = args[0];
      const timeArg = args[1];
      const repeat = args[2];

      if (action === 'list') {
        const entries = [...state.schedules.entries()].filter(([j]) => j === from);
        if (!entries.length) {
          await helpers.reply(from, '📋 No schedules for this group.');
          return;
        }
        const txt = entries
          .map(([, s]) => {
            const t = new Date(s.at).toISOString().replace('T', ' ').slice(0, 16);
            return `│ ${s.action.toUpperCase()} @ ${t} UTC (${s.repeat || 'once'})`;
          })
          .join('\n');
        await helpers.reply(from, `${UI.box('SCHEDULES', '🕒')}\n\n${txt}`);
        return;
      }

      if (action === 'cancel') {
        state.schedules.delete(from);
        saveState();
        await helpers.reply(from, `${UI.box('SCHEDULE CLEARED', '🗑️')}`);
        return;
      }

      if (action !== 'open' && action !== 'close') {
        helpers.fail('Usage: .schedule open|close <HH:MM|30m|2h> [daily]');
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
        helpers.fail('❌ Invalid time. Use HH:MM (UTC) or 30m / 2h.');
      }

      state.schedules.set(from, {
        action,
        at,
        repeat: repeat === 'daily' ? 'daily' : 'once'
      });
      saveState();

      const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      await helpers.reply(
        from,
        `${UI.box('SCHEDULED', '🕒')}\n\n│ Action : ${action.toUpperCase()}\n│ At     : ${when}\n│ Repeat : ${repeat === 'daily' ? 'daily' : 'once'}`
      );
    }
  },
  {
    name: '.warn',
    admin: true,
    category: 'moderation',
    desc: 'Warn a user (3 = kick)',
    usage: '.warn @user [reason]',
    handler: async ({ msg, from, args }) => {
      helpers.requireGroup(from);
      const mentioned = helpers.requireMention(msg, '.warn @user [reason]');
      const target = mentioned[0];
      const groupWarns = state.warnings.get(from) || {};
      const reason = args.slice(1).join(' ') || 'no reason given';
      const list = groupWarns[target] || [];
      list.push(reason);
      groupWarns[target] = list;
      state.warnings.set(from, groupWarns);
      saveState();

      if (list.length >= 3) {
        try {
          await state.sock.groupParticipantsUpdate(from, [target], 'remove');
          await state.sock.sendMessage(from, {
            text: `🚪 @${target.split('@')[0]} was kicked (3 warnings).`,
            mentions: [target]
          });
          delete groupWarns[target];
          state.warnings.set(from, groupWarns);
          saveState();
        } catch {
          await helpers.reply(from, '⚠️ 3 warnings reached but kick failed.');
        }
      } else {
        await state.sock.sendMessage(from, {
          text: `⚠️ @${target.split('@')[0]} warned (${list.length}/3).\nReason: ${reason}`,
          mentions: [target]
        });
      }
    }
  },
  {
    name: '.warnings',
    admin: true,
    category: 'moderation',
    desc: 'List warnings for a user',
    usage: '.warnings @user',
    handler: async ({ msg, from }) => {
      helpers.requireGroup(from);
      const mentioned = helpers.requireMention(msg, '.warnings @user');
      const target = mentioned[0];
      const groupWarns = state.warnings.get(from) || {};
      const list = groupWarns[target] || [];
      await state.sock.sendMessage(from, {
        text: `${UI.box('WARNINGS', '📋')}\n\n@${target.split('@')[0]} has *${list.length}/3* warnings.\n\n${
          list.map((r, i) => `${i + 1}. ${r}`).join('\n') || '—'
        }`,
        mentions: [target]
      });
    }
  },
  {
    name: '.resetwarn',
    admin: true,
    category: 'moderation',
    desc: 'Clear warnings for a user',
    usage: '.resetwarn @user',
    handler: async ({ msg, from }) => {
      helpers.requireGroup(from);
      const mentioned = helpers.requireMention(msg, '.resetwarn @user');
      const target = mentioned[0];
      const groupWarns = state.warnings.get(from) || {};
      delete groupWarns[target];
      state.warnings.set(from, groupWarns);
      saveState();
      await state.sock.sendMessage(from, {
        text: `✅ Warnings cleared for @${target.split('@')[0]}.`,
        mentions: [target]
      });
    }
  },

  // ========================================================================
  // 📸 SPECIAL
  // ========================================================================
  {
    name: '.vo',
    admin: true,
    category: 'special',
    desc: 'View-once capture (global)',
    handler: async ({ from, args }) => {
      if (args[0] === 'on') {
        state.viewOnceEnabled = true;
        saveState();
        await helpers.reply(from, `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ✅ ON`);
      } else if (args[0] === 'off') {
        state.viewOnceEnabled = false;
        saveState();
        await helpers.reply(from, `${UI.box('VO CAPTURE', '📸')}\n\n│ Status : ❌ OFF`);
      } else {
        helpers.fail('Usage: .vo on/off');
      }
    }
  },
  {
    name: '.autodl',
    admin: true,
    category: 'special',
    desc: 'Auto download',
    handler: async ({ from, args }) => {
      if (args[0] === 'on') {
        state.autoDownload = true;
        saveState();
        await helpers.reply(from, `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ✅ ON`);
      } else if (args[0] === 'off') {
        state.autoDownload = false;
        saveState();
        await helpers.reply(from, `${UI.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ❌ OFF`);
      } else {
        helpers.fail('Usage: .autodl on/off');
      }
    }
  },
  {
    name: '.poststatus',
    admin: true,
    category: 'special',
    desc: 'Post to status',
    handler: async ({ msg, from }) => {
      const quoted = helpers.quoted(msg);
      const ctx = helpers.contextInfo(msg);
      if (!quoted || !ctx) {
        await helpers.replyTyping(
          from,
          `${UI.box('POST STATUS', '📤')}\n\nReply to a message with *.poststatus* to publish it to your WhatsApp status.`
        );
        return;
      }
      try {
        const fakeQuoted = {
          key: {
            remoteJid: from,
            id: ctx.stanzaId,
            fromMe: ctx.participant === state.botJid,
            participant: ctx.participant
          },
          message: quoted
        };
        const ok = await postToStatus(fakeQuoted);
        if (ok) {
          await helpers.replyTyping(
            from,
            `${UI.box('POSTED', '✅')}\n\nVisible on your status for the next 24 hours.`
          );
        } else {
          await helpers.replyTyping(from, '❌ Only text, images, videos supported.');
        }
      } catch (e) {
        console.error('[Status]', e);
        await helpers.reply(from, '❌ Status post failed.');
      }
    }
  }
];

// ============================================================================
// BUILD LOOKUP TABLES
// ============================================================================
const COMMAND_LOOKUP = new Map(); // trigger → command object
const ADMIN_TRIGGERS = new Set();

for (const cmd of COMMANDS) {
  const triggers = [cmd.name, ...(cmd.aliases || [])];
  for (const t of triggers) {
    COMMAND_LOOKUP.set(t.toLowerCase(), cmd);
    if (cmd.admin) ADMIN_TRIGGERS.add(t.toLowerCase());
  }
}

// ============================================================================
// MENU BUILDER (auto-generates from registry)
// ============================================================================
function buildMenu(uptimeMin) {
  const CATEGORY_META = {
    general:    { emoji: '📌', title: 'GENERAL' },
    media:      { emoji: '🎨', title: 'MEDIA' },
    fun:        { emoji: '🎲', title: 'FUN' },
    tools:      { emoji: '🛠️', title: 'TOOLS' },
    admin:      { emoji: '👮', title: 'ADMIN' },
    pause:      { emoji: '⏸️', title: 'PAUSE' },
    group:      { emoji: '👥', title: 'GROUP' },
    moderation: { emoji: '🛡️', title: 'MODERATION' },
    special:    { emoji: '📸', title: 'SPECIAL' }
  };

  const ORDER = ['general', 'media', 'fun', 'tools', 'admin', 'pause', 'group', 'moderation', 'special'];

  // Group commands by category
  const byCat = {};
  for (const cmd of COMMANDS) {
    if (!cmd.category) continue;
    if (!byCat[cmd.category]) byCat[cmd.category] = [];
    byCat[cmd.category].push(cmd);
  }

  let menu = `${UI.box('COMMAND CENTER', '🤖')}

╭───────────────────────╮
│  *WhatsApp Bot*  •  v1
│  Prefix: \`.\`
│  Uptime: ${uptimeMin}m
╰───────────────────────╯
`;

  for (const cat of ORDER) {
    const meta = CATEGORY_META[cat];
    const cmds = byCat[cat];
    if (!meta || !cmds || !cmds.length) continue;

    menu += `\n┌─ ${meta.emoji} *${meta.title}* ─────────\n`;
    for (const c of cmds) {
      // Name column padded to 20 chars, plus description
      const name = c.name.padEnd(16, ' ');
      menu += `│ ${name} ${c.desc || ''}\n`;
    }
    menu += `└───────────────────────\n`;
  }

  menu += `
╭───────────────────────╮
│ Admin  : ${ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set'}
│ Uptime : ${uptimeMin} min
│ Prefix : .
╰───────────────────────╯
  _Powered by Fanuels DX_`;

  return menu;
}

// ============================================================================
// COMMAND ROUTER
// ============================================================================
async function handleCommand(msg, from, senderJid, rawText) {
  const sockInstance = state.sock;
  const text = rawText.trim();
  const cmd = text.toLowerCase();
  const parts = cmd.split(' ');
  const base = parts[0];
  const args = parts.slice(1);
  const admin = isAdmin(senderJid);
  const isGroup = from.endsWith('@g.us');

  const command = COMMAND_LOOKUP.get(base);
  if (!command) {
    // Unknown command starting with '.' → reply
    if (base.startsWith('.')) {
      await withTyping(from, () =>
        sockInstance.sendMessage(from, {
          text: `${UI.box('UNKNOWN', '❓')}\n\nCommand *${base}* not found.\nType *.help* to see the menu.`
        })
      );
    }
    return;
  }

  if (command.admin && !admin) {
    await helpers.denied(from);
    return;
  }

  const ctx = {
    msg,
    from,
    senderJid,
    args,
    text,
    base,
    isGroup,
    admin,
    sock: sockInstance,
    state
  };

  try {
    await command.handler(ctx);
  } catch (err) {
    if (err.userFacing) {
      await helpers.reply(from, err.message);
    } else {
      console.error(`[cmd ${base}]`, err);
      await helpers.reply(from, `❌ Command *${base}* failed: ${err.message}`);
    }
  }
}

module.exports = {
  tryCaptureViewOnce,
  postToStatus,
  sendWelcome,
  sendGoodbye,
  handleCommand,
  resolveSenderJid,
  helpers,
  COMMANDS
};