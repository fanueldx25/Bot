import os, io, re, csv, json, time, uuid, base64, zipfile, asyncio, logging, threading
from datetime import datetime, timezone

from dotenv import load_dotenv
from flask import Flask, request, render_template_string, jsonify, send_file
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode, ChatAction
from telegram.ext import (
    ApplicationBuilder, CommandHandler, CallbackQueryHandler,
    MessageHandler, filters, ContextTypes,
)
from openai import OpenAI

# ---------- 1. Config ----------
load_dotenv()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()

DEFAULT_SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT",
    ("You are a helpful, concise AI assistant. "
     "When the user asks you to create, generate, or export a file "
     "(PDF, ZIP, TXT, BAT, CSV, JSON, Markdown), call the appropriate "
     "tool. Keep replies short and clear.")
).strip()

DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gpt-oss:20b").strip()
AVAILABLE_MODELS = [
    "gemma4:31b", "gpt-oss:120b", "gpt-oss:20b",
    "nemotron-3-nano:30b", "nemotron-3-super", "nemotron-3-ultra",
]
if DEFAULT_MODEL not in AVAILABLE_MODELS:
    AVAILABLE_MODELS.insert(0, DEFAULT_MODEL)

MAX_HISTORY = 24          # messages kept per chat
MAX_TOOL_ITERATIONS = 5   # AI->tool->AI loops per turn

# ---------- 2. Logging ----------
logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("bot")

# ---------- 3. Globals ----------
BOT_START = time.time()
BOT_STATE = {"running": False, "last_error": None}

# ---------- 4. Memory Harness ----------
class MemoryHarness:
    """Per-chat conversation memory with auto-truncation."""
    def __init__(self, max_msgs=MAX_HISTORY):
        self._store = {}
        self.max = max_msgs

    def add(self, chat_id: int, role: str, content: str):
        self._store.setdefault(chat_id, []).append({"role": role, "content": content})
        self._trim(chat_id)

    def get(self, chat_id: int):
        return list(self._store.get(chat_id, []))

    def clear(self, chat_id: int):
        self._store.pop(chat_id, None)

    def size(self, chat_id: int) -> int:
        return len(self._store.get(chat_id, []))

    def _trim(self, chat_id: int):
        hist = self._store[chat_id]
        if len(hist) > self.max:
            self._store[chat_id] = hist[-self.max:]

memory = MemoryHarness()

# ---------- 5. File Generation Tools ----------
def _safe_name(name: str, ext: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9_\-]+", "_", name or "file").strip("_") or "file"
    return f"{base}.{ext}"

def tool_create_pdf(title: str, content: str, filename: str = "document"):
    from fpdf import FPDF
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 12, title, ln=True)
    pdf.set_font("Helvetica", "", 11)
    pdf.multi_cell(0, 6, content)
    data = pdf.output(dest="S")
    if isinstance(data, str):  # older fpdf
        data = data.encode("latin-1")
    return _safe_name(filename, "pdf"), bytes(data), "application/pdf"

def tool_create_txt(content: str, filename: str = "note"):
    return _safe_name(filename, "txt"), content.encode("utf-8"), "text/plain"

def tool_create_md(content: str, filename: str = "note"):
    return _safe_name(filename, "md"), content.encode("utf-8"), "text/markdown"

def tool_create_bat(content: str, filename: str = "script"):
    body = "@echo off\r\n" + content.replace("\n", "\r\n")
    return _safe_name(filename, "bat"), body.encode("utf-8"), "application/octet-stream"

def tool_create_csv(headers, rows, filename: str = "data"):
    buf = io.StringIO()
    w = csv.writer(buf)
    if headers: w.writerow(headers)
    for r in rows: w.writerow(r)
    return _safe_name(filename, "csv"), buf.getvalue().encode("utf-8"), "text/csv"

def tool_create_json(content, filename: str = "data"):
    if isinstance(content, str):
        try: content = json.loads(content)
        except Exception: pass
    return _safe_name(filename, "json"), json.dumps(content, indent=2).encode("utf-8"), "application/json"

