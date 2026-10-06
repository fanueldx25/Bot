import os, io, re, csv, json, time, base64, zipfile, asyncio, logging, threading
from datetime import datetime

from dotenv import load_dotenv
from flask import Flask, request, render_template_string, jsonify
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode, ChatAction
from telegram.ext import (
    ApplicationBuilder, CommandHandler, CallbackQueryHandler,
    MessageHandler, filters, ContextTypes,
)
from openai import OpenAI

# Image + PDF libraries
from PIL import Image
from fpdf import FPDF

# ---------- 1. Config ----------
load_dotenv()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()

DEFAULT_SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT",
    (
        "You are a helpful, concise AI assistant with persistent memory of this "
        "conversation. You can generate files (PDF, TXT, MD, BAT, CSV, JSON, ZIP), "
        "create invoices and resumes as PDFs, and process images (compress, "
        "convert format, resize) that the user has sent.\n\n"
        "IMPORTANT: When the user refers to something you previously wrote "
        "(e.g. 'make THAT into a PDF'), use the content from your earlier "
        "assistant messages in this conversation. Do not ask them to repeat it.\n\n"
        "When the user sends an image and then says 'compress this' or "
        "'convert to PNG', call the appropriate image tool WITHOUT a source "
        "argument — it uses the last image they uploaded automatically.\n\n"
        "Keep replies short. Just call the tool and confirm what you made."
    ),
).strip()

DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gpt-oss:20b").strip()
AVAILABLE_MODELS = [
    "gemma4:31b", "gpt-oss:120b", "gpt-oss:20b",
    "nemotron-3-nano:30b", "nemotron-3-super", "nemotron-3-ultra",
]
if DEFAULT_MODEL not in AVAILABLE_MODELS:
    AVAILABLE_MODELS.insert(0, DEFAULT_MODEL)

MAX_HISTORY = 30
MAX_TOOL_ITERATIONS = 6

# ---------- 2. Logging ----------
logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("bot")

# ---------- 3. Globals ----------
BOT_START = time.time()
BOT_STATE = {"running": False, "last_error": None}

# ---------- 4. Memory Harness ----------
class MemoryHarness:
    def __init__(self, max_msgs=MAX_HISTORY):
        self._store = {}
        self.max = max_msgs

    def add(self, chat_id, role, content):
        self._store.setdefault(chat_id, []).append({"role": role, "content": content})
        if len(self._store[chat_id]) > self.max:
            self._store[chat_id] = self._store[chat_id][-self.max:]

    def get(self, chat_id):
        return list(self._store.get(chat_id, []))

    def clear(self, chat_id):
        self._store.pop(chat_id, None)

    def size(self, chat_id):
        return len(self._store.get(chat_id, []))

memory = MemoryHarness()

# Image buffer per chat: holds the most recent image the user sent
image_buffer = {}   # chat_id -> {"bytes": bytes, "mime": str, "name": str}

# ---------- 5. File / Image Generation Tools ----------
def _safe_name(name, ext):
    base = re.sub(r"[^a-zA-Z0-9_\-]+", "_", name or "file").strip("_") or "file"
    return f"{base}.{ext}"


# --- Documents ---

def tool_create_pdf(title: str, content: str, filename: str = "document"):
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.multi_cell(0, 10, title)
    pdf.ln(2)
    pdf.set_font("Helvetica", "", 11)
    for para in content.split("\n"):
        pdf.multi_cell(0, 6, para if para else " ")
    out = pdf.output(dest="S")
    if isinstance(out, str):
        out = out.encode("latin-1")
    return _safe_name(filename, "pdf"), bytes(out), "application/pdf"


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
    if headers:
        w.writerow(headers)
    for r in rows:
        w.writerow(r)
    return _safe_name(filename, "csv"), buf.getvalue().encode("utf-8"), "text/csv"


def tool_create_json(content, filename: str = "data"):
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except Exception:
            pass
    return _safe_name(filename, "json"), json.dumps(content, indent=2).encode("utf-8"), "application/json"


