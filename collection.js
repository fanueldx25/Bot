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
 * @param {string} meta.usage
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

// ============================================================================
// SEED THE REGISTRY
// ============================================================================
const seed = [
  // ---------- General ----------
  { name: '.help', category: 'general', description: 'Show menu' },
  { name: '.menu', category: 'general', description: 'Show menu', aliases: ['.help'] },
  { name: '.ping', category: 'general', description: 'Check bot alive' },
  { name: '.id', category: 'general', description: 'Your JID' },
  { name: '.myid', category: 'general', description: 'Your number' },
  { name: '.whoami', category: 'general', description: 'Check admin status' },
  { name: '.time', category: 'general', description: 'Server time' },
  { name: '.uptime', category: 'general', description: 'Bot uptime' },
  { name: '.echo', category: 'general', description: 'Repeat text', usage: '.echo <text>' },
  { name: '.calc', category: 'general', description: 'Safe calculator', usage: '.calc <expression>' },
  
  // ---------- Media ----------
  { name: '.sticker', category: 'media', description: 'Image → sticker', aliases: ['.s'] },
  { name: '.s', category: 'media', description: 'Image → sticker' },
  { name: '.toimg', category: 'media', description: 'Sticker → image' },
  { name: '.tts', category: 'media', description: 'Text → voice', usage: '.tts <text>' },
  { name: '.voice', category: 'media', description: 'Reply → voice' },
  { name: '.getpp', category: 'media', description: 'Get profile picture' },
  
  // ---------- Fun ----------
  { name: '.roll', category: 'fun', description: 'Roll dice (e.g. 2d6)', usage: '.roll [NdN]' },
  { name: '.flip', category: 'fun', description: 'Flip a coin' },
  { name: '.8ball', category: 'fun', description: 'Magic 8-ball', usage: '.8ball <question>' },
  { name: '.joke', category: 'fun', description: 'Random joke' },
  { name: '.quote', category: 'fun', description: 'Random quote' },
  { name: '.trivia', category: 'fun', description: 'Play a trivia question' },
  { name: '.truth', category: 'fun', description: 'Truth question' },
  { name: '.dare', category: 'fun', description: 'Dare challenge' },
  { name: '.ship', category: 'fun', description: 'Ship two users', usage: '.ship @a @b' },
  
  // ---------- Tools ----------
  { name: '.shorten', category: 'tools', description: 'Shorten URL', usage: '.shorten <url>' },
  { name: '.weather', category: 'tools', description: 'Weather lookup', usage: '.weather <city>' },
  { name: '.translate', category: 'tools', description: 'Translate text', usage: '.translate <lang> <text>' },
  { name: '.lyrics', category: 'tools', description: 'Fetch song lyrics', usage: '.lyrics <song>' },
  
  // ---------- Admin ----------
  { name: '.status', category: 'admin', description: 'Bot status', adminOnly: true },
  { name: '.restart', category: 'admin', description: 'Restart bot', adminOnly: true },
  { name: '.logout', category: 'admin', description: 'Disconnect session', adminOnly: true },
  { name: '.backup', category: 'admin', description: 'Backup session', adminOnly: true },
  { name: '.restore', category: 'admin', description: 'Restore session', adminOnly: true },
  { name: '.pair', category: 'admin', description: 'Re-pair bot', adminOnly: true, usage: '.pair <number>' },
  { name: '.addadmin', category: 'admin', description: 'Promote user to admin', adminOnly: true },
  { name: '.deladmin', category: 'admin', description: 'Demote admin', adminOnly: true },
  
  // ---------- Pause ----------
  { name: '.pause', category: 'pause', description: 'Pause bot', adminOnly: true, usage: '.pause [all]' },
  { name: '.resume', category: 'pause', description: 'Resume bot', adminOnly: true, usage: '.resume [all]' },
  { name: '.pausestatus', category: 'pause', description: 'Pause status', adminOnly: true },
  
  // ---------- Group ----------
  { name: '.welcome', category: 'group', description: 'Welcome on/off', adminOnly: true, usage: '.welcome on|off' },
  { name: '.goodbye', category: 'group', description: 'Goodbye on/off', adminOnly: true, usage: '.goodbye on|off' },
  { name: '.setwelcome', category: 'group', description: 'Custom welcome', adminOnly: true, usage: '.setwelcome <text>' },
  { name: '.tagall', category: 'group', description: 'Tag everyone', adminOnly: true },
  { name: '.hidetag', category: 'group', description: 'Hidden tag', adminOnly: true },
  { name: '.kick', category: 'group', description: 'Kick user', adminOnly: true, usage: '.kick @user' },
  { name: '.promote', category: 'group', description: 'Promote user', adminOnly: true, usage: '.promote @user' },
  { name: '.demote', category: 'group', description: 'Demote user', adminOnly: true, usage: '.demote @user' },
  { name: '.mute', category: 'group', description: 'Mute group', adminOnly: true },
  { name: '.unmute', category: 'group', description: 'Unmute group', adminOnly: true },
  { name: '.groupinfo', category: 'group', description: 'Group info', adminOnly: true },
  
  // ---------- Moderation ----------
  { name: '.antilink', category: 'moderation', description: 'Anti-link on/off/action', adminOnly: true },
  { name: '.reactions', category: 'moderation', description: 'Toggle bot reactions', adminOnly: true },
  { name: '.schedule', category: 'moderation', description: 'Schedule group open/close', adminOnly: true },
  { name: '.warn', category: 'moderation', description: 'Warn a user (3 = kick)', adminOnly: true, usage: '.warn @user [reason]' },
  { name: '.warnings', category: 'moderation', description: 'List warnings for a user', adminOnly: true, usage: '.warnings @user' },
  { name: '.resetwarn', category: 'moderation', description: 'Clear warnings for a user', adminOnly: true, usage: '.resetwarn @user' },
  
  // ---------- Special ----------
  { name: '.vo', category: 'special', description: 'View-once capture (global)', adminOnly: true },
  { name: '.vv', category: 'special', description: 'Reveal a view-once message' },
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