def tool_create_zip(files, filename: str = "archive"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.writestr(f.get("name", "file.txt"), f.get("content", ""))
    return _safe_name(filename, "zip"), buf.getvalue(), "application/zip"

# Tool registry (used by both bot & MCP)
TOOL_REGISTRY = {
    "create_pdf":  tool_create_pdf,
    "create_txt":  tool_create_txt,
    "create_md":   tool_create_md,
    "create_bat":  tool_create_bat,
    "create_csv":  tool_create_csv,
    "create_json": tool_create_json,
    "create_zip":  tool_create_zip,
}

# OpenAI-compatible tool schemas
TOOL_SCHEMAS = [
    {"type": "function", "function": {
        "name": "create_pdf", "description": "Create a PDF document.",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string"}, "content": {"type": "string"},
            "filename": {"type": "string"}}, "required": ["title", "content"]}}},
    {"type": "function", "function": {
        "name": "create_txt", "description": "Create a plain text file.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"}, "filename": {"type": "string"}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "create_md", "description": "Create a Markdown file.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"}, "filename": {"type": "string"}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "create_bat", "description": "Create a Windows .bat script.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"}, "filename": {"type": "string"}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "create_csv", "description": "Create a CSV file.",
        "parameters": {"type": "object", "properties": {
            "headers": {"type": "array", "items": {"type": "string"}},
            "rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
            "filename": {"type": "string"}}, "required": ["rows"]}}},
    {"type": "function", "function": {
        "name": "create_json", "description": "Create a JSON file.",
        "parameters": {"type": "object", "properties": {
            "content": {}, "filename": {"type": "string"}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "create_zip", "description": "Bundle multiple text files into a ZIP archive.",
        "parameters": {"type": "object", "properties": {
            "files": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "content": {"type": "string"}},
                "required": ["name", "content"]}},
            "filename": {"type": "string"}}, "required": ["files"]}}},
]

def run_tool(name: str, args: dict):
    """Execute a tool by name with dict args. Returns (filename, bytes, mimetype)."""
    fn = TOOL_REGISTRY.get(name)
    if not fn:
        raise ValueError(f"Unknown tool: {name}")
    return fn(**args)

# ---------- 6. OpenAI / Ollama client ----------
openai_client = OpenAI(base_url="https://ollama.com/v1", api_key=OLLAMA_API_KEY)

# ---------- 7. Telegram helpers ----------
def esc(t: str) -> str:
    return "".join(f"\\{c}" if c in r"_*[]()~`>#+-=|{}.!" else c for c in t)

async def safe_edit(msg, text: str, markup=None, parse_mode=ParseMode.MARKDOWN_V2):
    try:
        await msg.edit_text(text, parse_mode=parse_mode, reply_markup=markup)
    except Exception:
        try:
            await msg.edit_text(text, reply_markup=markup)
        except Exception:
            pass

def model_of(ctx): return ctx.chat_data.get("model", DEFAULT_MODEL)
def prompt_of(ctx): return ctx.chat_data.get("system_prompt", DEFAULT_SYSTEM_PROMPT)

def main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🧠 Clear Memory", callback_data="act:clear"),
         InlineKeyboardButton("🤖 Switch Model", callback_data="act:model")],
        [InlineKeyboardButton("📄 Make PDF",  callback_data="act:pdf"),
         InlineKeyboardButton("🗜️ Make ZIP", callback_data="act:zip")],
        [InlineKeyboardButton("📊 Stats", callback_data="act:stats"),
         InlineKeyboardButton("❓ Help",  callback_data="act:help")],
    ])

# ---------- 8. AI turn with tool-calling harness ----------
def ai_turn(chat_id: int, user_text: str, ctx: ContextTypes.DEFAULT_TYPE):
    """
    Runs one conversational turn with tools.
    Returns (final_text, list_of_generated_files).
    Files are (filename, bytes, mimetype) tuples.
    """
    # Build message list: system + prior history + new user msg
    messages = [{"role": "system", "content": prompt_of(ctx)}]
    messages.extend(memory.get(chat_id))
    messages.append({"role": "user", "content": user_text})

    generated_files = []
    model = model_of(ctx)

    for _ in range(MAX_TOOL_ITERATIONS):
        resp = openai_client.chat.completions.create(
            model=model, messages=messages, tools=TOOL_SCHEMAS, tool_choice="auto",
        )
        msg = resp.choices[0].message

        # No tool calls → done
        if not msg.tool_calls:
            return (msg.content or "").strip(), generated_files

        # Append assistant tool-call message
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [tc.model_dump() for tc in msg.tool_calls],
        })

        # Execute each tool call
        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
                fname, fbytes, mime = run_tool(tc.function.name, args)
                generated_files.append((fname, fbytes, mime))
                result = {"status": "success", "filename": fname,
                          "size_bytes": len(fbytes)}
            except Exception as e:
                logger.exception(f"Tool {tc.function.name} failed")
                result = {"status": "error", "error": str(e)}

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result),
            })

    return "⚠️ Reached tool iteration limit. Please try a simpler request.", generated_files

