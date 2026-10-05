require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');

// --- Configuration ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;

// Choose a model from your Ollama Cloud dashboard
// Options from your screenshot: "gemma4:31b", "gpt-oss:120b", "gpt-oss:20b", "nemotron-3-nano:30b", "nemotron-3-super"
const OLLAMA_MODEL = 'gpt-oss:20b';

// Initialize the OpenAI client pointing to Ollama's cloud endpoint
const openai = new OpenAI({
  baseURL: 'https://ollama.com/v1',
  apiKey: OLLAMA_API_KEY,
});

// Initialize the Telegram Bot with polling
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log(`Bot is starting... Using model: ${OLLAMA_MODEL}`);

// --- Telegram Bot Handlers ---

// Handle the /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'there';
  
  bot.sendMessage(
    chatId,
    `Hi ${userName}! I'm an AI assistant powered by Ollama Cloud. I'm using the ${OLLAMA_MODEL} model. How can I help you today?`
  );
});

// Handle the /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Just send me any message, and I'll respond using the AI model!");
});

// Handle all incoming text messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Ignore commands (messages starting with '/') and non-text messages
  if (!text || text.startsWith('/')) return;
  
  // Show "typing..." status in Telegram
  bot.sendChatAction(chatId, 'typing');
  
  try {
    // Call the Ollama Cloud API via the OpenAI-compatible client
    const response = await openai.chat.completions.create({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful and friendly AI assistant.' },
        { role: 'user', content: text }
      ],
      // stream: false, // Set to true if you want to implement streaming later
    });
    
    const aiResponse = response.choices[0].message.content;
    
    // Send the AI response back to Telegram
    bot.sendMessage(chatId, aiResponse);
    
  } catch (error) {
    console.error('Error calling Ollama API:', error.message || error);
    bot.sendMessage(chatId, 'Sorry, I encountered an error while processing your request. Please try again later.');
  }
});

// Handle polling errors gracefully
bot.on('polling_error', (error) => {
  console.error('Telegram Polling Error:', error.message || error);
});