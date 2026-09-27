// ============================================================================
// engine.js — extra command engine for the WhatsApp bot
// ============================================================================
// Responsibilities:
//   1. AUTO-REGISTER: on the first message from a chat, save the sender's
//      LID → phone mapping (when Baileys gives us one) and mark the chat as
//      "known". IMPORTANT: this NEVER blocks message handling. It only
//      learns. If we don't yet know the sender's phone JID, we still let the
//      message flow through the normal router — the phone JID arrives on a
//      later message or via the LID map.
//   2. SECOND PREFIX: accept '!' in addition to '.', so users can type
//      !help, !ping, etc. Both prefixes route to the same command table.
//   3. DOCUMENT → PDF: !topdf (reply to any media/document → sends PDF back)
//      !format (reply to a document → re-sends it with normalized filename,
//      and optionally converts to PDF if it's a text file)
//   4. MEMBER MANAGEMENT: !add <phone> — adds a phone number to the current
//      group; !remove @user — removes a mentioned user from the group.
//   5. RATE LIMIT: sliding window per (chat, user). 5 commands / 10 seconds.
//      Over-limit sends a single warning and drops the command for the rest
//      of the window. Users with an unresolved JID are bucketed under a
//      stable chat-level key so they still get rate-limited, not bypassed.
//
// The module is installed by handlers.js via engine.install(...) — it does not
// require handlers.js back (avoids circular import).
// ============================================================================

const state = require('./state');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PREFIXES = ['.', '!'];       // '.' keeps working; '!' is the new one

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 5;          // commands per window per user per chat

// Track who we've already auto-registered so we only log once per chat.
const seenChats = new Set();

// Rate-limit buckets: key = `${chat}:${user}` → { count, resetAt }
const rateBuckets = new Map();

// Sweep stale buckets periodically so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (b.resetAt <= now) rateBuckets.delete(k);
  }
}, 30_000).unref();

// ---------------------------------------------------------------------------
// Safe require of connection.js (avoids circular import at load time).
// connection.js does NOT require engine.js, so this is one-way. We lazy-load
// inside the functions that need safeSend / rememberMessage so engine.js can
// still be required in isolation for tests.
// ---------------------------------------------------------------------------
function getConnection() {
  try {
    return require('./connection');
  } catch (_) {
    return null;
  }
}

// ============================================================================
// PREFIX HELPERS
// ============================================================================
function isCommand(text) {
  if (!text || typeof text !== 'string') return false;
  return PREFIXES.some((p) => text.startsWith(p));
}

function stripPrefix(text) {
  if (!text) return text;
  for (const p of PREFIXES) {
    if (text.startsWith(p)) return text.slice(p.length);
  }
  return text;
}

// ============================================================================
// RATE LIMITER
// ============================================================================
// If `user` is falsy or resolves to a `@lid`, bucket under the chat only so
// the user still gets rate-limited (instead of getting a fresh bucket for
// every message because the key keeps changing).
function rateKey(chat, user) {
  const u = user && typeof user === 'string' ? user.split('@')[0].split(':')[0] : 'anon';
  return `${chat}:${u}`;
}

function checkRate(chat, user) {
  const key = rateKey(chat, user);
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(key, b);
  }
  b.count++;
  if (b.count > RATE_LIMIT_MAX) {
    return { ok: false, retryInSec: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true };
}

