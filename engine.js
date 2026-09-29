import { pool } from './db.js';
import { humanSend } from './bot.js';

let cache = { loadedAt: 0, rules: [] };
const TTL = 30_000;

async function loadRules() {
  if (Date.now() - cache.loadedAt < TTL) return cache.rules;
  const { rows } = await pool.query(
    `SELECT id, trigger, action FROM automations
     WHERE session_id='owner' AND enabled=TRUE`
  );
  cache = { loadedAt: Date.now(), rules: rows };
  return rows;
}

export function invalidateAutomationCache() {
  cache.loadedAt = 0;
}

/** Called from bot.js on every inbound message */
export async function runAutomations({ sock, msg, jid, text }) {
  const rules = await loadRules();
  if (!rules.length || !text) return;

  const lower = text.toLowerCase();

  for (const rule of rules) {
    const { trigger, action } = rule;
    if (!matches(trigger, { jid, text: lower, raw: text })) continue;
    try {
      await execute(sock, jid, msg, action, { text });
    } catch (e) {
      console.error('automation exec failed', rule.id, e);
    }
  }
}

function matches(trigger, ctx) {
  if (!trigger || !trigger.type) return false;
  switch (trigger.type) {
    case 'keyword':
      return ctx.text.includes((trigger.value || '').toLowerCase());
    case 'exact':
      return ctx.text === (trigger.value || '').toLowerCase();
    case 'regex':
      try { return new RegExp(trigger.value, trigger.flags || 'i').test(ctx.raw); }
      catch { return false; }
    case 'from':
      return ctx.jid === trigger.value;
    default:
      return false;
  }
}

async function execute(sock, jid, msg, action, variables = {}) {
  switch (action.type) {
    case 'reply':
      return humanSend(
        jid,
        { text: interpolate(action.text || '', variables) },
        { quoted: msg }
      );
    case 'react':
      return sock.sendMessage(jid, {
        react: { text: action.emoji || '👍', key: msg.key },
      });
    case 'forward':
      return sock.sendMessage(action.to, {
        forward: msg,
        text: action.caption || '',
      });
    case 'delay':
      return new Promise((r) => setTimeout(r, action.ms || 1000));
    default:
      return;
  }
}

function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}