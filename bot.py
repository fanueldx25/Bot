import os, io, re, csv, json, time, base64, zipfile, asyncio, logging, threading, ast, math
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
from flask import Flask, request, render_template_string, jsonify
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode, ChatAction
from telegram.ext import (
    ApplicationBuilder, CommandHandler, CallbackQueryHandler,
    MessageHandler, filters, ContextTypes,
)
from openai import OpenAI
from PIL import Image
from fpdf import FPDF

# ---------- 1. Config ----------
load_dotenv()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()

# Preferred sites — searches will try these first
PREFERRED_SITES = [s.strip() for s in os.getenv(
    "PREFERRED_SITES",
    "wikipedia.org,stackoverflow.com,github.com,docs.python.org,arxiv.org"
).split(",") if s.strip()]

DEFAULT_SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT",
    (
        "You are a helpful AI assistant with persistent memory, file tools, "
        "web search, URL fetching, calendar, and safe code execution.\n\n"
        "IMPORTANT RULES:\n"
        "1. When the user references something you wrote earlier "
        "('make THAT a PDF'), reuse the exact content from your previous "
        "assistant messages. Do not ask them to repeat it.\n"
        "2. For recent/real-time info, ALWAYS call web_search first.\n"
        "3. To read a webpage, call fetch_url with its URL.\n"
        "4. For date/time questions, call calendar_today.\n"
        "5. For math or small logic problems, call run_python with a short "
        "snippet that prints the answer.\n"
        "6. When the user sends an image and says 'compress/convert/resize this', "
        "call the image tool WITHOUT a source — it uses the last upload.\n"
        "7. Keep replies short. Just call the tool and confirm the result."
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
logging.getLogger("urllib3").setLevel(logging.WARNING)
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
    def get(self, chat_id): return list(self._store.get(chat_id, []))
    def clear(self, chat_id): self._store.pop(chat_id, None)
    def size(self, chat_id): return len(self._store.get(chat_id, []))

memory = MemoryHarness()
image_buffer = {}   # chat_id -> {"bytes", "mime", "name"}
CALENDAR = {}       # chat_id -> list of events

# ---------- 5. PDF text sanitizer ----------
def _pdf_safe(text: str) -> str:
    """Normalize text to latin-1 for FPDF's built-in fonts, and shrink long lines."""
    reps = {
        "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
        "\u2013": "-", "\u2014": "--", "\u2026": "...", "\u00a0": " ",
        "\u2022": "*", "\u2192": "->", "\u2190": "<-", "\u00b7": "-",
    }
    for k, v in reps.items():
        text = text.replace(k, v)
    # Replace anything not in latin-1 with '?'
    return text.encode("latin-1", errors="replace").decode("latin-1")

# ---------- 6. Document Tools ----------
def _safe_name(name, ext):
    base = re.sub(r"[^a-zA-Z0-9_\-]+", "_", name or "file").strip("_") or "file"
    return f"{base}.{ext}"

def _pdf_output_bytes(pdf):
    out = pdf.output(dest="S")
    if isinstance(out, str):
        out = out.encode("latin-1")
    return bytes(out)

def tool_create_pdf(title: str, content: str, filename: str = "document"):
    title = _pdf_safe(title or "Untitled")
    content = _pdf_safe(content or "")
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.multi_cell(0, 10, title)
    pdf.ln(2)
    pdf.set_font("Helvetica", "", 11)
    # Chunk very long paragraphs so multi_cell never chokes
    for para in content.split("\n"):
        para = para or " "
        if len(para) <= 2000:
            pdf.multi_cell(0, 6, para)
        else:
            for i in range(0, len(para), 2000):
                pdf.multi_cell(0, 6, para[i:i+2000])
    return _safe_name(filename, "pdf"), _pdf_output_bytes(pdf), "application/pdf"

def tool_create_txt(content: str, filename: str = "note"):
    return _safe_name(filename, "txt"), content.encode("utf-8"), "text/plain"

def tool_create_md(content: str, filename: str = "note"):
    return _safe_name(filename, "md"), content.encode("utf-8"), "text/markdown"

def tool_create_bat(content: str, filename: str = "script"):
    body = "@echo off\r\n" + content.replace("\n", "\r\n")
    return _safe_name(filename, "bat"), body.encode("utf-8"), "application/octet-stream"

def tool_create_csv(headers, rows, filename: str = "data"):
    buf = io.StringIO(); w = csv.writer(buf)
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

# ---------- Invoice ----------
def tool_create_invoice(invoice_number, date, from_name, from_address,
                        to_name, to_address, items, tax_rate=0.0,
                        currency="$", notes="", filename="invoice"):
    pdf = FPDF(); pdf.add_page(); pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_font("Helvetica", "B", 24); pdf.cell(0, 12, "INVOICE", ln=True, align="R")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"#{invoice_number}", ln=True, align="R")
    pdf.cell(0, 6, f"Date: {date}", ln=True, align="R"); pdf.ln(6)
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(90, 6, "From:", ln=False); pdf.cell(0, 6, "To:", ln=True)
    pdf.set_font("Helvetica", "", 10)
    fl = from_name.split("\n") + from_address.split("\n")
    tl = to_name.split("\n") + to_address.split("\n")
    for i in range(max(len(fl), len(tl))):
        pdf.cell(90, 5, _pdf_safe(fl[i] if i < len(fl) else ""), ln=False)
        pdf.cell(0, 5, _pdf_safe(tl[i] if i < len(tl) else ""), ln=True)
    pdf.ln(6)
    pdf.set_fill_color(240, 240, 240); pdf.set_font("Helvetica", "B", 10)
    pdf.cell(90, 8, "Description", border=1, fill=True)
    pdf.cell(25, 8, "Qty", border=1, fill=True, align="C")
    pdf.cell(35, 8, "Unit Price", border=1, fill=True, align="R")
    pdf.cell(40, 8, "Total", border=1, fill=True, align="R", ln=True)
    pdf.set_font("Helvetica", "", 10)
    sub = 0.0
    for it in items:
        qty = float(it.get("qty", 1)); price = float(it.get("price", 0))
        line = qty * price; sub += line
        pdf.cell(90, 8, _pdf_safe(str(it.get("description", ""))[:60]), border=1)
        pdf.cell(25, 8, f"{qty:g}", border=1, align="C")
        pdf.cell(35, 8, f"{currency}{price:,.2f}", border=1, align="R")
        pdf.cell(40, 8, f"{currency}{line:,.2f}", border=1, align="R", ln=True)
    tax = sub * (tax_rate / 100.0); grand = sub + tax
    pdf.cell(150, 8, "", border=0)
    pdf.cell(40, 8, f"Subtotal: {currency}{sub:,.2f}", ln=True, align="R")
    if tax_rate:
        pdf.cell(150, 8, "", border=0)
        pdf.cell(40, 8, f"Tax ({tax_rate:g}%): {currency}{tax:,.2f}", ln=True, align="R")
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(150, 8, "", border=0)
    pdf.cell(40, 8, f"TOTAL: {currency}{grand:,.2f}", ln=True, align="R")
    if notes:
        pdf.ln(10); pdf.set_font("Helvetica", "I", 9)
        pdf.multi_cell(0, 5, _pdf_safe(f"Notes: {notes}"))
    return _safe_name(filename, "pdf"), _pdf_output_bytes(pdf), "application/pdf"

