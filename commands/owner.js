import { getTarget, onlyDigits } from '../lib/helpers.js'
import { Sessions } from '../db.js'
import { header, kv } from '../lib/format.js'

export default [
  /* ── Mode switching ──────────────────────────────────── */
  {
    name: 'mode',
    category: 'owner',
    description: 'Set bot mode: private (owner-only) or public (everyone)',
    ownerOnly: true,
    async run({ text, reply, sessionId }) {
      const next = (text || '').trim().toLowerCase()
      if (!['private', 'public'].includes(next)) {
        const current = (await Sessions.getById(sessionId))?.mode ?? 'private'
        return reply(
          header('Mode', 'ACCESS CONTROL') + '\n\n' +
          kv({
            Current: current.toUpperCase(),
            Usage: '.mode private | .mode public',
            Private: 'only the owner can command',
            Public: 'anyone in DM/group can command',
          }),
        )
      }
      await Sessions.setMode(sessionId, next)
      await reply(
        header('Mode', 'UPDATED') + '\n\n' +
        kv({ Mode: next.toUpperCase() }),
      )
    },
  },
  {
    name: 'self',
    aliases: ['selfmode'],
    category: 'owner',
    description: 'Enable/disable responding to your own self-chat',
    ownerOnly: true,
    async run({ text, reply, sessionId }) {
      const arg = (text || '').trim().toLowerCase()
      if (!['on', 'off'].includes(arg)) {
        const s = await Sessions.getById(sessionId)
        return reply(
          header('Self Mode', 'TOGGLE') + '\n\n' +
          kv({
            Current: s?.self_mode ? 'ON' : 'OFF',
            Usage: '.self on | .self off',
            Info: 'When ON you can command the bot in your own "Message yourself" chat.',
          }),
        )
      }
      await Sessions.setSelfMode(sessionId, arg === 'on')
      await reply(
        header('Self Mode', 'UPDATED') + '\n\n' +
        kv({ State: arg.toUpperCase() }),
      )
    },
  },
  
  /* ── Existing owner commands ─────────────────────────── */
  {
    name: 'broadcast',
    aliases: ['bc'],
    category: 'owner',
    description: 'Broadcast to every group',
    ownerOnly: true,
    async run({ sock, text, reply }) {
      if (!text) return reply('Usage: *.broadcast <message>*')
      const chats = await sock.groupFetchAllParticipating()
      const ids = Object.keys(chats)
      await reply(header('Broadcast', 'SENDING') + '\n\n' + kv({ Groups: ids.length }))
      let sent = 0
      for (const id of ids) {
        try {
          await sock.sendMessage(id, { text })
          sent++
          await new Promise((r) => setTimeout(r, 1500))
        } catch {}
      }
      await reply(header('Broadcast', 'COMPLETE') + '\n\n' + kv({ Delivered: `${sent}/${ids.length}` }))
    },
  },
  {
    name: 'block',
    category: 'owner',
    description: 'Block a user',
    ownerOnly: true,
    async run({ sock, msg, text, reply }) {
      const t = getTarget(msg) || (onlyDigits(text) ? `${onlyDigits(text)}@s.whatsapp.net` : null)
      if (!t) return reply('Usage: *.block <number>* or reply to a message.')
      await sock.updateBlockStatus(t, 'block')
      await reply(header('Block', 'DONE') + '\n\n' + kv({ User: t.split('@')[0] }))
    },
  },
  {
    name: 'unblock',
    category: 'owner',
    description: 'Unblock a user',
    ownerOnly: true,
    async run({ sock, msg, text, reply }) {
      const t = getTarget(msg) || (onlyDigits(text) ? `${onlyDigits(text)}@s.whatsapp.net` : null)
      if (!t) return reply('Usage: *.unblock <number>*')
      await sock.updateBlockStatus(t, 'unblock')
      await reply(header('Unblock', 'DONE') + '\n\n' + kv({ User: t.split('@')[0] }))
    },
  },
  {
    name: 'setprefix',
    aliases: ['prefix'],
    category: 'owner',
    description: 'Change command prefix',
    ownerOnly: true,
    async run({ text, reply, config }) {
      if (!text) {
        return reply(header('Prefix', 'CURRENT') + '\n\n' + kv({ Prefix: config.prefix }))
      }
      config.prefix = text.trim().slice(0, 3)
      await reply(header('Prefix', 'UPDATED') + '\n\n' + kv({ New: config.prefix }))
    },
  },
  {
    name: 'restart',
    category: 'owner',
    description: 'Restart the bot process',
    ownerOnly: true,
    async run({ reply }) {
      await reply(header('System', 'RESTARTING') + '\n\n' + kv({ Action: 'process.exit(0)' }))
      setTimeout(() => process.exit(0), 1000)
    },
  },
]