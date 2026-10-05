import os
import logging
from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    ApplicationBuilder, 
    CommandHandler, 
    MessageHandler, 
    filters, 
    ContextTypes
)
from openai import OpenAI

# 1. Load Environment Variables
load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY")
OLLAMA_MODEL = "gpt-oss:20b"

# 2. Setup Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", 
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# 3. Handlers (Start, Help, Message)
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_name = update.effective_user.first_name or "there"
    await update.message.reply_text(
        f"Hi {user_name}! I'm an AI assistant powered by Ollama Cloud. "
        f"I'm using the {OLLAMA_MODEL} model."
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Just send me any message, and I'll respond!")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_message = update.message.text
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=ChatAction.TYPING)

    try:
        # Access the global client initialized in main()
        response = context.bot_data["openai_client"].chat.completions.create(
            model=OLLAMA_MODEL,
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": user_message}
            ],
        )
        ai_response = response.choices[0].message.content
    except Exception as e:
        logger.error(f"Error calling Ollama API: {e}")
        ai_response = "Sorry, I encountered an error. Please try again later."

    await update.message.reply_text(ai_response)

# 4. Main Application Logic
def main() -> None:
    if not TELEGRAM_BOT_TOKEN or not OLLAMA_API_KEY:
        logger.error("❌ Missing environment variables. Check Render settings.")
        return

    # Initialize the OpenAI client ONLY after verifying keys exist
    client = OpenAI(
        base_url="https://ollama.com/v1",
        api_key=OLLAMA_API_KEY,
    )

    application = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()
    
    # Store client in bot_data so handlers can access it
    application.bot_data["openai_client"] = client

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Bot is starting...")
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()