# ---------- Resume ----------
def tool_create_resume(full_name, title="", email="", phone="", location="",
                       summary="", experience=None, education=None,
                       skills=None, filename="resume"):
    experience = experience or []; education = education or []; skills = skills or []
    pdf = FPDF(); pdf.add_page(); pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_font("Helvetica", "B", 22); pdf.cell(0, 10, _pdf_safe(full_name), ln=True)
    if title:
        pdf.set_font("Helvetica", "I", 12); pdf.set_text_color(90, 90, 90)
        pdf.cell(0, 6, _pdf_safe(title), ln=True); pdf.set_text_color(0, 0, 0)
    contact = " | ".join(c for c in [email, phone, location] if c)
    if contact:
        pdf.set_font("Helvetica", "", 10); pdf.set_text_color(60, 60, 60)
        pdf.cell(0, 6, _pdf_safe(contact), ln=True); pdf.set_text_color(0, 0, 0)
    pdf.ln(3)
    def sec(t):
        pdf.ln(2); pdf.set_font("Helvetica", "B", 12)
        pdf.set_fill_color(230, 230, 230)
        pdf.cell(0, 8, f"  {t.upper()}", ln=True, fill=True)
        pdf.set_font("Helvetica", "", 10); pdf.ln(1)
    if summary: sec("Summary"); pdf.multi_cell(0, 5, _pdf_safe(summary))
    if experience:
        sec("Experience")
        for e in experience:
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 5, _pdf_safe(f"{e.get('role','')} - {e.get('company','')}"), ln=True)
            pdf.set_font("Helvetica", "I", 9); pdf.set_text_color(90,90,90)
            pdf.cell(0, 5, _pdf_safe(e.get("period", "")), ln=True); pdf.set_text_color(0,0,0)
            pdf.set_font("Helvetica", "", 10)
            if e.get("description"): pdf.multi_cell(0, 5, _pdf_safe(e["description"]))
            pdf.ln(2)
    if education:
        sec("Education")
        for e in education:
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 5, _pdf_safe(f"{e.get('degree','')} - {e.get('school','')}"), ln=True)
            pdf.set_font("Helvetica", "I", 9); pdf.set_text_color(90,90,90)
            pdf.cell(0, 5, _pdf_safe(e.get("period", "")), ln=True); pdf.set_text_color(0,0,0); pdf.ln(2)
    if skills:
        sec("Skills"); pdf.multi_cell(0, 5, _pdf_safe(" | ".join(str(s) for s in skills)))
    return _safe_name(filename, "pdf"), _pdf_output_bytes(pdf), "application/pdf"

# ---------- Image tools ----------
_MIME_MAP = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}

def _load_source_image(chat_id, source=None):
    if source:
        import requests
        r = requests.get(source, timeout=20); r.raise_for_status()
        return r.content
    buf = image_buffer.get(chat_id)
    if not buf: raise ValueError("No image available. Please send an image first.")
    return buf["bytes"]

def _image_tool_compress(chat_id, quality=70, fmt="JPEG", source=None):
    data = _load_source_image(chat_id, source)
    img = Image.open(io.BytesIO(data))
    if fmt.upper() == "JPEG" and img.mode in ("RGBA", "P"): img = img.convert("RGB")
    out = io.BytesIO()
    img.save(out, format=fmt.upper(), quality=int(quality), optimize=True)
    return (_safe_name(f"compressed_{int(time.time())}", fmt.lower()),
            out.getvalue(), _MIME_MAP.get(fmt.upper(), "application/octet-stream"))

def _image_tool_convert(chat_id, fmt="PNG", source=None):
    data = _load_source_image(chat_id, source)
    img = Image.open(io.BytesIO(data))
    if fmt.upper() == "JPEG" and img.mode in ("RGBA", "P"): img = img.convert("RGB")
    out = io.BytesIO(); img.save(out, format=fmt.upper())
    return (_safe_name(f"converted_{int(time.time())}", fmt.lower()),
            out.getvalue(), _MIME_MAP.get(fmt.upper(), "application/octet-stream"))

def _image_tool_resize(chat_id, width=800, height=None, keep_aspect=True, source=None):
    data = _load_source_image(chat_id, source)
    img = Image.open(io.BytesIO(data))
    w, h = img.size
    if keep_aspect and height is None:
        height = int(h * (width / float(w)))
    elif keep_aspect and width is None:
        width = int(w * (height / float(h)))
    new_size = (int(width), int(height or h))
    img = img.resize(new_size, Image.LANCZOS)
    fmt = "PNG" if img.mode in ("RGBA", "P") else "JPEG"
    if fmt == "JPEG" and img.mode != "RGB": img = img.convert("RGB")
    out = io.BytesIO(); img.save(out, format=fmt, quality=85)
    return (_safe_name(f"resized_{new_size[0]}x{new_size[1]}", fmt.lower()),
            out.getvalue(), _MIME_MAP[fmt])

# ---------- Web Search ----------
def _ddg_search(query, num=5):
    import requests
    from bs4 import BeautifulSoup
    from urllib.parse import quote_plus, urlparse, parse_qs
    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                             "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"}
    r = requests.get(url, headers=headers, timeout=15)
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    for res in soup.select(".result")[:num]:
        a = res.select_one("a.result__a")
        snip = res.select_one(".result__snippet")
        if not a: continue
        href = a.get("href", "")
        if "uddg=" in href:
            try: href = parse_qs(urlparse(href).query)["uddg"][0]
            except Exception: pass
        out.append({
            "title": a.get_text(strip=True),
            "url": href,
            "snippet": (snip.get_text(strip=True) if snip else ""),
        })
    return out