def tool_create_zip(files, filename: str = "archive"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.writestr(f.get("name", "file.txt"), f.get("content", ""))
    return _safe_name(filename, "zip"), buf.getvalue(), "application/zip"


# --- Invoice ---

def tool_create_invoice(
    invoice_number: str,
    date: str,
    from_name: str,
    from_address: str,
    to_name: str,
    to_address: str,
    items,
    tax_rate: float = 0.0,
    currency: str = "$",
    notes: str = "",
    filename: str = "invoice",
):
    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)

    # Header
    pdf.set_font("Helvetica", "B", 24)
    pdf.cell(0, 12, "INVOICE", ln=True, align="R")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"#{invoice_number}", ln=True, align="R")
    pdf.cell(0, 6, f"Date: {date}", ln=True, align="R")
    pdf.ln(6)

    # From / To
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(90, 6, "From:", ln=False)
    pdf.cell(0, 6, "To:", ln=True)
    pdf.set_font("Helvetica", "", 10)
    from_lines = from_name.split("\n") + from_address.split("\n")
    to_lines = to_name.split("\n") + to_address.split("\n")
    rows = max(len(from_lines), len(to_lines))
    for i in range(rows):
        left = from_lines[i] if i < len(from_lines) else ""
        right = to_lines[i] if i < len(to_lines) else ""
        pdf.cell(90, 5, left, ln=False)
        pdf.cell(0, 5, right, ln=True)
    pdf.ln(6)

    # Table header
    pdf.set_fill_color(240, 240, 240)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(90, 8, "Description", border=1, fill=True)
    pdf.cell(25, 8, "Qty", border=1, fill=True, align="C")
    pdf.cell(35, 8, "Unit Price", border=1, fill=True, align="R")
    pdf.cell(40, 8, "Total", border=1, fill=True, align="R", ln=True)

    # Table body
    pdf.set_font("Helvetica", "", 10)
    subtotal = 0.0
    for item in items:
        desc = str(item.get("description", ""))
        qty = float(item.get("qty", 1))
        price = float(item.get("price", 0))
        total = qty * price
        subtotal += total
        pdf.cell(90, 8, desc[:60], border=1)
        pdf.cell(25, 8, f"{qty:g}", border=1, align="C")
        pdf.cell(35, 8, f"{currency}{price:,.2f}", border=1, align="R")
        pdf.cell(40, 8, f"{currency}{total:,.2f}", border=1, align="R", ln=True)

    # Totals
    tax = subtotal * (tax_rate / 100.0)
    grand = subtotal + tax
    pdf.cell(150, 8, "", border=0)
    pdf.cell(40, 8, f"Subtotal: {currency}{subtotal:,.2f}", ln=True, align="R")
    if tax_rate:
        pdf.cell(150, 8, "", border=0)
        pdf.cell(40, 8, f"Tax ({tax_rate:g}%): {currency}{tax:,.2f}", ln=True, align="R")
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(150, 8, "", border=0)
    pdf.cell(40, 8, f"TOTAL: {currency}{grand:,.2f}", ln=True, align="R")

    # Notes
    if notes:
        pdf.ln(10)
        pdf.set_font("Helvetica", "I", 9)
        pdf.multi_cell(0, 5, f"Notes: {notes}")

    out = pdf.output(dest="S")
    if isinstance(out, str):
        out = out.encode("latin-1")
    return _safe_name(filename, "pdf"), bytes(out), "application/pdf"


# --- Resume / CV ---

