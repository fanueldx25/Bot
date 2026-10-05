require('dotenv').config();
const { Bot, webhookCallback } = require('node-telegram-bot-api');
const express = require('express');
const OpenAI = require('openai');

// --- Configuration ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
// Render automatically provides the PORT and RENDER_EXTERNAL_URL environment variables
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

if (!TELEGRAM_TOKEN || !OLLAMA_API_KEY) {
  console.error('❌ Missing environment variables. Check your .env file or Render settings.');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('❌ RENDER_EXTERNAL_URL is not set. Webhook mode requires this.');
  process.exit(1);
}

// Choose a model from your Ollama Cloud dashboard
const OLLAMA_MODEL = 'gpt-oss:20b';

// Initialize the OpenAI client pointing to Ollama's cloud endpoint
const openai = new OpenAI({
  baseURL: 'https://ollama.com/v1',
  apiKey: OLLAMA_API_KEY,
});

// Initialize the Telegram Bot using the v2 API
const bot = new Bot(TELEGRAM_TOKEN);

// --- Bot Command and Message Handlers (v2 Middleware Style) ---

// Handle the /start command
bot.command('start', (ctx) => {
  const userName = ctx.from.first_name || 'there';
  ctx.reply(
    `Hi ${userName}! I'm an AI assistant powered by Ollama Cloud. ` +
    `I'm using the ${OLLAMA_MODEL} model. How can I help you today?`
  );
});

// Handle the /help command
bot.command('help', (ctx) => {
  ctx.reply("Just send me any message, and I'll respond using the AI model!");
});

// Handle all incoming text messages
bot.on('message', async (ctx) => {
  const text = ctx.message.text;
  
  // Ignore commands (messages starting with '/')
  if (!text || text.startsWith('/')) return;
  
  // Show "typing..." status
  await ctx.api.sendChatAction({ chat_id: ctx.chat.id, action: 'typing' });
  
  try {
    // Call Ollama Cloud API via OpenAI-compatible client
    const response = await openai.chat.completions.create({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful and friendly AI assistant.' },
        { role: 'user', content: text }
      ],
    });
    
    const aiResponse = response.choices[0].message.content;
    await ctx.reply(aiResponse);
    
  } catch (error) {
    console.error('❌ Error calling Ollama API:', error.message || error);
    await ctx.reply('Sorry, I encountered an error while processing your request. Please try again later.');
  }
});

// Last-resort error handler
bot.catch((err, ctx) => {
  console.error('❌ Bot handler failed:', err);
});

// --- Set up the web server and webhook ---
const app = express();
app.use(express.json());

// The webhook endpoint that Telegram will send updates to
app.use(`/webhook/${TELEGRAM_TOKEN}`, webhookCallback(bot, 'express'));

// A simple health check endpoint for Render
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

// Start the server
app.listen(PORT, async () => {
  console.log(`✅ Web server is listening on port ${PORT}`);
  try {
    // Set the webhook with Telegram
    await bot.api.setWebhook(`${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`);
    console.log(`✅ Webhook set to: ${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`);
  } catch (error) {
    console.error('❌ Failed to set webhook:', error.message || error);
  }
});