def tool_web_search(query: str, site: str = "", num_results: int = 5):
    q = f"site:{site} {query}" if site else query
    try:
        results = _ddg_search(q, num=int(num_results))
    except Exception as e:
        return {"error": str(e), "query": q}
    # Also try each preferred site if no result
    if not results and not site:
        for s in PREFERRED_SITES[:2]:
            try:
                results.extend(_ddg_search(f"site:{s} {query}", num=2))
            except Exception:
                pass
    return {"query": q, "results": results}

# ---------- URL Fetch ----------
def tool_fetch_url(url: str, max_chars: int = 6000):
    import requests
    from bs4 import BeautifulSoup
    headers = {"User-Agent": "Mozilla/5.0 (compatible; TelegramBot/2.0)"}
    r = requests.get(url, headers=headers, timeout=20)
    r.raise_for_status()
    ctype = r.headers.get("content-type", "")
    if "html" in ctype:
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()
        text = " ".join(soup.get_text(" ").split())
    elif "json" in ctype:
        text = json.dumps(r.json(), indent=2)[:max_chars]
    else:
        text = r.text[:max_chars]
    title = ""
    try:
        title_el = BeautifulSoup(r.text, "html.parser").find("title")
        if title_el: title = title_el.get_text(strip=True)
    except Exception: pass
    return {"url": url, "title": title, "content": text[:max_chars], "length": len(text)}

# ---------- Calendar ----------
def tool_calendar_today():
    now = datetime.now(timezone.utc)
    return {
        "date": now.strftime("%Y-%m-%d"),
        "weekday": now.strftime("%A"),
        "time_utc": now.strftime("%H:%M:%S"),
        "iso": now.isoformat(),
    }

def tool_calendar_add(chat_id: int, title: str, date: str, time: str = "", notes: str = ""):
    ev = {"title": title, "date": date, "time": time, "notes": notes,
          "created_at": datetime.now(timezone.utc).isoformat()}
    CALENDAR.setdefault(chat_id, []).append(ev)
    return {"status": "added", "event": ev, "total": len(CALENDAR[chat_id])}

def tool_calendar_list(chat_id: int):
    events = CALENDAR.get(chat_id, [])
    # Sort by date/time
    def key(e): return (e.get("date", ""), e.get("time", ""))
    return {"count": len(events), "events": sorted(events, key=key)}

def tool_calendar_remove(chat_id: int, index: int):
    events = CALENDAR.get(chat_id, [])
    if index < 0 or index >= len(events):
        return {"error": f"index out of range (0-{len(events)-1})"}
    removed = events.pop(index)
    return {"status": "removed", "event": removed, "remaining": len(events)}

# ---------- Safe Python Executor ----------
_BANNED_NAMES = {"open", "exec", "eval", "compile", "__import__", "input",
                 "breakpoint", "help", "exit", "quit"}

def tool_run_python(code: str, chat_id: int = 0):
    """Execute tiny Python snippets (no imports, no I/O, 3s timeout)."""
    if len(code) > 2000:
        return {"error": "Code too long (max 2000 chars)"}
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as e:
        return {"error": f"Syntax error: {e}"}
    # Walk the AST and forbid dangerous things
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return {"error": "Imports are not allowed"}
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in _BANNED_NAMES:
                return {"error": f"{node.func.id}() is not allowed"}
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return {"error": "Dunder attribute access is not allowed"}

    out_lines = []
    def capture(*args, **kw):
        out_lines.append(" ".join(str(a) for a in args))
    safe_builtins = {
        "print": capture,
        "len": len, "range": range, "str": str, "int": int, "float": float,
        "list": list, "dict": dict, "set": set, "tuple": tuple, "bool": bool,
        "sum": sum, "min": min, "max": max, "abs": abs, "round": round,
        "sorted": sorted, "enumerate": enumerate, "zip": zip,
        "map": map, "filter": filter, "all": all, "any": any,
        "math": math, "True": True, "False": False, "None": None,
    }
    scope = {"__builtins__": safe_builtins, "math": math}
    result = {}
    def runner():
        try:
            exec(code, scope)
            result["ok"] = True
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
    t = threading.Thread(target=runner, daemon=True)
    t.start(); t.join(timeout=3.0)
    if t.is_alive():
        return {"error": "Execution timed out (3s limit)"}
    if "error" in result:
        return {"error": result["error"]}
    return {"output": "\n".join(out_lines) if out_lines else "(no output)"}

# ---------- 7. Tool Registry ----------
TOOL_REGISTRY = {
    "create_pdf": tool_create_pdf, "create_txt": tool_create_txt,
    "create_md": tool_create_md, "create_bat": tool_create_bat,
    "create_csv": tool_create_csv, "create_json": tool_create_json,
    "create_zip": tool_create_zip, "create_invoice": tool_create_invoice,
    "create_resume": tool_create_resume,
}
IMAGE_TOOLS = {"compress_image": _image_tool_compress,
               "convert_image": _image_tool_convert,
               "resize_image": _image_tool_resize}

def run_tool(name, args, chat_id=0):
    """Dispatch: file, image, web, calendar, or code tool."""
    if name in IMAGE_TOOLS:
        return IMAGE_TOOLS[name](chat_id, **args)
    if name == "web_search":
        return ("web_search.json", json.dumps(tool_web_search(**args), indent=2).encode("utf-8"),
                "application/json")
    if name == "fetch_url":
        return ("page.json", json.dumps(tool_fetch_url(**args), indent=2).encode("utf-8"),
                "application/json")
    if name == "calendar_today":
        return ("today.json", json.dumps(tool_calendar_today(), indent=2).encode("utf-8"),
                "application/json")
    if name == "calendar_add":
        return ("calendar.json", json.dumps(tool_calendar_add(chat_id, **args), indent=2).encode("utf-8"),
                "application/json")
    if name == "calendar_list":
        return ("calendar.json", json.dumps(tool_calendar_list(chat_id), indent=2).encode("utf-8"),
                "application/json")
    if name == "calendar_remove":
        return ("calendar.json", json.dumps(tool_calendar_remove(chat_id, **args), indent=2).encode("utf-8"),
                "application/json")
    if name == "run_python":
        return ("output.json", json.dumps(tool_run_python(args.get("code",""), chat_id), indent=2).encode("utf-8"),
                "application/json")
    fn = TOOL_REGISTRY.get(name)
    if not fn: raise ValueError(f"Unknown tool: {name}")
    return fn(**args)

