// lib/helpers.js
export const MEDIA_TYPES = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage',
]

/**
 * Returns a message object that downloadMediaMessage() can consume —
 * either the original message, or a reconstructed one for a quoted reply.
 * Also unwraps view-once wrappers so .vv / .sticker / .toimg work on them.
 */
export function resolveMediaMessage(msg, chatId) {
  const m = msg.message ?? {}

  // 1. Direct view-once wrapper on the current message
  const viewOnce =
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message
  if (viewOnce) return { key: msg.key, message: viewOnce }

  // 2. Normal top-level media
  for (const t of MEDIA_TYPES) if (m[t]) return msg

  // 3. Quoted media
  const ci =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo

  if (ci?.quotedMessage) {
    const q = ci.quotedMessage

    // 3a. Quoted view-once
    const qViewOnce =
      q.viewOnceMessage?.message ||
      q.viewOnceMessageV2?.message ||
      q.viewOnceMessageV2Extension?.message

    const key = {
      remoteJid: chatId,
      id: ci.stanzaId,
      participant: ci.participant,
    }

    if (qViewOnce) return { key, message: qViewOnce }

    // 3b. Quoted normal media
    for (const t of MEDIA_TYPES) if (q[t]) return { key, message: q }
  }

  return null
}

/** Pull the first mentioned JID, or the replied-to sender. */
export function getTarget(msg) {
  const ci = msg.message?.extendedTextMessage?.contextInfo
  return ci?.participant ?? ci?.mentionedJid?.[0] ?? null
}

/** Strip everything but digits (for phone-number inputs). */
export const onlyDigits = (s = '') => s.replace(/\D/g, '')