def tool_create_resume(
    full_name: str,
    title: str = "",
    email: str = "",
    phone: str = "",
    location: str = "",
    summary: str = "",
    experience=None,
    education=None,
    skills=None,
    filename: str = "resume",
):
    experience = experience or []
    education = education or []
    skills = skills or []

    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)

    # Name
    pdf.set_font("Helvetica", "B", 22)
    pdf.cell(0, 10, full_name, ln=True)
    if title:
        pdf.set_font("Helvetica", "I", 12)
        pdf.set_text_color(90, 90, 90)
        pdf.cell(0, 6, title, ln=True)
        pdf.set_text_color(0, 0, 0)

    # Contact line
    contact = " · ".join([c for c in [email, phone, location] if c])
    if contact:
        pdf.set_font("Helvetica", "", 10)
        pdf.set_text_color(60, 60, 60)
        pdf.cell(0, 6, contact, ln=True)
        pdf.set_text_color(0, 0, 0)
    pdf.ln(3)

    def section(title_text):
        pdf.ln(2)
        pdf.set_font("Helvetica", "B", 12)
        pdf.set_fill_color(230, 230, 230)
        pdf.cell(0, 8, f"  {title_text.upper()}", ln=True, fill=True)
        pdf.set_font("Helvetica", "", 10)
        pdf.ln(1)

    if summary:
        section("Summary")
        pdf.multi_cell(0, 5, summary)

    if experience:
        section("Experience")
        for exp in experience:
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 5, f"{exp.get('role','')} — {exp.get('company','')}", ln=True)
            pdf.set_font("Helvetica", "I", 9)
            pdf.set_text_color(90, 90, 90)
            pdf.cell(0, 5, exp.get("period", ""), ln=True)
            pdf.set_text_color(0, 0, 0)
            pdf.set_font("Helvetica", "", 10)
            if exp.get("description"):
                pdf.multi_cell(0, 5, exp["description"])
            pdf.ln(2)

    if education:
        section("Education")
        for ed in education:
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 5, f"{ed.get('degree','')} — {ed.get('school','')}", ln=True)
            pdf.set_font("Helvetica", "I", 9)
            pdf.set_text_color(90, 90, 90)
            pdf.cell(0, 5, ed.get("period", ""), ln=True)
            pdf.set_text_color(0, 0, 0)
            pdf.ln(2)

    if skills:
        section("Skills")
        pdf.multi_cell(0, 5, " · ".join(str(s) for s in skills))

    out = pdf.output(dest="S")
    if isinstance(out, str):
        out = out.encode("latin-1")
    return _safe_name(filename, "pdf"), bytes(out), "application/pdf"


# --- Image tools ---

_MIME_MAP = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}

def _load_source_image(chat_id, source=None):
    """Get image bytes from a URL or the chat's image buffer."""
    if source:
        import requests
        r = requests.get(source, timeout=20)
        r.raise_for_status()
        return r.content
    buf = image_buffer.get(chat_id)
    if not buf:
        raise ValueError("No image available. Please send an image first.")
    return buf["bytes"]


def _image_tool_compress(chat_id, quality=70, fmt="JPEG", source=None):
    data = _load_source_image(chat_id, source)
    img = Image.open(io.BytesIO(data))
    if fmt.upper() == "JPEG" and img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    out = io.BytesIO()
    img.save(out, format=fmt.upper(), quality=int(quality), optimize=True)
    return (
        _safe_name(f"compressed_{int(time.time())}", fmt.lower()),
        out.getvalue(),
        _MIME_MAP.get(fmt.upper(), "application/octet-stream"),
    )


def _image_tool_convert(chat_id, fmt="PNG", source=None):
    data = _load_source_image(chat_id, source)
    img = Image.open(io.BytesIO(data))
    if fmt.upper() == "JPEG" and img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    out = io.BytesIO()
    img.save(out, format=fmt.upper())
    return (
        _safe_name(f"converted_{int(time.time())}", fmt.lower()),
        out.getvalue(),
        _MIME_MAP.get(fmt.upper(), "application/octet-stream"),
    )