// ============================================================================
// AUTO-REGISTER  (NEVER blocks message handling)
// ============================================================================
// Called by handlers.js for every incoming message, BEFORE the command
// router. It only learns. It returns a diagnostic object — do NOT gate
// command execution on `.known`.
//
// Returns:
//   {
//     known: boolean,        // diagnostic only — did we have a phone JID?
//     registered: boolean,   // true the very first time we see this chat
//     senderJid: string,     // best-effort JID (never null for a valid msg)
//   }
// ============================================================================
function autoRegister(msg, from, senderJid) {
  const result = { known: false, registered: false, senderJid };

  // ---- 1) Try to capture the LID → phone mapping from whatever Baileys gave us.
  try {
    const lidJid = msg.key?.remoteJid || '';
    const pnJid =
      msg.key?.senderPn ||
      msg.key?.participantPn ||
      msg.key?.remoteJidAlt ||
      msg.key?.participantAlt;

    if (
      lidJid.endsWith('@lid') &&
      pnJid &&
      pnJid.endsWith('@s.whatsapp.net') &&
      typeof state.registerLidMapping === 'function'
    ) {
      state.registerLidMapping(lidJid, pnJid);
      result.senderJid = pnJid;
      result.known = true;
    }
  } catch (_) { /* silent */ }

  // ---- 2) If the passed-in senderJid is already a phone JID, we're known.
  if (!result.known && senderJid && senderJid.endsWith('@s.whatsapp.net')) {
    result.known = true;
    result.senderJid = senderJid;
  }

  // ---- 3) If it's an @lid, try the map.
  if (
    !result.known &&
    senderJid &&
    senderJid.endsWith('@lid') &&
    typeof state.resolveLid === 'function'
  ) {
    try {
      const num = senderJid.split('@')[0].split(':')[0];
      const pn = state.resolveLid(num);
      if (pn) {
        result.senderJid = `${pn}@s.whatsapp.net`;
        result.known = true;
      }
    } catch (_) { /* silent */ }
  }

  // ---- 4) Absolute fallback: never return an empty senderJid for a valid msg.
  if (!result.senderJid) result.senderJid = from || null;

  // ---- 5) First-contact logging (once per chat).
  const chatKey = from || result.senderJid;
  if (chatKey && !seenChats.has(chatKey)) {
    seenChats.add(chatKey);
    result.registered = true;
    console.log(
      `[engine] first contact — chat=${chatKey} user=${result.senderJid || 'unknown'} known=${result.known}`
    );
  }

  return result;
}

// Expose the seen set for diagnostics (handlers.js may want to inspect).
function getRegistered() {
  return Array.from(seenChats);
}