# ---------- 9. Command Handlers ----------
async def start_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    name = esc(u.effective_user.first_name or "there")
    text = (f"👋 Hi *{name}*\n\n"
            f"I'm your *Ollama Cloud* assistant with memory and file tools\\.\n"
            f"Model: `{esc(model_of(c))}`\n"
            f"Memory: `{memory.size(u.effective_chat.id)}` messages\n\n"
            f"Try: _create a PDF about machine learning_ or _make a zip with 3 text files_\\.")
    await u.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2,
                               reply_markup=main_menu())

async def help_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    text = ("*Commands*\n"
            "`/start` \\- Menu\n"
            "`/help` \\- This message\n"
            "`/model` \\- Switch model\n"
            "`/prompt` \\- Set custom persona\n"
            "`/clear` \\- Wipe conversation memory\n"
            "`/files` \\- File tools info\n\n"
            "*Try asking:*\n"
            "• _make me a PDF about Node\\.js_\n"
            "• _create a bat script that prints hello_\n"
            "• _bundle 3 text files into a zip_")
    await u.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2,
                               reply_markup=main_menu())

async def clear_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    memory.clear(u.effective_chat.id)
    m = await u.message.reply_text("🧠 Memory cleared\\.")
    await asyncio.sleep(2)
    try: await m.delete()
    except Exception: pass

async def files_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    text = ("📦 *File tools*\n"
            "`create_pdf` \\- PDF document\n"
            "`create_txt` \\- Plain text\n"
            "`create_md`  \\- Markdown\n"
            "`create_bat` \\- Windows script\n"
            "`create_csv` \\- CSV table\n"
            "`create_json` \\- JSON data\n"
            "`create_zip` \\- ZIP bundle\n\n"
            "Just ask in plain English and I'll pick the right one\\.")
    await u.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2)

async def model_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    active = model_of(c)
    rows = [[InlineKeyboardButton(("✅ " if m == active else "") + m,
                                  callback_data=f"model:{m}")]
            for m in AVAILABLE_MODELS]
    await u.message.reply_text("Choose a model:",
                               reply_markup=InlineKeyboardMarkup(rows))

async def prompt_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    args = c.args
    if not args:
        cur = prompt_of(c)
        await u.message.reply_text(f"Current prompt:\n\n{cur[:400]}\n\n"
                                   "Set with: /prompt <your new prompt>")
        return
    new = " ".join(args).strip()
    c.chat_data["system_prompt"] = new
    await u.message.reply_text(f"✅ Persona updated ({len(new)} chars).")

# ---------- 10. Callback Query Handler (buttons) ----------
async def callback_handler(u: Update, c: ContextTypes.DEFAULT_TYPE):
    q = u.callback_query
    await q.answer()
    data = q.data or ""

    if data.startswith("model:"):
        chosen = data.split(":", 1)[1]
        if chosen in AVAILABLE_MODELS:
            c.chat_data["model"] = chosen
            await q.edit_message_text(f"✅ Model: `{esc(chosen)}`",
                                      parse_mode=ParseMode.MARKDOWN_V2)
        return

    if data.startswith("act:"):
        action = data.split(":", 1)[1]
        if action == "clear":
            memory.clear(u.effective_chat.id)
            await q.edit_message_text("🧠 Memory cleared.")
        elif action == "stats":
            txt = (f"📊 Stats\n"
                   f"Memory: {memory.size(u.effective_chat.id)} msgs\n"
                   f"Model: {model_of(c)}\n"
                   f"Uptime: {int(time.time() - BOT_START)}s")
            await q.edit_message_text(txt)
        elif action == "help":
            await q.edit_message_text("Send a message or use /help. "
                                      "Try: *create a PDF about X*",
                                      parse_mode=ParseMode.MARKDOWN_V2)
        elif action == "model":
            rows = [[InlineKeyboardButton(m, callback_data=f"model:{m}")]
                    for m in AVAILABLE_MODELS]
            await q.edit_message_text("Choose a model:",
                                      reply_markup=InlineKeyboardMarkup(rows))
        elif action == "pdf":
            await q.edit_message_text("📄 Just tell me the topic, e.g. "
                                      "_make a PDF about Rome_",
                                      parse_mode=ParseMode.MARKDOWN_V2)
        elif action == "zip":
            await q.edit_message_text("🗜️ Tell me what files to bundle, e.g. "
                                      "_zip 3 text files: a, b, c_",
                                      parse_mode=ParseMode.MARKDOWN_V2)
        return