# ---------- 8. Tool Schemas ----------
TOOL_SCHEMAS = [
    # --- Files ---
    {"type":"function","function":{"name":"create_pdf",
        "description":"Create a PDF from title + body text. Use whenever the user asks for a PDF or says 'make that a PDF'.",
        "parameters":{"type":"object","properties":{
            "title":{"type":"string"},"content":{"type":"string"},"filename":{"type":"string"}},
            "required":["title","content"]}}},
    {"type":"function","function":{"name":"create_txt",
        "description":"Create a plain text file.",
        "parameters":{"type":"object","properties":{
            "content":{"type":"string"},"filename":{"type":"string"}},"required":["content"]}}},
    {"type":"function","function":{"name":"create_md",
        "description":"Create a Markdown file.",
        "parameters":{"type":"object","properties":{
            "content":{"type":"string"},"filename":{"type":"string"}},"required":["content"]}}},
    {"type":"function","function":{"name":"create_bat",
        "description":"Create a Windows .bat script.",
        "parameters":{"type":"object","properties":{
            "content":{"type":"string"},"filename":{"type":"string"}},"required":["content"]}}},
    {"type":"function","function":{"name":"create_csv",
        "description":"Create a CSV table.",
        "parameters":{"type":"object","properties":{
            "headers":{"type":"array","items":{"type":"string"}},
            "rows":{"type":"array","items":{"type":"array","items":{"type":"string"}}},
            "filename":{"type":"string"}},"required":["rows"]}}},
    {"type":"function","function":{"name":"create_json",
        "description":"Create a JSON file.",
        "parameters":{"type":"object","properties":{
            "content":{},"filename":{"type":"string"}},"required":["content"]}}},
    {"type":"function","function":{"name":"create_zip",
        "description":"Bundle several text files into a ZIP.",
        "parameters":{"type":"object","properties":{
            "files":{"type":"array","items":{"type":"object","properties":{
                "name":{"type":"string"},"content":{"type":"string"}},
                "required":["name","content"]}},"filename":{"type":"string"}},"required":["files"]}}},
    {"type":"function","function":{"name":"create_invoice",
        "description":"Create a professional invoice PDF.",
        "parameters":{"type":"object","properties":{
            "invoice_number":{"type":"string"},"date":{"type":"string"},
            "from_name":{"type":"string"},"from_address":{"type":"string"},
            "to_name":{"type":"string"},"to_address":{"type":"string"},
            "items":{"type":"array","items":{"type":"object","properties":{
                "description":{"type":"string"},"qty":{"type":"number"},"price":{"type":"number"}},
                "required":["description","qty","price"]}},
            "tax_rate":{"type":"number"},"currency":{"type":"string"},
            "notes":{"type":"string"},"filename":{"type":"string"}},
            "required":["invoice_number","date","from_name","from_address","to_name","to_address","items"]}}},
    {"type":"function","function":{"name":"create_resume",
        "description":"Create a resume / CV as a PDF.",
        "parameters":{"type":"object","properties":{
            "full_name":{"type":"string"},"title":{"type":"string"},
            "email":{"type":"string"},"phone":{"type":"string"},"location":{"type":"string"},
            "summary":{"type":"string"},
            "experience":{"type":"array","items":{"type":"object","properties":{
                "role":{"type":"string"},"company":{"type":"string"},
                "period":{"type":"string"},"description":{"type":"string"}}}},
            "education":{"type":"array","items":{"type":"object","properties":{
                "degree":{"type":"string"},"school":{"type":"string"},"period":{"type":"string"}}}},
            "skills":{"type":"array","items":{"type":"string"}},
            "filename":{"type":"string"}},"required":["full_name"]}}},
    # --- Images ---
    {"type":"function","function":{"name":"compress_image",
        "description":"Compress the last image sent by the user (or a URL).",
        "parameters":{"type":"object","properties":{
            "quality":{"type":"integer"},"fmt":{"type":"string"},"source":{"type":"string"}}}}},
    {"type":"function","function":{"name":"convert_image",
        "description":"Convert the last image to JPEG, PNG, WEBP, or GIF.",
        "parameters":{"type":"object","properties":{
            "fmt":{"type":"string"},"source":{"type":"string"}},"required":["fmt"]}}},
    {"type":"function","function":{"name":"resize_image",
        "description":"Resize the last image to given width and/or height.",
        "parameters":{"type":"object","properties":{
            "width":{"type":"integer"},"height":{"type":"integer"},
            "keep_aspect":{"type":"boolean"},"source":{"type":"string"}}}}},
    # --- Web ---
    {"type":"function","function":{"name":"web_search",
        "description":"Search the live web via DuckDuckGo. Use for news, facts, current events. Optionally restrict to a site.",
        "parameters":{"type":"object","properties":{
            "query":{"type":"string"},
            "site":{"type":"string","description":"Optional domain, e.g. wikipedia.org"},
            "num_results":{"type":"integer"}},"required":["query"]}}},
    {"type":"function","function":{"name":"fetch_url",
        "description":"Download a web page and return its title + cleaned text. Use to read articles, docs, or a user-provided URL.",
        "parameters":{"type":"object","properties":{
            "url":{"type":"string"},"max_chars":{"type":"integer"}},"required":["url"]}}},
    # --- Calendar ---
    {"type":"function","function":{"name":"calendar_today",
        "description":"Return today's date, weekday, and current UTC time.",
        "parameters":{"type":"object","properties":{}}}},
    {"type":"function","function":{"name":"calendar_add",
        "description":"Add a calendar event for this chat.",
        "parameters":{"type":"object","properties":{
            "title":{"type":"string"},"date":{"type":"string","description":"YYYY-MM-DD"},
            "time":{"type":"string","description":"HH:MM (optional)"},
            "notes":{"type":"string"}},"required":["title","date"]}}},
    {"type":"function","function":{"name":"calendar_list",
        "description":"List all saved events for this chat.",
        "parameters":{"type":"object","properties":{}}}},
    {"type":"function","function":{"name":"calendar_remove",
        "description":"Remove an event by its index from calendar_list.",
        "parameters":{"type":"object","properties":{"index":{"type":"integer"}},"required":["index"]}}},
    # --- Code ---
    {"type":"function","function":{"name":"run_python",
        "description":"Execute a short Python snippet for math, data wrangling, or logic. No imports; must use print() to output. 3s timeout.",
        "parameters":{"type":"object","properties":{
            "code":{"type":"string","description":"Python code, use print() for output"}},
            "required":["code"]}}},
]

