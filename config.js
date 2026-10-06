export default {
  botName: 'NovaBot',
  prefix: '.',
  ownerNumbers: (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean),
  
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-prod',
  cookieName: 'wa_token',
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,
  
  ai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    imageModel: process.env.OPENAI_IMAGE_MODEL || 'dall-e-3',
    systemPrompt: 'You are NovaBot, a helpful WhatsApp assistant. Keep replies short.',
    historyLimit: 10,
  },
  
  apis: {
    ytmp3: process.env.API_YTMP3 || '',
    ytmp4: process.env.API_YTMP4 || '',
    tiktok: process.env.API_TIKTOK || '',
    instagram: process.env.API_INSTAGRAM || '',
  },
}