# ---------- 11. Message Handler ----------
async def handle_message(u: Update, c: ContextTypes.DEFAULT_TYPE):
    chat_id = u.effective_chat.id
    user_text = u.message.text or ""
    if not user_text.strip():
        return

    # Show a status bubble we will EDIT (not spam) and DELETE (after 1s)
    status = await u.message.reply_text("⏳ Thinking...")
    await c.bot.send_chat_action(chat_id, ChatAction.TYPING)

    try:
        # Run AI turn in a thread (openai client is sync)
        loop = asyncio.get_event_loop()
        reply_text, files = await loop.run_in_executor(
            None, ai_turn, chat_id, user_text, c
        )
    except Exception as e:
        logger.exception("AI turn failed")
        reply_text, files = f"⚠️ Error: {e}", []

    # Persist to memory
    memory.add(chat_id, "user", user_text)
    if reply_text:
        memory.add(chat_id, "assistant", reply_text)

    # Send generated files first
    for fname, fbytes, _mime in files:
        try:
            await u.message.reply_document(
                document=io.BytesIO(fbytes), filename=fname
            )
        except Exception as e:
            logger.warning(f"File send failed: {e}")

    # Edit the status message into the final reply
    if reply_text:
        # Avoid MarkdownV2 breakage by sending as plain if it looks risky
        try:
            await status.edit_text(reply_text[:4000])
        except Exception:
            await status.edit_text(reply_text[:4000])
    else:
        await status.edit_text("✅ Done.")

    # Auto-delete the status message after 8 seconds if no reply, to keep chat clean
    if not reply_text:
        await asyncio.sleep(8)
        try: await status.delete()
        except Exception: pass

# ---------- 12. Flask app ----------
flask_app = Flask(__name__)

@flask_app.route("/")
def index():
    return render_template_string(INDEX_HTML,
        uptime=f"{int(time.time()-BOT_START)}s",
        model=DEFAULT_MODEL,
        running=BOT_STATE["running"],
        memory_chats=len(memory._store),
        tools=len(TOOL_REGISTRY),
    )

@flask_app.route("/health")
def health():
    return jsonify({"ok": True, "bot_running": BOT_STATE["running"],
                    "uptime": int(time.time()-BOT_START)})

@flask_app.route("/diag")
def diag():
    return jsonify({"bot_running": BOT_STATE["running"],
                    "last_error": BOT_STATE["last_error"],
                    "model": DEFAULT_MODEL,
                    "chats_in_memory": len(memory._store),
                    "tools": list(TOOL_REGISTRY.keys())})

# ---------- 13. MCP-style JSON-RPC endpoint ----------
def mcp_tool_list():
    return [{"name": t["function"]["name"],
             "description": t["function"]["description"],
             "inputSchema": t["function"]["parameters"]} for t in TOOL_SCHEMAS]

