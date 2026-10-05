require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const MarkdownIt = require('markdown-it');
const { exec } = require('child_process');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Ollama Cloud API Configuration ---
const OLLAMA_CLOUD_URL = 'https://ollama.com/v1';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;

if (!OLLAMA_API_KEY) {
    console.error("❌ ERROR: OLLAMA_API_KEY is missing in your .env file.");
    process.exit(1);
}

// --- Model Registry with Capabilities ---
const MODEL_REGISTRY = {
    "gemma4:31b":         { vision: true,  audio: true,  tools: true, thinking: true,  size: "31b" },
    "gpt-oss:120b":       { vision: false, audio: false, tools: true, thinking: true,  size: "120b" },
    "gpt-oss:20b":        { vision: false, audio: false, tools: true, thinking: true,  size: "20b" },
    "nemotron-3-nano:30b":{ vision: false, audio: false, tools: true, thinking: true,  size: "30b" },
    "nemotron-3-super":   { vision: false, audio: false, tools: true, thinking: true,  size: "120b" },
    "nemotron-3-ultra":   { vision: false, audio: false, tools: true, thinking: true,  size: "120b" }
};

const DB_FILE = path.join(__dirname, 'chats.json');

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

// --- Multer for file uploads (memory storage) ---
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// --- Database Helpers ---
const loadDB = () => {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ chats: {} }));
    return JSON.parse(fs.readFileSync(DB_FILE));
};
const saveDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// --- Python Sandbox ---
const runPythonScript = (scriptContent) => {
    return new Promise((resolve) => {
        const tempFile = path.join(__dirname, `temp_script_${Date.now()}.py`);
        fs.writeFileSync(tempFile, scriptContent);
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        exec(`${pythonCmd} ${tempFile}`, (error, stdout, stderr) => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (error) resolve({ success: false, output: stderr || error.message });
            else resolve({ success: true, output: stdout });
        });
    });
};

// --- Web Search Tool ---
async function performWebSearch(query) {
    try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = await res.text();
        const snippets = html.match(/<a class="result__snippet".*?>(.*?)<\/a>/g) || [];
        return snippets.slice(0, 4).map(s => s.replace(/<[^>]*>?/gm, '')).join('\n\n') || "No results found.";
    } catch (e) {
        return "Search failed: " + e.message;
    }
}

// --- Tool Definitions for Native Tool-Calling ---
const TOOLS = [
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for real-time information, statistics, or current events. Use this whenever the user asks about recent data or facts you may not know.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The search query" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "run_python",
            description: "Execute a Python script on the server. Use for data analysis, calculations, or generating files.",
            parameters: {
                type: "object",
                properties: {
                    code: { type: "string", description: "The Python code to execute" }
                },
                required: ["code"]
            }
        }
    }
];

// --- Streaming Cloud Call (with tool-call support) ---
async function streamOllamaCloud(model, messages, res, onComplete) {
    const caps = MODEL_REGISTRY[model] || {};
    const body = {
        model: model,
        messages: messages,
        stream: true
    };

    // Only send tools to models that support them
    if (caps.tools) body.tools = TOOLS;

    const response = await fetch(`${OLLAMA_CLOUD_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OLLAMA_API_KEY}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Cloud API Error ${response.status}: ${errText}`);
    }

    let fullResponse = "";
    let toolCalls = [];
    const decoder = new TextDecoder();

    for await (const chunk of response.body) {
        const text = decoder.decode(chunk, { stream: true });
        const lines = text.split('\n').filter(l => l.trim() !== '');

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') {
                res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
                res.end();
                return onComplete(fullResponse, toolCalls);
            }
            try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices[0]?.delta || {};

                if (delta.content) {
                    fullResponse += delta.content;
                    res.write(`data: ${JSON.stringify({ content: delta.content, done: false })}\n\n`);
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCalls[idx]) {
                            toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                        }
                        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                    }
                }
            } catch (e) { /* ignore partial */ }
        }
    }

    if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
        res.end();
    }
    onComplete(fullResponse, toolCalls);
}

