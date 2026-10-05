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

const app = express();
const PORT = process.env.PORT || 3000;

// --- Ollama Cloud API Configuration ---
const OLLAMA_CLOUD_URL = 'https://ollama.com/v1'; 
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;

if (!OLLAMA_API_KEY) {
    console.error("❌ ERROR: OLLAMA_API_KEY is missing in your .env file.");
    console.error("Please add your API key to the .env file and restart the server.");
    process.exit(1);
}

// The exact models you have hosted on Ollama Cloud
const AVAILABLE_MODELS = [
    "gemma4:31b",
    "gpt-oss:120b",
    "gpt-oss:20b",
    "nemotron-3-nano:30b",
    "nemotron-3-super",
    "nemotron-3-ultra"
];

const DB_FILE = path.join(__dirname, 'chats.json');

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Markdown Parser
const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true
});

// --- Database Helpers ---
const loadDB = () => {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ chats: {} }));
    return JSON.parse(fs.readFileSync(DB_FILE));
};

const saveDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

// --- Helper: Python Script Execution ---
const runPythonScript = (scriptContent) => {
    return new Promise((resolve, reject) => {
        const tempFile = path.join(__dirname, `temp_script_${Date.now()}.py`);
        fs.writeFileSync(tempFile, scriptContent);

        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

        exec(`${pythonCmd} ${tempFile}`, (error, stdout, stderr) => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

            if (error) {
                resolve({ success: false, output: stderr || error.message });
            } else {
                resolve({ success: true, output: stdout });
            }
        });
    });
};

// --- Helper: Call Ollama Cloud API (Streaming) ---
// Returns the full response string at the end
async function streamOllamaCloud(model, messages, res) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await fetch(`${OLLAMA_CLOUD_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OLLAMA_API_KEY}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    stream: true
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ollama Cloud Error: ${response.status} - ${errorText}`);
            }

            let fullResponse = "";
            const decoder = new TextDecoder();

            for await (const chunk of response.body) {
                const text = decoder.decode(chunk, { stream: true });
                const lines = text.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        if (dataStr === '[DONE]') {
                            res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
                            res.end();
                            return resolve(fullResponse);
                        }
                        try {
                            const parsed = JSON.parse(dataStr);
                            const content = parsed.choices[0]?.delta?.content || "";
                            if (content) {
                                fullResponse += content;
                                res.write(`data: ${JSON.stringify({ content, done: false })}\n\n`);
                            }
                        } catch (e) {
                            // Ignore partial JSON chunks
                        }
                    }
                }
            }

            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ content: '', done: true })}\n\n`);
                res.end();
            }
            resolve(fullResponse);

        } catch (error) {
            reject(error);
        }
    });
}

// --- Helper: Non-Streaming Cloud Call (For Gamma extraction) ---
async function callOllamaCloudNonStreaming(model, prompt) {
    try {
        const response = await fetch(`${OLLAMA_CLOUD_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OLLAMA_API_KEY}`
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                stream: false
            })
        });

        if (!response.ok) return null;
        const data = await response.json();
        return data.choices[0]?.message?.content || null;
    } catch (e) {
        console.error("Gamma extraction failed:", e);
        return null;
    }
}

// --- Main Chat Endpoint ---
app.post('/api/chat', async (req, res) => {
    const { 
        chatId, 
        model, 
        messages, 
        useWebSearch, 
        useThinkingMode, 
        extractTextWithGamma,
        systemPrompt 
    } = req.body;

    const db = loadDB();
    if (!db.chats[chatId]) {
        db.chats[chatId] = { id: chatId, title: 'New Chat', messages: [], createdAt: new Date() };
    }

    const currentChat = db.chats[chatId];
    const lastUserMessage = messages[messages.length - 1].content;

    // 1. Web Search Logic (DuckDuckGo HTML scrape)
    let webContext = "";
    if (useWebSearch) {
        try {
            const searchRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(lastUserMessage)}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            const html = await searchRes.text();
            const snippets = html.match(/<a class="result__snippet".*?>(.*?)<\/a>/g) || [];
            webContext = "\n[WEB SEARCH RESULTS]:\n" + snippets.slice(0, 3).map(s => s.replace(/<[^>]*>?/gm, '')).join('\n');
        } catch (e) {
            console.error("Web search failed", e);
        }
    }

    // 2. Gamma Model Text Extraction (Using gemma4:31b as the extractor)
    let gammaExtractedContext = "";
    if (extractTextWithGamma && lastUserMessage.length > 10) {
        const extractionPrompt = `Extract key entities, code snippets, or specific data points from this text. Return only the extracted data:\n\n${lastUserMessage}`;
        const gammaResult = await callOllamaCloudNonStreaming('gemma4:31b', extractionPrompt);
        if (gammaResult) {
            gammaExtractedContext = `\n[GAMMA EXTRACTED CONTEXT]: ${gammaResult}`;
        }
    }

    // 3. Construct Final Messages Array
    let finalMessages = [];
    if (systemPrompt) {
        finalMessages.push({ role: 'system', content: systemPrompt });
    }
    
    // Add history (excluding the last user message which we will modify)
    finalMessages.push(...messages.slice(0, -1));

    // Add the modified current user message
    let finalUserContent = lastUserMessage;
    if (webContext) finalUserContent += webContext;
    if (gammaExtractedContext) finalUserContent += gammaExtractedContext;
    
    // Thinking mode tag injection
    if (useThinkingMode) {
        finalUserContent = `<thinking>\n${finalUserContent}\n</thinking>`;
    }

    finalMessages.push({ role: 'user', content: finalUserContent });

    // Save User Message (original, without injected context)
    currentChat.messages.push({ role: 'user', content: lastUserMessage, timestamp: new Date() });
    saveDB(db);

    // 4. Stream Response from Ollama Cloud
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const fullAssistantResponse = await streamOllamaCloud(model || 'gpt-oss:20b', finalMessages, res);
        
        // Save the Assistant's response to the database after streaming completes
        if (fullAssistantResponse) {
            currentChat.messages.push({ 
                role: 'assistant', 
                content: fullAssistantResponse, 
                timestamp: new Date() 
            });
            saveDB(db);
        }
        
    } catch (error) {
        console.error(error);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ content: `\n[Error: ${error.message}]`, done: true })}\n\n`);
            res.end();
        }
    }
});

// --- Endpoint to get Available Models ---
app.get('/api/models', (req, res) => {
    res.json(AVAILABLE_MODELS);
});

// --- PDF Generation Endpoint ---
app.post('/api/generate-pdf', (req, res) => {
    const { content, title } = req.body;
    const doc = new PDFDocument();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${title || 'export'}.pdf`);
    
    doc.pipe(res);
    doc.fontSize(20).text(title || 'Chat Export', { align: 'center' });
    doc.moveDown();
    
    const plainText = content.replace(/[#*`]/g, '');
    doc.fontSize(12).text(plainText);
    
    doc.end();
});

// --- Python Execution Endpoint ---
app.post('/api/run-python', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    const result = await runPythonScript(code);
    res.json(result);
});

// --- Chat Management Endpoints ---
app.get('/api/chats', (req, res) => {
    const db = loadDB();
    const chatList = Object.values(db.chats).map(c => ({ id: c.id, title: c.title, date: c.createdAt }));
    res.json(chatList);
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

// Start Server
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`☁️  Connected to Ollama Cloud API at ${OLLAMA_CLOUD_URL}`);
    console.log(`🤖 Available Models: ${AVAILABLE_MODELS.join(', ')}`);
});