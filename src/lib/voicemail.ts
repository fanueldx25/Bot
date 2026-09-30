import axios from 'axios';
import { db } from '../db/index.ts';
import { voicemails } from '../db/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { addLog } from './config.ts';

// Track callers waiting to leave a voicemail (15 minutes window)
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

/**
 * Generates an audio buffer for the voicemail greeting using high-quality TTS.
 */
export async function generateVoicemailAudio(
  text: string,
  lang: string = 'en'
): Promise<Buffer | null> {
  const cleanText = text.trim();
  if (!cleanText) return null;

  // 1. Google Translate TTS
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://translate.google.com/',
      },
    });
    if (res.data && res.data.byteLength > 100) {
      return Buffer.from(res.data);
    }
  } catch (err: any) {
    console.warn('Google TTS for voicemail greeting error:', err.message);
  }

  // 2. Fallback TTS API
  try {
    const fallbackUrl = `https://api.vreden.my.id/api/tts?text=${encodeURIComponent(cleanText)}`;
    const fallbackRes = await axios.get(fallbackUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
    });
    if (fallbackRes.data && fallbackRes.data.byteLength > 100) {
      return Buffer.from(fallbackRes.data);
    }
  } catch (err: any) {
    console.warn('Fallback TTS error:', err.message);
  }

  return null;
}

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
        messageText: null,
      })
      .returning({ id: voicemails.id });

    const newId = inserted[0]?.id;
    if (newId) {
      activeVoicemailCallers.set(from, {
        id: newId,
        callId,
        callerNumber,
        timestamp: Date.now(),
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
        audioUrl: audioUrl || null,
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
