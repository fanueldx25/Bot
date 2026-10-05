import os
import time
import logging
import threading

from dotenv import load_dotenv
from flask import Flask, render_template_string, jsonify
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode, ChatAction
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
from openai import OpenAI

# ---------- 1. Environment & Config ----------
load_dotenv()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()

# System prompt comes from environment, with a default fallback
DEFAULT_SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT",
    (
        "You are a helpful and friendly AI assistant. "
        "Keep responses concise and well-structured. "
        "Use plain text only — no markdown formatting."
    ),
).strip()

DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gpt-oss:20b").strip()

AVAILABLE_MODELS = [
    "gemma4:31b",
    "gpt-oss:120b",
    "gpt-oss:20b",
    "nemotron-3-nano:30b",
    "nemotron-3-super",
    "nemotron-3-ultra",
]

# Ensure the default model is always selectable
if DEFAULT_MODEL not in AVAILABLE_MODELS:
    AVAILABLE_MODELS.insert(0, DEFAULT_MODEL)

# ---------- 2. Logging ----------
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# ---------- 3. Globals for Status Page ----------
BOT_START_TIME = time.time()
BOT_STATE = {"running": False}

# ---------- 4. Flask + Bot Init ----------
flask_app = Flask(__name__)

openai_client = OpenAI(base_url="https://ollama.com/v1", api_key=OLLAMA_API_KEY)
application = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()
application.bot_data["openai_client"] = openai_client


# ---------- 5. Helpers ----------
def escape_markdown(text: str) -> str:
    special = r"_*[]()~`>#+-=|{}.!"
    return "".join(f"\\{c}" if c in special else c for c in text)


def get_uptime() -> str:
    secs = int(time.time() - BOT_START_TIME)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def current_model(context: ContextTypes.DEFAULT_TYPE) -> str:
    return context.chat_data.get("model", DEFAULT_MODEL)


def current_prompt(context: ContextTypes.DEFAULT_TYPE) -> str:
    return context.chat_data.get("system_prompt", DEFAULT_SYSTEM_PROMPT)


async def send_formatted(
    update: Update, text: str, parse_mode: str = ParseMode.MARKDOWN_V2
) -> None:
    try:
        await update.message.reply_text(text, parse_mode=parse_mode)
    except Exception as e:
        logger.warning(f"Formatted send failed ({e}), falling back to plain text.")
        import re
        plain = re.sub(r"[*_`\[\]()~>#+\-=|{}.!\\]", "", text)
        await update.message.reply_text(plain)


# ---------- 6. Command Handlers ----------
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    name = escape_markdown(update.effective_user.first_name or "there")
    model = escape_markdown(current_model(context))
    text = (
        f"Hi *{name}*\\! 👋\n\n"
        f"I'm an AI assistant powered by *Ollama Cloud*\\.\n"
        f"Current model: `{model}`\n\n"
        f"Send me a message, or use /model to switch models, "
        f"or /prompt to change my personality\\!"
    )
    await send_formatted(update, text)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (
        "*Commands:*\n"
        "`/start` \\- Welcome message\n"
        "`/help` \\- This help text\n"
        "`/model` \\- Switch the AI model\n"
        "`/prompt` \\- View or set a custom system prompt\n"
        "`/resetprompt` \\- Restore the default system prompt\n"
        "`/photo` \\- Send a sample photo\n"
        "`/document` \\- Send a sample document\n\n"
        "Or just type a message to chat\\!"
    )
    await send_formatted(update, text)


async def model_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    active = current_model(context)
    buttons = [
        [
            InlineKeyboardButton(
                f"{'✅ ' if m == active else ''}{m}",
                callback_data=f"model:{m}",
            )
        ]
        for m in AVAILABLE_MODELS
    ]
    keyboard = InlineKeyboardMarkup(buttons)
    text = f"*Current model:* `{escape_markdown(active)}`\n\nChoose a model below:"
    await update.message.reply_text(
        text, parse_mode=ParseMode.MARKDOWN_V2, reply_markup=keyboard
    )