def _image_tool_resize(chat_id, width=800, height=None, keep_aspect=True, source=None):
    data = _load_source_image(chat_id, source)
    img = Image.open(io.BytesIO(data))
    if keep_aspect and height is None:
        w_percent = width / float(img.size[0])
        height = int(img.size[1] * w_percent)
    elif keep_aspect and width is None:
        h_percent = height / float(img.size[1])
        width = int(img.size[0] * h_percent)
    new_size = (int(width), int(height or img.size[1]))
    img = img.resize(new_size, Image.LANCZOS)
    if img.mode in ("RGBA", "P"):
        fmt = "PNG"
    else:
        fmt = "JPEG"
    out = io.BytesIO()
    if fmt == "JPEG" and img.mode != "RGB":
        img = img.convert("RGB")
    img.save(out, format=fmt, quality=85)
    return (
        _safe_name(f"resized_{width}x{new_height if (new_height := height) else 'auto'}", fmt.lower()),
        out.getvalue(),
        _MIME_MAP[fmt],
    )


# --- Tool registry ---
TOOL_REGISTRY = {
    # Documents
    "create_pdf":  tool_create_pdf,
    "create_txt":  tool_create_txt,
    "create_md":   tool_create_md,
    "create_bat":  tool_create_bat,
    "create_csv":  tool_create_csv,
    "create_json": tool_create_json,
    "create_zip":  tool_create_zip,
    # Business docs
    "create_invoice": tool_create_invoice,
    "create_resume":  tool_create_resume,
}

# Image tools require chat_id — registered separately
IMAGE_TOOLS = {
    "compress_image": _image_tool_compress,
    "convert_image":  _image_tool_convert,
    "resize_image":   _image_tool_resize,
}

# --- Tool schemas (OpenAI format) ---
TOOL_SCHEMAS = [
    {"type": "function", "function": {
        "name": "create_pdf", "description": "Create a PDF document with a title and body text. Use this whenever the user wants a PDF, or says 'make that a PDF'.",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string"},
            "content": {"type": "string", "description": "Full body text of the PDF."},
            "filename": {"type": "string"}}, "required": ["title", "content"]}}},
    {"type": "function", "function": {
        "name": "create_txt", "description": "Create a plain text (.txt) file.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"}, "filename": {"type": "string"}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "create_md", "description": "Create a Markdown (.md) file.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"}, "filename": {"type": "string"}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "create_bat", "description": "Create a Windows .bat script.",
        "parameters": {"type": "object", "properties": {
            "content": {"type": "string"}, "filename": {"type": "string"}},
            "required": ["content"]}}},
    {"type": "function", "function": {
        "name": "create_csv", "description": "Create a CSV table.",
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
        "name": "create_zip", "description": "Bundle several text files into a ZIP archive.",
        "parameters": {"type": "object", "properties": {
            "files": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "content": {"type": "string"}},
                "required": ["name", "content"]}},
            "filename": {"type": "string"}}, "required": ["files"]}}},
    {"type": "function", "function": {
        "name": "create_invoice", "description": "Create a professional invoice PDF with line items and totals. Use when the user asks for an invoice or bill.",
        "parameters": {"type": "object", "properties": {
            "invoice_number": {"type": "string"},
            "date": {"type": "string", "description": "e.g. 2026-10-06"},
            "from_name": {"type": "string"},
            "from_address": {"type": "string"},
            "to_name": {"type": "string"},
            "to_address": {"type": "string"},
            "items": {"type": "array", "items": {"type": "object", "properties": {
                "description": {"type": "string"},
                "qty": {"type": "number"},
                "price": {"type": "number"}}, "required": ["description", "qty", "price"]}},
            "tax_rate": {"type": "number", "description": "Percent, e.g. 10 for 10%"},
            "currency": {"type": "string", "description": "e.g. $ or €"},
            "notes": {"type": "string"},
            "filename": {"type": "string"}},
            "required": ["invoice_number", "date", "from_name", "from_address", "to_name", "to_address", "items"]}}},
    {"type": "function", "function": {
        "name": "create_resume", "description": "Create a professional resume / CV as a PDF.",
        "parameters": {"type": "object", "properties": {
            "full_name": {"type": "string"},
            "title": {"type": "string"},
            "email": {"type": "string"},
            "phone": {"type": "string"},
            "location": {"type": "string"},
            "summary": {"type": "string"},
            "experience": {"type": "array", "items": {"type": "object", "properties": {
                "role": {"type": "string"}, "company": {"type": "string"},
                "period": {"type": "string"}, "description": {"type": "string"}}}},
            "education": {"type": "array", "items": {"type": "object", "properties": {
                "degree": {"type": "string"}, "school": {"type": "string"},
                "period": {"type": "string"}}}},
            "skills": {"type": "array", "items": {"type": "string"}},
            "filename": {"type": "string"}},
            "required": ["full_name"]}}},
    {"type": "function", "function": {
        "name": "compress_image", "description": "Compress the last image the user sent (or a URL). Returns a smaller file. Use when user says 'compress', 'shrink', 'reduce size'.",
        "parameters": {"type": "object", "properties": {
            "quality": {"type": "integer", "description": "1-100, default 70"},
            "fmt": {"type": "string", "description": "JPEG, PNG, or WEBP"},
            "source": {"type": "string", "description": "Optional image URL"}}}}},
    {"type": "function", "function": {
        "name": "convert_image", "description": "Convert the last image to a different format (JPG, PNG, WEBP, GIF).",
        "parameters": {"type": "object", "properties": {
            "fmt": {"type": "string", "description": "JPEG, PNG, WEBP, or GIF"},
            "source": {"type": "string"}}, "required": ["fmt"]}}},
    {"type": "function", "function": {
        "name": "resize_image", "description": "Resize the last image to given width and/or height.",
        "parameters": {"type": "object", "properties": {
            "width": {"type": "integer"},
            "height": {"type": "integer"},
            "keep_aspect": {"type": "boolean", "description": "Default true"},
            "source": {"type": "string"}}}}},
]


