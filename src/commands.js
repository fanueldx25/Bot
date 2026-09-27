import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { evaluate } from 'mathjs';
import { runtime, config } from './config.js';
import { db } from './lib/database.js';

const execP = promisify(exec);

/* ---------- helpers ---------- */
const isAdmin = (ctx) =>
  runtime.admins.has(ctx.sender.split('@')[0]) ||
  runtime.admins.has(ctx.config.ownerNumber);

const isGroupAdmin = async (ctx) => {
  if (!ctx.isGroup) return false;
  const meta = await ctx.sock.groupMetadata(ctx.from);
  const p = meta.participants.find(x => x.id === ctx.sender);
  return p?.admin === 'admin' || p?.admin === 'superadmin';
};

const fmtUptime = () => {
  const s = Math.floor((Date.now() - runtime.startedAt) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
};

const getQuoted = (ctx) =>
  ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

const react = async (ctx, emoji) => {
  try {
    await ctx.sock.sendMessage(ctx.from, { react: { text: emoji, key: ctx.msg.key } });
  } catch {}
};

const PHONE_REGEX = /^\d{8,15}$/;

/* ============================================================
   ======================== COMMANDS ==========================
   ============================================================ */
export const commands = [

  /* ---------------------- GENERAL ---------------------- */
  {
    name: 'help',
    aliases: ['menu'],
    category: 'general',
    description: 'Show this menu',
    async run(ctx) {
      const groups = {};
      for (const c of commands) {
        if (c.hidden) continue;
        groups[c.category] ??= [];
        groups[c.category].push(c);
      }
      let out = `╭━━━━━━━━━━━━━━━━━━━━╮\n┃  🤖  *${config.botName.toUpperCase()}*\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n`;
      for (const [cat, list] of Object.entries(groups)) {
        out += `┌─ 📌 *${cat.toUpperCase()}* ─────────\n`;
        for (const c of list) {
          out += `│ ${config.prefixes[0]}${c.name.padEnd(14)} ${c.description || ''}\n`;
        }
        out += `└───────────────────────\n\n`;
      }
      out += `_Powered by Fanuels DX_`;
      await ctx.reply(out);
    },
  },
  {
    name: 'ping', category: 'general', description: 'Check bot alive',
    async run(ctx) {
      const t = Date.now();
      const m = await ctx.reply('🏓 ...');
      await ctx.sock.sendMessage(ctx.from,
        { text: `🏓 Pong! \`${Date.now() - t}ms\``, edit: m.key });
    },
  },
  {
    name: 'id', category: 'general', description: 'Your JID / number',
    async run(ctx) { await ctx.reply(`🆔 \`${ctx.sender}\``); },
  },
  {
    name: 'whoami', category: 'general', description: 'Check admin status',
    async run(ctx) {
      const admin = isAdmin(ctx) || await isGroupAdmin(ctx);
      await ctx.reply(`👤 ${admin ? '✅ Admin' : '❌ Not admin'}`);
    },
  },
  {
    name: 'time', category: 'general', description: 'Server time',
    async run(ctx) { await ctx.reply(`🕐 ${new Date().toLocaleString()}`); },
  },
  {
    name: 'uptime', category: 'general', description: 'Bot uptime',
    async run(ctx) { await ctx.reply(`⏱️ ${fmtUptime()}`); },
  },
  {
    name: 'echo', category: 'general', description: 'Repeat text',
    async run(ctx) {
      if (!ctx.text) return ctx.reply('Usage: .echo hello');
      await ctx.reply(ctx.text);
    },
  },
  {
    name: 'calc', category: 'general', description: 'Safe calculator',
    async run(ctx) {
      if (!ctx.text) return ctx.reply('Usage: .calc 2+2*3');
      try { await ctx.reply(`🧮 *${ctx.text}* = ${evaluate(ctx.text)}`); }
      catch { await ctx.reply('❌ Invalid expression'); }
    },
  },

  /* ---------------------- MEDIA ---------------------- */
  {
    name: 'sticker', aliases: ['s'], category: 'media',
    description: 'Image/video → sticker',
    async run(ctx) {
      const q = getQuoted(ctx);
      const media = q?.imageMessage || q?.videoMessage ||
                    ctx.msg.message?.imageMessage || ctx.msg.message?.videoMessage;
      if (!media) return ctx.reply('Reply to an image/video with .sticker');
      const type = (q?.imageMessage || ctx.msg.message?.imageMessage) ? 'image' : 'video';

      const stream = await downloadContentFromMessage(media, type);
      let buf = Buffer.alloc(0);
      for await (const c of stream) buf = Buffer.concat([buf, c]);

      const inPath = join(tmpdir(), `in_${Date.now()}`);
      const outPath = join(tmpdir(), `out_${Date.now()}.webp`);
      await writeFile(inPath, buf);

      const filter = type === 'image'
        ? `scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000`
        : `fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000`;

      await execP(`ffmpeg -y -i "${inPath}" -vf "${filter}" "${outPath}"`);
      const webp = await readFile(outPath);
      await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
      await unlink(inPath).catch(() => {});
      await unlink(outPath).catch(() => {});
    },
  },
  {
    name: 'toimg', category: 'media', description: 'Sticker → image',
    async run(ctx) {
      const q = getQuoted(ctx);
      if (!q?.stickerMessage) return ctx.reply('Reply to a sticker.');
      const stream = await downloadContentFromMessage(q.stickerMessage, 'sticker');
      let buf = Buffer.alloc(0);
      for await (const c of stream) buf = Buffer.concat([buf, c]);
      const inPath = join(tmpdir(), `s_${Date.now()}.webp`);
      const outPath = join(tmpdir(), `s_${Date.now()}.png`);
      await writeFile(inPath, buf);
      await execP(`ffmpeg -y -i "${inPath}" "${outPath}"`);
      const png = await readFile(outPath);
      await ctx.sock.sendMessage(ctx.from, { image: png }, { quoted: ctx.msg });
      await unlink(inPath).catch(() => {});
      await unlink(outPath).catch(() => {});
    },
  },
  {
    name: 'tts', category: 'media', description: 'Text → voice (uses free API)',
    async run(ctx) {
      if (!ctx.text) return ctx.reply('Usage: .tts hello world');
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(ctx.text)}&tl=en&client=tw-ob`;
      const r = await fetch(url);
      const buf = Buffer.from(await r.arrayBuffer());
      await ctx.sock.sendMessage(ctx.from,
        { audio: buf, mimetype: 'audio/mp4', ptt: true }, { quoted: ctx.msg });
    },
  },
  {
    name: 'getpp', category: 'media', description: 'Get profile picture',
    async run(ctx) {
      const target = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant || ctx.sender;
      try {
        const url = await ctx.sock.profilePictureUrl(target, 'image');
        await ctx.sock.sendMessage(ctx.from, { image: { url } }, { quoted: ctx.msg });
      } catch { await ctx.reply('❌ No profile picture.'); }
    },
  },
  {
    name: 'stext', category: 'media', description: 'Text → sticker',
    async run(ctx) {
      if (!ctx.text) return ctx.reply('Usage: .stext hello');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
        <rect width="100%" height="100%" fill="#111827"/>
        <text x="50%" y="50%" fill="#fff" font-size="48" font-family="Arial"
              text-anchor="middle" dominant-baseline="middle">${ctx.text.replace(/[<>&]/g, '')}</text>
      </svg>`;
      const inPath = join(tmpdir(), `t_${Date.now()}.svg`);
      const outPath = join(tmpdir(), `t_${Date.now()}.webp`);
      await writeFile(inPath, svg);
      await execP(`ffmpeg -y -i "${inPath}" "${outPath}"`);
      const webp = await readFile(outPath);
      await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
      await unlink(inPath).catch(() => {});
      await unlink(outPath).catch(() => {});
    },
  },

  /* ---------------------- FUN ---------------------- */
  {
    name: 'roll', category: 'fun', description: 'Roll dice (e.g. 2d6)',
    async run(ctx) {
      const spec = ctx.args[0] || '1d6';
      const m = /^(\d+)d(\d+)$/i.exec(spec);
      if (!m) return ctx.reply('Usage: .roll 2d6');
      const n = +m[1], sides = +m[2];
      if (n > 100 || sides > 1000) return ctx.reply('Too big.');
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
      await ctx.reply(`🎲 *${spec}* → [${rolls.join(', ')}] = *${rolls.reduce((a, b) => a + b, 0)}*`);
    },
  },
  {
    name: 'flip', category: 'fun', description: 'Flip a coin',
    async run(ctx) { await ctx.reply(`🪙 ${Math.random() < 0.5 ? 'Heads' : 'Tails'}`); },
  },
  {
    name: '8ball', category: 'fun', description: 'Magic 8-ball',
    async run(ctx) {
      const a = ['Yes.','No.','Maybe.','Definitely.','Absolutely not.','Ask again later.','Very likely.','Unclear.'];
      await ctx.reply(`🎱 ${a[Math.floor(Math.random() * a.length)]}`);
    },
  },
  {
    name: 'joke', category: 'fun', description: 'Random joke',
    async run(ctx) {
      const r = await fetch('https://official-joke-api.appspot.com/random_joke').then(r => r.json());
      await ctx.reply(`😂 ${r.setup}\n\n${r.punchline}`);
    },
  },
  {
    name: 'quote', category: 'fun', description: 'Random quote',
    async run(ctx) {
      const r = await fetch('https://api.quotable.io/random').then(r => r.json());
      await ctx.reply(`💬 _"${r.content}"_\n— ${r.author}`);
    },
  },
  {
    name: 'trivia', category: 'fun', description: 'Play a trivia question',
    async run(ctx) {
      const r = await fetch('https://opentdb.com/api.php?amount=1&type=multiple').then(r => r.json());
      const q = r.results[0];
      const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
      const answers = [...q.incorrect_answers, q.correct_answer]
        .map(decode).sort(() => Math.random() - 0.5);
      const list = answers.map((a, i) => `${i + 1}. ${a}`).join('\n');
      await ctx.reply(`❓ *${decode(q.question)}*\n\n${list}\n\n_Correct answer: ${decode(q.correct_answer)}_`);
    },
  },
  {
    name: 'truth', category: 'fun', description: 'Truth question',
    async run(ctx) {
      const truths = ['What is your biggest fear?','What is your biggest regret?','Who do you admire most?','What is a secret you never told anyone?'];
      await ctx.reply(`💭 ${truths[Math.floor(Math.random() * truths.length)]}`);
    },
  },
  {
    name: 'dare', category: 'fun', description: 'Dare challenge',
    async run(ctx) {
      const dares = ['Send a selfie.','Text your crush hi.','Speak in a foreign accent for 5 min.','Do 20 pushups.'];
      await ctx.reply(`🔥 ${dares[Math.floor(Math.random() * dares.length)]}`);
    },
  },
  {
    name: 'ship', category: 'fun', description: 'Ship two users',
    async run(ctx) {
      const mentioned = ctx.msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (mentioned.length < 2) return ctx.reply('Mention two users.');
      const pct = Math.floor(Math.random() * 101);
      await ctx.reply(`💞 @${mentioned[0].split('@')[0]} + @${mentioned[1].split('@')[0]} = *${pct}%*`,
        { mentions: mentioned });
    },
  },

  /* ---------------------- TOOLS ---------------------- */
  {
    name: 'shorten', category: 'tools', description: 'Shorten URL',
    async run(ctx) {
      if (!ctx.args[0]) return ctx.reply('Usage: .shorten <url>');
      const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(ctx.args[0])}`);
      await ctx.reply(`🔗 ${await r.text()}`);
    },
  },
  {
    name: 'weather', category: 'tools', description: 'Weather lookup',
    async run(ctx) {
      if (!ctx.text) return ctx.reply('Usage: .weather London');
      const r = await fetch(`https://wttr.in/${encodeURIComponent(ctx.text)}?format=3`).then(r => r.text());
      await ctx.reply(`🌤️ ${r}`);
    },
  },
  {
    name: 'translate', category: 'tools', description: 'Translate text (usage: .translate es hello)',
    async run(ctx) {
      if (ctx.args.length < 2) return ctx.reply('Usage: .translate <lang> <text>');
      const [lang, ...rest] = ctx.args;
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(rest.join(' '))}`;
      const data = await fetch(url).then(r => r.json());
      await ctx.reply(`🌐 ${data[0].map(x => x[0]).join('')}`);
    },
  },
  {
    name: 'lyrics', category: 'tools', description: 'Fetch song lyrics',
    async run(ctx) {
      if (!ctx.text) return ctx.reply('Usage: .lyrics <song>');
      const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(ctx.text.split(' - ')[0])}/${encodeURIComponent(ctx.text.split(' - ')[1] || ctx.text)}`).then(r => r.json());
      await ctx.reply(r.lyrics ? r.lyrics.slice(0, 2000) : '❌ Not found.');
    },
  },
  {
    name: 'dict', category: 'tools', description: 'Manage auto-correct dictionary',
    async run(ctx) {
      const sub = ctx.args[0];
      if (sub === 'add' && ctx.args.length >= 3) {
        const map = db.get('dict') || {};
        map[ctx.args[1]] = ctx.args[2];
        db.set('dict', map);
        return ctx.reply(`✅ ${ctx.args[1]} → ${ctx.args[2]}`);
      }
      if (sub === 'del' && ctx.args[1]) {
        const map = db.get('dict') || {};
        delete map[ctx.args[1]];
        db.set('dict', map);
        return ctx.reply(`🗑️ Removed.`);
      }
      const map = db.get('dict') || {};
      const lines = Object.entries(map).map(([k, v]) => `• ${k} → ${v}`).join('\n') || '(empty)';
      await ctx.reply(`📖 *Dictionary*\n${lines}\n\nUse: .dict add <wrong> <right> | .dict del <wrong>`);
    },
  },
  {
    name: 'edit', category: 'tools', description: 'Repost replied msg edited',
    async run(ctx) {
      const q = getQuoted(ctx);
      const original = q?.conversation || q?.extendedTextMessage?.text;
      if (!original) return ctx.reply('Reply to a text message.');
      await ctx.sock.sendMessage(ctx.from, { text: `✏️ *Edited:*\n${ctx.text}` });
    },
  },
  {
    name: 'topdf', category: 'tools', description: 'Convert replied doc/text to PDF',
    async run(ctx) {
      const q = getQuoted(ctx);
      const text = q?.conversation || q?.extendedTextMessage?.text;
      if (!text) return ctx.reply('Reply to a text message.');
      // light PDF writer
      const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${text.length + 40}>>stream\nBT /F1 12 Tf 40 750 Td (${text.replace(/[()\\]/g, '')}) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n0\n%%EOF`;
      await ctx.sock.sendMessage(ctx.from, {
        document: Buffer.from(pdf),
        mimetype: 'application/pdf',
        fileName: `note_${Date.now()}.pdf`,
      }, { quoted: ctx.msg });
    },
  },
  {
    name: 'format', category: 'tools', description: 'Normalize replied doc name',
    async run(ctx) {
      const q = getQuoted(ctx);
      if (!q?.documentMessage) return ctx.reply('Reply to a document.');
      const stream = await downloadContentFromMessage(q.documentMessage, 'document');
      let buf = Buffer.alloc(0);
      for await (const c of stream) buf = Buffer.concat([buf, c]);
      const cleanName = (q.documentMessage.fileName || 'file')
        .replace(/\s+/g, '_').replace(/[^\w.\-]/g, '');
      await ctx.sock.sendMessage(ctx.from, {
        document: buf,
        mimetype: q.documentMessage.mimetype,
        fileName: cleanName,
      }, { quoted: ctx.msg });
    },
  },

  /* ---------------------- ADMIN ---------------------- */
  {
    name: 'status', category: 'admin', description: 'Bot status',
    adminOnly: true,
    async run(ctx) {
      await ctx.reply(
        `📊 *Status*\nUptime: ${fmtUptime()}\nPaused: ${runtime.paused}\n` +
        `Admins: ${[...runtime.admins].length}\nCommands: ${commands.length}`
      );
    },
  },
  {
    name: 'logout', category: 'admin', description: 'Disconnect session',
    adminOnly: true,
    async run(ctx) {
      await ctx.reply('👋 Logging out…');
      const { logout } = await import('./connection.js');
      await logout();
    },
  },
  {
    name: 'restart', category: 'admin', description: 'Restart bot',
    adminOnly: true,
    async run(ctx) {
      await ctx.reply('🔄 Restarting…');
      const { restart } = await import('./connection.js');
      await restart();
    },
  },
  {
    name: 'pair', category: 'admin', description: 'Re-pair bot',
    adminOnly: true,
    async run(ctx) {
      const phone = (ctx.args[0] || config.ownerNumber).replace(/\D/g, '');
      if (!PHONE_REGEX.test(phone)) return ctx.reply('Usage: .pair <phone>');
      const { requestPairingCode } = await import('./connection.js');
      requestPairingCode(phone);
      await ctx.reply(`📲 Pairing code requested for ${phone}. Check the dashboard feed.`);
    },
  },
  {
    name: 'addadmin', category: 'admin', description: 'Promote user to admin',
    adminOnly: true,
    async run(ctx) {
      const target = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant || ctx.args[0];
      if (!target) return ctx.reply('Mention a user.');
      runtime.admins.add(target.split('@')[0]);
      await ctx.reply(`✅ Added admin ${target}`);
    },
  },
  {
    name: 'deladmin', category: 'admin', description: 'Demote admin',
    adminOnly: true,
    async run(ctx) {
      const target = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant || ctx.args[0];
      if (!target) return ctx.reply('Mention a user.');
      runtime.admins.delete(target.split('@')[0]);
      await ctx.reply(`🗑️ Removed admin ${target}`);
    },
  },

  /* ---------------------- PAUSE ---------------------- */
  {
    name: 'pause', category: 'pause', description: 'Pause bot',
    adminOnly: true,
    async run(ctx) {
      if (ctx.isGroup) { runtime.pausedChats.add(ctx.from); await ctx.reply('⏸️ Paused in this chat.'); }
      else { runtime.paused = true; await ctx.reply('⏸️ Bot paused globally.'); }
    },
  },
  {
    name: 'resume', category: 'pause', description: 'Resume bot',
    adminOnly: true,
    async run(ctx) {
      if (ctx.isGroup) { runtime.pausedChats.delete(ctx.from); await ctx.reply('▶️ Resumed in this chat.'); }
      else { runtime.paused = false; await ctx.reply('▶️ Bot resumed.'); }
    },
  },
  {
    name: 'pausestatus', category: 'pause', description: 'Pause status',
    async run(ctx) {
      await ctx.reply(`Global: ${runtime.paused ? '⏸️ paused' : '▶️ running'}\nThis chat: ${runtime.pausedChats.has(ctx.from) ? '⏸️ paused' : '▶️ running'}`);
    },
  },

  /* ---------------------- GROUP ---------------------- */
  {
    name: 'welcome', category: 'group', description: 'Welcome on/off',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const on = ctx.args[0] === 'on';
      if (on) runtime.welcome.set(ctx.from, true); else runtime.welcome.delete(ctx.from);
      await ctx.reply(`👋 Welcome ${on ? 'enabled' : 'disabled'}.`);
    },
  },
  {
    name: 'goodbye', category: 'group', description: 'Goodbye on/off',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const on = ctx.args[0] === 'on';
      if (on) runtime.goodbye.set(ctx.from, true); else runtime.goodbye.delete(ctx.from);
      await ctx.reply(`👋 Goodbye ${on ? 'enabled' : 'disabled'}.`);
    },
  },
  {
    name: 'setwelcome', category: 'group', description: 'Custom welcome (use @user)',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      if (!ctx.text) return ctx.reply('Usage: .setwelcome Hi @user');
      runtime.customWelcome.set(ctx.from, ctx.text);
      await ctx.reply('✅ Saved.');
    },
  },
  {
    name: 'tagall', category: 'group', description: 'Tag everyone',
    async run(ctx) {
      if (!ctx.isGroup) return ctx.reply('Group only.');
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const meta = await ctx.sock.groupMetadata(ctx.from);
      const mentions = meta.participants.map(p => p.id);
      const text = ctx.text || '📢 Attention everyone!';
      await ctx.sock.sendMessage(ctx.from, {
        text: `*${text}*\n\n${mentions.map(m => `@${m.split('@')[0]}`).join(' ')}`,
        mentions,
      });
    },
  },
  {
    name: 'hidetag', category: 'group', description: 'Hidden tag',
    async run(ctx) {
      if (!ctx.isGroup) return ctx.reply('Group only.');
      const meta = await ctx.sock.groupMetadata(ctx.from);
      await ctx.sock.sendMessage(ctx.from, {
        text: ctx.text || '📢',
        mentions: meta.participants.map(p => p.id),
      });
    },
  },
  {
    name: 'kick', category: 'group', description: 'Kick user',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const t = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!t) return ctx.reply('Mention or reply.');
      await ctx.sock.groupParticipantsUpdate(ctx.from, [t], 'remove');
      await ctx.reply('✅ Kicked.');
    },
  },
  {
    name: 'promote', category: 'group', description: 'Promote user',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const t = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!t) return ctx.reply('Mention or reply.');
      await ctx.sock.groupParticipantsUpdate(ctx.from, [t], 'promote');
      await ctx.reply('✅ Promoted.');
    },
  },
  {
    name: 'demote', category: 'group', description: 'Demote user',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const t = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!t) return ctx.reply('Mention or reply.');
      await ctx.sock.groupParticipantsUpdate(ctx.from, [t], 'demote');
      await ctx.reply('✅ Demoted.');
    },
  },
  {
    name: 'mute', category: 'group', description: 'Mute group',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      await ctx.sock.groupSettingUpdate(ctx.from, 'announcement');
      await ctx.reply('🔇 Group muted.');
    },
  },
  {
    name: 'unmute', category: 'group', description: 'Unmute group',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      await ctx.sock.groupSettingUpdate(ctx.from, 'not_announcement');
      await ctx.reply('🔊 Group unmuted.');
    },
  },
  {
    name: 'groupinfo', category: 'group', description: 'Group info',
    async run(ctx) {
      if (!ctx.isGroup) return ctx.reply('Group only.');
      const m = await ctx.sock.groupMetadata(ctx.from);
      await ctx.reply(`📋 *${m.subject}*\nID: ${m.id}\nMembers: ${m.participants.length}\nDesc: ${m.desc || '—'}`);
    },
  },
  {
    name: 'add', category: 'group', description: 'Add phone number to group',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const phone = (ctx.args[0] || '').replace(/\D/g, '');
      if (!PHONE_REGEX.test(phone)) return ctx.reply('Usage: .add <number>');
      await ctx.sock.groupParticipantsUpdate(ctx.from, [`${phone}@s.whatsapp.net`], 'add');
      await ctx.reply('✅ Added.');
    },
  },
  {
    name: 'remove', category: 'group', description: 'Remove mentioned user',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const t = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!t) return ctx.reply('Mention or reply.');
      await ctx.sock.groupParticipantsUpdate(ctx.from, [t], 'remove');
      await ctx.reply('✅ Removed.');
    },
  },

  /* ---------------------- MODERATION ---------------------- */
  {
    name: 'antilink', category: 'moderation', description: 'Anti-link on/off/action',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const mode = ctx.args[0] || 'off';
      if (mode === 'off') runtime.antilink.delete(ctx.from);
      else runtime.antilink.set(ctx.from, mode);
      await ctx.reply(`🛡️ Antilink → ${mode}`);
    },
  },
  {
    name: 'auto', category: 'moderation', description: 'Auto-correct in this chat',
    async run(ctx) {
      const on = ctx.args[0] === 'on';
      if (on) runtime.autoCorrect.set(ctx.from, true); else runtime.autoCorrect.delete(ctx.from);
      await ctx.reply(`🤖 Auto-correct ${on ? 'on' : 'off'}.`);
    },
  },
  {
    name: 'antimention', category: 'moderation', description: 'Block group mentions',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const on = ctx.args[0] === 'on';
      if (on) runtime.antimention.add(ctx.from); else runtime.antimention.delete(ctx.from);
      await ctx.reply(`🛡️ Antimention ${on ? 'on' : 'off'}.`);
    },
  },
  {
    name: 'reactions', category: 'moderation', description: 'Toggle bot reactions',
    async run(ctx) {
      const on = ctx.args[0] === 'on';
      if (on) runtime.reactions.add(ctx.from); else runtime.reactions.delete(ctx.from);
      await ctx.reply(`✨ Reactions ${on ? 'on' : 'off'}.`);
    },
  },
  {
    name: 'schedule', category: 'moderation', description: 'Schedule group open/close (usage: .schedule open 09:00)',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const [action, time] = ctx.args;
      if (!['open', 'close'].includes(action) || !/^\d{1,2}:\d{2}$/.test(time)) {
        return ctx.reply('Usage: .schedule <open|close> HH:MM');
      }
      const key = `schedule.${ctx.from}`;
      const list = db.get(key) || [];
      list.push({ action, time, setBy: ctx.sender, createdAt: Date.now() });
      db.set(key, list);
      await ctx.reply(`⏰ Scheduled ${action} at ${time}.`);
    },
  },
  {
    name: 'warn', category: 'moderation', description: 'Warn user (3 = kick)',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const t = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!t) return ctx.reply('Mention or reply.');
      const all = runtime.warnings.get(ctx.from) || {};
      all[t] = (all[t] || 0) + 1;
      runtime.warnings.set(ctx.from, all);
      await ctx.reply(`⚠️ Warned ${t} (${all[t]}/3)`);
      if (all[t] >= 3) {
        await ctx.sock.groupParticipantsUpdate(ctx.from, [t], 'remove');
        delete all[t];
        runtime.warnings.set(ctx.from, all);
      }
    },
  },
  {
    name: 'warnings', category: 'moderation', description: 'List warnings for a user',
    async run(ctx) {
      const t = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant || ctx.sender;
      const all = runtime.warnings.get(ctx.from) || {};
      await ctx.reply(`📋 ${t} → ${all[t] || 0}/3`);
    },
  },
  {
    name: 'resetwarn', category: 'moderation', description: 'Clear warnings',
    async run(ctx) {
      if (!await isGroupAdmin(ctx) && !isAdmin(ctx)) return ctx.reply('❌ Admin only.');
      const t = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant;
      const all = runtime.warnings.get(ctx.from) || {};
      delete all[t];
      runtime.warnings.set(ctx.from, all);
      await ctx.reply('♻️ Cleared.');
    },
  },

  /* ---------------------- SPECIAL ---------------------- */
  {
    name: 'vv', category: 'special', description: 'Reveal a view-once message',
    async run(ctx) {
      const q = getQuoted(ctx);
      if (!q) return ctx.reply('Reply to a view-once message.');
      // Re-send as normal media
      const inner = Object.values(q)[0];
      const type = Object.keys(q)[0].replace('Message', '');
      const stream = await downloadContentFromMessage(inner, type);
      let buf = Buffer.alloc(0);
      for await (const c of stream) buf = Buffer.concat([buf, c]);
      await ctx.sock.sendMessage(ctx.from, { [type]: buf, caption: '👁️ View-once revealed' });
    },
  },
  {
    name: 'vo', category: 'special', description: 'View-once capture (global)',
    async run(ctx) {
      const q = getQuoted(ctx);
      if (!q) return ctx.reply('Reply to a view-once message.');
      await ctx.reply('✅ View-once logged.');
    },
  },
  {
    name: 'autodl', category: 'special', description: 'Auto download',
    async run(ctx) {
      const on = ctx.args[0] === 'on';
      if (on) runtime.autodl.add(ctx.from); else runtime.autodl.delete(ctx.from);
      await ctx.reply(`📥 Autodl ${on ? 'on' : 'off'}.`);
    },
  },
  {
    name: 'poststatus', category: 'special', description: 'Post replied msg to your status',
    async run(ctx) {
      const q = getQuoted(ctx);
      const text = q?.conversation || q?.extendedTextMessage?.text || ctx.text;
      if (!text) return ctx.reply('Reply to a text.');
      await ctx.sock.sendMessage('status@broadcast', { text });
      await ctx.reply('✅ Posted to status.');
    },
  },
];