// --- Main Chat Endpoint ---
app.post('/api/chat', async (req, res) => {
    const {
        chatId, model, messages,
        useWebSearch, useThinkingMode,
        extractTextWithGamma, systemPrompt
    } = req.body;

    const db = loadDB();
    if (!db.chats[chatId]) {
        db.chats[chatId] = { id: chatId, title: 'New Chat', messages: [], createdAt: new Date() };
    }
    const currentChat = db.chats[chatId];

    // Detect if any message contains multimodal content (image/audio)
    const hasMultimodal = messages.some(m =>
        Array.isArray(m.content) && m.content.some(c => c.type === 'image_url' || c.type === 'input_audio')
    );

    // Auto-route to gemma4 if multimodal content is present
    let activeModel = model;
    const caps = MODEL_REGISTRY[activeModel] || {};
    if (hasMultimodal && !caps.vision) {
        console.log(`⚠️ Model ${activeModel} lacks vision. Auto-routing to gemma4:31b.`);
        activeModel = 'gemma4:31b';
    }

    const activeCaps = MODEL_REGISTRY[activeModel] || {};
    const lastUserMessage = messages[messages.length - 1];

    // --- Legacy Context Injection (Web Search + Gamma Extraction) ---
    let injectedContext = "";

    if (useWebSearch && !activeCaps.tools) {
        // For models without native tools, pre-fetch search
        const query = typeof lastUserMessage.content === 'string'
            ? lastUserMessage.content
            : lastUserMessage.content.find(c => c.type === 'text')?.text || '';
        const results = await performWebSearch(query);
        injectedContext += `\n\n[WEB SEARCH RESULTS]\n${results}`;
    }

    if (extractTextWithGamma && activeModel !== 'gemma4:31b' && !hasMultimodal) {
        // Only run Gamma extraction for text-only scenarios
        const textContent = typeof lastUserMessage.content === 'string'
            ? lastUserMessage.content
            : lastUserMessage.content.find(c => c.type === 'text')?.text || '';

        if (textContent.length > 15) {
            try {
                const gammaRes = await fetch(`${OLLAMA_CLOUD_URL}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OLLAMA_API_KEY}` },
                    body: JSON.stringify({
                        model: 'gemma4:31b',
                        messages: [{ role: 'user', content: `Extract key entities, code snippets, or specific data from this text. Return ONLY the extracted data:\n\n${textContent}` }],
                        stream: false
                    })
                });
                if (gammaRes.ok) {
                    const gData = await gammaRes.json();
                    const extracted = gData.choices[0]?.message?.content;
                    if (extracted) injectedContext += `\n\n[GAMMA EXTRACTED CONTEXT]\n${extracted}`;
                }
            } catch (e) { console.error("Gamma extraction failed", e); }
        }
    }

    // --- Build Final Messages Array ---
    let finalMessages = [];
    if (systemPrompt) finalMessages.push({ role: 'system', content: systemPrompt });
    finalMessages.push(...messages.slice(0, -1));

    // Append injected context to the last user message if it exists
    let lastContent = lastUserMessage.content;
    if (injectedContext) {
        if (typeof lastContent === 'string') {
            lastContent += injectedContext;
        } else {
            const textPart = lastContent.find(c => c.type === 'text');
            if (textPart) textPart.text += injectedContext;
        }
    }

    // Thinking mode (only for capable models)
    if (useThinkingMode && activeCaps.thinking) {
        if (typeof lastContent === 'string') {
            lastContent = `<thinking>\n${lastContent}\n</thinking>`;
        } else {
            const textPart = lastContent.find(c => c.type === 'text');
            if (textPart) textPart.text = `<thinking>\n${textPart.text}\n</thinking>`;
        }
    }

    finalMessages.push({ role: 'user', content: lastContent });

    // Persist user message (without injected context)
    currentChat.messages.push({
        role: 'user',
        content: lastUserMessage.content,
        timestamp: new Date()
    });
    saveDB(db);

    // --- Stream Response ---
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        await streamOllamaCloud(activeModel, finalMessages, res, async (assistantResponse, toolCalls) => {
            // Handle tool calls if any
            if (toolCalls.length > 0) {
                // Send a status update to the client
                res.write(`data: ${JSON.stringify({ content: `\n\n> 🛠️ *Executing tool: ${toolCalls.map(t => t.function.name).join(', ')}...*\n\n`, done: false })}\n\n`);

                // Add assistant message with tool_calls to context
                finalMessages.push({
                    role: 'assistant',
                    content: assistantResponse || null,
                    tool_calls: toolCalls
                });

                // Execute each tool
                for (const tc of toolCalls) {
                    let result = "";
                    try {
                        const args = JSON.parse(tc.function.arguments || '{}');
                        if (tc.function.name === 'web_search') {
                            result = await performWebSearch(args.query);
                        } else if (tc.function.name === 'run_python') {
                            const r = await runPythonScript(args.code);
                            result = r.output;
                        } else {
                            result = "Unknown tool.";
                        }
                    } catch (e) {
                        result = "Tool error: " + e.message;
                    }

                    finalMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: result
                    });
                }

                // Re-stream with tool results
                await streamOllamaCloud(activeModel, finalMessages, res, async (finalResponse) => {
                    if (finalResponse) {
                        currentChat.messages.push({
                            role: 'assistant',
                            content: finalResponse,
                            timestamp: new Date()
                        });
                        saveDB(db);
                    }
                });
            } else if (assistantResponse) {
                currentChat.messages.push({
                    role: 'assistant',
                    content: assistantResponse,
                    timestamp: new Date()
                });
                saveDB(db);
            }
        });
    } catch (error) {
        console.error(error);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ content: `\n\n[Error: ${error.message}]`, done: true })}\n\n`);
            res.end();
        }
    }
});

// --- File Upload Endpoint (returns base64) ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const isImage = mimeType.startsWith('image/');
    const isAudio = mimeType.startsWith('audio/');

    res.json({
        success: true,
        filename: req.file.originalname,
        mimeType: mimeType,
        isImage: isImage,
        isAudio: isAudio,
        dataUrl: `data:${mimeType};base64,${base64}`
    });
});

// --- Models & Capabilities Endpoint ---
app.get('/api/models', (req, res) => {
    res.json(MODEL_REGISTRY);
});

// --- PDF Generation ---
app.post('/api/generate-pdf', (req, res) => {
    const { content, title } = req.body;
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${title || 'export'}.pdf`);
    doc.pipe(res);
    doc.fontSize(20).text(title || 'Chat Export', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(content.replace(/[#*`]/g, ''));
    doc.end();
});

// --- Python Sandbox Endpoint ---
app.post('/api/run-python', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });
    res.json(await runPythonScript(code));
});

// --- Chat Management ---
app.get('/api/chats', (req, res) => {
    const db = loadDB();
    res.json(Object.values(db.chats).map(c => ({ id: c.id, title: c.title, date: c.createdAt })));
});

app.get('/api/chats/:id', (req, res) => {
    const db = loadDB();
    const chat = db.chats[req.params.id];
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json(chat);
});

app.delete('/api/chats/:id', (req, res) => {
    const db = loadDB();
    delete db.chats[req.params.id];
    saveDB(db);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`✅ AI System Pro v4.0 running on http://localhost:${PORT}`);
    console.log(`☁️  Ollama Cloud API: ${OLLAMA_CLOUD_URL}`);
    console.log(`🤖 Models loaded: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
});