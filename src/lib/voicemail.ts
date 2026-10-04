import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
// @ts-ignore
import ffmpeg from 'fluent-ffmpeg';
import { db } from '../db/index.ts';
import { voicemails } from '../db/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { addLog } from './config.ts';

// ---------------------------------------------------------------------------
// Pending voicemail sessions
// ---------------------------------------------------------------------------

interface PendingVoicemail {
  id: number;
  callId: string;
  callerNumber: string;
  timestamp: number;
}

const activeVoicemailCallers = new Map<string, PendingVoicemail>();

// Cleanup stale pending voicemails older than 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [from, data] of activeVoicemailCallers.entries()) {
    if (now - data.timestamp > 15 * 60 * 1000) {
      activeVoicemailCallers.delete(from);
    }
  }
}, 60 * 1000);

// ---------------------------------------------------------------------------
// TTS helpers
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TMP = os.tmpdir();
const ttsCache = new Map<string, { buffer: Buffer; ts: number }>();
const TTS_CACHE_TTL = 30 * 60 * 1000; // 30 min
const TTS_CACHE_MAX = 100;

function cacheKey(text: string, lang: string) {
  return crypto.createHash('sha1').update(`${lang}|${text}`).digest('hex');
}

function getCached(text: string, lang: string): Buffer | null {
  const k = cacheKey(text, lang);
  const entry = ttsCache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTS_CACHE_TTL) {
    ttsCache.delete(k);
    return null;
  }
  return entry.buffer;
}

function setCached(text: string, lang: string, buffer: Buffer) {
  if (ttsCache.size >= TTS_CACHE_MAX) {
    const oldest = [...ttsCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) ttsCache.delete(oldest[0]);
  }
  ttsCache.set(cacheKey(text, lang), { buffer, ts: Date.now() });
}

/**
 * Reject anything that isn't actually an audio stream.
 * Catches HTML error pages, JSON errors, empty responses, tiny stubs.
 */
function looksLikeAudio(buf: Buffer, contentType?: string): boolean {
  if (!buf || buf.length < 1024) return false;

  // MP3: "ID3" tag OR frame sync 0xFF 0xFB / 0xF3 / 0xF2 / 0xFA
  if (buf.length > 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync

  // OGG: "OggS"
  if (buf.length > 4 && buf.toString('ascii', 0, 4) === 'OggS') return true;

  // WAV: "RIFF"..."WAVE"
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return true;

  // M4A/MP4: "ftyp" at offset 4
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') return true;

  // WebM/MKV: EBML header
  if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;

  // Content-type as a soft signal (only if it clearly says audio/*)
  if (contentType && /^audio\//i.test(contentType)) return true;

  // HTML/JSON error page — reject explicitly
  const head = buf.toString('utf8', 0, Math.min(64, buf.length)).trimStart();
  if (head.startsWith('<') || head.startsWith('{') || head.startsWith('[')) return false;

  return false;
}

/**
 * Normalize any audio buffer to a clean, WhatsApp-friendly MP3.
 * Adds ID3 headers, correct bitrate, and proper encoding.
 */
async function normalizeToMp3(input: Buffer, label: string): Promise<Buffer | null> {
  const inPath = path.join(TMP, `tts-in-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outPath = path.join(TMP, `tts-out-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);

  try {
    fs.writeFileSync(inPath, input);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .audioChannels(1)          // mono — better for voice
        .audioFrequency(44100)     // standard sample rate
        .format('mp3')
        .outputOptions([
          '-write_id3v2', '1',     // ensure ID3v2 header
          '-id3v2_version', '3',   // v3 is the most compatible
          '-map_metadata', '-1'    // strip weird metadata
        ])
        .on('end', () => resolve())
        .on('error', (e: any) => reject(new Error(e?.message || 'ffmpeg failed')))
        .save(outPath);
    });

    if (!fs.existsSync(outPath)) return null;
    const normalized = fs.readFileSync(outPath);
    if (!looksLikeAudio(normalized, 'audio/mpeg')) return null;

    return normalized;
  } catch (e: any) {
    console.warn(`[tts:${label}] normalize failed:`, e.message);
    return null;
  } finally {
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
  }
}

/**
 * Attempt one TTS source and return the raw buffer if it looks like real audio.
 */
async function fetchTts(url: string, headers: Record<string, string> = {}): Promise<Buffer | null> {
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': UA,
        Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      }
    });

    if (res.status < 200 || res.status >= 300) return null;

    const contentType = String(res.headers['content-type'] || '');
    const buf = Buffer.from(res.data || []);
    if (!looksLikeAudio(buf, contentType)) return null;

    return buf;
  } catch {
    return null;
  }
}

/**
 * Generates a normalized MP3 buffer for the voicemail greeting.
 * Tries multiple TTS endpoints, validates each, then ffmpeg-normalizes.
 */
