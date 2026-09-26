// ============================================================================
// collection.js — command registry / metadata collection
// ============================================================================

const commands = new Map();

/**
 * Register a command.
 * @param {string} name        - e.g. '.ping'
 * @param {object} meta
 * @param {string} meta.category
 * @param {string} meta.description
 * @param {boolean} meta.adminOnly
 * @param {string[]} meta.aliases
 */
function register(name, meta = {}) {
  const key = name.toLowerCase();
  commands.set(key, {
    name: key,
    category: meta.category || 'general',
    description: meta.description || '',
    adminOnly: !!meta.adminOnly,
    aliases: meta.aliases || [],
    usage: meta.usage || ''
  });
}

function get(name) {
  return commands.get((name || '').toLowerCase());
}

function has(name) {
  return commands.has((name || '').toLowerCase());
}

function all() {
  return [...commands.values()];
}

function byCategory(cat) {
  return all().filter((c) => c.category === cat);
}

function isAdminCommand(name) {
  const c = get(name);
  return c ? c.adminOnly : false;
}

// ---------- Seed the registry ----------
const seed = [
  // General
  { name: '.help', category: 'general', description: 'Show menu' },
  { name: '.menu', category: 'general', description: 'Show menu', aliases: ['.help'] },
  { name: '.ping', category: 'general', description: 'Check bot alive' },
  { name: '.id', category: 'general', description: 'Your JID' },
  { name: '.myid', category: 'general', description: 'Your number' },
  { name: '.time', category: 'general', description: 'Server time' },
  { name: '.uptime', category: 'general', description: 'Bot uptime' },
  
  // Media
  { name: '.sticker', category: 'media', description: 'Image → sticker', aliases: ['.s'] },
  { name: '.s', category: 'media', description: 'Image → sticker' },
  { name: '.toimg', category: 'media', description: 'Sticker → image' },
  { name: '.tts', category: 'media', description: 'Text → voice' },
  { name: '.voice', category: 'media', description: 'Reply → voice' },
  { name: '.getpp', category: 'media', description: 'Get profile picture' },
  
  // Admin
  { name: '.status', category: 'admin', description: 'Bot status', adminOnly: true },
  { name: '.restart', category: 'admin', description: 'Restart bot', adminOnly: true },
  { name: '.logout', category: 'admin', description: 'Disconnect session', adminOnly: true },
  { name: '.backup', category: 'admin', description: 'Backup session', adminOnly: true },
  { name: '.restore', category: 'admin', description: 'Restore session', adminOnly: true },
  
  // Pause
  { name: '.pause', category: 'pause', description: 'Pause bot', adminOnly: true },
  { name: '.resume', category: 'pause', description: 'Resume bot', adminOnly: true },
  { name: '.pausestatus', category: 'pause', description: 'Pause status', adminOnly: true },
  
  // Group
  { name: '.welcome', category: 'group', description: 'Welcome on/off', adminOnly: true },
  { name: '.goodbye', category: 'group', description: 'Goodbye on/off', adminOnly: true },
  { name: '.setwelcome', category: 'group', description: 'Custom welcome', adminOnly: true },
  { name: '.tagall', category: 'group', description: 'Tag everyone', adminOnly: true },
  { name: '.hidetag', category: 'group', description: 'Hidden tag', adminOnly: true },
  { name: '.kick', category: 'group', description: 'Kick user', adminOnly: true },
  { name: '.promote', category: 'group', description: 'Promote user', adminOnly: true },
  { name: '.demote', category: 'group', description: 'Demote user', adminOnly: true },
  { name: '.mute', category: 'group', description: 'Mute group', adminOnly: true },
  { name: '.unmute', category: 'group', description: 'Unmute group', adminOnly: true },
  { name: '.groupinfo', category: 'group', description: 'Group info', adminOnly: true },
  
  // Special
  { name: '.vo', category: 'special', description: 'View-once capture', adminOnly: true },
  { name: '.autodl', category: 'special', description: 'Auto download', adminOnly: true },
  { name: '.poststatus', category: 'special', description: 'Post to status', adminOnly: true }
];

seed.forEach((c) => register(c.name, c));

module.exports = {
  register,
  get,
  has,
  all,
  byCategory,
  isAdminCommand,
  commands
};