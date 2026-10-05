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
    ContextTypes,
)
from openai import OpenAI

# 1. Load Environment Variables
load_dotenv()

# .strip() removes any accidental whitespace or newlines from copy-pasting
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()

# Choose a model from your Ollama Cloud dashboard
# Options: "gemma4:31b", "gpt-oss:120b", "gpt-oss:20b", "nemotron-3-nano:30b", "nemotron-3-super"
OLLAMA_MODEL = "gpt-oss:20b"

# 2. Setup Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
# Reduce noise from httpx logs
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


# 3. Define Command Handlers
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Sends a welcome message when the /start command is issued."""
    user_name = update.effective_user.first_name or "there"
    await update.message.reply_text(
        f"Hi {user_name}! I'm an AI assistant powered by Ollama Cloud. "
        f"I'm using the {OLLAMA_MODEL} model. How can I help you today?"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Sends a help message when the /help command is issued."""
    await update.message.reply_text(
        "Just send me any message, and I'll respond using the AI model!"
    )


# 4. Define Message Handler
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handles incoming user messages and responds using the Ollama Cloud API."""
    user_message = update.message.text
    logger.info(f"User message: {user_message}")

    # Show "typing..." status in Telegram
    await context.bot.send_chat_action(
        chat_id=update.effective_chat.id, action=ChatAction.TYPING
    )

    try:
        # Retrieve the OpenAI client from bot_data
        client: OpenAI = context.bot_data["openai_client"]

        # Call the Ollama Cloud API via the OpenAI-compatible client
        response = client.chat.completions.create(
            model=OLLAMA_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful and friendly AI assistant.",
                },
                {"role": "user", "content": user_message},
            ],
        )
        ai_response = response.choices[0].message.content
        logger.info(f"AI response: {ai_response[:50]}...")

    except Exception as e:
        logger.error(f"Error calling Ollama API: {e}")
        ai_response = (
            "Sorry, I encountered an error while processing your request. "
            "Please try again later."
        )

    await update.message.reply_text(ai_response)


# 5. Main Application Logic
def main() -> None:
    """Starts the bot."""
    # Validate environment variables before doing anything else
    if not TELEGRAM_BOT_TOKEN or not OLLAMA_API_KEY:
        logger.error(
            "❌ Missing environment variables. Please check your Render settings."
        )
        return

    # Initialize the Ollama Client safely
    try:
        client = OpenAI(
            base_url="https://ollama.com/v1",
            api_key=OLLAMA_API_KEY,
        )
    except Exception as e:
        logger.error(f"❌ Failed to initialize OpenAI client: {e}")
        return

    # Build the Telegram Application
    application = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()

    # Store the OpenAI client in bot_data so handlers can access it
    application.bot_data["openai_client"] = client

    # Register handlers
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message)
    )

    # Run the bot until the user presses Ctrl-C
    logger.info(f"🚀 Bot is starting... Using model: {OLLAMA_MODEL}")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()