// lib/format.js
// ─────────────────────────────────────────────────────────────
//  ROBOTIC UI KIT — consistent, boxed, structured WhatsApp replies
// ─────────────────────────────────────────────────────────────

export const R = {
  // Heavy box (banner)
  tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║',
  // Light box (sections)
  tl2: '┏', tr2: '┓', bl2: '┗', br2: '┛', h2: '━', v2: '┃',
  // Markers
  arrow: '▸', dot: '●', check: '✓', cross: '✗', warn: '⚠',
}

/** Wide banner at the top of every reply. */
export function header(title, subtitle = '') {
  const w = 34
  const t = String(title).toUpperCase()
  const line  = `╔${R.h.repeat(w)}╗`
  const title_ = `║  🤖  ${t.padEnd(w - 6).slice(0, w - 6)}║`
  const out = [line, title_]
  if (subtitle) {
    const s = String(subtitle).toUpperCase()
    out.push(`║      ${s.padEnd(w - 8).slice(0, w - 8)}║`)
  }
  out.push(`╚${R.h.repeat(w)}╝`)
  return out.join('\n')
}

/** Small section divider, e.g. ┏━[ 🧰 TOOLS ]━━━━━ */
export function section(label, icon = R.dot) {
  const text = `${icon}  ${String(label).toUpperCase()}`
  const pad = Math.max(1, 26 - text.length)
  return `${R.tl2}${R.h2}[ ${text} ]${R.h2.repeat(pad)}`
}

/** One-line status row. */
export function row(label, value, { icon = R.arrow, pad = 10 } = {}) {
  return `${icon} ${String(label).toUpperCase().padEnd(pad)} ${value}`
}

/** Key/value block. */
export function kv(pairs) {
  const entries = Object.entries(pairs)
  if (!entries.length) return ''
  const width = Math.max(...entries.map(([k]) => String(k).length))
  return entries
    .map(([k, v]) => `${R.v2} ${String(k).padEnd(width)} : ${v}`)
    .join('\n')
}

/** Closing footer. */
export function footer() {
  return `${R.bl2}${R.h2.repeat(36)}`
}

/** Inline pill, e.g. [ ONLINE ] */
export const pill = (s) => `[ ${String(s).toUpperCase()} ]`

/** Big centered banner, mostly for splash screens. */
export function banner(text) {
  const t = String(text)
  const w = t.length + 6
  return [
    `╔${R.h.repeat(w)}╗`,
    `║  ${t}  ║`,
    `╚${R.h.repeat(w)}╝`,
  ].join('\n')
}

/** Standard error block. */
export function err(message) {
  return header('Error', 'SYSTEM NOTICE') + '\n\n' + kv({ Message: message })
}

/** Standard success block. */
export function ok(title, pairs = {}) {
  return header(title, 'SUCCESS') + '\n\n' + kv(pairs)
}