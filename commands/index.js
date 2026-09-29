import { registerCommand } from '../bot.js';
import info from './info.js';
import group from './group.js';
import access from './access.js';
import anti from './anti.js';
import owner from './owner.js';
import system from './system.js';
import ai from './ai.js';

const modules = {
  info,
  group,
  access,
  anti,
  owner,
  system,
  ai,
};

/**
 * Loads all command modules and registers them with the bot.
 * Supports both:
 *   export default { ping: async (ctx) => {} }                 ← plain function
 *   export default { restart: { ownerOnly: true, handler } }   ← with metadata
 */
export async function loadCommands() {
  let count = 0;
  let ownerCount = 0;
  
  for (const [scope, mod] of Object.entries(modules)) {
    const map = mod?.default || mod;
    if (!map || typeof map !== 'object') {
      console.warn(`⚠️  Command module "${scope}" has no default export`);
      continue;
    }
    
    for (const [name, value] of Object.entries(map)) {
      if (typeof value === 'function') {
        registerCommand(name, value);
        count++;
      } else if (value && typeof value.handler === 'function') {
        value.handler.ownerOnly = !!value.ownerOnly;
        registerCommand(name, value.handler);
        count++;
        if (value.ownerOnly) ownerCount++;
      } else {
        console.warn(`⚠️  Skipped invalid command "${name}" in ${scope}`);
      }
    }
  }
  
  console.log(`📦 Loaded ${count} commands (${ownerCount} owner-only)`);
  return { count, ownerCount };
}

export default { loadCommands };