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
    const sender   = jidNormalizedUser(msg.key.participant || msg.key.remoteJid)
    const botJid   = jidNormalizedUser(sock.user?.id ?? '')

    // Normalize both sides; strip :device suffix from both.
    const chatIdNorm = jidNormalizedUser(chatId)
    const botPhone   = botJid.split('@')[0].split(':')[0]
    const chatPhone  = chatId.split('@')[0].split(':')[0]
    const isSelfChat = fromMe && (chatIdNorm === botJid || chatPhone === botPhone)

    const isOwner = config.ownerNumbers.includes(sender)

    if (process.env.DEBUG_SELF === '1') {
      console.log('[self-check]', {
        fromMe, chatId, chatIdNorm, botJid, chatPhone, botPhone,
        isSelfChat, selfMode: runtime.selfMode, mode: runtime.mode,
      })
    }

    if (fromMe && !isSelfChat) return
    if (isSelfChat && !runtime.selfMode) return
    if (runtime.mode === 'private' && !isOwner && !isSelfChat) return

    const botJidFull = jidNormalizedUser(sock.user?.id ?? '')
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
      ?.includes(botJidFull)

    if (!body.startsWith(config.prefix)) {
      if (mentioned && runtime.mode === 'public') {
        const aiCmd = COMMANDS.get('ai')
        if (aiCmd) {
          const ctx = buildCtx({
            sock, msg, chatId, sender, isGroup,
            args: body.split(/\s+/), text: body, command: 'ai',
            prefix: config.prefix, commands: COMMANDS,
            sessionId, markSent,
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

    if (cmd.ownerOnly && !isOwner) return
    if (cmd.groupOnly && !isGroup) return
    if (cmd.adminOnly && isGroup) {
      try {
        const meta = await sock.groupMetadata(chatId)
        const me = meta.participants.find((p) => p.id === sender)
        if (!me?.admin) {
          const sent = await sock.sendMessage(chatId, { text: '🚫 Admins only.' }, { quoted: msg })
          markSent(sessionId, sent?.key)
          return
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
    config,                // ← critical: commands access config.botName etc.
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