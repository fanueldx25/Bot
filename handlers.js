// ============================================================================
// handlers.js — Feature handlers + command router (extensible version)
// ============================================================================
// Fixes applied in this file (cumulative):
//   1.  .trivia no longer attaches a rogue listener to sock.ev
//   2.  .restart awaits stopBot() before startBot()
//   3.  .pair goes through connection.stopBot() instead of raw sock.end()
//   4.  handleCommand guards against null socket
//   5.  resolveSenderJid handles @lid correctly instead of lying about it
//   6.  helpers.mentions unwraps ephemeral / viewOnce / document wrappers
//   7.  helpers.contextInfo does the same
//   8.  helpers.quoted reuses contextInfo
//   9.  Trivia state is a bounded Map with a sweep timer
//   10. .calc caps expression length and rejects non-finite results
//   11. handleCommand preserves arg casing (only the command name is lowered)
//   12. helpers.reply + replyWithBanner log every send for DM debugging
//   13. helpers.resolveJid converts @lid mentions to @s.whatsapp.net when
//       the LID is mapped, returns null otherwise so callers can error out.
//       Used by .getpp, .kick, .promote, .demote, .warn, .ship, .addadmin.
//
//   14. 🔧 FIX: preCommandHooks no longer blocks on engine.autoRegister().
//       New chats ALWAYS flow through to the command router. engine.js
//       only learns; it never gates.
//   15. 🔧 FIX: engine.install() is called BEFORE COMMAND_LOOKUP is built,
//       so the engine's extra commands (!topdf, !format, !add, !remove)
//       are reachable from the router. buildLookup() is a function.
//   16. 🔧 FIX: handleCommand uses engine.isCommand / engine.stripPrefix,
//       so both '.' and '!' prefixes work end-to-end.
//   17. 🔧 FIX: helpers.reply / replyWithBanner / sendWelcome / sendGoodbye
//       / tryCaptureViewOnce / postToStatus route through engine.send
//       (which wraps connection.safeSend) so E2EE retry receipts work.
//   18. 🔧 FIX: .poststatus reconstructs the quoted message properly and
//       works for text, image, and video quoted messages.
//   19. 🔧 FIX: rate limiting is applied per chat/user via engine.checkRate,
//       but NEVER blocks the very first command in a chat.
// ============================================================================

// handlers.js — PANDA WhatsApp Bot (complete)
// ---------------------------------------------------------------------------
// Requires:
//   ./state      → getters, UI, isAdmin, withTyping, withRecording, saveState…
//   ./engine     → command installer, rate-limit, send() bridge
//   ./ui         → PANDA block-letter banners + reusable blocks  (NEW)
//   @whiskeysockets/baileys
//   pino, fs, path, os
// ---------------------------------------------------------------------------

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

const UIkit = require('./ui');

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

const engine = require('./engine');
const ADMIN_NUMBER = state.ADMIN_NUMBER;

// ============================================================================
// EPHEMERAL GAME STATE (per-chat, expires)
// ============================================================================
const TRIVIA_STATE = new Map(); // chatJid → { answers: string[], expiresAt: number }

setInterval(() => {
  const now = Date.now();
  for (const [chat, s] of TRIVIA_STATE) {
    if (now > s.expiresAt) TRIVIA_STATE.delete(chat);
  }
}, 60_000).unref();

// ============================================================================
// AUTO VIEW/LIKE-STATUS TRACKER
// ---------------------------------------------------------------------------
// When the bot posts to status@broadcast we schedule 3-min and 5-min
// "views" (and a like) of the freshly posted status, using the same socket.
// This mimics WhatsApp's own behaviour where a user opens the status and
// taps ❤️. It is tracked by status message-id → timers, so multiple posts
// at once are handled independently.
// ============================================================================
const STATUS_TIMERS = new Map(); // msgId → { t3: Timeout, t5: Timeout }

function scheduleStatusEngagement(msgId) {
  if (!msgId) return;
  cancelStatusEngagement(msgId);

  const sock = state.sock;
  if (!sock) return;

  const t3 = setTimeout(() => {
    viewStatus(msgId).catch((e) =>
      console.error('[status-view 3m]', e.message)
    );
  }, 3 * 60 * 1000);

  const t5 = setTimeout(() => {
    viewStatus(msgId).catch((e) =>
      console.error('[status-view 5m]', e.message)
    );
    likeStatus(msgId).catch((e) =>
      console.error('[status-like 5m]', e.message)
    );
  }, 5 * 60 * 1000);

  STATUS_TIMERS.set(msgId, { t3, t5 });
}

function cancelStatusEngagement(msgId) {
  const cur = STATUS_TIMERS.get(msgId);
  if (!cur) return;
  clearTimeout(cur.t3);
  clearTimeout(cur.t5);
  STATUS_TIMERS.delete(msgId);
}

// Send a read receipt to status@broadcast for a given message id.
async function viewStatus(msgId) {
  const sock = state.sock;
  if (!sock) return;
  try {
    // Baileys accepts an array of { remoteJid, id, participant } keys.
    await sock.readMessages([
      {
        remoteJid: 'status@broadcast',
        id: msgId,
        participant: state.botJid || undefined
      }
    ]);
    console.log('[status] viewed', msgId);
  } catch (e) {
    console.error('[status] view failed', e.message);
  }
}

// Send a reaction (❤️) to a status message.
async function likeStatus(msgId) {
  const sock = state.sock;
  if (!sock) return;
  try {
    await sock.sendMessage(
      'status@broadcast',
      { react: { text: '❤️', key: { remoteJid: 'status@broadcast', id: msgId, fromMe: true } } },
      { statusJidList: [] }
    );
    console.log('[status] liked', msgId);
  } catch (e) {
    console.error('[status] like failed', e.message);
  }
}

// ============================================================================
// SENDER RESOLVER
// ============================================================================
function resolveSenderJid(msg, fallbackJid) {
  const pn = msg?.key?.senderPn || msg?.key?.participantPn;
  if (pn && typeof pn === 'string' && pn.endsWith('@s.whatsapp.net')) {
    const num = pn.split('@')[0].split(':')[0];
    if (/^\d{7,15}$/.test(num)) return `${num}@s.whatsapp.net`;
  }

  const participant = msg?.key?.participant;
  if (participant && participant.endsWith('@s.whatsapp.net')) {
    const num = participant.split('@')[0].split(':')[0];
    if (/^\d{7,15}$/.test(num)) return `${num}@s.whatsapp.net`;
  }

  if (fallbackJid) {
    const raw = fallbackJid.split('@')[0].split(':')[0];
    if (fallbackJid.endsWith('@lid')) {
      const resolved = state.resolveLid && state.resolveLid(raw);
      if (resolved) return `${resolved}@s.whatsapp.net`;
      return fallbackJid;
    }
    if (/^\d{7,15}$/.test(raw)) return `${raw}@s.whatsapp.net`;
  }

  return '';
}

// ============================================================================
// MESSAGE UNWRAPPING
// ============================================================================
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage'
];