@flask_app.route("/mcp", methods=["GET", "POST"])
def mcp_endpoint():
    if request.method == "GET":
        return jsonify({
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "ollama-telegram-bot", "version": "1.0.0"},
            "tools": mcp_tool_list(),
        })

    payload = request.get_json(silent=True) or {}
    req_id = payload.get("id")
    method = payload.get("method")
    params = payload.get("params", {}) or {}

    def ok(result): return jsonify({"jsonrpc": "2.0", "id": req_id, "result": result})
    def err(code, msg): return jsonify({"jsonrpc": "2.0", "id": req_id,
                                        "error": {"code": code, "message": msg}})

    if method == "initialize":
        return ok({"protocolVersion": "2024-11-05",
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": "ollama-telegram-bot", "version": "1.0.0"}})
    if method == "tools/list":
        return ok({"tools": mcp_tool_list()})
    if method == "tools/call":
        name = params.get("name"); args = params.get("arguments", {})
        try:
            fname, fbytes, mime = run_tool(name, args)
            return ok({"content": [
                {"type": "text", "text": f"Generated {fname} ({len(fbytes)} bytes)"},
                {"type": "resource",
                 "resource": {"uri": f"data:{mime};base64,{base64.b64encode(fbytes).decode()}",
                              "mimeType": mime, "name": fname}},
            ]})
        except Exception as e:
            return err(-32603, str(e))
    return err(-32601, f"Method not found: {method}")

# ---------- 14. Frontend ----------
INDEX_HTML = r"""
<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ollama Bot · Tools + Memory</title>
<style>
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
 background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;
 min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
 .c{max-width:720px;width:100%;background:rgba(255,255,255,.05);
 backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.1);
 border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
 h1{font-size:28px;margin:8px 0;background:linear-gradient(90deg,#a78bfa,#60a5fa);
 -webkit-background-clip:text;-webkit-text-fill-color:transparent}
 .sub{color:#94a3b8;margin-bottom:24px;font-size:14px}
 .st{display:flex;gap:10px;align-items:center;padding:14px 18px;
 background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);
 border-radius:12px;margin-bottom:20px}
 .st.off{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3)}
 .dot{width:10px;height:10px;border-radius:50%;background:#22c55e;animation:p 2s infinite}
 .st.off .dot{background:#ef4444}
 @keyframes p{0%,100%{opacity:1}50%{opacity:.5}}
 .g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
 .k{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
 border-radius:10px;padding:14px}
 .k .l{font-size:10px;text-transform:uppercase;color:#94a3b8;letter-spacing:1px}
 .k .v{font-size:18px;font-weight:600;margin-top:4px}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin:20px 0 10px}
 .t{display:flex;flex-wrap:wrap;gap:6px}
 .t span{font-family:monospace;font-size:12px;background:rgba(167,139,250,.15);
 color:#c4b5fd;padding:4px 10px;border-radius:6px}
 a{color:#a78bfa;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body><div class="c">
<div style="font-size:48px">🤖</div>
<h1>Ollama Bot · Memory + Tools</h1>
<p class="sub">Telegram bot with file generation, memory & MCP endpoint</p>
<div class="st {{ 'off' if not running else '' }}"><span class="dot"></span>
<span><b>{{ 'Online' if running else 'Bot Offline' }}</b> — uptime {{ uptime }}</span></div>
<div class="g">
<div class="k"><div class="l">Model</div><div class="v">{{ model }}</div></div>
<div class="k"><div class="l">Active Chats</div><div class="v">{{ memory_chats }}</div></div>
<div class="k"><div class="l">Tools</div><div class="v">{{ tools }}</div></div>
</div>
<h2>File Tools</h2>
<div class="t">
<span>PDF</span><span>ZIP</span><span>TXT</span><span>BAT</span>
<span>CSV</span><span>JSON</span><span>Markdown</span>
</div>
<h2>MCP Endpoint</h2>
<div class="t"><span>POST /mcp · JSON-RPC</span><span>initialize</span>
<span>tools/list</span><span>tools/call</span></div>
<p style="margin-top:24px;text-align:center;color:#64748b;font-size:12px">
Telegram → <a href="https://t.me/bye_messy_note_bot">@bye_messy_note_bot</a></p>
</div></body></html>
"""

# ---------- 15. Bot thread ----------
def build_application():
    app = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("clear", clear_command))
    app.add_handler(CommandHandler("files", files_command))
    app.add_handler(CommandHandler("model", model_command))
    app.add_handler(CommandHandler("prompt", prompt_command))
    app.add_handler(CallbackQueryHandler(callback_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    return app

def run_bot_thread():
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        app = build_application()
        BOT_STATE["running"] = True
        BOT_STATE["last_error"] = None
        logger.info("🚀 Bot thread online.")
        app.run_polling(allowed_updates=Update.ALL_TYPES, stop_signals=None)
    except Exception as e:
        BOT_STATE["running"] = False
        BOT_STATE["last_error"] = f"{type(e).__name__}: {e}"
        logger.exception("Bot thread crashed")

# ---------- 16. Self ping ----------
def start_keep_alive():
    url = os.getenv("RENDER_EXTERNAL_URL")
    if not url:
        logger.warning("No RENDER_EXTERNAL_URL — self-ping disabled")
        return
    def loop():
        import requests
        time.sleep(60)
        while True:
            try: requests.get(f"{url}/health", timeout=10)
            except Exception: pass
            time.sleep(14 * 60)
    threading.Thread(target=loop, daemon=True).start()

# ---------- 17. Main ----------
def main():
    if not TELEGRAM_BOT_TOKEN or not OLLAMA_API_KEY:
        logger.error("❌ Missing env vars")
        return
    # Clean any old webhook
    try:
        import requests
        r = requests.get(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/deleteWebhook",
            timeout=10)
        logger.info(f"Webhook cleanup: {r.json()}")
    except Exception as e:
        logger.warning(f"Webhook cleanup failed: {e}")

    threading.Thread(target=run_bot_thread, daemon=True).start()
    start_keep_alive()

    port = int(os.getenv("PORT", 8080))
    logger.info(f"🌐 Web listening on 0.0.0.0:{port}")
    flask_app.run(host="0.0.0.0", port=port, threaded=True)

if __name__ == "__main__":
    main()