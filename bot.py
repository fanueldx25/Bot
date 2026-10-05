import os
import logging
import asyncio
import threading
import time
from dotenv import load_dotenv
from flask import Flask
from telegram import Update, ParseMode
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
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()
OLLAMA_MODEL = "gpt-oss:20b"

# 2. Setup Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# 3. Initialize Flask App
app = Flask(__name__)

# 4. Initialize Telegram Bot and OpenAI Client
client = OpenAI(
    base_url="https://ollama.com/v1",
    api_key=OLLAMA_API_KEY,
)
application = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()
application.bot_data["openai_client"] = client

# --- Helper: Escape MarkdownV2 special characters ---
def escape_markdown(text: str) -> str:
    special_chars = r'_*[]()~`>#+-=|{}.!'
    return "".join(f"\\{c}" if c in special_chars else c for c in text)

# --- Helper: Send a formatted message with fallback ---
async def send_formatted_message(update: Update, text: str, parse_mode: str = ParseMode.MARKDOWN_V2) -> None:
    try:
        await update.message.reply_text(text, parse_mode=parse_mode)
    except Exception as e:
        logger.warning(f"Formatted send failed ({e}), falling back to plain text.")
        import re
        plain = re.sub(r"[*_`\[\]()~>#+\-=|{}.!]", "", text)
        await update.message.reply_text(plain)

# --- Command Handlers ---
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_name = escape_markdown(update.effective_user.first_name or "there")
    text = (
        f"Hi *{user_name}*\\! 👋\n\n"
        f"I'm an AI assistant powered by *Ollama Cloud*\\.\n"
        f"I'm using the `{OLLAMA_MODEL}` model\\.\n\n"
        f"Send me any message and I'll respond\\!"
    )
    await send_formatted_message(update, text)

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (
        "*Commands:*\n"
        "`/start` \\- Welcome message\n"
        "`/help` \\- This help text\n"
        "`/photo` \\- Send a sample photo\n"
        "`/document` \\- Send a sample document\n\n"
        "Or just type a message to chat with the AI\\!"
    )
    await send_formatted_message(update, text)

async def photo_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    photo_url = "https://telegram.org/img/t_logo.png"
    caption = escape_markdown("Here's a sample photo! 📸")
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=ChatAction.UPLOAD_PHOTO)
    await update.message.reply_photo(photo=photo_url, caption=caption, parse_mode=ParseMode.MARKDOWN_V2)

async def document_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    document_url = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
    caption = escape_markdown("Here's a sample document! 📄")
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=ChatAction.UPLOAD_DOCUMENT)
    await update.message.reply_document(document=document_url, caption=caption, parse_mode=ParseMode.MARKDOWN_V2)

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_message = update.message.text
    logger.info(f"User message: {user_message}")
    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=ChatAction.TYPING)
    try:
        client: OpenAI = context.bot_data["openai_client"]
        response = client.chat.completions.create(
            model=OLLAMA_MODEL,
            messages=[
                {"role": "system", "content": "You are a helpful and friendly AI assistant. Keep responses concise and well-structured. Use plain text only — no markdown formatting."},
                {"role": "user", "content": user_message},
            ],
        )
        ai_response = response.choices[0].message.content
        logger.info(f"AI response: {ai_response[:50]}...")
        escaped = escape_markdown(ai_response)
        await send_formatted_message(update, escaped)
    except Exception as e:
        logger.error(f"Error calling Ollama API: {e}")
        await update.message.reply_text("Sorry, I encountered an error. Please try again later.")

# --- Register Handlers ---
application.add_handler(CommandHandler("start", start_command))
application.add_handler(CommandHandler("help", help_command))
application.add_handler(CommandHandler("photo", photo_command))
application.add_handler(CommandHandler("document", document_command))
application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

# --- Self-Ping to Prevent Render Sleep ---
def start_keep_alive():
    """Pings the service's own public URL to keep it alive on Render."""
    public_url = os.getenv("RENDER_EXTERNAL_URL")
    if not public_url:
        logger.warning("RENDER_EXTERNAL_URL not set. Self-ping is disabled.")
        return
    def ping_loop():
        time.sleep(60)  # wait for the server to boot
        while True:
            try:
                import requests
                requests.get(f"{public_url}/health", timeout=10)
                logger.info("Self-ping successful.")
            except Exception as e:
                logger.warning(f"Self-ping failed: {e}")
            time.sleep(14 * 60)  # ping every 14 minutes to prevent 15-min sleep
    thread = threading.Thread(target=ping_loop, daemon=True)
    thread.start()

# --- Flask Routes ---
@app.route("/")
def index():
    return "Bot is running"

@app.route("/health")
def health():
    return "OK", 200

# --- Main ---
def main() -> None:
    if not TELEGRAM_BOT_TOKEN or not OLLAMA_API_KEY:
        logger.error("❌ Missing environment variables. Check Render settings.")
        return

    # Start the self-ping thread
    start_keep_alive()

    # Run the Telegram bot in a background thread
    def run_bot():
        logger.info(f"🚀 Telegram bot is starting... Using model: {OLLAMA_MODEL}")
        application.run_polling(allowed_updates=Update.ALL_TYPES)

    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()

    # Start the Flask web server (blocking) so Render sees an open port
    port = int(os.getenv("PORT", 8080))
    logger.info(f"🌐 Starting web server on port {port}")
    app.run(host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()