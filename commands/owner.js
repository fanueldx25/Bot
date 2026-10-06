// commands/owner.js
import { getTarget, onlyDigits } from '../lib/helpers.js'
import { Sessions } from '../db.js'
import { G, info, err, stats, ok } from '../lib/format.js'

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
          info('Mode', 'Access Control', stats({
            current: current.toUpperCase(),
            usage: '.mode private | .mode public',
            private: 'only the owner can command',
            public: 'anyone in DM/group can command',
          })),
        )
      }
      await Sessions.setMode(sessionId, next)
      await reply(ok('Mode', { mode: next.toUpperCase() }, 'Updated'))
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
          info('Self Mode', 'Toggle', stats({
            current: s?.self_mode ? 'ON' : 'OFF',
            usage: '.self on | .self off',
            info: 'Command the bot in your own "Message yourself" chat.',
          })),
        )
      }
      await Sessions.setSelfMode(sessionId, arg === 'on')
      await reply(ok('Self Mode', { state: arg.toUpperCase() }, 'Updated'))
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
      if (!text) return reply(err('Usage: .broadcast <message>'))
      const chats = await sock.groupFetchAllParticipating()
      const ids = Object.keys(chats)
      await reply(info('Broadcast', 'Sending', stats({ groups: ids.length })))
      let sent = 0
      for (const id of ids) {
        try {
          await sock.sendMessage(id, { text })
          sent++
          await new Promise((r) => setTimeout(r, 1500))
        } catch {}
      }
      await reply(ok('Broadcast', { delivered: `${sent}/${ids.length}` }, 'Complete'))
    },
  },
  {
    name: 'block',
    category: 'owner',
    description: 'Block a user',
    ownerOnly: true,
    async run({ sock, msg, text, reply }) {
      const t = getTarget(msg) || (onlyDigits(text) ? `${onlyDigits(text)}@s.whatsapp.net` : null)
      if (!t) return reply(err('Usage: .block <number> or reply to a message'))
      await sock.updateBlockStatus(t, 'block')
      await reply(ok('Block', { user: t.split('@')[0], state: 'BLOCKED' }, 'Done'))
    },
  },
  {
    name: 'unblock',
    category: 'owner',
    description: 'Unblock a user',
    ownerOnly: true,
    async run({ sock, msg, text, reply }) {
      const t = getTarget(msg) || (onlyDigits(text) ? `${onlyDigits(text)}@s.whatsapp.net` : null)
      if (!t) return reply(err('Usage: .unblock <number>'))
      await sock.updateBlockStatus(t, 'unblock')
      await reply(ok('Unblock', { user: t.split('@')[0], state: 'UNBLOCKED' }, 'Done'))
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
        return reply(info('Prefix', 'Current', stats({ prefix: config.prefix })))
      }
      config.prefix = text.trim().slice(0, 3)
      await reply(ok('Prefix', { new: config.prefix }, 'Updated'))
    },
  },
  {
    name: 'restart',
    category: 'owner',
    description: 'Restart the bot process',
    ownerOnly: true,
    async run({ reply }) {
      await reply(info('System', 'Restarting', stats({ action: 'process.exit(0)' }), 'Bye'))
      setTimeout(() => process.exit(0), 1000)
    },
  },
]