def run_tool(name: str, args: dict, chat_id: int):
    """Execute a tool. Image tools get chat_id to look up the image buffer."""
    if name in IMAGE_TOOLS:
        return IMAGE_TOOLS[name](chat_id, **args)
    fn = TOOL_REGISTRY.get(name)
    if not fn:
        raise ValueError(f"Unknown tool: {name}")
    return fn(**args)


# ---------- 6. OpenAI / Ollama client ----------
openai_client = OpenAI(base_url="https://ollama.com/v1", api_key=OLLAMA_API_KEY)

# ---------- 7. Telegram helpers ----------
def esc(t: str) -> str:
    return "".join(f"\\{c}" if c in r"_*[]()~`>#+-=|{}.!" else c for c in t)

def model_of(ctx): return ctx.chat_data.get("model", DEFAULT_MODEL)
def prompt_of(ctx): return ctx.chat_data.get("system_prompt", DEFAULT_SYSTEM_PROMPT)

def main_menu():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🧠 Clear Memory", callback_data="act:clear"),
         InlineKeyboardButton("🤖 Switch Model", callback_data="act:model")],
        [InlineKeyboardButton("📄 PDF",    callback_data="act:pdf"),
         InlineKeyboardButton("🧾 Invoice", callback_data="act:invoice"),
         InlineKeyboardButton("👤 Resume", callback_data="act:resume")],
        [InlineKeyboardButton("🖼️ Compress", callback_data="act:compress"),
         InlineKeyboardButton("🔄 Convert",  callback_data="act:convert"),
         InlineKeyboardButton("📊 Stats",    callback_data="act:stats")],
    ])

# ---------- 8. AI turn with tool-calling + memory ----------
def ai_turn(chat_id: int, user_text: str, ctx: ContextTypes.DEFAULT_TYPE):
    messages = [{"role": "system", "content": prompt_of(ctx)}]
    messages.extend(memory.get(chat_id))
    messages.append({"role": "user", "content": user_text})

    generated_files = []
    model = model_of(ctx)

    for _ in range(MAX_TOOL_ITERATIONS):
        resp = openai_client.chat.completions.create(
            model=model, messages=messages,
            tools=TOOL_SCHEMAS, tool_choice="auto",
        )
        msg = resp.choices[0].message

        if not msg.tool_calls:
            return (msg.content or "").strip(), generated_files

        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [tc.model_dump() for tc in msg.tool_calls],
        })

        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
                fname, fbytes, mime = run_tool(tc.function.name, args, chat_id)
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

    return "⚠️ Hit tool iteration limit. Try a simpler request.", generated_files


