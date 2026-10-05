require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Available models from your Ollama account
const AVAILABLE_MODELS = [
  { id: 'gemma4:31b', name: 'Gemma 4 31B', provider: 'Google', vision: true, tag: 'Free' },
  { id: 'gpt-oss:120b', name: 'GPT-OSS 120B', provider: 'OpenAI', vision: false, tag: 'Free' },
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', provider: 'OpenAI', vision: false, tag: 'Free' },
  { id: 'nemotron-3-nano:30b', name: 'Nemotron 3 Nano 30B', provider: 'NVIDIA', vision: false, tag: 'Free' },
  { id: 'nemotron-3-super', name: 'Nemotron 3 Super', provider: 'NVIDIA', vision: false, tag: 'Free' },
  { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra', provider: 'NVIDIA', vision: false, tag: 'Free' },
];

// GET models list
app.get('/api/models', (req, res) => {
  res.json({ models: AVAILABLE_MODELS });
});

// POST chat completion (streaming)
app.post('/api/chat', async (req, res) => {
  const { model, messages } = req.body;
  
  if (!model || !messages) {
    return res.status(400).json({ error: 'Model and messages are required' });
  }
  
  if (!AVAILABLE_MODELS.find((m) => m.id === model)) {
    return res.status(400).json({ error: 'Invalid model' });
  }
  
  try {
    const response = await fetch(`${process.env.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error('Ollama API error:', errText);
      return res.status(response.status).json({ error: errText });
    }
    
    // Stream response back to client via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            res.write(`data: ${JSON.stringify({ content: json.message.content })}\n\n`);
          }
          if (json.done) {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          }
        } catch (e) {
          // ignore parse errors on partial chunks
        }
      }
    }
    
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Chat error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});