// ui.js — PANDA-themed visual toolkit for the bot UI
// Pure functions → strings. No dependencies.

const LETTERS = {
  P: ['█████', '█   █', '█████', '█    ', '█    '],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  L: ['█    ', '█    ', '█    ', '█    ', '█    '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  G: [' ████', '█    ', '█  ██', '█   █', ' ███ '],
  V: ['█   █', '█   █', '█   █', ' █ █ ', '  █  '],
  X: ['█   █', ' █ █ ', '  █  ', ' █ █ ', '█   █'],
  U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
  F: ['█████', '█    ', '████ ', '█    ', '█    '],
  W: ['█   █', '█   █', '█ █ █', '██ ██', '█   █'],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  Y: ['█   █', ' █ █ ', '  █  ', '  █  ', '  █  '],
  Z: ['█████', '   █ ', '  █  ', ' █   ', '█████'],
  ' ': ['     ', '     ', '     ', '     ', '     ']
};

function bigLetters(word) {
  const chars = String(word).toUpperCase().split('');
  const rows = ['', '', '', '', ''];
  for (const ch of chars) {
    const glyph = LETTERS[ch] || LETTERS[' '];
    for (let i = 0; i < 5; i++) rows[i] += glyph[i] + ' ';
  }
  return rows.join('\n');
}

function pandaBanner(subtitle = '') {
  const panda = bigLetters('PANDA');
  const sub = subtitle ? `\n  🐼  *${subtitle}*` : '';
  return (
    '```\n' + panda + '\n```\n' +
    '  ─────────────────────────────' +
    sub
  );
}

function section(title, emoji = '▸') {
  const line = '━'.repeat(28);
  return `\n${emoji}  *${title}*\n${line}`;
}

function row(label, value, width = 12) {
  return `│ ${String(label).padEnd(width, ' ')} : ${value}`;
}

function box(title, emoji = '✅') {
  const inner = `${emoji}  ${title}  ${emoji}`;
  const pad = Math.max(0, 30 - inner.length);
  const left = ' '.repeat(Math.floor(pad / 2));
  const right = ' '.repeat(Math.ceil(pad / 2));
  return (
    '╭──────────────────────────────╮\n' +
    `│ ${left}${inner}${right} │\n` +
    '╰──────────────────────────────╯'
  );
}

function info(title, emoji, pairs, width = 12) {
  const lines = Object.entries(pairs).map(([k, v]) => row(k, v, width));
  return `${box(title, emoji)}\n${section(title, emoji)}\n${lines.join('\n')}`;
}

function prompt(emoji, text) {
  return `${emoji}  ${text}`;
}

function usage(lines) {
  return `\n📖 *Usage*\n${'─'.repeat(28)}\n` + lines.map((l) => `│ ${l}`).join('\n');
}

function bar(pct, width = 12) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

module.exports = {
  bigLetters,
  pandaBanner,
  section,
  row,
  box,
  info,
  prompt,
  usage,
  bar,
  divider
};