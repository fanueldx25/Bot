export default {
  botName: 'NovaBot',
  prefix: '.',
  ownerNumbers: (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean),

  jwtSecret: process.env.JWT_SECRET || 'change-me-in-prod',
  cookieName: 'wa_token',
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,

  // ── AI (Ollama Cloud) ──────────────────────────────────────
  ai: {
    apiKey: process.env.OLLAMA_API_KEY || '',
    baseUrl: process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1',
    model: process.env.OLLAMA_MODEL || 'gemma4:31b',
    systemPrompt:
      'You are NovaBot, a concise WhatsApp assistant. Reply in plain text, ' +
      'no markdown, no code fences. Keep answers under 3 short paragraphs.',
    historyLimit: 10,
  },

  // ── Behaviour defaults (overridable per-session in DB) ─────
  defaults: {
    mode: 'private',     // 'private' | 'public'
    selfMode: true,      // respond to messages the bot itself sends (self-chat)
  },

  apis: {
    ytmp3: process.env.API_YTMP3 || '',
    ytmp4: process.env.API_YTMP4 || '',
    tiktok: process.env.API_TIKTOK || '',
    instagram: process.env.API_INSTAGRAM || '',
  },
}