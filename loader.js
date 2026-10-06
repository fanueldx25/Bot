// loader.js
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Loads commands from ./commands/*.js
 * Each file must export default an object OR an array of command objects.
 * Returns a Map keyed by lowercase name/alias -> command object.
 */
export async function loadCommands(rootDir) {
  const map = new Map()
  if (!fs.existsSync(rootDir)) return map

  for (const file of fs.readdirSync(rootDir).filter((f) => f.endsWith('.js'))) {
    const mod = await import(pathToFileURL(path.join(rootDir, file)).href)
    const exported = mod.default
    const list = Array.isArray(exported) ? exported : [exported]

    for (const cmd of list) {
      if (!cmd?.name || typeof cmd.run !== 'function') {
        console.warn(`⚠️ Skipping invalid command in ${file}`)
        continue
      }
      cmd.category ??= file.replace('.js', '')
      cmd.aliases ??= []
      for (const key of [cmd.name, ...cmd.aliases]) {
        map.set(key.toLowerCase(), cmd)
      }
    }
  }
  return map
}

/**
 * Returns a de-duplicated array of unique command OBJECTS (deduped by .name).
 * Safe to call with undefined / non-Map values.
 */
export const uniqueCommands = (map) => {
  if (!map || typeof map.values !== 'function') return []
  const seen = new Map()
  for (const cmd of map.values()) {
    if (cmd?.name && !seen.has(cmd.name)) seen.set(cmd.name, cmd)
  }
  return [...seen.values()]
}

export default {
  botName: 'NovaBot',
  prefix: '.',
  ownerNumbers: (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean),

  jwtSecret: process.env.JWT_SECRET || 'change-me-in-prod',
  cookieName: 'wa_token',
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,

  // ── AI (Ollama Cloud) ──────────────────────────────────────
  ai: {
    apiKey: process.env.OLLAMA_API_KEY || '',
    baseUrl: process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1',
    model: process.env.OLLAMA_MODEL || 'gemma4:31b',
    systemPrompt:
      'You are NovaBot, a concise WhatsApp assistant. Reply in plain text, ' +
      'no markdown, no code fences. Keep answers under 3 short paragraphs.',
    historyLimit: 10,
  },

  // ── Behaviour defaults (overridable per-session in DB) ─────
  defaults: {
    mode: 'private',     // 'private' | 'public'
    selfMode: true,      // respond to messages the bot itself sends (self-chat)
  },

  apis: {
    ytmp3: process.env.API_YTMP3 || '',
    ytmp4: process.env.API_YTMP4 || '',
    tiktok: process.env.API_TIKTOK || '',
    instagram: process.env.API_INSTAGRAM || '',
  },
}