function unwrapMessage(message) {
  let m = message;
  let guard = 0;
  while (m && guard++ < 6) {
    let unwrapped = false;
    for (const k of WRAPPER_KEYS) {
      if (m[k]?.message) {
        m = m[k].message;
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) break;
  }
  return m;
}

// ============================================================================
// SAFE SEND BRIDGE
// ============================================================================
async function safeSend(from, content, opts = {}) {
  try {
    return await engine.send(from, content, opts);
  } catch (e) {
    const sock = state.sock;
    if (!sock) throw e;
    return sock.sendMessage(from, content, opts);
  }
}

// ============================================================================
// SHARED HELPERS
// ============================================================================
const helpers = {
  async reply(from, text, opts = {}) {
    console.log('[reply] →', from, '|', String(text).slice(0, 60).replace(/\n/g, ' '));
    try {
      const res = await safeSend(from, { text, ...opts });
      console.log('[reply] sent, id =', res?.key?.id || '(no id)');
      return res;
    } catch (e) {
      console.error('[reply] sendMessage FAILED:', e.message);
      throw e;
    }
  },

  async replyWithBanner(from, text) {
    console.log('[replyWithBanner] →', from);
    try {
      const sock = state.sock;
      if (!sock) return helpers.reply(from, text);
      if (!state.BANNER_BUFFER) return await safeSend(from, { text });
      try {
        return await sendWithBanner(from, text);
      } catch (e) {
        console.warn('[replyWithBanner] banner failed, falling back to text:', e.message);
        return await safeSend(from, { text });
      }
    } catch (e) {
      console.error('[replyWithBanner] FAILED:', e.message);
      throw e;
    }
  },

  async replyTyping(from, text, opts = {}) {
    return withTyping(from, () => helpers.reply(from, text, opts));
  },

  async denied(from) {
    return helpers.replyTyping(
      from,
      `${UIkit.box('ACCESS DENIED', '🔒')}\n\nSorry, this command is restricted to the admin.`
    );
  },

  fail(message) {
    const err = new Error(message);
    err.userFacing = true;
    throw err;
  },

  requireGroup(from) {
    if (!from.endsWith('@g.us')) helpers.fail('❌ This command only works in groups.');
  },

  resolveJid(jid) {
    if (!jid) return jid;
    if (jid.endsWith('@s.whatsapp.net')) return jid;
    if (jid.endsWith('@lid')) {
      const num = jid.split('@')[0].split(':')[0];
      const pn = state.resolveLid && state.resolveLid(num);
      if (pn) return `${pn}@s.whatsapp.net`;
      return null;
    }
    return jid;
  },

  mentions(msg) {
    const m = unwrapMessage(msg?.message);
    if (!m) return [];
    for (const key of Object.keys(m)) {
      const ci = m[key]?.contextInfo;
      if (ci?.mentionedJid?.length) return ci.mentionedJid;
    }
    return [];
  },

  quoted(msg) {
    const ci = helpers.contextInfo(msg);
    return ci?.quotedMessage || null;
  },

  contextInfo(msg) {
    const m = unwrapMessage(msg?.message);
    if (!m) return null;
    for (const key of Object.keys(m)) {
      const ci = m[key]?.contextInfo;
      if (ci) return ci;
    }
    return null;
  },

  requireMention(msg, usage) {
    const m = helpers.mentions(msg);
    if (!m.length) helpers.fail(`❌ Usage: ${usage}`);
    return m;
  },

  humanDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
};

// ============================================================================
// FEATURE HANDLERS (event-driven)
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
        await safeSend(adminJid, { image: buffer, caption });
      } else if (mediaType === 'videoMessage') {
        await safeSend(adminJid, { video: buffer, caption });
      } else {
        await safeSend(adminJid, {
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

// ============================================================================
// POST TO STATUS
// ============================================================================
async function postToStatus(quotedMsg) {
  const sockInstance = state.sock;
  if (!sockInstance) {
    console.error('[Status] no socket');
    return false;
  }

  try {
    const inner = unwrapMessage(quotedMsg.message) || quotedMsg.message;
    const type = getContentType(inner);
    console.log('[Status] posting type =', type);

    let payload = null;

    if (type === 'conversation') {
      const text = inner.conversation || '';
      if (!text) return false;
      payload = { text, backgroundColor: '#1F2C33', font: 2 };
    } else if (type === 'extendedTextMessage') {
      const text = inner.extendedTextMessage?.text || '';
      if (!text) return false;
      payload = { text, backgroundColor: '#1F2C33', font: 2 };
    } else if (type === 'imageMessage') {
      const buf = await downloadMediaMessage(
        { key: quotedMsg.key, message: { imageMessage: inner.imageMessage } },
        'buffer',
        {},
        {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sockInstance.updateMediaMessage
        }
      );
      payload = { image: buf, caption: inner.imageMessage?.caption || '' };
    } else if (type === 'videoMessage') {
      const buf = await downloadMediaMessage(
        { key: quotedMsg.key, message: { videoMessage: inner.videoMessage } },
        'buffer',
        {},
        {
          logger: pino({ level: 'silent' }),
          reuploadRequest: sockInstance.updateMediaMessage
        }
      );
      payload = { video: buf, caption: inner.videoMessage?.caption || '' };
    } else {
      console.warn('[Status] unsupported type:', type);
      return false;
    }

    const sent = await safeSend('status@broadcast', payload, {
      broadcast: true,
      statusJidList: []
    });

    // 🔥 Auto view + like scheduling (3 min, 5 min after posting)
    const id = sent?.key?.id;
    if (id) {
      scheduleStatusEngagement(id);
      console.log('[Status] scheduled engagement for', id);
    }

    console.log('[Status] posted ✅');
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
        await safeSend(groupJid, {
          image: state.BANNER_BUFFER,
          caption: `${UIkit.pandaBanner('NEW MEMBER')}\n\n_Welcome to the family!_`
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
        : `${UIkit.section('WELCOME', '👋')}
│ 📌 ${groupName}

Hello @${num}!
You've joined the group.

${UIkit.section('RULES', '📋')}
│ ✅ Read the rules
│ ✅ Be respectful
│ ✅ No spam or links

${UIkit.divider}
  _Type *.help* to see commands_`;

      await safeSend(groupJid, { text, mentions: [jid] });
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
        await safeSend(groupJid, {
          image: state.BANNER_BUFFER,
          caption: `${UIkit.pandaBanner('MEMBER LEFT')}\n\n_We'll miss you._`
        });
      } catch (e) {}
    }

    for (const jid of participants) {
      const num = jid.split('@')[0];
      const text = `${UIkit.section('GOODBYE', '👋')}
│ 📌 ${groupName}

@${num} has left the group.

${UIkit.divider}
  _Wishing you the best!_`;

      await safeSend(groupJid, { text, mentions: [jid] });
    }
  } catch (e) {
    console.error('[Goodbye] Error:', e.message);
  }
}

// ============================================================================
// TEXT-TO-STICKER RENDERER
// ============================================================================
async function renderTextSticker(text, opts = {}) {
  let {
    font = 'Arial',
    color = 'white',
    bg = 'transparent',
    wm = false,
    random = false
  } = opts;

  const FONTS = {
    Arial: 'Arial, Helvetica, sans-serif',
    Impact: 'Impact, "Arial Black", sans-serif',
    Comic: '"Comic Sans MS", "Comic Sans", cursive',
    Times: '"Times New Roman", Times, serif',
    Courier: '"Courier New", Courier, monospace',
    Verdana: 'Verdana, Geneva, sans-serif'
  };

  const COLORS = ['white','black','red','green','blue','yellow','pink','orange','purple','cyan'];

  if (random) {
    const fontKeys = Object.keys(FONTS);
    font = fontKeys[Math.floor(Math.random() * fontKeys.length)];
    color = COLORS[Math.floor(Math.random() * COLORS.length)];
    bg = COLORS[Math.floor(Math.random() * COLORS.length)];
  }

  const SIZE = 512;
  const fontFamily = FONTS[font] || FONTS.Arial;

  const MAX_CHARS_PER_LINE = 14;
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > MAX_CHARS_PER_LINE) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 6) lines.length = 6;

  const lineHeight = 64;
  const totalH = lines.length * lineHeight;
  const startY = SIZE / 2 - totalH / 2 + lineHeight * 0.8;

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const bgRect =
    bg === 'transparent'
      ? ''
      : `<rect width="${SIZE}" height="${SIZE}" fill="${esc(bg)}"/>`;

  const linesSvg = lines
    .map((l, i) => {
      const y = startY + i * lineHeight;
      return `<text x="${SIZE / 2}" y="${y}"
        text-anchor="middle"
        font-family="${esc(fontFamily)}"
        font-size="52"
        font-weight="900"
        fill="${esc(color)}"
        stroke="black"
        stroke-width="3"
        paint-order="stroke"
        stroke-linejoin="round"
      >${esc(l)}</text>`;
    })
    .join('');

  const wmSvg = wm
    ? `<text x="${SIZE / 2}" y="${SIZE - 24}" text-anchor="middle"
        font-family="Arial" font-size="18" fill="${esc(color)}" opacity="0.7"
      >Fanuels DX</text>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
    ${bgRect}
    ${linesSvg}
    ${wmSvg}
  </svg>`;

  const { Resvg } = require('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZE },
    background: bg === 'transparent' ? undefined : bg
  });
  const png = resvg.render().asPng();

  try {
    const sharp = require('sharp');
    return await sharp(png).webp({ quality: 90 }).toBuffer();
  } catch {
    return png;
  }
}