# ---------- 9. Command handlers ----------
async def start_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    name = esc(u.effective_user.first_name or "there")
    text = (
        f"👋 Hi *{name}*\n\n"
        f"I'm your *Ollama Cloud* assistant\\.\n"
        f"Model: `{esc(model_of(c))}` · Memory: `{memory.size(u.effective_chat.id)}` msgs\n\n"
        f"I can *remember our chat*, generate PDFs, ZIPs, invoices, resumes, and "
        f"process images you send\\.\n\n"
        f"Try: _write a short poem_ then _now make it a PDF_"
    )
    await u.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2,
                               reply_markup=main_menu())

async def help_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    text = (
        "*Commands*\n"
        "`/start` \\- Menu\n`/help` \\- This text\n"
        "`/model` \\- Switch AI model\n`/prompt` \\- Custom persona\n"
        "`/clear` \\- Wipe memory\n`/tools` \\- List all tools\n\n"
        "*File tools:* PDF, TXT, MD, BAT, CSV, JSON, ZIP\n"
        "*Business:* Invoice, Resume/CV \\(PDF\\)\n"
        "*Images:* Compress, Convert format, Resize\n\n"
        "*Memory chaining:* ask me to write something, then say "
        "_'now make that a PDF'_ — I'll remember\\."
    )
    await u.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2,
                               reply_markup=main_menu())

async def clear_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    memory.clear(u.effective_chat.id)
    image_buffer.pop(u.effective_chat.id, None)
    m = await u.message.reply_text("🧠 Memory cleared\\.")
    await asyncio.sleep(2)
    try: await m.delete()
    except Exception: pass

async def tools_command(u: Update, c: ContextTypes.DEFAULT_TYPE):
    lines = ["*📦 Available tools*\n"]
    for t in TOOL_SCHEMAS:
        lines.append(f"• `{t['function']['name']}` — {t['function']['description'].split('.')[0]}")
    await u.message.reply_text("\n".join(lines)[:4000], parse_mode=ParseMode.MARKDOWN_V2)

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
        await u.message.reply_text(
            f"Current prompt:\n\n{prompt_of(c)[:400]}\n\n"
            "Set with: /prompt <new prompt>")
        return
    new = " ".join(args).strip()
    c.chat_data["system_prompt"] = new
    await u.message.reply_text(f"✅ Persona updated ({len(new)} chars).")


# ---------- 10. Callback handler (buttons) ----------
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
        hints = {
            "clear": "🧠 Memory cleared.",
            "stats": (f"📊 Stats\n"
                      f"Memory: {memory.size(u.effective_chat.id)} msgs\n"
                      f"Model: {model_of(c)}\n"
                      f"Uptime: {int(time.time() - BOT_START)}s"),
            "model": "Pick a model in the next message…",
            "pdf": "📄 Tell me the topic, e.g. _make a PDF about Rome_",
            "invoice": "🧾 Describe the invoice, e.g. _invoice for 3 hours of design at $80/hr to Acme Inc_",
            "resume": "👤 Send resume details, e.g. _CV for Jane Doe, Software Engineer, jane@x.com, 5y exp at Google_",
            "compress": "🖼️ Send me an image first, then say _compress it_",
            "convert": "🔄 Send an image, then say _convert to PNG_",
            "help": "Send a message or use /help.",
        }
        if action == "model":
            rows = [[InlineKeyboardButton(m, callback_data=f"model:{m}")]
                    for m in AVAILABLE_MODELS]
            await q.edit_message_text("Choose a model:",
                                      reply_markup=InlineKeyboardMarkup(rows))
            return
        await q.edit_message_text(hints.get(action, "OK."),
                                  parse_mode=ParseMode.MARKDOWN_V2)


