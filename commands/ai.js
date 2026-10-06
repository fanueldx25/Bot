// commands/ai.js
import * as AI from '../ai.js'
import { G, info, err, stats, ok } from '../lib/format.js'

export default [
  {
    name: 'ai',
    aliases: ['ask', 'gpt'],
    category: 'ai',
    description: 'Ask the AI anything',
    async run({ chatId, sender, text, reply }) {
      if (!text) {
        return reply(err('Usage: .ai <prompt>'))
      }
      if (!AI.isEnabled()) {
        return reply(err('AI not configured (set OLLAMA_API_KEY)'))
      }

      try {
        const out = await AI.chat({ chatId, userId: sender, prompt: text })
        await reply(
          info(
            'AI',
            'Response',
            stats({ prompt: text.slice(0, 50) + (text.length > 50 ? '…' : '') }) +
              '\n\n' +
              out,
            'Ollama Cloud',
          ),
        )
      } catch (e) {
        await reply(err(e.message))
      }
    },
  },
  {
    name: 'imagine',
    aliases: ['img', 'draw'],
    category: 'ai',
    description: 'Generate an image from a prompt',
    async run({ text, reply, send, msg }) {
      if (!text) return reply(err('Usage: .imagine <prompt>'))
      await reply(info('Imagine', 'Generating', stats({ prompt: text })))
      try {
        const url = await AI.imagine(text)
        await send({ image: { url }, caption: `🎨 ${text}` }, { quoted: msg })
      } catch (e) {
        await reply(err(e.message))
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
      await reply(ok('AI', { action: 'HISTORY CLEARED' }, 'Done'))
    },
  },
]