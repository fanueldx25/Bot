import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Loads commands from ./commands/*.js
 * Each file must export default an object OR an array of command objects.
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

export const uniqueCommands = (map) =>
  new Set([...map.values()].map((c) => c.name))