# ---------- 11. Photo handler (buffer for image tools) ----------
async def handle_photo(u: Update, c: ContextTypes.DEFAULT_TYPE):
    chat_id = u.effective_chat.id
    try:
        photo = u.message.photo[-1]
        file = await c.bot.get_file(photo.file_id)
        data = await file.download_as_bytearray()
        image_buffer[chat_id] = {
            "bytes": bytes(data),
            "mime": "image/jpeg",
            "name": f"image_{int(time.time())}.jpg",
        }
        await u.message.reply_text(
            f"📷 Image received ({len(data):,} bytes).\n"
            "Now try: *compress it*, *convert to PNG*, or *resize to 800px*",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        logger.exception("Photo handling failed")
        await u.message.reply_text(f"⚠️ Couldn't process image: {e}")


async def handle_document_image(u: Update, c: ContextTypes.DEFAULT_TYPE):
    doc = u.message.document
    if not doc or not (doc.mime_type or "").startswith("image/"):
        return
    chat_id = u.effective_chat.id
    try:
        file = await c.bot.get_file(doc.file_id)
        data = await file.download_as_bytearray()
        image_buffer[chat_id] = {
            "bytes": bytes(data),
            "mime": doc.mime_type,
            "name": doc.file_name or "image",
        }
        await u.message.reply_text(
            f"📷 Image received ({len(data):,} bytes). "
            "Ask me to compress, convert, or resize it.",
        )
    except Exception as e:
        logger.exception("Document image failed")
        await u.message.reply_text(f"⚠️ Couldn't process image: {e}")


# ---------- 12. Text message handler ----------
async def handle_message(u: Update, c: ContextTypes.DEFAULT_TYPE):
    chat_id = u.effective_chat.id
    user_text = u.message.text or ""
    if not user_text.strip():
        return

    status = await u.message.reply_text("⏳ Thinking...")
    await c.bot.send_chat_action(chat_id, ChatAction.TYPING)

    try:
        loop = asyncio.get_event_loop()
        reply_text, files = await loop.run_in_executor(
            None, ai_turn, chat_id, user_text, c
        )
    except Exception as e:
        err = str(e)
        if "401" in err or "Unauthorized" in err:
            logger.error("Ollama 401 — check OLLAMA_API_KEY")
            reply_text = ("⚠️ AI backend rejected the request (401). "
                          "The bot owner needs to fix OLLAMA_API_KEY in Render.")
        else:
            logger.exception("AI turn failed")
            reply_text = f"⚠️ Error: {e}"
        files = []

    # Save to memory
    memory.add(chat_id, "user", user_text)
    if reply_text:
        memory.add(chat_id, "assistant", reply_text)
    if files:
        memory.add(chat_id, "assistant",
                   f"[Generated files: {', '.join(f[0] for f in files)}]")

    # Send files first
    for fname, fbytes, _mime in files:
        try:
            await u.message.reply_document(
                document=io.BytesIO(fbytes), filename=fname)
        except Exception as e:
            logger.warning(f"File send failed: {e}")
            await u.message.reply_text(f"⚠️ Couldn't send {fname}: {e}")

    # Edit the status bubble into the final reply
    if reply_text:
        try:
            await status.edit_text(reply_text[:4000])
        except Exception:
            try:
                await status.edit_text("✅ Done.")
            except Exception:
                pass
    elif not files:
        await status.edit_text("🤔 No response.")
    else:
        try:
            await status.edit_text("✅ File generated.")
        except Exception:
            pass


# ---------- 13. Flask app ----------
flask_app = Flask(__name__)

@flask_app.route("/")
def index():
    return render_template_string(INDEX_HTML,
        uptime=f"{int(time.time()-BOT_START)}s",
        model=DEFAULT_MODEL,
        running=BOT_STATE["running"],
        memory_chats=len(memory._store),
        tools=len(TOOL_REGISTRY) + len(IMAGE_TOOLS),
    )

@flask_app.route("/health")
def health():
    return jsonify({"ok": True, "bot_running": BOT_STATE["running"],
                    "uptime": int(time.time()-BOT_START)})

@flask_app.route("/diag")
def diag():
    return jsonify({
        "bot_running": BOT_STATE["running"],
        "last_error": BOT_STATE["last_error"],
        "model": DEFAULT_MODEL,
        "chats_in_memory": len(memory._store),
        "tools": list(TOOL_REGISTRY.keys()) + list(IMAGE_TOOLS.keys()),
        "ollama_key_prefix": (OLLAMA_API_KEY[:6] + "…") if OLLAMA_API_KEY else "MISSING",
        "ollama_key_length": len(OLLAMA_API_KEY),
    })

# ---------- 14. MCP JSON-RPC endpoint ----------
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
            "serverInfo": {"name": "ollama-telegram-bot", "version": "2.0.0"},
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
                   "serverInfo": {"name": "ollama-telegram-bot", "version": "2.0.0"}})
    if method == "tools/list":
        return ok({"tools": mcp_tool_list()})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments", {})
        try:
            # MCP has no chat_id — use 0 as a global bucket
            fname, fbytes, mime = run_tool(name, args, chat_id=0)
            return ok({"content": [
                {"type": "text", "text": f"Generated {fname} ({len(fbytes)} bytes)"},
                {"type": "resource",
                 "resource": {"uri": f"data:{mime};base64,{base64.b64encode(fbytes).decode()}",
                              "mimeType": mime, "name": fname}},
            ]})
        except Exception as e:
            return err(-32603, str(e))
    return err(-32601, f"Method not found: {method}")


