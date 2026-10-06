import { getTarget, onlyDigits } from '../lib/helpers.js'

export default [
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
      await reply(`📤 Broadcasting to *${ids.length}* groups…`)
      let sent = 0
      for (const id of ids) {
        try {
          await sock.sendMessage(id, { text })
          sent++
          await new Promise((r) => setTimeout(r, 1500))
        } catch {}
      }
      await reply(`✅ Delivered to *${sent}/${ids.length}* groups.`)
    },
  },
  {
    name: 'block',
    category: 'owner',
    description: 'Block a user',
    ownerOnly: true,
    async run({ sock, msg, text, reply }) {
      const t =
        getTarget(msg) ||
        (onlyDigits(text) ? `${onlyDigits(text)}@s.whatsapp.net` : null)
      if (!t) return reply('Usage: *.block <number>* or reply to a message.')
      await sock.updateBlockStatus(t, 'block')
      await reply(`🚫 Blocked ${t.split('@')[0]}`)
    },
  },
  {
    name: 'unblock',
    category: 'owner',
    description: 'Unblock a user',
    ownerOnly: true,
    async run({ sock, msg, text, reply }) {
      const t =
        getTarget(msg) ||
        (onlyDigits(text) ? `${onlyDigits(text)}@s.whatsapp.net` : null)
      if (!t) return reply('Usage: *.unblock <number>*')
      await sock.updateBlockStatus(t, 'unblock')
      await reply(`✅ Unblocked ${t.split('@')[0]}`)
    },
  },
  {
    name: 'setprefix',
    aliases: ['prefix'],
    category: 'owner',
    description: 'Change command prefix',
    ownerOnly: true,
    async run({ text, reply, config }) {
      if (!text) return reply(`Current prefix: *${config.prefix}*`)
      config.prefix = text.trim().slice(0, 3)
      await reply(`✅ Prefix changed to *${config.prefix}*`)
    },
  },
  {
    name: 'restart',
    category: 'owner',
    description: 'Restart the bot process',
    ownerOnly: true,
    async run({ reply }) {
      await reply('♻️ Restarting…')
      setTimeout(() => process.exit(0), 1000)
    },
  },
]