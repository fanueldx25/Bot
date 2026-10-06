// commands/download.js
import { makeDownloader } from '../lib/makeDownloader.js'
import config from '../config.js'
import { G } from '../lib/format.js'

export default [
  makeDownloader({
    name: 'ytmp3',
    aliases: ['yta', 'ytaudio'],
    description: 'Download YouTube audio as MP3',
    endpoint: config.apis.ytmp3,
    kind: 'audio',
    icon: G.bolt,
  }),
  makeDownloader({
    name: 'ytmp4',
    aliases: ['ytv', 'ytvideo'],
    description: 'Download a YouTube video',
    endpoint: config.apis.ytmp4,
    kind: 'video',
    icon: G.bar,
  }),
  makeDownloader({
    name: 'tiktok',
    aliases: ['tt'],
    description: 'Download a TikTok video',
    endpoint: config.apis.tiktok,
    kind: 'video',
    icon: G.diamond,
  }),
  makeDownloader({
    name: 'instagram',
    aliases: ['ig', 'reel'],
    description: 'Download an Instagram post or reel',
    endpoint: config.apis.instagram,
    kind: 'video',
    icon: G.pointer,
  }),
]