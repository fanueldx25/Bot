// commands/tools.js
import sharp from 'sharp'
import { evaluate } from 'mathjs'
import { resolveMediaMessage } from '../lib/helpers.js'
import { G, head, foot, stats, info, err, ok } from '../lib/format.js'

export default [
  {
    name: 'sticker',
    aliases: ['s', 'stiker'],
    category: 'tools',
    description: 'Convert an image to a sticker',
    async run({ msg, chatId, sock, reply, send, download }) {
      const target = resolveMediaMessage(msg, chatId)
      if (!target) return reply(err('Reply to an image with .sticker'))
      await reply(info('Sticker', 'Image → WebP', `  ${G.bolt} Processing…`))
      try {
        const buf = await download(target)
        const webp = await sharp(buf)
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 80 })
          .toBuffer()
        await send({ sticker: webp }, { quoted: msg })
      } catch (e) {
        await reply(err(e.message))
      }
    },
  },
  {
    name: 'toimg',
    aliases: ['toimage'],
    category: 'tools',
    description: 'Convert a sticker back to an image',
    async run({ msg, chatId, sock, reply, send, download }) {
      const target = resolveMediaMessage(msg, chatId)
      if (!target) return reply(err('Reply to a sticker with .toimg'))
      try {
        const buf = await download(target)
        const png = await sharp(buf).png().toBuffer()
        await send({ image: png, caption: '✓ Converted' }, { quoted: msg })
      } catch (e) {
        await reply(err(e.message))
      }
    },
  },
  {
    name: 'vv',
    aliases: ['viewonce', 'reveal'],
    category: 'tools',
    description: 'Capture a view-once photo, video or voice note',
    async run({ msg, chatId, sock, reply, send, download }) {
      const target = resolveMediaMessage(msg, chatId)
      if (!target) return reply(err('Reply to a view-once message with .vv'))

      const inner = target.message
      const media = inner.imageMessage || inner.videoMessage || inner.audioMessage
      if (!media) return reply(err('No view-once media found'))
      if (!media.viewOnce) return reply(err('Not a view-once message'))

      try {
        const buf = await download(target)
        if (inner.imageMessage) await send({ image: buf, caption: '📸 Captured' }, { quoted: msg })
        else if (inner.videoMessage) await send({ video: buf, caption: '🎥 Captured' }, { quoted: msg })
        else await send({ audio: buf, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg })
      } catch (e) {
        await reply(err(e.message))
      }
    },
  },
  {
    name: 'qr',
    aliases: ['qrcode'],
    category: 'tools',
    description: 'Generate a QR code from text',
    async run({ text, reply, send, msg }) {
      if (!text) return reply(err('Usage: .qr <text or url>'))
      const url =
        'https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=' +
        encodeURIComponent(text)
      await send(
        { image: { url }, caption: `🔳 ${text}` },
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
      if (!text) return reply(err('Usage: .calc 2 + 2 * 10'))
      try {
        const result = evaluate(text)
        await reply(
          info('Calc', 'Math Engine', stats({ input: text, result: String(result) }), 'Done'),
        )
      } catch {
        await reply(err('Invalid expression'))
      }
    },
  },
  {
    name: 'translate',
    aliases: ['tr'],
    category: 'tools',
    description: 'Translate text (default: English)',
    async run({ args, reply }) {
      const target = (args[0]?.length === 2 ? args.shift().toLowerCase() : 'en') || 'en'
      const query = args.join(' ')
      if (!query) return reply(err('Usage: .translate <lang> <text>'))
      try {
        const res = await fetch(
          `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=auto|${target}`,
        )
        const data = await res.json()
        const out = data?.responseData?.translatedText
        if (!out) return reply(err('Translation failed'))
        await reply(
          info('Translate', target.toUpperCase(), stats({ source: 'AUTO', target: target.toUpperCase() }) + '\n\n' + out, 'Done'),
        )
      } catch (e) {
        await reply(err(e.message))
      }
    },
  },
  {
    name: 'weather',
    aliases: ['w'],
    category: 'tools',
    description: 'Current weather for a city',
    async run({ text, reply }) {
      if (!text) return reply(err('Usage: .weather <city>'))
      try {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(text)}?format=j1`)
        if (!res.ok) return reply(err('Could not fetch weather'))
        const data = await res.json()
        const c = data.current_condition?.[0]
        if (!c) return reply(err('City not found'))
        await reply(
          info(
            'Weather',
            text,
            stats({
              temp: `${c.temp_C}°C (feels ${c.FeelsLikeC}°C)`,
              humidity: `${c.humidity}%`,
              wind: `${c.windspeedKmph} km/h`,
              sky: c.weatherDesc?.[0]?.value ?? '—',
            }),
          ),
        )
      } catch (e) {
        await reply(err(e.message))
      }
    },
  },
  {
    name: 'shorten',
    aliases: ['short'],
    category: 'tools',
    description: 'Shorten a long URL',
    async run({ text, reply }) {
      if (!/^https?:\/\//i.test(text)) return reply(err('Usage: .shorten https://…'))
      try {
        const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text)}`)
        const short = await res.text()
        await reply(
          info('Shorten', 'URL Compressor', stats({ long: text.slice(0, 40) + '…', short }), 'Done'),
        )
      } catch (e) {
        await reply(err(e.message))
      }
    },
  },
  {
    name: 'tts',
    category: 'tools',
    description: 'Convert text into a voice note',
    async run({ text, reply, send, msg }) {
      if (!text) return reply(err('Usage: .tts <text>'))
      const url =
        'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=' +
        encodeURIComponent(text.slice(0, 190))
      await send(
        { audio: { url }, mimetype: 'audio/mpeg', ptt: true },
        { quoted: msg },
      )
    },
  },
]