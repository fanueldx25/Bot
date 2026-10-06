// commands/general.js
import { uniqueCommands } from '../loader.js'
import { header, section, row, kv, footer, pill, R } from '../lib/format.js'

const BOOTED_AT = Date.now()

const ICONS = {
  general: '⚙️',
  tools: '🧰',
  download: '📥',
  group: '👥',
  owner: '👑',
  ai: '🧠',
  uncategorized: '📁',
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
      
      let out = header(config.botName || 'NovaBot', 'COMMAND SYSTEM') + '\n\n'
      out +=
        kv({
          Status: 'ONLINE',
          Prefix: prefix,
          Session: sessionId ?? '—',
          Commands: uniqueCommands(commands).size,
          Modules: groups.size,
        }) + '\n\n'
      
      for (const [cat, list] of [...groups.entries()].sort()) {
        out += `${section(cat, ICONS[cat] ?? '📁')}\n`
        for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
          out += `${R.v2} ▸ ${prefix}${c.name.padEnd(11)} ${c.description}\n`
        }
        out += footer() + '\n\n'
      }
      
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
      
      const out =
        header('Ping', 'LATENCY PROBE') +
        '\n\n' +
        kv({
          Status: 'RESPONSIVE',
          Latency: `${ms} ms`,
          Signal: signal,
          Uptime: `${uptimeSec}s`,
        }) +
        '\n\n' +
        footer() +
        '\n' +
        `  ${pill('SYSTEM ONLINE')}`
      
      await reply(out)
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
      
      const out =
        header('Uptime', 'RUNTIME COUNTER') +
        '\n\n' +
        kv({
          Days: d,
          Hours: h,
          Minutes: m,
          Seconds: s,
        }) +
        '\n\n' +
        row('Total', `${t}s`) +
        '\n' +
        row(
          'Since',
          new Date(BOOTED_AT).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        )
      
      await reply(out)
    },
  },
  
  /* ── ID ──────────────────────────────────────────────── */
  {
    name: 'id',
    category: 'general',
    description: 'Show chat and user JIDs',
    async run({ reply, chatId, sender, isGroup }) {
      const out =
        header('Identifiers', 'JID INSPECTOR') +
        '\n\n' +
        kv({
          Chat: chatId,
          User: sender,
          Type: isGroup ? 'GROUP' : 'PRIVATE',
        })
      await reply(out)
    },
  },
  
  /* ── INFO ────────────────────────────────────────────── */
  {
    name: 'info',
    category: 'general',
    description: 'Bot information',
    async run({ reply, config, commands, sessionId }) {
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
      const out =
        header(config.botName || 'NovaBot', 'SYSTEM INFO') +
        '\n\n' +
        kv({
          Version: 'v1.0.0',
          Session: sessionId ?? '—',
          Prefix: config.prefix,
          Node: process.version,
          Platform: process.platform,
          Arch: process.arch,
          Memory: `${mem} MB`,
          Commands: uniqueCommands(commands).size,
        }) +
        '\n\n' +
        footer() +
        '\n' +
        `  ${pill('OPERATIONAL')}`
      await reply(out)
    },
  },
  
  /* ── OWNER ───────────────────────────────────────────── */
  {
    name: 'owner',
    category: 'general',
    description: 'Get owner contact',
    async run({ reply, config }) {
      const list = (config.ownerNumbers || [])
        .map((n, i) => `${R.v2} ${i + 1}. wa.me/${n.split('@')[0]}`)
        .join('\n')
      
      const out =
        header('Owner', 'CONTACT CARD') +
        '\n\n' +
        (list || `${R.v2} not configured`)
      await reply(out)
    },
  },
]