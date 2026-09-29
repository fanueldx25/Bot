import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';
import { getSock, humanSend } from './bot.js';
import { isOwner } from './commands/access.js';
import { log } from './db.js';

/**
 * Detects view-once messages and re-sends the media to the owner.
 * Baileys gives us the message directly in messages.upsert when viewOnce=true.
 */
export async function handleViewOnce({ sock, msg, jid }) {
  const m = msg.message;
  const type = getContentType(m);
  if (!type) return;

  const inner =
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message;

  if (!inner) return;

  const innerType = getContentType(inner);
  const mediaNode = inner[innerType];
  if (!mediaNode) return;

  try {
    const buffer = await downloadMediaMessage(
      { key: msg.key, message: inner },
      'buffer',
      {},
      { logger: console, reuploadRequest: sock.updateMediaMessage }
    );

    const caption = mediaNode.caption || '';
    const kind = innerType.replace('Message', ''); // image | video | audio

    const payload = {};
    if (kind === 'image') payload.image = buffer;
    else if (kind === 'video') payload.video = buffer;
    else if (kind === 'audio') payload.audio = buffer;
    else return;

    if (caption) payload.caption = caption;

    // Send to owner's own chat
    const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    await sock.sendMessage(ownerJid, {
      ...payload,
      caption: `👁️ View-once from ${jid}${caption ? `\n\n${caption}` : ''}`,
    });

    await log('owner', 'info', `View-once ${kind} extracted from ${jid}`);
  } catch (e) {
    console.error('view-once extract failed:', e);
    await log('owner', 'error', `View-once extract failed: ${e.message}`);
  }
}