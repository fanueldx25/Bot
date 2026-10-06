// lib/format.js
// ─────────────────────────────────────────────────────────────
//  NEXUS TERMINAL — rare block/mark glyph UI kit
//  Glyph set:  ▰ ▱ ⬢ ⌁ ◈ ▸ ✦ ·
// ─────────────────────────────────────────────────────────────

export const G = {
  bar: '▰', // filled upper block
  barEmpty: '▱', // empty lower parallelogram
  hex: '⬢', // hexagon
  bolt: '⌁', // electric arrow
  diamond: '◈', // diamond
  pointer: '▸', // small pointer
  star: '✦', // sparkle
  dot: '·', // interpunct
  slash: '//',
  check: '✓',
  cross: '✗',
  warn: '⚠',
}

const W = 28

/** Banner header: ▰▰▰… + hex title + bolt subtitle. */
export function head(title, subtitle = '') {
  const top = G.bar.repeat(W)
  const bot = G.bar.repeat(W)
  const lines = [top, `  ${G.hex}  ${String(title).toUpperCase()}`]
  if (subtitle) lines.push(`  ${G.bolt}  ${String(subtitle).toUpperCase()}`)
  lines.push(bot)
  return lines.join('\n')
}

/** Footer strip with optional centered tag. */
export function foot(tag = '') {
  const line = G.barEmpty.repeat(W)
  if (!tag) return line
  return [line, `  ${G.star} ${String(tag).toUpperCase()} ${G.star}`, line].join('\n')
}

/** Key/value rows prefixed with ◈ and pointed with ▸. */
export function stats(pairs) {
  const entries = Object.entries(pairs)
  if (!entries.length) return ''
  const width = Math.max(...entries.map(([k]) => String(k).length))
  return entries
    .map(
      ([k, v]) =>
      `  ${G.diamond} ${String(k).toUpperCase().padEnd(width)} ${G.pointer} ${v}`,
    )
    .join('\n')
}

/** Section divider for the menu. */
export function section(label, icon = G.diamond) {
  return `  ${icon}  ${String(label).toUpperCase()}  ${G.bar.repeat(12)}`
}

/** One command line. */
export function entry(name, desc, prefix = '.') {
  return `  ${G.pointer} ${prefix}${String(name).padEnd(12)} ${G.dot} ${desc}`
}

/** Inline pill. */
export const pill = (s) => `${G.barEmpty} ${String(s).toUpperCase()} ${G.bar}`

/** Composed success message. */
export function ok(title, pairs = {}, tag = 'SUCCESS') {
  return [head(title, 'STATUS UPDATE'), '', stats(pairs), '', foot(tag)].join('\n')
}

/** Composed error message. */
export function err(message) {
  return [head('Error', 'SYSTEM NOTICE'), '', `  ${G.cross} ${message}`, '', foot('FAILED')].join('\n')
}

/** Composed info message with arbitrary body. */
export function info(title, subtitle, body, tag = '') {
  return [head(title, subtitle), '', body, '', foot(tag)].join('\n')
}