// ============================================================================
// DOCUMENT / PDF HELPERS
// ============================================================================
// Convert text into a minimal valid PDF (Helvetica, one or more pages,
// wrapped lines). No external deps. Works in any PDF reader.
// Non-text documents are NOT converted — see !topdf handler.
// ---------------------------------------------------------------------------
async function textToPdfBuffer(title, body) {
  const escape = (s) =>
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');

  const MAX_LINE = 90;
  const rawLines = String(body).split(/\r?\n/);
  const lines = [];
  for (const l of rawLines) {
    if (l.length <= MAX_LINE) {
      lines.push(l);
    } else {
      for (let i = 0; i < l.length; i += MAX_LINE) {
        lines.push(l.slice(i, i + MAX_LINE));
      }
    }
  }

  const FONT_SIZE = 11;
  const LEADING = 15;
  const TOP_Y = 780;
  const MAX_LINES_PER_PAGE = Math.floor((TOP_Y - 40) / LEADING);

  const pages = [];
  for (let i = 0; i < lines.length; i += MAX_LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + MAX_LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push(['']);

  const objects = [];
  const addObj = (s) => {
    objects.push(s);
    return objects.length;
  };

  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = [];
  for (const pageLines of pages) {
    let content = `BT\n/F1 ${FONT_SIZE} Tf\n${LEADING} TL\n40 ${TOP_Y} Td\n`;
    for (const line of pageLines) {
      content += `(${escape(line)}) Tj T*\n`;
    }
    content += 'ET';

    const contentId = addObj(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
    );

    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
    `/Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

// ---------------------------------------------------------------------------
// Download a document from a quoted/replied message.
// Uses the modern Baileys `reuploadRequest` signature so E2EE retries work.
// ---------------------------------------------------------------------------
async function downloadQuotedDocument(quoted, from, ctxStanzaId) {
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  const pino = require('pino');

  const fakeMsg = {
    key: { remoteJid: from, id: ctxStanzaId, fromMe: false },
    message: { documentMessage: quoted.documentMessage }
  };

  const reuploadRequest =
    state.sock && typeof state.sock.updateMediaMessage === 'function'
      ? state.sock.updateMediaMessage.bind(state.sock)
      : undefined;

  return downloadMediaMessage(
    fakeMsg,
    'buffer',
    {},
    {
      logger: pino({ level: 'silent' }),
      reuploadRequest
    }
  );
}

// ---------------------------------------------------------------------------
// Send helper that prefers connection.safeSend (retries transient E2EE
// errors) and caches the outgoing message for Baileys retry receipts.
// Falls back to state.sock.sendMessage if connection.js isn't loadable.
// ---------------------------------------------------------------------------
async function send(from, content, options = {}) {
  const conn = getConnection();
  const sendFn =
    (conn && typeof conn.safeSend === 'function' && conn.safeSend) ||
    (state.sock && state.sock.sendMessage.bind(state.sock));

  if (!sendFn) throw new Error('No socket available to send');

  const sent = await sendFn(from, content, options);
  if (conn && typeof conn.rememberMessage === 'function') {
    try { conn.rememberMessage(sent); } catch (_) { /* silent */ }
  }
  return sent;
}

// ============================================================================
// ENGINE INSTALL
// ============================================================================
function install(handlers) {
  if (!handlers || !handlers.COMMANDS) {
    throw new Error('[engine] install() requires the handlers module');
  }
  const { COMMANDS, helpers } = handlers;

  // ---- Idempotence: don't push twice if install() is called more than once.
  const already = new Set(COMMANDS.map((c) => c.name));
  const EXTRA = [];

  // -------------------------------------------------------------------------
  // DOCUMENT → PDF
  // -------------------------------------------------------------------------
  if (!already.has('!topdf')) {
    EXTRA.push({
      name: '!topdf',
      aliases: ['!pdf'],
      category: 'tools',
      desc: 'Convert a replied doc/text to PDF',
      usage: '!topdf (reply to a document or text)',
      handler: async ({ msg, from }) => {
        const quoted = helpers.quoted(msg);
        if (!quoted) {
          helpers.fail('❌ Reply to a message (text or document) with !topdf.');
          return;
        }

        const inner = quoted.ephemeralMessage?.message || quoted;
        const docMsg = inner.documentMessage;
        const textMsg =
          inner.conversation || inner.extendedTextMessage?.text || null;

        let pdfBuffer;
        let baseName;

        if (docMsg) {
          if ((docMsg.mimetype || '').includes('pdf')) {
            await helpers.reply(from, '📄 That file is already a PDF.');
            return;
          }

          const fname = docMsg.fileName || 'document';
          const isText =
            (docMsg.mimetype || '').startsWith('text/') ||
            /\.(txt|md|csv|json|log)$/i.test(fname);

          if (!isText) {
            helpers.fail('❌ Only text-based documents can be converted to PDF right now.');
            return;
          }

          const ctx = helpers.contextInfo(msg);
          const raw = await downloadQuotedDocument(inner, from, ctx.stanzaId);
          pdfBuffer = await textToPdfBuffer(fname, raw.toString('utf8'));
          baseName = fname.replace(/\.[^.]+$/, '') + '.pdf';
        } else if (textMsg) {
          pdfBuffer = await textToPdfBuffer('Message', textMsg);
          baseName = `message-${Date.now()}.pdf`;
        } else {
          helpers.fail('❌ Reply to a text message or a .txt document.');
          return;
        }

        await send(from, {
          document: pdfBuffer,
          mimetype: 'application/pdf',
          fileName: baseName
        });
      }
    });
  }

  if (!already.has('!format')) {
    EXTRA.push({
      name: '!format',
      aliases: [],
      category: 'tools',
      desc: 'Format a replied document (normalize name, option to convert)',
      usage: '!format [pdf] (reply to a document)',
      handler: async ({ msg, from, args }) => {
        const quoted = helpers.quoted(msg);
        if (!quoted) {
          helpers.fail('❌ Reply to a document with !format.');
          return;
        }

        const inner = quoted.ephemeralMessage?.message || quoted;
        const docMsg = inner.documentMessage;
        if (!docMsg) {
          helpers.fail('❌ Not a document message.');
          return;
        }

        const wantPdf = (args[0] || '').toLowerCase() === 'pdf';

        const ctx = helpers.contextInfo(msg);
        const raw = await downloadQuotedDocument(inner, from, ctx.stanzaId);

        const original = docMsg.fileName || 'document';
        const safeName = original
          .replace(/[^\w.\-]+/g, '_')
          .replace(/_+/g, '_')
          .slice(0, 80);

        if (wantPdf) {
          const isText =
            (docMsg.mimetype || '').startsWith('text/') ||
            /\.(txt|md|csv|json|log)$/i.test(original);
          if (!isText) {
            helpers.fail('❌ Only text documents can be converted via !format pdf.');
            return;
          }
          const pdfBuffer = await textToPdfBuffer(original, raw.toString('utf8'));
          const newName = safeName.replace(/\.[^.]+$/, '') + '.pdf';
          await send(from, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: newName
          });
          return;
        }

        await send(from, {
          document: raw,
          mimetype: docMsg.mimetype || 'application/octet-stream',
          fileName: safeName
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // GROUP MEMBER MANAGEMENT
  // -------------------------------------------------------------------------
  if (!already.has('!add')) {
    EXTRA.push({
      name: '!add',
      aliases: ['!addmember', '!invite'],
      admin: true,
      category: 'group',
      desc: 'Add a phone number to this group',
      usage: '!add <phone-digits> (must be in a group)',
      handler: async ({ from, args }) => {
        helpers.requireGroup(from);
        const phone = (args[0] || '').replace(/\D/g, '');
        if (!phone || phone.length < 10) {
          helpers.fail('❌ Usage: !add <phone-digits>  (e.g. !add 237651858408)');
          return;
        }
        const jid = `${phone}@s.whatsapp.net`;
        try {
          const res = await state.sock.groupParticipantsUpdate(from, [jid], 'add');
          const status =
            Array.isArray(res) && res[0]?.status ? res[0].status : 'unknown';

          if (status === '403') {
            helpers.fail('❌ Cannot add: their privacy settings require an invite link.');
          } else if (status === '409') {
            await helpers.reply(from, `ℹ️ +${phone} is already a member.`);
          } else if (status === '200') {
            await helpers.reply(from, `✅ Added +${phone}`);
          } else {
            await helpers.reply(from, `📨 Add request sent for +${phone} (status ${status}).`);
          }
        } catch (e) {
          console.error('[engine !add]', e.message);
          helpers.fail('❌ Could not add. Make sure the bot is an admin in this group.');
        }
      }
    });
  }

  if (!already.has('!remove')) {
    EXTRA.push({
      name: '!remove',
      aliases: ['!rm'],
      admin: true,
      category: 'group',
      desc: 'Remove a mentioned user from this group',
      usage: '!remove @user (must be in a group)',
      handler: async ({ msg, from }) => {
        helpers.requireGroup(from);

        const mentioned = helpers.mentions(msg);
        if (!mentioned.length) {
          const text = msg.message?.extendedTextMessage?.text || '';
          const m = text.match(/(\d{10,15})/);
          if (m) {
            const jid = `${m[1]}@s.whatsapp.net`;
            await state.sock.groupParticipantsUpdate(from, [jid], 'remove');
            await helpers.reply(from, `✅ Removed +${m[1]}`);
            return;
          }
          helpers.fail('❌ Usage: !remove @user  (or !remove <phone-digits>)');
          return;
        }

        const resolved = mentioned
          .map((j) => helpers.resolveJid(j))
          .filter(Boolean);
        if (!resolved.length) {
          helpers.fail('❌ Cannot resolve the mentioned user — add their LID to LID_MAP.');
          return;
        }
        await state.sock.groupParticipantsUpdate(from, resolved, 'remove');
        await helpers.reply(from, `✅ Removed ${resolved.length} member(s).`);
      }
    });
  }

  for (const cmd of EXTRA) {
    COMMANDS.push(cmd);
  }

  console.log(
    `[engine] installed ${EXTRA.length} command(s): ${EXTRA.map((c) => c.name).join(', ') || '(none new)'}`
  );

  return {
    autoRegister,
    checkRate,
    isCommand,
    stripPrefix,
    PREFIXES,
    textToPdfBuffer
  };
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  install,
  PREFIXES,
  isCommand,
  stripPrefix,
  autoRegister,
  getRegistered,
  checkRate,
  textToPdfBuffer,
  send
};