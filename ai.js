import OpenAI from 'openai'
import config from './config.js'

let client = null
if (config.ai.apiKey) {
  client = new OpenAI({ apiKey: config.ai.apiKey, baseURL: config.ai.baseUrl })
}

/* In-memory per-chat history. Swap for a Postgres table if you want it persistent. */
const histories = new Map()

const key = (chatId, userId) => `${chatId}:${userId}`

export const isEnabled = () => Boolean(client)

export async function chat({ chatId, userId = 'default', prompt, systemPrompt }) {
  if (!client) throw new Error('AI not configured (set OPENAI_API_KEY)')
  
  const k = key(chatId, userId)
  const history = histories.get(k) ?? [
    { role: 'system', content: systemPrompt ?? config.ai.systemPrompt },
  ]
  
  history.push({ role: 'user', content: prompt })
  
  const trimmed = [
    history[0],
    ...history.slice(1).slice(-config.ai.historyLimit),
  ]
  
  const res = await client.chat.completions.create({
    model: config.ai.model,
    messages: trimmed,
  })
  
  const reply = res.choices[0].message.content
  history.push({ role: 'assistant', content: reply })
  histories.set(k, history)
  return reply
}

export async function imagine(prompt) {
  if (!client) throw new Error('AI not configured (set OPENAI_API_KEY)')
  const res = await client.images.generate({
    model: config.ai.imageModel,
    prompt,
    size: '1024x1024',
    n: 1,
  })
  return res.data[0].url
}

export function forget(chatId, userId = 'default') {
  histories.delete(key(chatId, userId))
}