// commands/group.js
import { getTarget, onlyDigits } from '../lib/helpers.js'
import { G, info, err, stats, ok, head, foot } from '../lib/format.js'

export default [
  {
    name: 'kick',
    aliases: ['remove'],
    category: 'group',
    description: 'Remove a member',
    groupOnly: true,
    adminOnly: true,
    async run({ sock, chatId, msg, reply }) {
      const t = getTarget(msg)
      if (!t) return reply(err('Reply to or mention the member'))
      await sock.groupParticipantsUpdate(chatId, [t], 'remove')
      await reply(ok('Kick', { user: `@${t.split('@')[0]}`, action: 'REMOVED' }, 'Removed'), { mentions: [t] })
    },
  },
  {
    name: 'add',
    category: 'group',
    description: 'Add a member',
    groupOnly: true,
    adminOnly: true,
    async run({ sock, chatId, text, reply }) {
      const n = onlyDigits(text)
      if (!n) return reply(err('Usage: .add 254712345678'))
      const jid = `${n}@s.whatsapp.net`
      const [res] = await sock.groupParticipantsUpdate(chatId, [jid], 'add')
      const code = res?.status
      await reply(
        code === '200'
          ? ok('Add', { user: `@${n}`, action: 'ADDED' }, 'Done')
          : err(`Could not add (status ${code})`),
        { mentions: [jid] },
      )
    },
  },
  {
    name: 'promote',
    category: 'group',
    description: 'Promote to admin',
    groupOnly: true,
    adminOnly: true,
    async run({ sock, chatId, msg, reply }) {
      const t = getTarget(msg)
      if (!t) return reply(err('Reply to or mention a member'))
      await sock.groupParticipantsUpdate(chatId, [t], 'promote')
      await reply(ok('Promote', { user: `@${t.split('@')[0]}`, rank: 'ADMIN' }, 'Done'), { mentions: [t] })
    },
  },
  {
    name: 'demote',
    category: 'group',
    description: 'Demote an admin',
    groupOnly: true,
    adminOnly: true,
    async run({ sock, chatId, msg, reply }) {
      const t = getTarget(msg)
      if (!t) return reply(err('Reply to or mention an admin'))
      await sock.groupParticipantsUpdate(chatId, [t], 'demote')
      await reply(ok('Demote', { user: `@${t.split('@')[0]}`, rank: 'MEMBER' }, 'Done'), { mentions: [t] })
    },
  },
  {
    name: 'mute',
    aliases: ['close'],
    category: 'group',
    description: 'Only admins can send',
    groupOnly: true,
    adminOnly: true,
    async run({ sock, chatId, reply }) {
      await sock.groupSettingUpdate(chatId, 'announcement')
      await reply(ok('Mute', { state: 'ANNOUNCEMENT', speakers: 'ADMINS' }, 'Locked'))
    },
  },
  {
    name: 'unmute',
    aliases: ['open'],
    category: 'group',
    description: 'Everyone can send',
    groupOnly: true,
    adminOnly: true,
    async run({ sock, chatId, reply }) {
      await sock.groupSettingUpdate(chatId, 'not_announcement')
      await reply(ok('Unmute', { state: 'OPEN', speakers: 'EVERYONE' }, 'Unlocked'))
    },
  },
  {
    name: 'tagall',
    aliases: ['everyone'],
    category: 'group',
    description: 'Mention every member',
    groupOnly: true,
    adminOnly: true,
    async run({ sock, chatId, text }) {
      const meta = await sock.groupMetadata(chatId)
      const mentions = meta.participants.map((p) => p.id)
      const list = mentions.map((m, i) => `  ${G.pointer} ${String(i + 1).padStart(2, '0')}. @${m.split('@')[0]}`).join('\n')
      await sock.sendMessage(chatId, {
        text: head('TagAll', text || 'Attention Everyone') + '\n\n' + list + '\n\n' + foot(`${mentions.length} mentioned`),
        mentions,
      })
    },
  },
  {
    name: 'groupinfo',
    aliases: ['ginfo'],
    category: 'group',
    description: 'Show group metadata',
    groupOnly: true,
    async run({ sock, chatId, reply }) {
      const m = await sock.groupMetadata(chatId)
      const admins = m.participants.filter((p) => p.admin)
      await reply(
        info(
          'Group Info',
          m.subject,
          stats({
            id: m.id,
            members: m.participants.length,
            admins: admins.map((p) => '@' + p.id.split('@')[0]).join(', ') || 'none',
            desc: (m.desc || 'No description').slice(0, 80),
          }),
        ),
        { mentions: admins.map((p) => p.id) },
      )
    },
  },
]