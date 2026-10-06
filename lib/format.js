// lib/format.js

const LINE_LEN = 22
const LINE = '─'.repeat(LINE_LEN)

/** Box-drawing glyphs and icon set used across all messages. */
export const G = {
  hex: '⬡',
  bolt: '⚡',
  bar: '▬',
  diamond: '◆',
  star: '★',
  pointer: '➤',
  dot: '•',
  cross: '✗',
  check: '✓',
  arrow: '→',
}

const B = {
  tl: '╭',
  ml: '│',
  bl: '╰',
}

/** Opens a titled box. Pair with `close()` to finish it. */
export function head(title, subtitle) {
  return [
    `${B.tl}${LINE}`,
    `${B.ml} ${G.diamond} ${title}`,
    `${B.ml} ${subtitle}`,
  ].join('\n')
}

/** Closes the currently open box. */
export function close() {
  return `${B.bl}${LINE}`
}

/** One `│ …` row inside an open box. */
export function row(content) {
  return `${B.ml} ${content}`
}

/** Turns a plain object into `│ ➤ Key: Value` rows. */
export function stats(obj) {
  return Object.entries(obj)
    .map(([k, v]) => {
      const key = k.charAt(0).toUpperCase() + k.slice(1)
      return row(`${G.pointer} ${key}: ${v}`)
    })
    .join('\n')
}

/** Section header inside a menu (opens a sub-box). */
export function section(name, icon = G.dot) {
  return `${B.tl}─ ${icon} ${String(name).toUpperCase()}`
}

/** A single command entry inside a section. */
export function entry(name, description, prefix = '.') {
  const d = description ? ` — ${description}` : ''
  return row(`${G.pointer} ${prefix}${name}${d}`)
}

/** Small inline badge, e.g. `[ mode: public ]`. */
export function pill(label, value) {
  return `[ ${label}: ${value} ]`
}

/** Final status line under a closed box. */
export function foot(label = 'Ready') {
  return `${G.check} ${label}`
}

/**
 * A complete, self-contained info box.
 * `body` is expected to be pre-formatted (e.g. output of `stats()` or `row()`).
 */
export function info(title, subtitle, body, footer) {
  const lines = [
    `${B.tl}${LINE}`,
    `${B.ml} ${G.diamond} ${title}`,
    `${B.ml} ${subtitle}`,
  ]
  if (body) lines.push(body)
  lines.push(`${B.bl}${LINE}`)
  if (footer) lines.push(`${G.check} ${footer}`)
  return lines.join('\n')
}

/** A complete error box. */
export function err(title, message) {
  return [
    `${B.tl}${LINE}`,
    `${B.ml} ${G.cross} ${title}`,
    `${B.ml} ${message}`,
    `${B.bl}${LINE}`,
  ].join('\n')
}