import { uniqueCommands } from '../loader.js'

const BOOTED_AT = Date.now()

const CATEGORY_ICONS = {
  general: '⚙️',
  tools: '🧰',
  download: '📥',
  group: '👥',
  owner: '👑',
  ai: '🧠',
}

export default [
  {
    name: 'menu',
    aliases: ['help', 'h'],
    category: 'general',
    description: 'List every available command',
    async run({ reply, commands, config, prefix }) {
      const groups = new Map()
      for (const cmd of uniqueCommands(commands)) {
        const list = groups.get(cmd.category) ?? []
        list.push(cmd)
        groups.set(cmd.category, list)
      }
      let out = `╭━━━「 *${config.botName}* 」━━━\n`
      for (const [cat, list] of [...groups.entries()].sort()) {
        out += `┃\n┃ ${CATEGORY_ICONS[cat] ?? '📁'} *${cat.toUpperCase()}*\n`
        for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
          out += `┃  ▸ ${prefix}${c.name} — ${c.description}\n`
        }
      }
      out += `┃\n╰━━━ Total: *${uniqueCommands(commands).size}* commands`
      await reply(out)
    },
  },
  {
    name: 'ping',
    aliases: ['p'],
    category: 'general',
    description: 'Check bot response time',
    async run({ sock, chatId, reply }) {
      const t0 = Date.now()
      const sent = await reply('🏓 Pinging…')
      const ms = Date.now() - t0
      await sock.sendMessage(
        chatId,
        { text: `🏓 *Pong!*\n⚡ Latency: ${ms}ms`, edit: sent.key },
      )
    },
  },
  {
    name: 'uptime',
    category: 'general',
    description: 'Show bot uptime',
    async run({ reply }) {
      const t = Math.floor((Date.now() - BOOTED_AT) / 1000)
      const d = Math.floor(t / 86400)
      const h = Math.floor((t % 86400) / 3600)
      const m = Math.floor((t % 3600) / 60)
      const s = t % 60
      await reply(`⏱️ Uptime: *${d}d ${h}h ${m}m ${s}s*`)
    },
  },
  {
    name: 'id',
    category: 'general',
    description: 'Show chat and user JIDs',
    async run({ reply, chatId, sender, isGroup }) {
      await reply(
        `🆔 *Chat JID:*\n\`${chatId}\`\n\n` +
          `👤 *Your JID:*\n\`${sender}\`\n\n` +
          `📍 ${isGroup ? 'Group' : 'Private chat'}`,
      )
    },
  },
  {
    name: 'info',
    category: 'general',
    description: 'Bot information',
    async run({ reply, config, commands }) {
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
      await reply(
        `🤖 *${config.botName}*\n` +
          `├ Prefix: \`${config.prefix}\`\n` +
          `├ Commands: ${uniqueCommands(commands).size}\n` +
          `├ Node: ${process.version}\n` +
          `├ Memory: ${mem} MB\n` +
          `└ Platform: ${process.platform}`,
      )
    },
  },
  {
    name: 'owner',
    category: 'general',
    description: 'Get owner contact',
    async run({ reply, config }) {
      const list = config.ownerNumbers
        .map((n) => `wa.me/${n.split('@')[0]}`)
        .join('\n')
      await reply(`👑 *Owner*\n${list || 'not configured'}`)
    },
  },
]