async def model_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    _, chosen = query.data.split(":", 1)
    if chosen not in AVAILABLE_MODELS:
        await query.edit_message_text("❌ Invalid model.")
        return
    context.chat_data["model"] = chosen
    await query.edit_message_text(
        f"✅ Model switched to: `{chosen}`\n\nSend me a message to try it!",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


async def prompt_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """View or set the system prompt for this chat.
    Usage:
      /prompt                -> shows current prompt
      /prompt <new prompt>   -> sets a custom prompt
    """
    # context.args contains the words after /prompt
    args = context.args

    if not args:
        active = current_prompt(context)
        text = (
            "*Current system prompt:*\n"
            f"```\n{active}\n```\n\n"
            "To set a new prompt, send:\n"
            "`/prompt You are a pirate who speaks in rhymes`\n\n"
            "To restore the default, use /resetprompt"
        )
        try:
            await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2)
        except Exception:
            # Prompt may contain characters that break MarkdownV2; fall back
            await update.message.reply_text(
                f"Current system prompt:\n\n{active}\n\n"
                "To set a new prompt, send: /prompt <your prompt>\n"
                "To restore the default: /resetprompt"
            )
        return

    new_prompt = " ".join(args).strip()
    if not new_prompt:
        await update.message.reply_text("❌ Prompt cannot be empty.")
        return

    context.chat_data["system_prompt"] = new_prompt
    preview = escape_markdown(new_prompt[:200])
    await update.message.reply_text(
        f"✅ System prompt updated\\.\n\n*New prompt:*\n`{preview}`",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


async def reset_prompt_command(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    context.chat_data.pop("system_prompt", None)
    await update.message.reply_text(
        "✅ System prompt restored to default.",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


async def photo_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await context.bot.send_chat_action(
        update.effective_chat.id, ChatAction.UPLOAD_PHOTO
    )
    await update.message.reply_photo(
        photo="https://telegram.org/img/t_logo.png",
        caption=escape_markdown("Here's a sample photo! 📸"),
        parse_mode=ParseMode.MARKDOWN_V2,
    )


async def document_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await context.bot.send_chat_action(
        update.effective_chat.id, ChatAction.UPLOAD_DOCUMENT
    )
    await update.message.reply_document(
        document="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        caption=escape_markdown("Here's a sample document! 📄"),
        parse_mode=ParseMode.MARKDOWN_V2,
    )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_message = update.message.text
    model = current_model(context)
    system_prompt = current_prompt(context)
    logger.info(f"User message [{model}]: {user_message}")

    await context.bot.send_chat_action(update.effective_chat.id, ChatAction.TYPING)

    try:
        client: OpenAI = context.bot_data["openai_client"]
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
        )
        ai_response = response.choices[0].message.content
        logger.info(f"AI response: {ai_response[:60]}...")
        await send_formatted(update, escape_markdown(ai_response))
    except Exception as e:
        logger.error(f"Error calling Ollama API: {e}")
        await update.message.reply_text(
            "Sorry, I encountered an error. Please try again later."
        )


# ---------- 7. Register Handlers ----------
application.add_handler(CommandHandler("start", start_command))
application.add_handler(CommandHandler("help", help_command))
application.add_handler(CommandHandler("model", model_command))
application.add_handler(CommandHandler("prompt", prompt_command))
application.add_handler(CommandHandler("resetprompt", reset_prompt_command))
application.add_handler(CommandHandler("photo", photo_command))
application.add_handler(CommandHandler("document", document_command))
application.add_handler(CallbackQueryHandler(model_callback, pattern=r"^model:"))
application.add_handler(
    MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message)
)


# ---------- 8. Frontend (HTML Status Page) ----------
INDEX_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ollama Telegram Bot</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    color: #fff; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .container {
    max-width: 680px; width: 100%;
    background: rgba(255,255,255,0.05);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px; padding: 40px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .logo { font-size: 48px; margin-bottom: 8px; }
  h1 { font-size: 28px; margin-bottom: 8px;
       background: linear-gradient(90deg,#a78bfa,#60a5fa);
       -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 14px; }
  .status {
    display: flex; align-items: center; gap: 10px;
    padding: 16px 20px;
    background: rgba(34,197,94,0.1);
    border: 1px solid rgba(34,197,94,0.3);
    border-radius: 12px; margin-bottom: 24px;
  }
  .status.offline { background: rgba(239,68,68,0.1);
                    border-color: rgba(239,68,68,0.3); }
  .dot { width: 10px; height: 10px; border-radius: 50%;
         background: #22c55e; animation: pulse 2s infinite; }
  .status.offline .dot { background: #ef4444; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
          margin-bottom: 24px; }
  .card { background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px; padding: 16px; }
  .card .label { font-size: 11px; text-transform: uppercase;
                 color: #94a3b8; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 16px; font-weight: 600; }
  h2 { font-size: 14px; text-transform: uppercase;
       letter-spacing: 1px; color: #94a3b8; margin-bottom: 12px;
       margin-top: 24px; }
  .commands { list-style: none; }
  .commands li {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; border-radius: 10px;
    background: rgba(255,255,255,0.03); margin-bottom: 8px;
    font-size: 14px;
  }
  .cmd { font-family: monospace; background: rgba(167,139,250,0.2);
         color: #c4b5fd; padding: 3px 8px; border-radius: 6px; font-size: 13px; }
  .prompt-box {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px; padding: 16px;
    font-family: monospace; font-size: 13px;
    color: #cbd5e1; line-height: 1.6;
    white-space: pre-wrap; word-break: break-word;
  }
  .footer { text-align: center; margin-top: 24px;
            color: #64748b; font-size: 12px; }
  a { color: #a78bfa; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="container">
    <div class="logo">🤖</div>
    <h1>Ollama Telegram Bot</h1>
    <p class="subtitle">Powered by Ollama Cloud AI · Running on Render</p>

    <div class="status {{ 'offline' if not bot_running else '' }}">
      <span class="dot"></span>
      <span>
        {% if bot_running %}<strong>Online</strong>{% else %}<strong>Bot Offline</strong>{% endif %}
        — uptime {{ uptime }}
      </span>
    </div>

    <div class="grid">
      <div class="card">
        <div class="label">Default Model</div>
        <div class="value">{{ default_model }}</div>
      </div>
      <div class="card">
        <div class="label">Available Models</div>
        <div class="value">{{ models_count }}</div>
      </div>
    </div>

    <h2>Default System Prompt</h2>
    <div class="prompt-box">{{ system_prompt }}</div>

    <h2>Bot Commands</h2>
    <ul class="commands">
      <li><span class="cmd">/start</span> Welcome message</li>
      <li><span class="cmd">/help</span> Show help text</li>
      <li><span class="cmd">/model</span> Switch AI model</li>
      <li><span class="cmd">/prompt</span> View or set a custom prompt</li>
      <li><span class="cmd">/resetprompt</span> Restore the default prompt</li>
      <li><span class="cmd">/photo</span> Sample photo</li>
      <li><span class="cmd">/document</span> Sample document</li>
    </ul>

    <p class="footer">
      Chat on Telegram → <a href="https://t.me/bye_messy_note_bot">@bye_messy_note_bot</a>
    </p>
  </div>
</body>
</html>
"""


@flask_app.route("/")
def index():
    return render_template_string(
        INDEX_HTML,
        uptime=get_uptime(),
        default_model=DEFAULT_MODEL,
        models_count=len(AVAILABLE_MODELS),
        system_prompt=DEFAULT_SYSTEM_PROMPT,
        bot_running=BOT_STATE["running"],
    )


@flask_app.route("/health")
def health():
    return (
        jsonify(
            {
                "status": "ok",
                "uptime": get_uptime(),
                "bot_running": BOT_STATE["running"],
            }
        ),
        200,
    )


# ---------- 9. Self-Ping (keep-alive for Render free tier) ----------
def start_keep_alive():
    public_url = os.getenv("RENDER_EXTERNAL_URL")
    if not public_url:
        logger.warning("RENDER_EXTERNAL_URL not set — self-ping disabled.")
        return

    def ping_loop():
        import requests
        time.sleep(60)
        while True:
            try:
                requests.get(f"{public_url}/health", timeout=10)
                logger.info("Self-ping OK")
            except Exception as e:
                logger.warning(f"Self-ping failed: {e}")
            time.sleep(14 * 60)

    threading.Thread(target=ping_loop, daemon=True).start()


# ---------- 10. Main ----------
def main() -> None:
    if not TELEGRAM_BOT_TOKEN or not OLLAMA_API_KEY:
        logger.error("❌ Missing env vars. Check Render settings.")
        return

    def run_bot():
        try:
            logger.info(f"🚀 Bot starting with default model: {DEFAULT_MODEL}")
            BOT_STATE["running"] = True
            # stop_signals=None is REQUIRED when running in a non-main thread
            application.run_polling(
                allowed_updates=Update.ALL_TYPES,
                stop_signals=None,
            )
        except Exception as e:
            BOT_STATE["running"] = False
            logger.exception(f"❌ Bot thread crashed: {e}")

    threading.Thread(target=run_bot, daemon=True).start()
    start_keep_alive()

    port = int(os.getenv("PORT", 8080))
    logger.info(f"🌐 Web server listening on 0.0.0.0:{port}")
    flask_app.run(host="0.0.0.0", port=port, threaded=True)


if __name__ == "__main__":
    main()