# ---------- 9. OpenAI client ----------
openai_client = OpenAI(base_url="https://ollama.com/v1", api_key=OLLAMA_API_KEY)

# ---------- 10. Telegram helpers ----------
def esc(t): return "".join(f"\\{c}" if c in r"_*[]()~`>#+-=|{}.!" else c for c in str(t))
def model_of(ctx): return ctx.chat_data.get("model", DEFAULT_MODEL)
def prompt_of(ctx): return ctx.chat_data.get("system_prompt", DEFAULT_SYSTEM_PROMPT)

def build_system_prompt(ctx, chat_id):
    """Inject current date + preferred sites into the system prompt."""
    now = datetime.now(timezone.utc)
    extra = (
        f"\n\nCURRENT DATE: {now.strftime('%A, %Y-%m-%d %H:%M UTC')}"
        f"\nPREFERRED SITES (prioritize in web_search): {', '.join(PREFERRED_SITES)}"
    )
    return prompt_of(ctx) + extra

def main_menu():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🧠 Clear Memory", callback_data="act:clear"),
         InlineKeyboardButton("🤖 Switch Model", callback_data="act:model")],
        [InlineKeyboardButton("🔍 Search",    callback_data="act:search"),
         InlineKeyboardButton("📅 Today",     callback_data="act:today"),
         InlineKeyboardButton("📋 Events",    callback_data="act:events")],
        [InlineKeyboardButton("📄 PDF",       callback_data="act:pdf"),
         InlineKeyboardButton("🧾 Invoice",   callback_data="act:invoice"),
         InlineKeyboardButton("👤 Resume",    callback_data="act:resume")],
        [InlineKeyboardButton("🖼️ Compress",  callback_data="act:compress"),
         InlineKeyboardButton("🔄 Convert",   callback_data="act:convert"),
        InlineKeyboardButton("📊 Stats",     callback_data="act:stats")],
    ])

# ---------- 11. AI turn ----------
def ai_turn(chat_id, user_text, ctx):
    messages = [{"role":"system","content": build_system_prompt(ctx, chat_id)}]
    messages.extend(memory.get(chat_id))
    messages.append({"role":"user","content": user_text})
    generated, model = [], model_of(ctx)
    for _ in range(MAX_TOOL_ITERATIONS):
        resp = openai_client.chat.completions.create(
            model=model, messages=messages,
            tools=TOOL_SCHEMAS, tool_choice="auto",
        )
        msg = resp.choices[0].message
        if not msg.tool_calls:
            return (msg.content or "").strip(), generated
        messages.append({"role":"assistant","content":msg.content or "",
                         "tool_calls":[tc.model_dump() for tc in msg.tool_calls]})
        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
                fname, fbytes, mime = run_tool(tc.function.name, args, chat_id)
                # For text-returning tools, inline the content in the tool result
                inline_tools = {"web_search","fetch_url","calendar_today",
                                "calendar_add","calendar_list","calendar_remove","run_python"}
                if tc.function.name in inline_tools:
                    payload = json.loads(fbytes.decode("utf-8"))
                    result = {"status":"success","data":payload}
                else:
                    generated.append((fname, fbytes, mime))
                    result = {"status":"success","filename":fname,"size_bytes":len(fbytes)}
            except Exception as e:
                logger.exception(f"Tool {tc.function.name} failed")
                result = {"status":"error","error":str(e)}
            messages.append({"role":"tool","tool_call_id":tc.id,
                             "content": json.dumps(result)})
    return "⚠️ Hit tool iteration limit.", generated

# ---------- 12. Commands ----------
async def start_command(u, c):
    name = esc(u.effective_user.first_name or "there")
    text = (f"👋 Hi *{name}*\n\n"
            f"Model: `{esc(model_of(c))}` · Memory: `{memory.size(u.effective_chat.id)}` msgs\n\n"
            f"I can search the live web, read URLs, keep a calendar, run small Python, "
            f"and generate PDFs, invoices, resumes, and images\\.\n\n"
            f"Try: _search for the latest AI news_")
    await u.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2, reply_markup=main_menu())

async def help_command(u, c):
    text = (
        "*Commands*\n"
        "`/start` \\- Menu\n`/help` \\- This text\n"
        "`/model` \\- Switch AI model\n`/prompt` \\- Custom persona\n"
        "`/clear` \\- Wipe memory + calendar + image\n"
        "`/tools` \\- List all tools\n`/run` \\- Execute Python snippet\n"
        "`/search` \\- Quick web search\n`/fetch` \\- Read a URL\n"
        "`/add` \\- Add calendar event\n`/events` \\- List events\n\n"
        "*Tips*\n"
        "• _search for X_ → live web search\n"
        "• _read https://..._ → fetch page content\n"
        "• _write a haiku_ then _make that a PDF_ → memory chaining\n"
        "• send an image then _compress it_"
    )
    await u.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2, reply_markup=main_menu())

async def clear_command(u, c):
    memory.clear(u.effective_chat.id)
    image_buffer.pop(u.effective_chat.id, None)
    CALENDAR.pop(u.effective_chat.id, None)
    m = await u.message.reply_text("🧠 Memory, image buffer, and calendar cleared\\.")
    await asyncio.sleep(2)
    try: await m.delete()
    except Exception: pass

async def tools_command(u, c):
    lines = ["*📦 Tools*\n"]
    for t in TOOL_SCHEMAS:
        lines.append(f"• `{t['function']['name']}` — {t['function']['description'][:80]}")
    await u.message.reply_text("\n".join(lines)[:4000], parse_mode=ParseMode.MARKDOWN_V2)

async def model_command(u, c):
    active = model_of(c)
    rows = [[InlineKeyboardButton(("✅ " if m == active else "") + m,
                                  callback_data=f"model:{m}")]
            for m in AVAILABLE_MODELS]
    await u.message.reply_text("Choose a model:", reply_markup=InlineKeyboardMarkup(rows))

async def prompt_command(u, c):
    args = c.args
    if not args:
        await u.message.reply_text(f"Current prompt:\n\n{prompt_of(c)[:400]}\n\n"
                                   "Set with: /prompt <new prompt>")
        return
    new = " ".join(args).strip()
    c.chat_data["system_prompt"] = new
    await u.message.reply_text(f"✅ Persona updated ({len(new)} chars).")

