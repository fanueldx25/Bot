// bot.js
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  jidNormalizedUser,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import config from './config.js'
import { loadCommands } from './loader.js'
import { usePostgresAuthState, Sessions } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const logger = pino({ level: 'silent' })

let COMMANDS = null
export async function bootstrapCommands() {
  COMMANDS = await loadCommands(path.join(__dirname, 'commands'))
  console.log(`📦 Loaded ${COMMANDS.size} command aliases`)
}

const activeBots = new Map()
const sentIds = new Map() // sessionId -> Set<msgId>

function markSent(sessionId, key) {
  if (!key?.id) return
  let s = sentIds.get(sessionId)
  if (!s) { s = new Set(); sentIds.set(sessionId, s) }
  s.add(key.id)
  if (s.size > 500) {
    const arr = [...s]
    sentIds.set(sessionId, new Set(arr.slice(arr.length - 250)))
  }
}
function wasSentByUs(sessionId, id) {
  return sentIds.get(sessionId)?.has(id) ?? false
}

function extractBody(msg) {
  const m = msg.message ?? {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  )
}

/** Strip a JID of any decoration, leaving only digits. */
const digits = (jid = '') =>
  String(jid).split('@')[0].split(':')[0].replace(/\D/g, '')

/** Default presence for a command if it doesn't declare one. */
const DEFAULT_PRESENCE = 'composing'

/**
 * Show the right presence + blue ticks for a command, run it,
 * then clear presence. Never throws — presence errors are logged and ignored.
 */
async function withPresence(sock, chatId, key, cmd, fn) {
  const presence = cmd?.presence ?? DEFAULT_PRESENCE

  // 1. Mark the incoming message as read (blue ticks).
  try {
    await sock.readMessages([key])
  } catch (e) {
    console.error('[read]', e?.message ?? e)
  }

  // 2. Subscribe presence for the duration of the command.
  try {
    if (presence === 'recording') {
      await sock.sendPresenceUpdate('recording', chatId)
    } else if (presence === 'composing') {
      await sock.sendPresenceUpdate('composing', chatId)
    } else if (presence === 'paused') {
      await sock.sendPresenceUpdate('paused', chatId)
    } else if (presence !== 'none') {
      await sock.sendPresenceUpdate(presence, chatId)
    }
  } catch (e) {
    console.error('[presence]', e?.message ?? e)
  }

  try {
    return await fn()
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', chatId)
    } catch {}
  }
}