// ============================================================================
// PRE-COMMAND HOOKS
// ============================================================================
async function preCommandHooks(msg, from, senderJid, rawText) {
  if (!rawText || !rawText.trim()) return false;
  const sock = state.sock;
  if (!sock) return false;

  try {
    engine.autoRegister(msg, from, senderJid);
  } catch (e) {
    console.error('[engine.autoRegister]', e.message);
  }

  // ---------- TRIVIA ----------
  const trivia = TRIVIA_STATE.get(from);
  if (trivia) {
    if (Date.now() > trivia.expiresAt) {
      TRIVIA_STATE.delete(from);
    } else if (!engine.isCommand(rawText)) {
      const guess = rawText.trim().toLowerCase();
      if (trivia.answers.includes(guess)) {
        TRIVIA_STATE.delete(from);
        try { await safeSend(from, { text: '✅ Correct!' }); } catch {}
        return true;
      }
    }
  }

  // ---------- AUTO-CORRECT ----------
  if (
    state.autoCorrectEnabled.has(from) &&
    !engine.isCommand(rawText) &&
    state.dictionary.size > 0
  ) {
    const tokens = rawText.split(/(\s+)/);
    let changed = false;
    const fixed = tokens
      .map((w) => {
        const key = w.toLowerCase().replace(/[^\w']/g, '');
        if (key && state.dictionary.has(key)) {
          changed = true;
          return w.replace(new RegExp(key, 'i'), state.dictionary.get(key));
        }
        return w;
      })
      .join('');

    if (changed && fixed !== rawText) {
      try {
        await safeSend(from, {
          text: `✍️ *Did you mean:*\n${fixed}`,
          quoted: msg
        });
      } catch (e) {
        console.error('[auto]', e.message);
      }
    }
  }

  // ---------- ANTI-MENTION ----------
  if (from.endsWith('@g.us') && state.antimentionGroups.has(from)) {
    const mentioned = helpers.mentions(msg);
    const mentionsGroupJid = mentioned.includes(from);
    const massMention = mentioned.length >= 5;

    if (mentionsGroupJid || massMention) {
      const policy = state.antimentionAction.get(from) || 'warn';
      const groupWarns = state.antimentionWarnings.get(from) || {};
      const list = groupWarns[senderJid] || [];
      list.push('mentioned the group');
      groupWarns[senderJid] = list;
      state.antimentionWarnings.set(from, groupWarns);
      saveState();

      try { await sock.sendMessage(from, { delete: msg.key }); } catch (e) {
        console.error('[antimention] delete failed:', e.message);
      }

      if (policy === 'kick') {
        try {
          await sock.groupParticipantsUpdate(from, [senderJid], 'remove');
          await safeSend(from, {
            text: `🚪 @${senderJid.split('@')[0]} kicked for mentioning the group.`,
            mentions: [senderJid]
          });
          delete groupWarns[senderJid];
          state.antimentionWarnings.set(from, groupWarns);
          saveState();
        } catch (e) {
          console.error('[antimention] kick failed:', e.message);
        }
      } else {
        await safeSend(from, {
          text: `⚠️ @${senderJid.split('@')[0]} — group mentions are not allowed (${list.length}/3).`,
          mentions: [senderJid]
        });
        if (list.length >= 3) {
          try {
            await sock.groupParticipantsUpdate(from, [senderJid], 'remove');
            await safeSend(from, {
              text: `🚪 @${senderJid.split('@')[0]} kicked (3 anti-mention warnings).`,
              mentions: [senderJid]
            });
          } catch (e) {}
          delete groupWarns[senderJid];
          state.antimentionWarnings.set(from, groupWarns);
          saveState();
        }
      }
      return true;
    }
  }

  // ---------- RATE LIMIT ----------
  if (engine.isCommand(rawText)) {
    const r = engine.checkRate(from, senderJid || from);
    if (!r.ok) {
      console.log(`[engine.rate] throttled ${from}/${senderJid} (retry in ${r.retryInSec}s)`);
      try {
        await safeSend(from, {
          text: `⏳ Slow down — try again in ${r.retryInSec}s.`
        });
      } catch {}
      return true;
    }
  }

  return false;
}

// ============================================================================
// COMMAND REGISTRY
// ============================================================================
const COMMANDS = [

  // ========================================================================
  // GENERAL
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
      const txt = `${UIkit.pandaBanner('PONG')}

${UIkit.section('LATENCY', '🏓')}
${UIkit.row('Status', '✅ online')}
${UIkit.row('Latency', `${Date.now() - start} ms`)}
${UIkit.row('Uptime', `${Math.floor(process.uptime())} s`)}`;
      await helpers.replyTyping(from, txt);
    }
  },
  {
    name: '.id',
    aliases: ['.myid'],
    category: 'general',
    desc: 'Your JID / number',
    handler: async ({ from, senderJid }) => {
      const num = (senderJid || '').split('@')[0].split(':')[0];
      await helpers.replyTyping(
        from,
        `${UIkit.pandaBanner('YOUR INFO')}

${UIkit.section('IDENTITY', '🆔')}
${UIkit.row('Number', `+${num}`)}
${UIkit.row('User JID', senderJid)}
${UIkit.row('Chat JID', from)}`
      );
    }
  },
  {
    name: '.whoami',
    category: 'general',
    desc: 'Check admin status',
    handler: async ({ msg, from, senderJid, admin }) => {
      const num = (senderJid || '').split('@')[0].split(':')[0];
      const raw = msg.key.participant || msg.key.remoteJid || '';
      const pn = msg.key.senderPn || 'none';
      const ppn = msg.key.participantPn || 'none';
      await helpers.reply(
        from,
        `${UIkit.pandaBanner('WHO AM I')}

${UIkit.section('DEBUG', '👤')}
${UIkit.row('Your number', `+${num}`)}
${UIkit.row('Resolved JID', senderJid)}
${UIkit.row('Raw participant', raw)}
${UIkit.row('senderPn', pn)}
${UIkit.row('participantPn', ppn)}
${UIkit.row('Admin number', ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'NOT SET')}
${UIkit.row('You are admin', admin ? '✅ YES' : '❌ NO')}`
      );
    }
  },
  {
    name: '.time',
    category: 'general',
    desc: 'Server time',
    handler: async ({ from }) => {
      await helpers.replyTyping(
        from,
        `${UIkit.pandaBanner('SERVER TIME')}\n\n│ ${new Date().toUTCString()}`
      );
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
        `${UIkit.pandaBanner('UPTIME')}

${UIkit.section('RUNTIME', '⏱️')}
${UIkit.row('Running', `${h}h ${m}m`)}
${UIkit.row('Status', state.botJid ? '✅ connected' : '❌ offline')}`
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
      const expr = text.replace(/^[.!]calc\s+/i, '').replace(/[^0-9+\-*/(). ]/g, '');
      if (expr.length > 200) helpers.fail('❌ Expression too long.');
      try {
        const result = Function(`"use strict"; return (${expr})`)();
        if (!Number.isFinite(result)) throw new Error('non-finite');
        await helpers.reply(from, `🧮 ${expr} = *${result}*`);
      } catch {
        helpers.fail('❌ Invalid expression.');
      }
    }
  },

  // ========================================================================
  // MEDIA
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
        await safeSend(from, { sticker: buf });
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
        await safeSend(from, { image: buf, caption: '🎨 *Converted to image*' });
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
          return safeSend(from, {
            audio: ogg,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
          });
        }
        return safeSend(from, {
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
      if (mentioned.length) {
        target = helpers.resolveJid(mentioned[0]);
        if (!target) helpers.fail('❌ Cannot resolve this user — their LID is not in LID_MAP.');
      }
      try {
        const url = await state.sock.profilePictureUrl(target, 'image');
        await safeSend(from, { image: { url }, caption: '📷 *Profile picture*' });
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
        await safeSend(from, { image: buf, caption });
      } else if (type === 'videoMessage') {
        await safeSend(from, { video: buf, caption });
      } else {
        await safeSend(from, {
          audio: buf,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
      }
    }
  },
  {
    name: '.stext',
    category: 'media',
    desc: 'Text → sticker',
    usage: '.stext <text> [--font=… --color=… --bg=… --wm --random]',
    handler: async ({ msg, from, text }) => {
      let raw = text.replace(/^[.!]stext\s*/i, '').trim();

      if (!raw) {
        const quoted = helpers.quoted(msg);
        raw = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
        if (!raw) helpers.fail('❌ Usage: .stext <text> (or reply to a text message)');
      }

      const flags = {};
      raw = raw
        .replace(/--(\w+)(?:=(\S+))?/g, (_, key, val) => {
          flags[key] = val === undefined ? true : val;
          return '';
        })
        .trim();

      if (!raw) helpers.fail('❌ No text after flags.');
      if (raw.length > 80) helpers.fail(`❌ Max 80 chars (you sent ${raw.length}).`);

      const opts = {
        font: typeof flags.font === 'string' ? flags.font : 'Arial',
        color: typeof flags.color === 'string' ? flags.color : 'white',
        bg: typeof flags.bg === 'string' ? flags.bg : 'transparent',
        wm: !!flags.wm,
        random: !!flags.random
      };

      try {
        const stickerBuf = await renderTextSticker(raw, opts);
        await safeSend(from, { sticker: stickerBuf });
      } catch (e) {
        console.error('[stext]', e);
        helpers.fail('❌ Sticker render failed: ' + e.message);
      }
    }
  },

  // ========================================================================
  // 🆕 DOWNLOADER — TikTok / YT / IG / FB / Spotify / X
  // ========================================================================
  {
    name: '.dl',
    aliases: ['.download', '.dlmedia'],
    category: 'media',
    desc: 'Download media from TikTok / YT / IG / FB / Spotify / X',
    usage: '.dl <url>  |  .dl help',
    handler: async ({ from, args }) => {
      const raw = args.join(' ').trim();

      // ---------- HELP ----------
      if (!raw || raw === 'help') {
        await helpers.replyWithBanner(
          from,
          `${UIkit.pandaBanner('MEDIA DOWNLOADER')}

${UIkit.section('SUPPORTED', '🌐')}
${UIkit.row('TikTok',    '🎵  videos / no-watermark')}
${UIkit.row('YouTube',   '▶️  video / audio / shorts')}
${UIkit.row('Instagram', '📸  reels / posts / stories')}
${UIkit.row('Facebook',  '📘  videos / reels')}
${UIkit.row('Spotify',   '🎧  track / album / playlist')}
${UIkit.row('Twitter/X', '🐦  videos / GIFs')}

${UIkit.section('HOW TO USE', '📖')}
│ .dl <url>            — auto-detects platform
│ .dl tiktok <url>
│ .dl yt <url>
│ .dl ig <url>
│ .dl fb <url>
│ .dl spotify <url>
│ .dl x <url>

${UIkit.section('NOTES', '💡')}
│ ⏳ Large files may take a while
│ 📦 Video + audio merged automatically
│ 🚫 Private / login-walled links are not supported`
        );
        return;
      }

      // ---------- PARSE ----------
      const KNOWN = ['tiktok','tt','yt','youtube','ig','instagram','fb','facebook','spotify','sp','x','twitter'];
      let platform = null;
      let url = raw;

      const first = raw.split(/\s+/)[0].toLowerCase();
      if (KNOWN.includes(first)) {
        platform = first;
        url = raw.split(/\s+/).slice(1).join(' ').trim();
      }

      if (!/^https?:\/\//i.test(url)) {
        helpers.fail('❌ Provide a valid URL, e.g. `.dl https://vt.tiktok.com/xxxx`');
      }

      if (!platform) {
        if (/tiktok\.com/i.test(url)) platform = 'tiktok';
        else if (/(youtube\.com|youtu\.be)/i.test(url)) platform = 'yt';
        else if (/instagram\.com/i.test(url)) platform = 'ig';
        else if (/(facebook\.com|fb\.watch)/i.test(url)) platform = 'fb';
        else if (/spotify\.com/i.test(url)) platform = 'spotify';
        else if (/(twitter\.com|x\.com)/i.test(url)) platform = 'x';
        else platform = 'unknown';
      }

      const PRETTY = {
        tiktok: '🎵 TikTok', tt: '🎵 TikTok',
        yt: '▶️ YouTube', youtube: '▶️ YouTube',
        ig: '📸 Instagram', instagram: '📸 Instagram',
        fb: '📘 Facebook', facebook: '📘 Facebook',
        spotify: '🎧 Spotify', sp: '🎧 Spotify',
        x: '🐦 Twitter/X', twitter: '🐦 Twitter/X',
        unknown: '🌐 Unknown'
      }[platform];

      await helpers.reply(
        from,
        `${UIkit.box('DOWNLOAD REQUEST', '⏳')}

${UIkit.section('JOB', '📥')}
${UIkit.row('Platform', PRETTY)}
${UIkit.row('URL', url.slice(0, 42) + (url.length > 42 ? '…' : ''))}
${UIkit.row('Status', 'fetching…')}`
      );

      try {
        // Prefer the transformer-based downloader if available
        const transformer = require('./transformer');
        const handled = await transformer.handleDownload({
          platform,
          url,
          from,
          state,
          helpers,
          safeSend
        });
        if (handled) return;

        helpers.fail(
          `❌ No handler found for platform *${PRETTY}*.\n` +
          `📌 The transformer module must export handleDownload().`
        );
      } catch (e) {
        console.error('[.dl]', e);
        helpers.fail(`❌ Download failed: ${e.message}`);
      }
    }
  },

  // ========================================================================
  // FUN
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
        'Yes.','No.','Maybe.','Ask again later.','Definitely.',
        'Absolutely not.',"I wouldn't bet on it.",'Signs point to yes.'
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
        "Why don't scientists trust atoms? They make up everything.",
        "I told my Wi-Fi we needed space. Now it won't connect.",
        "Why did the developer go broke? He used up all his cache."
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
        { q: 'How many continents are there?', a: ['7','seven'] },
        { q: 'What planet is known as the Red Planet?', a: ['mars'] },
        { q: 'What is the largest ocean on Earth?', a: ['pacific','pacific ocean'] },
        { q: 'Who wrote "Romeo and Juliet"?', a: ['shakespeare','william shakespeare'] }
      ];
      const pick = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
      TRIVIA_STATE.set(from, {
        answers: pick.a,
        expiresAt: Date.now() + 30_000
      });
      await helpers.reply(
        from,
        `${UIkit.pandaBanner('TRIVIA')}\n\n${pick.q}\n\n_Reply with your answer — you have 30s._`
      );
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
      await helpers.reply(from, `${UIkit.pandaBanner('TRUTH')}\n\n${pick}`);
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
      await helpers.reply(from, `${UIkit.pandaBanner('DARE')}\n\n${pick}`);
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
      const aRes = helpers.resolveJid(a) || a;
      const bRes = helpers.resolveJid(b) || b;

      const seed = [a, b].slice().sort().join('|');
      let h = 0;
      for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
      const pct = Math.abs(h) % 101;
      const bar = UIkit.bar(pct, 10);
      await helpers.reply(
        from,
        `${UIkit.pandaBanner('SHIP')}

${UIkit.section('LOVE METER', '💞')}
${UIkit.row('A', `@${a.split('@')[0]}`)}
${UIkit.row('B', `@${b.split('@')[0]}`)}
${UIkit.row('Score', `${bar}  *${pct}%*`)}`,
        { mentions: [aRes, bRes] }
      );
    }
  },

  // ========================================================================
  // TOOLS
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
            `${UIkit.pandaBanner('LYRICS')}\n\n*${hit.title}* — ${hit.artist.name}\n\n${lyrics}`
          );
        } catch (e) {
          console.error('[lyrics]', e.message);
          await helpers.reply(from, '❌ Lyrics fetch failed.');
        }
      });
    }
  },
  {
    name: '.dict',
    admin: true,
    category: 'tools',
    desc: 'Manage auto-correct dictionary',
    usage: '.dict add <wrong> <right> | del <wrong> | list',
    handler: async ({ from, args }) => {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'add') {
        const wrong = (args[1] || '').toLowerCase();
        const right = args[2];
        if (!wrong || !right) helpers.fail('Usage: .dict add <wrong> <right>');
        state.dictionary.set(wrong, right);
        saveState();
        await helpers.reply(from, `${UIkit.box('DICT ADDED', '📖')}\n\n│ ${wrong} → ${right}`);
      } else if (sub === 'del' || sub === 'remove') {
        const wrong = (args[1] || '').toLowerCase();
        if (!wrong) helpers.fail('Usage: .dict del <wrong>');
        const existed = state.dictionary.delete(wrong);
        saveState();
        await helpers.reply(
          from,
          existed ? `${UIkit.box('DICT REMOVED', '🗑️')}` : '❌ Not in dictionary.'
        );
      } else if (sub === 'list') {
        const entries = [...state.dictionary.entries()];
        if (!entries.length) {
          await helpers.reply(from, '📖 Dictionary is empty.');
          return;
        }
        const body = entries.slice(0, 100).map(([w, r]) => `│ ${w} → ${r}`).join('\n');
        const more = entries.length > 100 ? `\n… and ${entries.length - 100} more.` : '';
        await helpers.reply(
          from,
          `${UIkit.pandaBanner('DICTIONARY')}\n\n${body}${more}\n\n_${entries.length} entries_`
        );
      } else {
        helpers.fail('Usage: .dict add|del|list');
      }
    }
  },
  {
    name: '.edit',
    category: 'tools',
    desc: 'Reply to a message to repost it edited',
    usage: '.edit <new text>',
    handler: async ({ msg, from, args }) => {
      const quoted = helpers.quoted(msg);
      if (!quoted) helpers.fail('❌ Reply to a message with *.edit <new text>*');
      const newText = args.join(' ');
      if (!newText) helpers.fail('❌ Usage: .edit <new text>');

      const ci = helpers.contextInfo(msg);
      const senderRaw = ci?.participant || '';
      const sender = helpers.resolveJid(senderRaw) || senderRaw;
      const senderNum = sender.split('@')[0];
      await helpers.reply(
        from,
        `✏️ *Edited* (@${senderNum})\n\n${newText}`,
        sender ? { mentions: [sender] } : {}
      );
    }
  },

  // ========================================================================
  // ADMIN
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
      const txt = `${UIkit.pandaBanner('BOT STATUS')}

${UIkit.section('CONNECTION', '🔌')}
${UIkit.row('Status', state.botJid ? '✅ online' : '❌ offline')}
${UIkit.row('Number', '+' + (state.currentNumber || 'N/A'))}
${UIkit.row('Uptime', `${h}h ${m}m`)}

${UIkit.section('FEATURES', '⚙️')}
${UIkit.row('Paused', pausedChats.size + ' chat(s)')}
${UIkit.row('View-once', state.viewOnceEnabled ? '✅ ON' : '❌ OFF')}
${UIkit.row('Auto-DL', state.autoDownload ? '✅ ON' : '❌ OFF')}
${UIkit.row('Welcome', state.welcomeEnabled.size + ' group(s)')}
${UIkit.row('Anti-link', state.antilinkGroups.size + ' group(s)')}
${UIkit.row('Auto-corr.', state.autoCorrectEnabled.size + ' chat(s)')}
${UIkit.row('Anti-ment.', state.antimentionGroups.size + ' group(s)')}
${UIkit.row('Dict words', state.dictionary.size)}
${UIkit.row('Reactions', state.reactionsGlobal ? '✅ global' : state.reactionsEnabled.size + ' chat(s)')}
${UIkit.row('Schedules', state.schedules.size)}
${UIkit.row('Status auto', `${STATUS_TIMERS.size} pending`)}

${UIkit.section('REPORT', '🕐')}
│ ${new Date().toUTCString()}`;
      await helpers.replyWithBanner(from, txt);
    }
  },
  {
    name: '.logout',
    admin: true,
    category: 'admin',
    desc: 'Disconnect session',
    handler: async ({ from }) => {
      await helpers.reply(from, '🚪 *Logging out…*');
      try { await state.sock.logout(); } catch (e) {}
    }
  },
  {
    name: '.restart',
    admin: true,
    category: 'admin',
    desc: 'Restart bot',
    handler: async ({ from }) => {
      await helpers.reply(from, '🔄 *Restarting…*');
      const conn = require('./connection');
      await conn.stopBot();
      await conn.startBot(state.currentNumber);
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
      await helpers.reply(from, `⏳ Requesting code for +${num}…`);
      const conn = require('./connection');
      await conn.stopBot();
      await conn.startBot(num);
      await helpers.reply(from, '📱 New pairing code sent to the dashboard.');
    }
  },
  {
    name: '.addadmin',
    admin: true,
    category: 'admin',
    desc: 'Promote user to admin',
    handler: async ({ msg, from }) => {
      const mentioned = helpers.requireMention(msg, '.addadmin @user');
      const added = [];
      for (const jid of mentioned) {
        const resolved = helpers.resolveJid(jid) || jid;
        const num = resolved.split('@')[0].split(':')[0];
        state.extraAdmins.add(num);
        added.push(num);
      }
      saveState();
      await helpers.reply(from, `${UIkit.box('ADMIN ADDED', '✅')}\n\n${added.join('\n')}`);
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
        const resolved = helpers.resolveJid(jid) || jid;
        const num = resolved.split('@')[0].split(':')[0];
        state.extraAdmins.delete(num);
      }
      saveState();
      await helpers.reply(from, `${UIkit.box('ADMIN REMOVED', '✅')}`);
    }
  },

  // ========================================================================
  // PAUSE
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
        await helpers.reply(from, `${UIkit.box('GLOBAL PAUSE', '⏸️')}\n\nBot is now silent everywhere.`);
        return;
      }
      pausedChats.add(from);
      saveState();
      await helpers.reply(from, `${UIkit.box('PAUSED', '⏸️')}\n\nBot is silent in this chat.`);
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
        await helpers.reply(from, `${UIkit.box('RESUMED', '▶️')}\n\nBot is active everywhere.`);
        return;
      }
      pausedChats.delete(from);
      saveState();
      await helpers.reply(from, `${UIkit.box('RESUMED', '▶️')}\n\nBot is active in this chat.`);
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
      await helpers.reply(from, `${UIkit.box('PAUSE STATUS', '📋')}\n\n│ ${status}`);
    }
  },

  // ========================================================================
  // GROUP
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
        await helpers.reply(from, `${UIkit.box('WELCOME ON', '✅')}`);
      } else if (args[0] === 'off') {
        state.welcomeEnabled.delete(from);
        saveState();
        await helpers.reply(from, `${UIkit.box('WELCOME OFF', '❌')}`);
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
        await helpers.reply(from, `${UIkit.box('GOODBYE ON', '✅')}`);
      } else if (args[0] === 'off') {
        state.goodbyeEnabled.delete(from);
        saveState();
        await helpers.reply(from, `${UIkit.box('GOODBYE OFF', '❌')}`);
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
      const custom = text.replace(/^[.!]setwelcome\s+/i, '');
      if (!custom) helpers.fail('Usage: .setwelcome <text>  (@user, @group)');
      state.customWelcome[from] = custom;
      saveState();
      await helpers.reply(from, `${UIkit.box('SAVED', '✅')}\n\nCustom welcome message set.`);
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
      const txt = `${UIkit.pandaBanner('ANNOUNCEMENT')}

${msgText}

${UIkit.divider}
${list}
${UIkit.divider}`;
      await safeSend(from, { text: txt, mentions });
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
      await safeSend(from, { text: msgText, mentions });
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
      const resolved = mentioned.map((j) => helpers.resolveJid(j)).filter(Boolean);
      if (!resolved.length) {
        helpers.fail('❌ Cannot resolve any mentioned user — their LIDs are not in LID_MAP.');
      }
      await state.sock.groupParticipantsUpdate(from, resolved, 'remove');
      await helpers.reply(from, `${UIkit.box('KICKED', '✅')}`);
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
      const resolved = mentioned.map((j) => helpers.resolveJid(j)).filter(Boolean);
      if (!resolved.length) {
        helpers.fail('❌ Cannot resolve mentioned user — add their LID to LID_MAP.');
      }
      await state.sock.groupParticipantsUpdate(from, resolved, 'promote');
      await helpers.reply(from, `${UIkit.box('PROMOTED', '✅')}`);
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
      const resolved = mentioned.map((j) => helpers.resolveJid(j)).filter(Boolean);
      if (!resolved.length) {
        helpers.fail('❌ Cannot resolve mentioned user — add their LID to LID_MAP.');
      }
      await state.sock.groupParticipantsUpdate(from, resolved, 'demote');
      await helpers.reply(from, `${UIkit.box('DEMOTED', '✅')}`);
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
      const txt = `${UIkit.pandaBanner('GROUP INFO')}

${UIkit.section('OVERVIEW', '📋')}
${UIkit.row('Name', meta.subject)}
${UIkit.row('ID', meta.id)}
${UIkit.row('Members', meta.participants.length)}
${UIkit.row('Admins', meta.participants.filter((p) => p.admin).length)}
${UIkit.row('Created', new Date(meta.creation * 1000).toUTCString().split(',')[0])}

${UIkit.section('ADMINS', '👑')}
${admins}`;
      await helpers.reply(from, txt);
    }
  },

  // ========================================================================
  // 🆕 GROUP BRANDING — .setgroup
  // ========================================================================
  {
    name: '.setgroup',
    aliases: ['.gset'],
    admin: true,
    category: 'group',
    desc: 'Update group name / description / picture',
    usage: '.setgroup name <text> | desc <text> | pic (reply to image) | info',
    handler: async ({ msg, from, args }) => {
      helpers.requireGroup(from);

      const sub = (args[0] || '').toLowerCase();
      const sock = state.sock;

      // ---------- INFO ----------
      if (!sub || sub === 'info') {
        const meta = await sock.groupMetadata(from);
        await helpers.replyWithBanner(
          from,
          `${UIkit.pandaBanner('GROUP BRANDING')}

${UIkit.section('CURRENT', '📋')}
${UIkit.row('Name', meta.subject)}
${UIkit.row('Desc', (meta.desc || '—').slice(0, 40))}
${UIkit.row('Members', meta.participants.length)}
${UIkit.row('ID', meta.id)}

${UIkit.section('COMMANDS', '🛠️')}
${UIkit.row('.setgroup name', '<new name>')}
${UIkit.row('.setgroup desc', '<new description>')}
${UIkit.row('.setgroup pic', '(reply to image)')}
${UIkit.row('.setgroup info', 'show this panel')}`
        );
        return;
      }

      // ---------- NAME ----------
      if (sub === 'name') {
        const newName = args.slice(1).join(' ').trim();
        if (!newName) helpers.fail('❌ Usage: .setgroup name <new name>');
        if (newName.length > 100) helpers.fail('❌ Name too long (max 100).');

        await withTyping(from, async () => {
          await sock.groupUpdateSubject(from, newName);
          await helpers.reply(
            from,
            `${UIkit.box('NAME UPDATED', '🏷️')}

${UIkit.section('NEW NAME', '✅')}
${UIkit.row('Name', newName)}`
          );
        });
        return;
      }

      // ---------- DESCRIPTION ----------
      if (sub === 'desc' || sub === 'description') {
        const newDesc = args.slice(1).join(' ').trim();
        if (!newDesc) helpers.fail('❌ Usage: .setgroup desc <new description>');
        if (newDesc.length > 512) helpers.fail('❌ Description too long (max 512).');

        await withTyping(from, async () => {
          await sock.groupUpdateDescription(from, newDesc);
          await helpers.reply(
            from,
            `${UIkit.box('DESCRIPTION UPDATED', '📝')}

${UIkit.section('NEW DESCRIPTION', '✅')}
│ ${newDesc}`
          );
        });
        return;
      }

      // ---------- PICTURE ----------
      if (sub === 'pic' || sub === 'icon' || sub === 'photo') {
        const quoted = helpers.quoted(msg);
        const img = quoted?.imageMessage;
        if (!img) {
          helpers.fail(
            '❌ Reply to an *image* with `.setgroup pic` to change the group icon.\n' +
            '📌 Tip: square images look best (min 192×192).'
          );
        }

        await withTyping(from, async () => {
          const ctx = helpers.contextInfo(msg);
          const fakeMsg = {
            key: { remoteJid: from, id: ctx.stanzaId, fromMe: false },
            message: { imageMessage: img }
          };
          const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage
          });
          await sock.updateProfilePicture(from, buf);
          await helpers.reply(
            from,
            `${UIkit.box('PICTURE UPDATED', '🖼️')}

${UIkit.section('STATUS', '✅')}
${UIkit.row('Group', 'icon refreshed')}
${UIkit.row('Size', `${(buf.length / 1024).toFixed(1)} KB`)}`
          );
        });
        return;
      }

      helpers.fail(
        `❌ Unknown sub-command *${sub}*.\n` +
        `📖 Try: .setgroup name | desc | pic | info`
      );
    }
  },

  // ========================================================================
  // MODERATION
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
          `${UIkit.box('ANTILINK ON', '🛡️')}\n\n│ Action : ${state.antilinkAction.get(from) || 'delete'}`
        );
      } else if (sub === 'off') {
        state.antilinkGroups.delete(from);
        saveState();
        await helpers.reply(from, `${UIkit.box('ANTILINK OFF', '🚫')}`);
      } else if (sub === 'action') {
        const a = args[1];
        if (!['delete', 'warn', 'kick'].includes(a)) {
          helpers.fail('❌ Usage: .antilink action delete|warn|kick');
        }
        state.antilinkAction.set(from, a);
        saveState();
        await helpers.reply(from, `${UIkit.box('ANTILINK ACTION', '⚙️')}\n\n│ ${a}`);
      } else {
        const enabled = state.antilinkGroups.has(from);
        await helpers.reply(
          from,
          `${UIkit.pandaBanner('ANTILINK')}

${UIkit.section('STATUS', '🛡️')}
${UIkit.row('Enabled', enabled ? '✅ ON' : '❌ OFF')}
${UIkit.row('Action', state.antilinkAction.get(from) || 'delete')}

${UIkit.section('USAGE', '📖')}
│ .antilink on|off
│ .antilink action delete|warn|kick`
        );
      }
    }
  },
  {
    name: '.auto',
    admin: true,
    category: 'moderation',
    desc: 'Auto-correct messages in this chat',
    usage: '.auto on|off',
    handler: async ({ from, args }) => {
      if (args[0] === 'on') {
        state.autoCorrectEnabled.add(from);
        saveState();
        await helpers.reply(
          from,
          `${UIkit.box('AUTO-CORRECT ON', '✍️')}\n\nBot will reply with corrections.`
        );
      } else if (args[0] === 'off') {
        state.autoCorrectEnabled.delete(from);
        saveState();
        await helpers.reply(from, `${UIkit.box('AUTO-CORRECT OFF', '🚫')}`);
      } else {
        helpers.fail('Usage: .auto on|off');
      }
    }
  },
  {
    name: '.antimention',
    admin: true,
    category: 'moderation',
    desc: 'Block group mentions in chat',
    usage: '.antimention on|off | action warn|kick',
    handler: async ({ from, args }) => {
      helpers.requireGroup(from);
      const sub = args[0];
      if (sub === 'on') {
        state.antimentionGroups.add(from);
        saveState();
        await helpers.reply(
          from,
          `${UIkit.box('ANTI-MENTION ON', '🛡️')}\n\nAction: ${state.antimentionAction.get(from) || 'warn'}`
        );
      } else if (sub === 'off') {
        state.antimentionGroups.delete(from);
        saveState();
        await helpers.reply(from, `${UIkit.box('ANTI-MENTION OFF', '🚫')}`);
      } else if (sub === 'action') {
        const a = args[1];
        if (!['warn', 'kick'].includes(a)) helpers.fail('Usage: .antimention action warn|kick');
        state.antimentionAction.set(from, a);
        saveState();
        await helpers.reply(from, `${UIkit.box('ANTI-MENTION ACTION', '⚙️')}\n\n${a}`);
      } else {
        const enabled = state.antimentionGroups.has(from);
        await helpers.reply(
          from,
          `${UIkit.pandaBanner('ANTI-MENTION')}

${UIkit.section('STATUS', '🛡️')}
${UIkit.row('Enabled', enabled ? '✅ ON' : '❌ OFF')}
${UIkit.row('Action', state.antimentionAction.get(from) || 'warn')}

${UIkit.section('USAGE', '📖')}
│ .antimention on|off
│ .antimention action warn|kick`
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
          await helpers.reply(from, `${UIkit.box('REACTIONS GLOBAL ON', '😄')}`);
        } else {
          state.reactionsEnabled.add(from);
          state.reactionsDisabled.delete(from);
          saveState();
          await helpers.reply(from, `${UIkit.box('REACTIONS ON HERE', '😄')}`);
        }
      } else if (scope === 'off') {
        if (mode === 'global') {
          state.reactionsGlobal = false;
          saveState();
          await helpers.reply(from, `${UIkit.box('REACTIONS GLOBAL OFF', '🚫')}`);
        } else {
          state.reactionsDisabled.add(from);
          state.reactionsEnabled.delete(from);
          saveState();
          await helpers.reply(from, `${UIkit.box('REACTIONS OFF HERE', '🚫')}`);
        }
      } else {
        const local = state.reactionsEnabled.has(from)
          ? 'ON'
          : state.reactionsDisabled.has(from)
          ? 'OFF'
          : 'inherit';
        await helpers.reply(
          from,
          `${UIkit.pandaBanner('REACTIONS')}

${UIkit.section('STATUS', '📋')}
${UIkit.row('This chat', local)}
${UIkit.row('Global', state.reactionsGlobal ? 'ON' : 'OFF')}

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
        await helpers.reply(from, `${UIkit.pandaBanner('SCHEDULES')}\n\n${txt}`);
        return;
      }

      if (action === 'cancel') {
        state.schedules.delete(from);
        saveState();
        await helpers.reply(from, `${UIkit.box('SCHEDULE CLEARED', '🗑️')}`);
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
        `${UIkit.box('SCHEDULED', '🕒')}

${UIkit.section('JOB', '📅')}
${UIkit.row('Action', action.toUpperCase())}
${UIkit.row('At', when)}
${UIkit.row('Repeat', repeat === 'daily' ? 'daily' : 'once')}`
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
      const targetRaw = mentioned[0];
      const target = helpers.resolveJid(targetRaw) || targetRaw;
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
          await safeSend(from, {
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
        await safeSend(from, {
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
      const targetRaw = mentioned[0];
      const target = helpers.resolveJid(targetRaw) || targetRaw;
      const groupWarns = state.warnings.get(from) || {};
      const list = groupWarns[target] || [];
      await safeSend(from, {
        text: `${UIkit.box('WARNINGS', '📋')}\n\n@${target.split('@')[0]} has *${list.length}/3* warnings.\n\n${
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
      const targetRaw = mentioned[0];
      const target = helpers.resolveJid(targetRaw) || targetRaw;
      const groupWarns = state.warnings.get(from) || {};
      delete groupWarns[target];
      state.warnings.set(from, groupWarns);
      saveState();
      await safeSend(from, {
        text: `✅ Warnings cleared for @${target.split('@')[0]}.`,
        mentions: [target]
      });
    }
  },

  // ========================================================================
  // SPECIAL
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
        await helpers.reply(from, `${UIkit.box('VO CAPTURE', '📸')}\n\n│ Status : ✅ ON`);
      } else if (args[0] === 'off') {
        state.viewOnceEnabled = false;
        saveState();
        await helpers.reply(from, `${UIkit.box('VO CAPTURE', '📸')}\n\n│ Status : ❌ OFF`);
      } else {
        await helpers.reply(
          from,
          `${UIkit.box('VO CAPTURE', '📸')}\n\n│ Status : ${state.viewOnceEnabled ? '✅ ON' : '❌ OFF'}\n\nUsage: .vo on|off`
        );
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
        await helpers.reply(from, `${UIkit.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ✅ ON`);
      } else if (args[0] === 'off') {
        state.autoDownload = false;
        saveState();
        await helpers.reply(from, `${UIkit.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ❌ OFF`);
      } else {
        await helpers.reply(
          from,
          `${UIkit.box('AUTO-DOWNLOAD', '⬇️')}\n\n│ Status : ${state.autoDownload ? '✅ ON' : '❌ OFF'}\n\nUsage: .autodl on|off`
        );
      }
    }
  },
  {
    name: '.poststatus',
    admin: true,
    category: 'special',
    desc: 'Post the replied message to your WhatsApp status (auto-viewed + liked)',
    usage: '.poststatus (reply to a text / image / video)',
    handler: async ({ msg, from }) => {
      const quoted = helpers.quoted(msg);
      const ctx = helpers.contextInfo(msg);

      if (!quoted || !ctx) {
        await helpers.replyTyping(
          from,
          `${UIkit.pandaBanner('POST STATUS')}

Reply to a *text*, *image*, or *video* message with .poststatus to publish it to your WhatsApp status.

${UIkit.section('SUPPORTED', '✅')}
│ text
│ image
│ video

${UIkit.section('AUTO-ENGAGE', '❤️')}
│ 👁️  auto view after 3 minutes
│ 👁️  auto view after 5 minutes
│ ❤️  auto like after 5 minutes`
        );
        return;
      }

      const sender =
        helpers.resolveJid(ctx.participant || '') ||
        ctx.participant ||
        from;

      const reconstructed = {
        key: {
          remoteJid: from,
          id: ctx.stanzaId,
          fromMe: ctx.participant === state.botJid,
          participant: sender
        },
        message: quoted
      };

      try {
        const ok = await postToStatus(reconstructed);
        if (ok) {
          await helpers.replyTyping(
            from,
            `${UIkit.box('POSTED', '✅')}

${UIkit.section('LIVE', '📡')}
│ Visible on your status for 24h
│ 👁️  view at +3 min
│ 👁️  view at +5 min
│ ❤️  like at +5 min`
          );
        } else {
          await helpers.replyTyping(
            from,
            '❌ Unsupported content. Reply to a text, image, or video message.'
          );
        }
      } catch (e) {
        console.error('[poststatus]', e);
        await helpers.reply(from, `❌ Status post failed: ${e.message}`);
      }
    }
  }
];