async def run_command(u, c):
    """Execute Python snippet from Telegram."""
    code = " ".join(c.args) if c.args else ""
    if not code:
        await u.message.reply_text("Usage: /run <python snippet>\nExample: /run print(sum(range(10)))")
        return
    result = tool_run_python(code, u.effective_chat.id)
    if "error" in result:
        await u.message.reply_text(f"❌ {result['error']}")
    else:
        await u.message.reply_text(f"```\n{result['output']}\n```",
                                   parse_mode=ParseMode.MARKDOWN_V2)

async def search_command(u, c):
    q = " ".join(c.args) if c.args else ""
    if not q:
        await u.message.reply_text("Usage: /search <query>")
        return
    r = tool_web_search(q, num_results=5)
    if not r.get("results"):
        await u.message.reply_text("No results.")
        return
    lines = [f"🔍 *{esc(q)}*"]
    for i, x in enumerate(r["results"], 1):
        lines.append(f"{i}. [{esc(x['title'][:60])}]({x['url']})\n{esc(x['snippet'][:120])}")
    await u.message.reply_text("\n\n".join(lines)[:4000], parse_mode=ParseMode.MARKDOWN_V2)

async def fetch_command(u, c):
    url = " ".join(c.args) if c.args else ""
    if not url:
        await u.message.reply_text("Usage: /fetch <url>")
        return
    try:
        r = tool_fetch_url(url, max_chars=3000)
        txt = f"📄 *{esc(r['title'][:80])}*\n\n{esc(r['content'][:2500])}"
        await u.message.reply_text(txt, parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await u.message.reply_text(f"❌ {e}")

async def add_command(u, c):
    args = c.args
    if len(args) < 2:
        await u.message.reply_text("Usage: /add <YYYY-MM-DD> <title> [HH:MM] [notes]")
        return
    date = args[0]; rest = args[1:]
    time_str = ""
    if rest and re.match(r"^\d{1,2}:\d{2}$", rest[-1]):
        time_str = rest.pop()
    if len(rest) > 1 and re.match(r"^\d{1,2}:\d{2}$", rest[-1]):
        time_str = rest.pop()
    title = " ".join(rest).strip() or "Untitled"
    r = tool_calendar_add(u.effective_chat.id, title=title, date=date, time=time_str)
    await u.message.reply_text(f"✅ Added: {title} on {date} {time_str}\nTotal events: {r['total']}")

async def events_command(u, c):
    r = tool_calendar_list(u.effective_chat.id)
    if not r["count"]:
        await u.message.reply_text("📅 No events yet. Add with /add.")
        return
    lines = ["📅 *Your events*"]
    for i, e in enumerate(r["events"]):
        when = e["date"] + (f" {e['time']}" if e.get("time") else "")
        lines.append(f"`[{i}]` {esc(when)} — {esc(e['title'])}")
    await u.message.reply_text("\n".join(lines)[:4000], parse_mode=ParseMode.MARKDOWN_V2)

# ---------- 13. Callbacks ----------
async def callback_handler(u, c):
    q = u.callback_query; await q.answer()
    data = q.data or ""
    if data.startswith("model:"):
        chosen = data.split(":", 1)[1]
        if chosen in AVAILABLE_MODELS:
            c.chat_data["model"] = chosen
            await q.edit_message_text(f"✅ Model: `{esc(chosen)}`", parse_mode=ParseMode.MARKDOWN_V2)
        return
    if data.startswith("act:"):
        a = data.split(":", 1)[1]
        if a == "model":
            rows = [[InlineKeyboardButton(m, callback_data=f"model:{m}")] for m in AVAILABLE_MODELS]
            await q.edit_message_text("Choose a model:", reply_markup=InlineKeyboardMarkup(rows)); return
        hints = {
            "clear": "🧠 Memory cleared.",
            "stats": (f"📊 Stats\nMemory: {memory.size(u.effective_chat.id)} msgs\n"
                      f"Model: {model_of(c)}\nUptime: {int(time.time()-BOT_START)}s"),
            "pdf": "📄 Try: _make a PDF about Rome_",
            "invoice": "🧾 Try: _invoice #1001 to Acme for 3 hrs design at $80_",
            "resume": "👤 Try: _CV for Jane Doe, Software Engineer_",
            "compress": "🖼️ Send an image then say _compress it_",
            "convert": "🔄 Send an image then say _convert to PNG_",
            "search": "🔍 Try: _search for the latest AI news_",
            "today": f"📅 Today: {datetime.now(timezone.utc).strftime('%A, %Y-%m-%d %H:%M UTC')}",
            "events": "📋 Send /events to see your calendar.",
        }
        await q.edit_message_text(hints.get(a, "OK."), parse_mode=ParseMode.MARKDOWN_V2)
        if a == "clear":
            memory.clear(u.effective_chat.id)
            image_buffer.pop(u.effective_chat.id, None)
            CALENDAR.pop(u.effective_chat.id, None)

# ---------- 14. Photo handler (FIXED escaping) ----------
async def handle_photo(u, c):
    chat_id = u.effective_chat.id
    try:
        photo = u.message.photo[-1]
        file = await c.bot.get_file(photo.file_id)
        data = await file.download_as_bytearray()
        image_buffer[chat_id] = {"bytes": bytes(data), "mime": "image/jpeg",
                                 "name": f"image_{int(time.time())}.jpg"}
        # Plain text (no parse_mode) to avoid escaping errors
        await u.message.reply_text(
            f"📷 Image received ({len(data):,} bytes).\n"
            f"Try: compress it, convert to PNG, or resize to 800px"
        )
    except Exception as e:
        logger.exception("Photo handling failed")
        await u.message.reply_text(f"⚠️ Couldn't process image: {e}")

async def handle_document_image(u, c):
    doc = u.message.document
    if not doc or not (doc.mime_type or "").startswith("image/"):
        return
    chat_id = u.effective_chat.id
    try:
        file = await c.bot.get_file(doc.file_id)
        data = await file.download_as_bytearray()
        image_buffer[chat_id] = {"bytes": bytes(data), "mime": doc.mime_type,
                                 "name": doc.file_name or "image"}
        await u.message.reply_text(
            f"📷 Image received ({len(data):,} bytes). "
            f"Ask me to compress, convert, or resize it."
        )
    except Exception as e:
        logger.exception("Document image failed")
        await u.message.reply_text(f"⚠️ Couldn't process image: {e}")

# ---------- 15. Message handler ----------
async def handle_message(u, c):
    chat_id = u.effective_chat.id
    user_text = u.message.text or ""
    if not user_text.strip(): return
    status = await u.message.reply_text("⏳ Thinking...")
    await c.bot.send_chat_action(chat_id, ChatAction.TYPING)
    try:
        loop = asyncio.get_event_loop()
        reply_text, files = await loop.run_in_executor(None, ai_turn, chat_id, user_text, c)
    except Exception as e:
        err = str(e)
        if "401" in err or "Unauthorized" in err:
            logger.error("Ollama 401")
            reply_text = "⚠️ AI backend rejected the request (401). Fix OLLAMA_API_KEY."
        else:
            logger.exception("AI turn failed")
            reply_text = f"⚠️ Error: {e}"
        files = []
    memory.add(chat_id, "user", user_text)
    if reply_text: memory.add(chat_id, "assistant", reply_text)
    if files: memory.add(chat_id, "assistant", f"[Generated: {', '.join(f[0] for f in files)}]")
    for fname, fbytes, _m in files:
        try:
            await u.message.reply_document(document=io.BytesIO(fbytes), filename=fname)
        except Exception as e:
            logger.warning(f"File send failed: {e}")
            await u.message.reply_text(f"⚠️ Couldn't send {fname}: {e}")
    if reply_text:
        try: await status.edit_text(reply_text[:4000])
        except Exception:
            try: await status.edit_text("✅ Done.")
            except Exception: pass
    elif files:
        try: await status.edit_text("✅ File generated.")
        except Exception: pass
    else:
        try: await status.edit_text("🤔 No response.")
        except Exception: pass

# ---------- 16. Flask ----------
flask_app = Flask(__name__)

@flask_app.route("/")
def index():
    return render_template_string(INDEX_HTML,
        uptime=f"{int(time.time()-BOT_START)}s", model=DEFAULT_MODEL,
        running=BOT_STATE["running"], memory_chats=len(memory._store),
        tools=len(TOOL_REGISTRY)+len(IMAGE_TOOLS)+9,
        preferred=", ".join(PREFERRED_SITES))

@flask_app.route("/health")
def health():
    return jsonify({"ok":True,"bot_running":BOT_STATE["running"],
                    "uptime":int(time.time()-BOT_START)})

@flask_app.route("/diag")
def diag():
    return jsonify({"bot_running":BOT_STATE["running"],
                    "last_error":BOT_STATE["last_error"], "model":DEFAULT_MODEL,
                    "chats_in_memory":len(memory._store),
                    "chats_with_calendar":len(CALENDAR),
                    "preferred_sites":PREFERRED_SITES,
                    "tools":list(TOOL_REGISTRY.keys())+list(IMAGE_TOOLS.keys())+
                            ["web_search","fetch_url","calendar_today","calendar_add",
                             "calendar_list","calendar_remove","run_python"],
                    "ollama_key_prefix":(OLLAMA_API_KEY[:6]+"…") if OLLAMA_API_KEY else "MISSING",
                    "ollama_key_length":len(OLLAMA_API_KEY)})

# ---------- 17. API: Run tool box ----------
@flask_app.route("/api/run", methods=["POST"])
def api_run():
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip()
    if not code:
        return jsonify({"error": "Empty code"}), 400
    result = tool_run_python(code, chat_id=0)
    return jsonify(result), 200

@flask_app.route("/api/search", methods=["POST"])
def api_search():
    data = request.get_json(silent=True) or {}
    q = (data.get("query") or "").strip()
    if not q:
        return jsonify({"error": "Empty query"}), 400
    return jsonify(tool_web_search(q)), 200

@flask_app.route("/api/fetch", methods=["POST"])
def api_fetch():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Empty url"}), 400
    try:
        return jsonify(tool_fetch_url(url, max_chars=4000)), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 200

# ---------- 18. MCP ----------
def mcp_tool_list():
    return [{"name":t["function"]["name"],"description":t["function"]["description"],
             "inputSchema":t["function"]["parameters"]} for t in TOOL_SCHEMAS]

@flask_app.route("/mcp", methods=["GET","POST"])
def mcp_endpoint():
    if request.method == "GET":
        return jsonify({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},
                        "serverInfo":{"name":"ollama-telegram-bot","version":"3.0.0"},
                        "tools":mcp_tool_list()})
    p = request.get_json(silent=True) or {}
    rid, method, params = p.get("id"), p.get("method"), p.get("params",{}) or {}
    def ok(r): return jsonify({"jsonrpc":"2.0","id":rid,"result":r})
    def err(code,msg): return jsonify({"jsonrpc":"2.0","id":rid,"error":{"code":code,"message":msg}})
    if method == "initialize":
        return ok({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},
                   "serverInfo":{"name":"ollama-telegram-bot","version":"3.0.0"}})
    if method == "tools/list": return ok({"tools":mcp_tool_list()})
    if method == "tools/call":
        n, a = params.get("name"), params.get("arguments",{})
        try:
            fn, fb, mime = run_tool(n, a, chat_id=0)
            return ok({"content":[
                {"type":"text","text":f"Generated {fn} ({len(fb)} bytes)"},
                {"type":"resource","resource":{"uri":f"data:{mime};base64,{base64.b64encode(fb).decode()}",
                 "mimeType":mime,"name":fn}}]})
        except Exception as e: return err(-32603,str(e))
    return err(-32601, f"Method not found: {method}")

