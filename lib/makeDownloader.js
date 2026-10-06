export function makeDownloader({ name, aliases = [], description, endpoint, kind }) {
  return {
    name,
    aliases,
    category: 'download',
    description,
    async run({ text, reply, sock, chatId, msg }) {
      if (!text) return reply(`Usage: .${name} <link>`)
      if (!endpoint) return reply(`⚠️ No API configured for *.${name}*.`)
      
      await reply('⏳ Fetching…')
      const res = await fetch(`${endpoint}${encodeURIComponent(text)}`)
      if (!res.ok) return reply(`❌ API error (${res.status})`)
      
      const data = await res.json()
      const media =
        data.url ?? data.result?.url ?? data.data?.url ?? data.link ?? null
      if (!media) return reply('❌ Could not extract a download link.')
      
      const payload =
        kind === 'audio' ?
        { audio: { url: media }, mimetype: 'audio/mpeg' } :
        { video: { url: media }, caption: data.title ?? '' }
      
      await sock.sendMessage(chatId, payload, { quoted: msg })
    },
  }
}