import * as AI from '../ai.js'
import { header, kv, row } from '../lib/format.js'

export default [
  {
    name: 'ai',
    aliases: ['ask', 'gpt'],
    category: 'ai',
    description: 'Ask the AI anything',
    async run({ chatId, sender, text, reply }) {
      if (!text) {
        return reply(
          header('AI', 'ASSISTANT') + '\n\n' +
          kv({ Usage: '.ai <prompt>', Model: 'ollama-cloud' }),
        )
      }
      if (!AI.isEnabled()) {
        return reply(header('AI', 'OFFLINE') + '\n\n' + kv({ Reason: 'OLLAMA_API_KEY not set' }))
      }

      try {
        const out = await AI.chat({ chatId, userId: sender, prompt: text })
        await reply(
          header('AI', 'RESPONSE') + '\n\n' +
          kv({ Prompt: text.slice(0, 60) + (text.length > 60 ? '…' : '') }) +
          '\n\n' + out,
        )
      } catch (e) {
        await reply(header('AI', 'ERROR') + '\n\n' + kv({ Message: e.message }))
      }
    },
  },
  {
    name: 'imagine',
    aliases: ['img', 'draw'],
    category: 'ai',
    description: 'Generate an image from a prompt (via Pollinations)',
    async run({ text, reply, send, msg }) {
      if (!text) {
        return reply(header('Imagine', 'IMAGE GEN') + '\n\n' + kv({ Usage: '.imagine <prompt>' }))
      }
      await reply(header('Imagine', 'GENERATING') + '\n\n' + kv({ Prompt: text }))
      try {
        const url = await AI.imagine(text)
        await send(
          { image: { url }, caption: `🎨 ${text}` },
          { quoted: msg },
        )
      } catch (e) {
        await reply(header('Imagine', 'ERROR') + '\n\n' + kv({ Message: e.message }))
      }
    },
  },
  {
    name: 'forget',
    aliases: ['reset'],
    category: 'ai',
    description: 'Clear your AI conversation history',
    async run({ chatId, sender, reply }) {
      AI.forget(chatId, sender)
      await reply(header('AI', 'HISTORY CLEARED') + '\n\n' + kv({ Status: 'done' }))
    },
  },
]