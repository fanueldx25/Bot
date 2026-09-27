// src/lib/utils.js

import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, readFile, unlink } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { runtime } from '../config.js';

const execP = promisify(exec);

/* ============================================================
   1. TIME / UPTIME
   ============================================================ */
export function formatUptime(ms = Date.now() - runtime.startedAt) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

export function serverTime() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/* ============================================================
   2. NUMBER / JID HELPERS
   ============================================================ */
export const cleanPhone = (raw = '') => raw.replace(/\D/g, '');

export const isValidPhone = (raw = '') => /^\d{8,15}$/.test(cleanPhone(raw));

export const toJid = (phone) => `${cleanPhone(phone)}@s.whatsapp.net`;

export const jidToNumber = (jid = '') => jid.split('@')[0].split(':')[0];

export const mention = (jid) => `@${jidToNumber(jid)}`;

/* ============================================================
   3. PERMISSION HELPERS
   ============================================================ */
export const isOwner = (sender, ownerNumber) =>
  jidToNumber(sender) === cleanPhone(ownerNumber);

export const isBotAdmin = (sender) =>
  runtime.admins.has(jidToNumber(sender));

export async function isGroupAdmin(sock, groupJid, sender) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const p = meta.participants.find(x => x.id === sender);
    return p?.admin === 'admin' || p?.admin === 'superadmin';
  } catch {
    return false;
  }
}

export async function isSenderAdmin(sock, ctx) {
  if (isBotAdmin(ctx.sender)) return true;
  if (isOwner(ctx.sender, ctx.config.ownerNumber)) return true;
  if (ctx.isGroup) return isGroupAdmin(sock, ctx.from, ctx.sender);
  return false;
}

/* ============================================================
   4. MEDIA DOWNLOAD / RE-UPLOAD
   ============================================================ */
/**
 * Download a media message (image, video, audio, document, sticker)
 * and return a Buffer.
 */
export async function downloadMedia(message, type) {
  const stream = await downloadContentFromMessage(message, type);
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
  return buf;
}

/**
 * Same as above but returns a temp file path + cleans itself up later.
 */
export async function downloadToTemp(message, type, ext = 'bin') {
  const buf = await downloadMedia(message, type);
  const filePath = join(tmpdir(), `wa_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  await writeFile(filePath, buf);
  return { buf, filePath };
}

/**
 * Run ffmpeg with args and clean up temp files afterwards.
 */
export async function runFfmpeg(input, output, filterArgs = '') {
  const cmd = `ffmpeg -y -i "${input}" ${filterArgs} "${output}"`;
  try {
    await execP(cmd);
    return await readFile(output);
  } finally {
    await unlink(input).catch(() => {});
    await unlink(output).catch(() => {});
  }
}

/**
 * Convert any media message to a WhatsApp sticker (512x512 webp).
 */
export async function toStickerBuffer(message, type = 'image') {
  const { filePath } = await downloadToTemp(message, type, type === 'video' ? 'mp4' : 'jpg');
  const outPath = join(tmpdir(), `sticker_${Date.now()}.webp`);
  const filter =
    'scale=512:512:force_original_aspect_ratio=decrease,' +
    'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';
  return runFfmpeg(filePath, outPath, `-vf "${filter}"`);
}

/* ============================================================
   5. REPLY / QUOTED MESSAGE HELPERS
   ============================================================ */
export function getQuoted(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

export function getQuotedParticipant(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.participant || null;
}

export function getMentions(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

export function getMessageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  );
}

/* ============================================================
   6. RANDOM / GENERIC
   ============================================================ */
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const chance = (pct) => Math.random() * 100 < pct;

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ============================================================
   7. TEXT FORMATTING
   ============================================================ */
export function codeBlock(text) {
  return `\`\`\`${text}\`\`\``;
}

export function inlineCode(text) {
  return `\`${text}\``;
}

export function truncate(text, max = 200) {
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

/* ============================================================
   8. SAFE JSON FETCH
   ============================================================ */
export async function fetchJson(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchText(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/* ============================================================
   9. WARN SYSTEM (shared across warn/warnings/resetwarn)
   ============================================================ */
export function addWarning(chatId, jid) {
  const all = runtime.warnings.get(chatId) || {};
  all[jid] = (all[jid] || 0) + 1;
  runtime.warnings.set(chatId, all);
  return all[jid];
}

export function getWarnings(chatId, jid) {
  return (runtime.warnings.get(chatId) || {})[jid] || 0;
}

export function clearWarnings(chatId, jid) {
  const all = runtime.warnings.get(chatId) || {};
  delete all[jid];
  runtime.warnings.set(chatId, all);
}