# ---------- 19. Frontend ----------
INDEX_HTML = r"""
<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ollama Bot · Tools v3</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
 background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;
 min-height:100vh;padding:20px;display:flex;justify-content:center}
 .c{max-width:780px;width:100%;background:rgba(255,255,255,.05);backdrop-filter:blur(20px);
 border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:32px;
 box-shadow:0 20px 60px rgba(0,0,0,.5)}
 h1{font-size:24px;margin:8px 0;background:linear-gradient(90deg,#a78bfa,#60a5fa);
 -webkit-background-clip:text;-webkit-text-fill-color:transparent}
 .sub{color:#94a3b8;font-size:13px;margin-bottom:20px}
 .st{display:flex;gap:10px;align-items:center;padding:12px 16px;
 background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);
 border-radius:12px;margin-bottom:16px;font-size:14px}
 .st.off{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3)}
 .dot{width:10px;height:10px;border-radius:50%;background:#22c55e;animation:p 2s infinite}
 .st.off .dot{background:#ef4444}
 @keyframes p{0%,100%{opacity:1}50%{opacity:.5}}
 .g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
 .k{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
 border-radius:10px;padding:12px}
 .k .l{font-size:10px;text-transform:uppercase;color:#94a3b8;letter-spacing:1px}
 .k .v{font-size:15px;font-weight:600;margin-top:4px}
 h2{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin:18px 0 8px}
 .t{display:flex;flex-wrap:wrap;gap:6px}
 .t span{font-family:monospace;font-size:11px;background:rgba(167,139,250,.15);
 color:#c4b5fd;padding:3px 8px;border-radius:6px}
 .box{background:#0b1020;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px}
 textarea{width:100%;background:transparent;border:none;color:#c9d1d9;
 font-family:ui-monospace,Menlo,monospace;font-size:13px;resize:vertical;
 min-height:80px;outline:none}
 input[type=text]{width:100%;background:transparent;border:none;color:#c9d1d9;
 font-family:ui-monospace,Menlo,monospace;font-size:13px;outline:none}
 .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
 button{background:linear-gradient(90deg,#7c3aed,#3b82f6);border:none;color:#fff;
 padding:8px 14px;border-radius:8px;font-size:12px;cursor:pointer;font-weight:600}
 button:hover{opacity:.9}
 pre{background:#0b1020;border-radius:8px;padding:12px;margin-top:10px;
 color:#c9d1d9;font-size:12px;max-height:300px;overflow:auto;white-space:pre-wrap;
 word-break:break-word;border:1px solid rgba(255,255,255,.06)}
 a{color:#a78bfa;text-decoration:none}a:hover{text-decoration:underline}
 .footer{text-align:center;margin-top:20px;color:#64748b;font-size:11px}
</style></head><body><div class="c">
<div style="font-size:40px">🤖</div>
<h1>Ollama Bot · Tools v3</h1>
<p class="sub">Memory · Web search · URL fetch · Calendar · Code runner · PDF · Invoices · Resumes · Images</p>
<div class="st {{ 'off' if not running else '' }}"><span class="dot"></span>
<span><b>{{ 'Online' if running else 'Bot Offline' }}</b> — uptime {{ uptime }}</span></div>
<div class="g">
<div class="k"><div class="l">Model</div><div class="v">{{ model }}</div></div>
<div class="k"><div class="l">Active Chats</div><div class="v">{{ memory_chats }}</div></div>
<div class="k"><div class="l">Tools</div><div class="v">{{ tools }}</div></div>
</div>
<h2>Preferred sites for search</h2>
<div class="t"><span>{{ preferred }}</span></div>

<h2>⚡ Tiny tool box — run Python</h2>
<div class="box">
 <textarea id="code">print(sum(range(1,101)))\nprint("Hello, world")</textarea>
 <div class="row">
   <button onclick="runCode()">▶ Run Python</button>
   <button onclick="doSearch()" style="background:linear-gradient(90deg,#059669,#10b981)">🔍 Web Search</button>
   <button onclick="doFetch()" style="background:linear-gradient(90deg,#dc2626,#f97316)">🌐 Fetch URL</button>
 </div>
 <input type="text" id="query" placeholder="search query  OR  https://example.com"
        style="margin-top:10px;padding:8px;background:#0b1020;border-radius:6px"/>
</div>
<pre id="out">Ready. Try the buttons above.</pre>

<h2>Capabilities</h2>
<div class="t">
<span>web_search</span><span>fetch_url</span><span>calendar_add</span>
<span>calendar_list</span><span>calendar_today</span><span>run_python</span>
<span>PDF</span><span>Invoice</span><span>Resume</span><span>ZIP</span>
<span>CSV</span><span>JSON</span><span>BAT</span><span>TXT</span><span>MD</span>
<span>compress_image</span><span>convert_image</span><span>resize_image</span>
</div>

<h2>MCP endpoint</h2>
<div class="t"><span>POST /mcp</span><span>GET /mcp</span><span>POST /api/run</span>
<span>POST /api/search</span><span>POST /api/fetch</span></div>

<p class="footer">Telegram → <a href="https://t.me/bye_messy_note_bot">@bye_messy_note_bot</a></p>
</div>
<script>
async function post(url, body){
  const out = document.getElementById('out');
  out.textContent = '⏳ Running...';
  try{
    const r = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)});
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
  }catch(e){ out.textContent = '❌ ' + e.message; }
}
function runCode(){ post('/api/run', {code: document.getElementById('code').value}); }
function doSearch(){ post('/api/search', {query: document.getElementById('query').value}); }
function doFetch(){ post('/api/fetch', {url: document.getElementById('query').value}); }
</script>
</body></html>
"""

