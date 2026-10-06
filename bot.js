import makeWASocket, {
  useMultiFileAuthState,
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

/* sessionId -> sock */
const activeBots = new Map()

/* ------------------------------------------------------------------ */
/*  Body extraction                                                    */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/*  Create / connect one bot instance                                  */
/* ------------------------------------------------------------------ */
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

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    if (state.creds.registered && session.status !== 'connected') {
      await Sessions.setStatus(sessionId, 'connected')
    }
  })

  /* If not registered yet, request a pairing code */
  if (!state.creds.registered) {
    if (typeof onPairingCode !== 'function') {
      throw new Error('onPairingCode callback required for new sessions')
    }
    const phone = session.phone_number.replace(/\D/g, '')
    // small delay — Baileys needs the socket to have connected to WA first
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

  /* ---------------------------------------------------------------- */
  /*  Message router                                                   */
  /* ---------------------------------------------------------------- */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    if (chatId === 'status@broadcast') return

    const body = extractBody(msg)

    /* Optional: AI auto-reply on mention in groups, or any DM */
    const isGroup = chatId.endsWith('@g.us')
    const sender = jidNormalizedUser(msg.key.participant || chatId)
    const mentioned =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(
        jidNormalizedUser(sock.user?.id),
      )

    if (!body.startsWith(config.prefix)) {
      if (mentioned || !isGroup) {
        // Let commands/ai.js handle if you want; for now, ignore
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
    if (cmd.ownerOnly && !config.ownerNumbers.includes(sender)) return
    if (cmd.groupOnly && !isGroup) return
    if (cmd.adminOnly && isGroup) {
      try {
        const meta = await sock.groupMetadata(chatId)
        const me = meta.participants.find((p) => p.id === sender)
        if (!me?.admin) {
          return sock.sendMessage(chatId, { text: '🚫 Admins only.' }, { quoted: msg })
        }
      } catch {
        return
      }
    }

    const ctx = {
      sock,
      msg,
      chatId,
      sender,
      isGroup,
      args,
      text: args.join(' '),
      command: cmd.name,
      prefix: config.prefix,
      config,
      commands: COMMANDS,

      reply: (content, opts = {}) =>
        sock.sendMessage(
          chatId,
          typeof content === 'string' ? { text: content } : content,
          { quoted: msg, ...opts },
        ),

      react: (emoji) =>
        sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }),

      download: (target = msg) =>
        downloadMediaMessage(target, 'buffer', {}, {
          logger,
          reuploadRequest: sock.updateMediaMessage,
        }),
    }

    try {
      await cmd.run(ctx)
    } catch (err) {
      console.error(`[${cmd.name}]`, err)
      await ctx.reply(`⚠️ *Error:* ${err.message}`)
    }
  })

  return sock
}

export async function stopBot(sessionId) {
  const sock = activeBots.get(sessionId)
  if (sock) {
    try {
      await sock.logout()
    } catch {}
    activeBots.delete(sessionId)
  }
}

export function isActive(sessionId) {
  return activeBots.has(sessionId)
}