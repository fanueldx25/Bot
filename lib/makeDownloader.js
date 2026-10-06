// lib/makeDownloader.js
import { G, head, foot, stats, info, err } from './format.js'

/**
 * Factory for the downloader commands — they all follow the same
 * fetch-URL -> send-media shape, so we generate them from one template.
 *
 * @param {object}  opts
 * @param {string}  opts.name         command name, e.g. 'ytmp3'
 * @param {string[]} [opts.aliases]   alternative triggers
 * @param {string}  opts.description  shown in .menu
 * @param {string}  opts.endpoint     API base URL — the link is appended raw
 * @param {'audio'|'video'} opts.kind media type to send back
 */
export function makeDownloader({ name, aliases = [], description, endpoint, kind }) {
  return {
    name,
    aliases,
    category: 'download',
    description,
    
    async run({ text, reply, send, msg }) {
      /* ── Input guards ─────────────────────────────────── */
      if (!text) {
        return reply(err(`Usage: .${name} <link>`))
      }
      if (!endpoint) {
        return reply(
          err(`No API configured for .${name}\nSet API_${name.toUpperCase()} in Render → Environment`),
        )
      }
      
      /* ── Fetching notice ──────────────────────────────── */
      await reply(
        info(
          'Download',
          `${name.toUpperCase()} · FETCHING`,
          `  ${G.bolt} Contacting API…`,
        ),
      )
      
      try {
        const res = await fetch(`${endpoint}${encodeURIComponent(text)}`)
        if (!res.ok) {
          return reply(err(`API error (${res.status})`))
        }
        
        const data = await res.json()
        const media =
          data.url ??
          data.result?.url ??
          data.data?.url ??
          data.link ??
          null
        
        if (!media) {
          return reply(err('Could not extract a download link'))
        }
        
        /* ── Result summary before sending the file ───── */
        await reply(
          info(
            'Download',
            name.toUpperCase(),
            stats({
              title: (data.title ?? '(untitled)').slice(0, 40),
              kind,
              size: data.size ?? data.filesize ?? '—',
            }),
          ),
        )
        
        /* ── Dispatch the media ────────────────────────── */
        const payload =
          kind === 'audio' ?
          { audio: { url: media }, mimetype: 'audio/mpeg' } :
          { video: { url: media }, caption: data.title ?? '' }
        
        await send(payload, { quoted: msg })
      } catch (e) {
        await reply(err(e.message))
      }
    },
  }
}