export async function generateVoicemailAudio(
  text: string,
  lang: string = 'en'
): Promise<Buffer | null> {
  const cleanText = text.trim();
  if (!cleanText) return null;

  const cached = getCached(cleanText, lang);
  if (cached) return cached;

  const encoded = encodeURIComponent(cleanText);
  const langSafe = encodeURIComponent(lang || 'en');

  // Ordered list of sources. All are free and don't require keys.
  const sources: Array<{ name: string; url: string; headers?: Record<string, string> }> = [
    {
      name: 'google-gtx',
      url: `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${langSafe}&client=gtx&ttsspeed=1`,
      headers: { Referer: 'https://translate.google.com/' }
    },
    {
      name: 'google-tw-ob',
      url: `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${langSafe}&client=tw-ob`,
      headers: { Referer: 'https://translate.google.com/' }
    },
    {
      // StreamElements free TTS (returns MP3, well-formed, no key needed)
      name: 'streamelements-brian',
      url: `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encoded}`
    },
    {
      // Alternate Google host (sometimes works when translate.google.com is rate-limited)
      name: 'google-translate-alt',
      url: `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${langSafe}&client=gtx`,
      headers: { Referer: 'https://translate.google.com/' }
    }
  ];

  for (const source of sources) {
    const raw = await fetchTts(source.url, source.headers);
    if (!raw) {
      console.warn(`[tts:${source.name}] no valid audio returned`);
      continue;
    }

    console.log(`[tts:${source.name}] got ${raw.length} bytes, normalizing...`);
    const normalized = await normalizeToMp3(raw, source.name);
    if (!normalized) {
      console.warn(`[tts:${source.name}] normalization failed`);
      continue;
    }

    console.log(`[tts:${source.name}] normalized to ${normalized.length} bytes`);
    setCached(cleanText, lang, normalized);
    return normalized;
  }

  console.error('[tts] all TTS sources failed');
  return null;
}

// ---------------------------------------------------------------------------
// Incoming call tracking
// ---------------------------------------------------------------------------

/**
 * Records an incoming call in the database and prepares for caller's voicemail reply.
 */
export async function recordIncomingCall(
  callId: string,
  from: string,
  callerName?: string,
  isVideo: boolean = false
): Promise<number | null> {
  const callerNumber = from.split('@')[0] || from;
  try {
    const inserted = await db
      .insert(voicemails)
      .values({
        callerNumber,
        callerName: callerName || `+${callerNumber}`,
        callId,
        callType: isVideo ? 'video' : 'voice',
        status: 'missed',
        messageText: null
      })
      .returning({ id: voicemails.id });

    const newId = inserted[0]?.id;
    if (newId) {
      activeVoicemailCallers.set(from, {
        id: newId,
        callId,
        callerNumber,
        timestamp: Date.now()
      });
      return newId;
    }
  } catch (error: any) {
    console.error('Failed to log incoming call to voicemails table:', error.message);
  }
  return null;
}

/**
 * Checks if a sender recently placed a call and has a pending voicemail session.
 */
export function isExpectingVoicemail(from: string): boolean {
  return activeVoicemailCallers.has(from);
}

/**
 * Retrieves the pending voicemail record for a caller if within active window.
 */
export function getPendingVoicemail(from: string): PendingVoicemail | undefined {
  return activeVoicemailCallers.get(from);
}

/**
 * Saves the caller's recorded message (voice note or text message) into the database.
 */
export async function recordVoicemailMessage(
  from: string,
  messageText: string,
  isVoiceNote: boolean = false,
  audioUrl?: string
): Promise<{ success: boolean; id?: number; callerNumber?: string }> {
  const pending = activeVoicemailCallers.get(from);
  if (!pending) return { success: false };

  try {
    await db
      .update(voicemails)
      .set({
        status: 'left_message',
        messageText,
        isVoiceNote: isVoiceNote ? 'true' : 'false',
        audioUrl: audioUrl || null
      })
      .where(eq(voicemails.id, pending.id));

    activeVoicemailCallers.delete(from);
    addLog(
      `Voicemail message recorded from +${pending.callerNumber} (${isVoiceNote ? 'Voice Note' : 'Text'})`,
      'info'
    );
    return { success: true, id: pending.id, callerNumber: pending.callerNumber };
  } catch (err: any) {
    console.error('Failed to update voicemail record with caller message:', err.message);
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Dashboard / DB helpers
// ---------------------------------------------------------------------------

/**
 * Returns latest voicemails for dashboard display.
 */
export async function getVoicemailList(limit: number = 50) {
  try {
    return await db
      .select()
      .from(voicemails)
      .orderBy(desc(voicemails.timestamp))
      .limit(limit);
  } catch (err: any) {
    console.error('Failed to fetch voicemails from DB:', err.message);
    return [];
  }
}

/**
 * Deletes a single voicemail by ID.
 */
export async function deleteVoicemail(id: number): Promise<boolean> {
  try {
    await db.delete(voicemails).where(eq(voicemails.id, id));
    return true;
  } catch (err: any) {
    console.error('Failed to delete voicemail:', err.message);
    return false;
  }
}

/**
 * Clears all voicemails.
 */
export async function clearAllVoicemails(): Promise<boolean> {
  try {
    await db.delete(voicemails);
    return true;
  } catch (err: any) {
    console.error('Failed to clear voicemails:', err.message);
    return false;
  }
}