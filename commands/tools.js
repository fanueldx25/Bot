import sharp from 'sharp'
import { evaluate } from 'mathjs'
import { resolveMediaMessage } from '../lib/helpers.js'

export default [
  {
    name: 'sticker',
    aliases: ['s', 'stiker'],
    category: 'tools',
    description: 'Convert an image to a sticker',
    async run({ msg, chatId, sock, reply, download }) {
      const target = resolveMediaMessage(msg, chatId)
      if (!target) return reply('↩️ Reply to an *image* with *.sticker*')
      await reply('🎨 Creating sticker…')
      const buf = await download(target)
      const webp = await sharp(buf)
        .resize(512, 512, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .webp({ quality: 80 })
        .toBuffer()
      await sock.sendMessage(chatId, { sticker: webp }, { quoted: msg })
    },
  },
  {
    name: 'toimg',
    aliases: ['toimage'],
    category: 'tools',
    description: 'Convert a sticker back to an image',
    async run({ msg, chatId, sock, reply, download }) {
      const target = resolveMediaMessage(msg, chatId)
      if (!target) return reply('↩️ Reply to a *sticker* with *.toimg*')
      const buf = await download(target)
      const png = await sharp(buf).png().toBuffer()
      await sock.sendMessage(
        chatId,
        { image: png, caption: '✅ Converted' },
        { quoted: msg },
      )
    },
  },
  {
    name: 'vv',
    aliases: ['viewonce', 'reveal'],
    category: 'tools',
    description: 'Capture a view-once photo, video or voice note',
    async run({ msg, chatId, sock, reply, download }) {
      const target = resolveMediaMessage(msg, chatId)
      if (!target) return reply('↩️ Reply to a *view-once* message with *.vv*')

      const inner = target.message
      const media =
        inner.imageMessage || inner.videoMessage || inner.audioMessage
      if (!media) return reply('❌ No view-once media found.')
      if (!media.viewOnce) return reply('⚠️ Not a view-once message.')

      const buf = await download(target)
      if (inner.imageMessage) {
        await sock.sendMessage(
          chatId,
          { image: buf, caption: '📸 View-once image' },
          { quoted: msg },
        )
      } else if (inner.videoMessage) {
        await sock.sendMessage(
          chatId,
          { video: buf, caption: '🎥 View-once video' },
          { quoted: msg },
        )
      } else {
        await sock.sendMessage(
          chatId,
          { audio: buf, mimetype: 'audio/mpeg', ptt: true },
          { quoted: msg },
        )
      }
    },
  },
  {
    name: 'qr',
    aliases: ['qrcode'],
    category: 'tools',
    description: 'Generate a QR code from text',
    async run({ text, reply, sock, chatId, msg }) {
      if (!text) return reply('Usage: *.qr <text or url>*')
      const url =
        'https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=' +
        encodeURIComponent(text)
      await sock.sendMessage(
        chatId,
        { image: { url }, caption: `🔳 QR for:\n${text}` },
        { quoted: msg },
      )
    },
  },
  {
    name: 'calc',
    aliases: ['math', 'calculate'],
    category: 'tools',
    description: 'Evaluate a math expression',
    async run({ text, reply }) {
      if (!text) return reply('Usage: *.calc 2 + 2 * 10*')
      try {
        const result = evaluate(text)
        await reply(`🧮 \`${text}\` = *${result}*`)
      } catch {
        await reply('❌ Invalid expression.')
      }
    },
  },
  {
    name: 'translate',
    aliases: ['tr'],
    category: 'tools',
    description: 'Translate text (default: English)',
    async run({ args, reply }) {
      const target = args[0]?.length === 2 ? args.shift().toLowerCase() : 'en'
      const query = args.join(' ')
      if (!query) return reply('Usage: *.translate <lang> <text>*')
      const res = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=auto|${target}`,
      )
      const data = await res.json()
      const out = data?.responseData?.translatedText
      await reply(out ? `🌐 *${target.toUpperCase()}*\n${out}` : '❌ Translation failed.')
    },
  },
  {
    name: 'weather',
    aliases: ['w'],
    category: 'tools',
    description: 'Current weather for a city',
    async run({ text, reply }) {
      if (!text) return reply('Usage: *.weather <city>*')
      const res = await fetch(
        `https://wttr.in/${encodeURIComponent(text)}?format=j1`,
      )
      if (!res.ok) return reply('❌ Could not fetch weather.')
      const data = await res.json()
      const c = data.current_condition?.[0]
      if (!c) return reply('❌ City not found.')
      await reply(
        `🌤️ *${text}*\n` +
          `├ 🌡️ ${c.temp_C}°C (feels ${c.FeelsLikeC}°C)\n` +
          `├ 💧 Humidity: ${c.humidity}%\n` +
          `├ 💨 Wind: ${c.windspeedKmph} km/h\n` +
          `└ 📝 ${c.weatherDesc?.[0]?.value ?? ''}`,
      )
    },
  },
  {
    name: 'shorten',
    aliases: ['short'],
    category: 'tools',
    description: 'Shorten a long URL',
    async run({ text, reply }) {
      if (!/^https?:\/\//i.test(text)) return reply('Usage: *.shorten https://…*')
      const res = await fetch(
        `https://tinyurl.com/api-create.php?url=${encodeURIComponent(text)}`,
      )
      await reply(`🔗 ${await res.text()}`)
    },
  },
  {
    name: 'tts',
    category: 'tools',
    description: 'Convert text into a voice note',
    async run({ text, reply, sock, chatId, msg }) {
      if (!text) return reply('Usage: *.tts <text>*')
      const url =
        'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' +
        encodeURIComponent(text.slice(0, 190))
      await sock.sendMessage(
        chatId,
        { audio: { url }, mimetype: 'audio/mpeg', ptt: true },
        { quoted: msg },
      )
    },
  },
]