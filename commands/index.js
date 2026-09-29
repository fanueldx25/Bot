import { registerCommand } from '../bot.js';
import { registerCommandSetting } from './access.js';
import info from './info.js';
import group from './group.js';
import access from './access.js';
import anti from './anti.js';
import owner from './owner.js';
import system from './system.js';
import ai from './ai.js';

const modules = { info, group, access, anti, owner, system, ai };

/**
 * Loads all command modules, registers them in memory with the bot,
 * AND writes each one to the command_settings table so the dashboard can list them.
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
        await registerCommandSetting(name, true);
        count++;
      } else if (value && typeof value.handler === 'function') {
        value.handler.ownerOnly = !!value.ownerOnly;
        registerCommand(name, value.handler);
        await registerCommandSetting(name, true);
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