# ---------- 15. Frontend ----------
INDEX_HTML = r"""
<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ollama Bot · Memory + Tools</title>
<style>
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
 background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;
 min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
 .c{max-width:720px;width:100%;background:rgba(255,255,255,.05);
 backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.1);
 border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
 h1{font-size:26px;margin:8px 0;background:linear-gradient(90deg,#a78bfa,#60a5fa);
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
<h1>Ollama Bot · Memory + Tools v2</h1>
<p class="sub">Persistent memory · PDFs · Invoices · Resumes · Image processing · MCP</p>
<div class="st {{ 'off' if not running else '' }}"><span class="dot"></span>
<span><b>{{ 'Online' if running else 'Bot Offline' }}</b> — uptime {{ uptime }}</span></div>
<div class="g">
<div class="k"><div class="l">Model</div><div class="v">{{ model }}</div></div>
<div class="k"><div class="l">Active Chats</div><div class="v">{{ memory_chats }}</div></div>
<div class="k"><div class="l">Tools</div><div class="v">{{ tools }}</div></div>
</div>
<h2>Capabilities</h2>
<div class="t">
<span>PDF</span><span>Invoice</span><span>Resume</span><span>ZIP</span>
<span>TXT</span><span>MD</span><span>BAT</span><span>CSV</span><span>JSON</span>
<span>Compress image</span><span>Convert image</span><span>Resize image</span>
</div>
<h2>MCP Endpoint</h2>
<div class="t"><span>POST /mcp · JSON-RPC</span><span>initialize</span>
<span>tools/list</span><span>tools/call</span></div>
<p style="margin-top:24px;text-align:center;color:#64748b;font-size:12px">
Telegram → <a href="https://t.me/bye_messy_note_bot">@bye_messy_note_bot</a></p>
</div></body></html>
"""


# ---------- 16. Bot thread ----------
def build_application():
    app = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("clear", clear_command))
    app.add_handler(CommandHandler("tools", tools_command))
    app.add_handler(CommandHandler("model", model_command))
    app.add_handler(CommandHandler("prompt", prompt_command))
    app.add_handler(CallbackQueryHandler(callback_handler))
    # Photos & image documents first
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.Document.IMAGE, handle_document_image))
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


# ---------- 17. Self ping ----------
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


# ---------- 18. Main ----------
def main():
    if not TELEGRAM_BOT_TOKEN or not OLLAMA_API_KEY:
        logger.error("❌ Missing env vars")
        return

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