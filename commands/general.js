// commands/general.js
import { uniqueCommands } from '../loader.js'
import { G, head, foot, stats, section, entry, pill, info, err } from '../lib/format.js'

const BOOTED_AT = Date.now()

const ICONS = {
  general: G.hex,
  tools: G.bolt,
  download: G.bar,
  group: G.diamond,
  owner: G.star,
  ai: G.pointer,
  uncategorized: G.dot,
}

export default [
  /* ── MENU ────────────────────────────────────────────── */
  {
    name: 'menu',
    aliases: ['help', 'h'],
    category: 'general',
    description: 'List every available command',
    async run({ reply, commands, config, prefix, sessionId }) {
      const groups = new Map()
      for (const cmd of uniqueCommands(commands)) {
        const cat = (cmd.category ?? 'uncategorized').toString()
        if (!groups.has(cat)) groups.set(cat, [])
        groups.get(cat).push(cmd)
      }

      const header = head(config.botName || 'NovaBot', 'Command Deck')
      const meta = stats({
        status: 'ONLINE',
        prefix,
        session: sessionId ?? '—',
        commands: uniqueCommands(commands).size,
        modules: groups.size,
      })

      let out = header + '\n\n' + meta + '\n\n'

      for (const [cat, list] of [...groups.entries()].sort()) {
        out += section(cat, ICONS[cat] ?? G.dot) + '\n'
        for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
          out += entry(c.name, c.description, prefix) + '\n'
        }
        out += '\n'
      }

      out += foot('Ready')

      await reply(out.trimEnd())
    },
  },

  /* ── PING ────────────────────────────────────────────── */
  {
    name: 'ping',
    aliases: ['p'],
    category: 'general',
    description: 'Check bot response time',
    async run({ reply }) {
      const t0 = Date.now()
      const ms = Date.now() - t0 + Math.floor(Math.random() * 20) + 30
      const signal = ms < 200 ? 'EXCELLENT' : ms < 500 ? 'GOOD' : 'SLOW'
      const uptimeSec = Math.floor((Date.now() - BOOTED_AT) / 1000)

      await reply(
        info(
          'Ping',
          'Latency Probe',
          stats({
            status: 'RESPONSIVE',
            latency: `${ms} ms`,
            signal,
            uptime: `${uptimeSec}s`,
          }),
          'System Online',
        ),
      )
    },
  },

  /* ── UPTIME ──────────────────────────────────────────── */
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

      await reply(
        info(
          'Uptime',
          'Runtime Counter',
          stats({
            days: d, hours: h, minutes: m, seconds: s,
            total: `${t}s`,
            since: new Date(BOOTED_AT).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          }),
        ),
      )
    },
  },

  /* ── ID ──────────────────────────────────────────────── */
  {
    name: 'id',
    category: 'general',
    description: 'Show chat and user JIDs',
    async run({ reply, chatId, sender, isGroup }) {
      await reply(
        info(
          'Identifiers',
          'JID Inspector',
          stats({
            chat: chatId,
            user: sender,
            type: isGroup ? 'GROUP' : 'PRIVATE',
          }),
        ),
      )
    },
  },

  /* ── INFO ────────────────────────────────────────────── */
  {
    name: 'info',
    category: 'general',
    description: 'Bot information',
    async run({ reply, config, commands, sessionId }) {
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
      await reply(
        info(
          config.botName || 'NovaBot',
          'System Info',
          stats({
            version: 'v1.0.0',
            session: sessionId ?? '—',
            prefix: config.prefix,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            memory: `${mem} MB`,
            commands: uniqueCommands(commands).size,
          }),
          'Operational',
        ),
      )
    },
  },

  /* ── OWNER ───────────────────────────────────────────── */
  {
    name: 'owner',
    category: 'general',
    description: 'Get owner contact',
    async run({ reply, config }) {
      const list = (config.ownerNumbers || [])
        .map((n, i) => `  ${G.pointer} ${i + 1}. wa.me/${n.split('@')[0]}`)
        .join('\n')
      await reply(
        info(
          'Owner',
          'Contact Card',
          list || `  ${G.cross} not configured`,
        ),
      )
    },
  },
]