export async function startBot(sessionId, { onPairingCode } = {}) {
  if (activeBots.has(sessionId)) return activeBots.get(sessionId)

  const session = await Sessions.getById(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const { state, saveCreds } = await usePostgresAuthState(sessionId)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
  })

  activeBots.set(sessionId, sock)

  let runtime = {
    mode: session.mode ?? config.defaults.mode,
    selfMode: session.self_mode ?? config.defaults.selfMode,
  }
  const refreshRuntime = async () => {
    const s = await Sessions.getById(sessionId)
    runtime = {
      mode: s.mode ?? config.defaults.mode,
      selfMode: s.self_mode ?? config.defaults.selfMode,
    }
  }
  const runtimeTimer = setInterval(refreshRuntime, 15_000)
  runtimeTimer.unref?.()

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    if (state.creds.registered && session.status !== 'connected') {
      await Sessions.setStatus(sessionId, 'connected')
    }
  })

  if (!state.creds.registered) {
    if (typeof onPairingCode !== 'function') {
      throw new Error('onPairingCode callback required for new sessions')
    }
    const phone = session.phone_number.replace(/\D/g, '')
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone)
        onPairingCode(code)
      } catch (e) {
        console.error('[pairing]', e)
        onPairingCode(null, e)
      }
    }, 3000)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      await Sessions.setStatus(sessionId, 'connected')
      console.log(`✅ Session ${sessionId} online`)
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      activeBots.delete(sessionId)
      if (code === DisconnectReason.loggedOut) {
        await Sessions.setStatus(sessionId, 'logged_out')
        console.log(`❌ Session ${sessionId} logged out`)
      } else {
        console.log(`🔄 Session ${sessionId} reconnecting…`)
        setTimeout(() => startBot(sessionId).catch(console.error), 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message) return

    const chatId = msg.key.remoteJid
    if (chatId === 'status@broadcast') return
    if (wasSentByUs(sessionId, msg.key.id)) return

    const body = extractBody(msg)
    if (!body) return

    const isGroup  = chatId.endsWith('@g.us')
    const fromMe   = !!msg.key.fromMe
    const senderJid = jidNormalizedUser(msg.key.participant || msg.key.remoteJid)
    const senderDigits = digits(senderJid)

    const botDigits  = digits(sock.user?.id)
    const chatDigits = digits(chatId)
    const isSelfChat = fromMe && (chatDigits === botDigits || chatId.endsWith('@lid'))

    const isOwner =
      config.ownerNumbers.some((n) => digits(n) === senderDigits) ||
      (isSelfChat && fromMe)

    if (process.env.DEBUG_SELF === '1') {
      console.log('[self-check]', {
        fromMe, chatId, senderJid, senderDigits, botDigits,
        isSelfChat, isOwner, selfMode: runtime.selfMode, mode: runtime.mode,
      })
    }

    if (fromMe && !isSelfChat) return
    if (isSelfChat && !runtime.selfMode) return
    if (runtime.mode === 'private' && !isOwner) return

    const botJidFull = jidNormalizedUser(sock.user?.id ?? '')
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
      ?.includes(botJidFull)

    // ── Non-command path ──────────────────────────────────────────
    // If the message is not a command (and not a mention in public mode),
    // we do NOTHING — no read, no presence. The message stays unread.
    if (!body.startsWith(config.prefix)) {
      if (mentioned && runtime.mode === 'public') {
        const aiCmd = COMMANDS.get('ai')
        if (aiCmd) {
          const ctx = buildCtx({
            sock, msg, chatId, sender: senderJid, isGroup,
            args: body.split(/\s+/), text: body, command: 'ai',
            prefix: config.prefix, commands: COMMANDS,
            sessionId, markSent,
          })
          try {
            await withPresence(sock, chatId, msg.key, aiCmd, () => aiCmd.run(ctx))
          } catch (e) {
            console.error('[ai-mention]', e)
          }
        }
      }
      return
    }

    // ── Command path ──────────────────────────────────────────────
    const [rawName, ...args] = body
      .slice(config.prefix.length)
      .trim()
      .split(/\s+/)
    const cmd = COMMANDS.get(rawName.toLowerCase())

    // Unknown command → treat like a normal message (leave unread).
    if (!cmd) return

    if (cmd.ownerOnly && !isOwner) return
    if (cmd.groupOnly && !isGroup) return
    if (cmd.adminOnly && isGroup) {
      // Admin check happens *after* presence so the user sees the bot
      // at least react; swap the two if you'd rather stay silent.
      try {
        const meta = await sock.groupMetadata(chatId)
        const me = meta.participants.find((p) => p.id === senderJid)
        if (!me?.admin) {
          await sock.sendMessage(chatId, { text: '🚫 Admins only.' }, { quoted: msg })
          markSent(sessionId, (await sock.sendMessage(
            chatId, { text: '🚫 Admins only.' }, { quoted: msg },
          ))?.key)
          return
        }
      } catch { return }
    }

    const ctx = buildCtx({
      sock, msg, chatId, sender: senderJid, isGroup, args,
      text: args.join(' '), command: cmd.name,
      prefix: config.prefix, commands: COMMANDS,
      sessionId, markSent,
    })

    try {
      await withPresence(sock, chatId, msg.key, cmd, () => cmd.run(ctx))
    } catch (err) {
      console.error(`[${cmd.name}]`, err)
      try { await ctx.reply(`⚠️ *Error:* ${err.message}`) } catch {}
    }
  })

  return sock
}

function buildCtx({
  sock, msg, chatId, sender, isGroup, args, text, command,
  prefix, commands, sessionId, markSent,
}) {
  return {
    sock, msg, chatId, sender, isGroup, args, text, command,
    prefix, commands,
    config,
    sessionId,

    reply: async (content, opts = {}) => {
      const sent = await sock.sendMessage(
        chatId,
        typeof content === 'string' ? { text: content } : content,
        { quoted: msg, ...opts },
      )
      markSent(sessionId, sent?.key)
      return sent
    },

    send: async (content, opts = {}) => {
      const sent = await sock.sendMessage(chatId, content, opts)
      markSent(sessionId, sent?.key)
      return sent
    },

    react: (emoji) =>
      sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }),

    download: (target = msg) =>
      downloadMediaMessage(target, 'buffer', {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      }),

    /** Expose presence helper so individual commands can override. */
    presence: (kind) => sock.sendPresenceUpdate(kind, chatId),
    read: () => sock.readMessages([msg.key]),
  }
}

export async function stopBot(sessionId) {
  const sock = activeBots.get(sessionId)
  if (sock) {
    try { await sock.logout() } catch {}
    activeBots.delete(sessionId)
    sentIds.delete(sessionId)
  }
}

export function isActive(sessionId) {
  return activeBots.has(sessionId)
}