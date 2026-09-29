const API_KEY = process.env.AI_API_KEY;
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

async function queryAI(prompt, history = []) {
  if (!API_KEY) throw new Error('AI_API_KEY not configured');
  
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful WhatsApp assistant. Keep replies concise.' },
        ...history,
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
    }),
  });
  
  if (!res.ok) throw new Error(`AI error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '(no response)';
}

const history = new Map(); // jid -> messages[]

const commands = {
  ai: async ({ jid, args, reply }) => {
    const prompt = args.join(' ');
    if (!prompt) return reply({ text: '❗ Usage: .ai <prompt>' });
    await reply({ text: '🤔 Thinking...' });
    try {
      const ans = await queryAI(prompt);
      await reply({ text: ans });
    } catch (e) {
      await reply({ text: `❌ ${e.message}` });
    }
  },
  
  chat: async ({ jid, args, reply }) => {
    const prompt = args.join(' ');
    if (!prompt) return reply({ text: '❗ Usage: .chat <message>' });
    const h = history.get(jid) || [];
    h.push({ role: 'user', content: prompt });
    if (h.length > 20) h.splice(0, h.length - 20);
    try {
      const ans = await queryAI(prompt, h);
      h.push({ role: 'assistant', content: ans });
      history.set(jid, h);
      await reply({ text: ans });
    } catch (e) {
      await reply({ text: `❌ ${e.message}` });
    }
  },
  
  resetchat: async ({ jid, reply }) => {
    history.delete(jid);
    await reply({ text: '🧹 Chat context cleared.' });
  },
};

export default commands;