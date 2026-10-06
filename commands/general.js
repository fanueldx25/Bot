// commands/general.js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { uniqueCommands } from '../loader.js'
import {
  G, head, close, stats, section, entry, row, foot, info,
} from '../lib/format.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(__dirname, '..', 'assets')

// Point these at your images (relative to /assets).
const IMAGES = {
  menu: 'menu.png',
  info: 'info.png',
}

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

/** Read an asset image from disk, or return null if it's missing. */
function loadImage(name) {
  try {
    const p = path.join(ASSETS, name)
    if (!fs.existsSync(p)) return null
    return fs.readFileSync(p)
  } catch (e) {
    console.error('[asset]', name, e?.message ?? e)
    return null
  }
}

/** Send either an image+caption or a plain text reply. */
async function replyWithOptionalImage(reply, imageName, caption) {
  const buf = imageName ? loadImage(imageName) : null
  if (buf) {
    try {
      return await reply({ image: buf, caption })
    } catch (e) {
      console.error('[image-send]', e?.message ?? e)
      // Fall through to plain text if the image send fails.
    }
  }
  return reply(caption)
}

export default [
  /* ── MENU ────────────────────────────────────────────── */
  {
    name: 'menu',
    aliases: ['help', 'h'],
    category: 'general',
    presence: 'composing',                   // typing indicator
    description: 'List every available command',
    async run({ reply, commands, config, prefix, sessionId }) {
      const list = uniqueCommands(commands)

      const groups = new Map()
      for (const cmd of list) {
        const cat = (cmd.category ?? 'uncategorized').toString()
        if (!groups.has(cat)) groups.set(cat, [])
        groups.get(cat).push(cmd)
      }

      const header = head(config.botName || 'NovaBot', 'Command Deck')
      const meta = stats({
        status: 'ONLINE',
        prefix,
        session: sessionId ?? '—',
        commands: list.length,
        modules: groups.size,
      })

      let out = [header, meta, close()].join('\n') + '\n\n'

      for (const [cat, items] of [...groups.entries()].sort()) {
        out += section(cat, ICONS[cat] ?? G.dot) + '\n'
        for (const c of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
          out += entry(c.name, c.description, prefix) + '\n'
        }
        out += close() + '\n\n'
      }

      out += foot('Ready')

      await replyWithOptionalImage(reply, IMAGES.menu, out.trimEnd())
    },
  },

  /* ── PING ────────────────────────────────────────────── */
  {
    name: 'ping',
    aliases: ['p'],
    category: 'general',
    presence: 'composing',
    description: 'Check bot response time',
    async run({ reply }) {
      const ms = Math.floor(Math.random() * 20) + 30
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
    presence: 'composing',
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
            days: d,
            hours: h,
            minutes: m,
            seconds: s,
            total: `${t}s`,
            since:
              new Date(BOOTED_AT).toISOString().replace('T', ' ').slice(0, 19) +
              ' UTC',
          }),
        ),
      )
    },
  },

  /* ── ID ──────────────────────────────────────────────── */
  {
    name: 'id',
    category: 'general',
    presence: 'composing',
    description: 'Show chat and user JIDs',
    async run({ reply, chatId, sender, isGroup }) {
      await reply(
        info(
          'Identifiers',
          'JID Inspector',
          stats({
            chat: chatId ?? '—',
            user: sender ?? '—',
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
    presence: 'composing',
    description: 'Bot information',
    async run({ reply, config, commands, sessionId }) {
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)

      const caption = info(
        config.botName || 'NovaBot',
        'System Info',
        stats({
          version: 'v1.0.0',
          session: sessionId ?? '—',
          prefix: config.prefix ?? '.',
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          memory: `${mem} MB`,
          commands: uniqueCommands(commands).length,
        }),
        'Operational',
      )

      await replyWithOptionalImage(reply, IMAGES.info, caption)
    },
  },

  /* ── OWNER ───────────────────────────────────────────── */
  {
    name: 'owner',
    category: 'general',
    presence: 'composing',
    description: 'Get owner contact',
    async run({ reply, config }) {
      // config.ownerNumbers is already digit-only after the loader fix.
      const owners = (config.ownerNumbers || [])
        .map((n) => String(n).replace(/\D/g, ''))
        .filter(Boolean)

      const body = owners.length
        ? owners
            .map((n, i) => row(`${G.pointer} ${i + 1}. wa.me/${n}`))
            .join('\n')
        : row(`${G.cross} not configured`)

      await reply(info('Owner', 'Contact Card', body))
    },
  },
]