// ============================================================================
// BUILD LOOKUP TABLES
// ============================================================================
const COMMAND_LOOKUP = new Map();
const ADMIN_TRIGGERS = new Set();

function buildLookup() {
  COMMAND_LOOKUP.clear();
  ADMIN_TRIGGERS.clear();

  for (const cmd of COMMANDS) {
    const triggers = [cmd.name, ...(cmd.aliases || [])];
    for (const t of triggers) {
      COMMAND_LOOKUP.set(t.toLowerCase(), cmd);
      if (cmd.admin) ADMIN_TRIGGERS.add(t.toLowerCase());
    }
  }

  console.log(`[handlers] lookup built with ${COMMAND_LOOKUP.size} trigger(s)`);
}

buildLookup();

try {
  engine.install({
    COMMANDS,
    helpers
  });
  buildLookup();
} catch (e) {
  console.error('[handlers] engine.install failed:', e.message);
}

// ============================================================================
// MENU BUILDER
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

  const ORDER = ['general','media','fun','tools','admin','pause','group','moderation','special'];

  const byCat = {};
  for (const cmd of COMMANDS) {
    if (!cmd.category) continue;
    (byCat[cmd.category] ||= []).push(cmd);
  }

  let menu = `${UIkit.pandaBanner('COMMAND CENTER')}

${UIkit.section('BOT INFO', 'ℹ️')}
${UIkit.row('Version', 'v1.0.0')}
${UIkit.row('Prefix',  '.  or  !')}
${UIkit.row('Uptime',  `${uptimeMin} min`)}
${UIkit.row('Admin',   ADMIN_NUMBER ? '+' + ADMIN_NUMBER : 'not set')}
`;

  for (const cat of ORDER) {
    const meta = CATEGORY_META[cat];
    const cmds = byCat[cat];
    if (!meta || !cmds?.length) continue;

    menu += `\n${UIkit.section(meta.title, meta.emoji)}\n`;
    for (const c of cmds) {
      menu += `│ ${c.name.padEnd(16, ' ')} ${c.desc || ''}\n`;
    }
  }

  menu += `\n${UIkit.divider}\n  🐼  _PANDA • powered by Fanuels DX_`;
  return menu;
}

// ============================================================================
// COMMAND ROUTER
// ============================================================================
async function handleCommand(msg, from, senderJid, rawText) {
  const sockInstance = state.sock;
  if (!sockInstance) {
    console.log('[cmd] dropped — no socket');
    return;
  }

  const text = rawText.trim();
  if (!engine.isCommand(text)) return;

  const parts = text.split(' ');
  const base = parts[0].toLowerCase();
  const args = parts.slice(1);

  const admin = isAdmin(senderJid);
  const isGroup = from.endsWith('@g.us');

  const command = COMMAND_LOOKUP.get(base);
  if (!command) {
    if (base.startsWith('.')) {
      await withTyping(from, () =>
        safeSend(from, {
          text: `${UIkit.box('UNKNOWN', '❓')}\n\nCommand *${base}* not found.\nType *.help* to see the menu.`
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

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  tryCaptureViewOnce,
  postToStatus,
  sendWelcome,
  sendGoodbye,
  handleCommand,
  resolveSenderJid,
  helpers,
  COMMANDS,
  preCommandHooks,
  renderTextSticker,
  buildLookup,
  // 🔥 expose status-engagement internals for testing / external triggers
  scheduleStatusEngagement,
  cancelStatusEngagement,
  viewStatus,
  likeStatus
};