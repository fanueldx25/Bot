import * as AI from '../ai.js'

export default [
  {
    name: 'ai',
    aliases: ['ask', 'gpt'],
    category: 'ai',
    description: 'Ask the AI anything',
    async run({ chatId, sender, text, reply }) {
      if (!text) return reply('Usage: *.ai <prompt>*')
      if (!AI.isEnabled()) return reply('⚠️ AI is not configured.')

      try {
        const out = await AI.chat({ chatId, userId: sender, prompt: text })
        await reply(`🧠 ${out}`)
      } catch (e) {
        await reply(`❌ AI error: ${e.message}`)
      }
    },
  },
  {
    name: 'imagine',
    aliases: ['img', 'dalle'],
    category: 'ai',
    description: 'Generate an image from a prompt',
    async run({ text, reply, sock, chatId, msg }) {
      if (!text) return reply('Usage: *.imagine <prompt>*')
      if (!AI.isEnabled()) return reply('⚠️ AI is not configured.')

      await reply('🎨 Generating image…')
      try {
        const url = await AI.imagine(text)
        await sock.sendMessage(
          chatId,
          { image: { url }, caption: `🎨 ${text}` },
          { quoted: msg },
        )
      } catch (e) {
        await reply(`❌ Image error: ${e.message}`)
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
      await reply('🧹 Conversation cleared.')
    },
  },
]