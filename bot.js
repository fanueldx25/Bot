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

/* Track IDs of messages we've sent so self-mode doesn't loop. */
const sentIds = new Map() // sessionId -> Set<msgId>
function markSent(sessionId, key) {
  if (!key?.id) return
  let s = sentIds.get(sessionId)
  if (!s) { s = new Set(); sentIds.set(sessionId, s) }
  s.add(key.id)
  if (s.size > 500) {
    // keep the set small — drop the oldest half
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

  /* Session config cached in memory — refreshed when dashboard changes it. */
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
  setInterval(refreshRuntime, 15_000).unref?.()

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

  /* ────────────────────────────────────────────────────────── */
  /*  Router                                                     */
  /* ────────────────────────────────────────────────────────── */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg?.message) return

    const chatId = msg.key.remoteJid
    if (chatId === 'status@broadcast') return

    /* Loop protection: never process a message we ourselves just sent. */
    if (wasSentByUs(sessionId, msg.key.id)) return

    const body = extractBody(msg)
    if (!body) return

    const isGroup = chatId.endsWith('@g.us')
    const fromMe = !!msg.key.fromMe
    const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid)
    const botJid = jidNormalizedUser(sock.user?.id ?? '')
    const isOwner = config.ownerNumbers.includes(sender)

    /* ── Self-mode gate ─────────────────────────────────────
       When fromMe is true it's the bot's own phone sending.
       Two legitimate cases:
         (a) self-chat  — you message your own number
         (b) sent from linked phone into another chat
       We only accept (a) when selfMode is on.                   */
    const isSelfChat = fromMe && chatId === botJid
    if (fromMe && !isSelfChat) return
    if (isSelfChat && !runtime.selfMode) return

    /* ── Public / Private gate ──────────────────────────────
       private : only the owner can command the bot, from DMs or self-chat
       public  : anyone in a group/DM can command it                    */
    if (runtime.mode === 'private' && !isOwner && !isSelfChat) {
      // still allow mentions of the bot inside groups? No — strict private.
      return
    }

    /* Ignore non-commands unless the bot was @mentioned in a group.
       (Mentioned messages are handed to the AI as free-text prompts.) */
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
      ?.includes(botJid)

    if (!body.startsWith(config.prefix)) {
      if (mentioned && runtime.mode === 'public') {
        // delegate to AI free-chat
        const aiCmd = COMMANDS.get('ai')
        if (aiCmd) {
          const ctx = buildCtx({
            sock, msg, chatId, sender, isGroup, args: body.split(/\s+/),
            text: body, command: 'ai', prefix: config.prefix,
            commands: COMMANDS, sessionId, markSent,
          })
          try { await aiCmd.run(ctx) } catch (e) { console.error('[ai-mention]', e) }
        }
      }
      return
    }

    const [rawName, ...args] = body
      .slice(config.prefix.length)
      .trim()
      .split(/\s+/)
    const cmd = COMMANDS.get(rawName.toLowerCase())
    if (!cmd) return

    /* Permission gates */
    if (cmd.ownerOnly && !isOwner) return
    if (cmd.groupOnly && !isGroup) return
    if (cmd.adminOnly && isGroup) {
      try {
        const meta = await sock.groupMetadata(chatId)
        const me = meta.participants.find((p) => p.id === sender)
        if (!me?.admin) {
          return sendAndMark(sock, sessionId, chatId,
            { text: '🚫 Admins only.' }, { quoted: msg })
        }
      } catch { return }
    }

    const ctx = buildCtx({
      sock, msg, chatId, sender, isGroup, args,
      text: args.join(' '), command: cmd.name,
      prefix: config.prefix, commands: COMMANDS,
      sessionId, markSent,
    })

    try {
      await cmd.run(ctx)
    } catch (err) {
      console.error(`[${cmd.name}]`, err)
      try {
        await ctx.reply(`⚠️ *Error:* ${err.message}`)
      } catch {}
    }
  })

  return sock
}

/* ────────────────────────────────────────────────────────── */
/*  Helpers                                                    */
/* ────────────────────────────────────────────────────────── */
async function sendAndMark(sock, sessionId, chatId, content, opts = {}) {
  const sent = await sock.sendMessage(chatId, content, opts)
  markSent(sessionId, sent?.key)
  return sent
}

function buildCtx({
  sock, msg, chatId, sender, isGroup, args, text, command,
  prefix, commands, sessionId, markSent,
}) {
  return {
    sock, msg, chatId, sender, isGroup, args, text, command,
    prefix, commands,

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