# ---------- 20. Bot thread ----------
def build_application():
    app = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("clear", clear_command))
    app.add_handler(CommandHandler("tools", tools_command))
    app.add_handler(CommandHandler("model", model_command))
    app.add_handler(CommandHandler("prompt", prompt_command))
    app.add_handler(CommandHandler("run", run_command))
    app.add_handler(CommandHandler("search", search_command))
    app.add_handler(CommandHandler("fetch", fetch_command))
    app.add_handler(CommandHandler("add", add_command))
    app.add_handler(CommandHandler("events", events_command))
    app.add_handler(CallbackQueryHandler(callback_handler))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.Document.IMAGE, handle_document_image))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    return app

def run_bot_thread():
    try:
        loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop)
        app = build_application()
        BOT_STATE["running"] = True; BOT_STATE["last_error"] = None
        logger.info("🚀 Bot thread online.")
        app.run_polling(allowed_updates=Update.ALL_TYPES, stop_signals=None)
    except Exception as e:
        BOT_STATE["running"] = False
        BOT_STATE["last_error"] = f"{type(e).__name__}: {e}"
        logger.exception("Bot thread crashed")

def start_keep_alive():
    url = os.getenv("RENDER_EXTERNAL_URL")
    if not url: return
    def loop():
        import requests
        time.sleep(60)
        while True:
            try: requests.get(f"{url}/health", timeout=10)
            except Exception: pass
            time.sleep(14 * 60)
    threading.Thread(target=loop, daemon=True).start()

# ---------- 21. Main ----------
def main():
    if not TELEGRAM_BOT_TOKEN or not OLLAMA_API_KEY:
        logger.error("❌ Missing env vars"); return
    try:
        import requests
        r = requests.get(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/deleteWebhook", timeout=10)
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