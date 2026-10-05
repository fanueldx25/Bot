// =============================================================
//  Nexus Chat — Express backend for Ollama Cloud
//  Deploy target: Render
// =============================================================

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { Ollama } from 'ollama'

// ---- ESM __dirname shim ----
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---- App setup ----
const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ---- Ollama Cloud client ----
const OLLAMA_HOST = process.env.OLLAMA_BASE_URL || 'https://ollama.com'
const OLLAMA_KEY = process.env.OLLAMA_API_KEY

if (!OLLAMA_KEY) {
  console.warn('⚠️  OLLAMA_API_KEY is not set — requests will fail with 401.')
}

const ollama = new Ollama({
  host: OLLAMA_HOST,
  headers: {
    Authorization: `Bearer ${OLLAMA_KEY || ''}`,
  },
})

// =============================================================
//  Available models
//  ⚠️ Replace the `id` values with the EXACT ids returned by
//     GET /api/debug/models after you deploy. Display names
//     in the Ollama UI do NOT always match API model IDs.
// =============================================================
const AVAILABLE_MODELS = [
  { id: 'gemma4:31b', name: 'Gemma 4 31B', provider: 'Google', vision: true, tag: 'Free' },
  { id: 'gpt-oss:120b', name: 'GPT-OSS 120B', provider: 'OpenAI', vision: false, tag: 'Free' },
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', provider: 'OpenAI', vision: false, tag: 'Free' },
  { id: 'nemotron-3-nano:30b', name: 'Nemotron 3 Nano 30B', provider: 'NVIDIA', vision: false, tag: 'Free' },
  { id: 'nemotron-3-super', name: 'Nemotron 3 Super', provider: 'NVIDIA', vision: false, tag: 'Free' },
  { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra', provider: 'NVIDIA', vision: false, tag: 'Free' },
]

// =============================================================
//  Routes
// =============================================================

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() })
})

// List of models the UI offers
app.get('/api/models', (req, res) => {
  res.json({ models: AVAILABLE_MODELS })
})

// Debug: ask Ollama Cloud which models your key actually has access to.
// Open this in your browser after deploy:
//   https://your-app.onrender.com/api/debug/models
app.get('/api/debug/models', async (req, res) => {
  try {
    const list = await ollama.list()
    res.json(list)
  } catch (e) {
    console.error('[debug] ollama.list error:', e)
    res.status(e?.status || 500).json({
      error: e?.message || 'unknown error',
      name: e?.name,
      status: e?.status,
    })
  }
})

// Streaming chat via Server-Sent Events (SSE)
app.post('/api/chat', async (req, res) => {
  const { model, messages } = req.body || {}
  console.log(`\n[/api/chat] model=${model} msgs=${messages?.length || 0}`)
  
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Body must include { model, messages }' })
  }
  if (!OLLAMA_KEY) {
    return res.status(500).json({ error: 'OLLAMA_API_KEY is not configured on the server' })
  }
  
  // Prep SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // disables proxy buffering (Render)
  res.flushHeaders?.()
  
  try {
    const stream = await ollama.chat({
      model,
      messages,
      stream: true,
    })
    
    for await (const chunk of stream) {
      const content = chunk?.message?.content
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`)
      }
    }
    
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('[chat error]', err)
    
    // If headers already sent, push an SSE error frame; otherwise JSON
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err?.message || 'stream error' })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.status(err?.status || 500).json({
        error: err?.message || 'chat failed',
        status: err?.status,
      })
    }
  }
})

// SPA fallback — must be last
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// =============================================================
//  Start
// =============================================================
app.listen(PORT, () => {
  console.log(`✅ Nexus Chat server running on port ${PORT}`)
  console.log(`   OLLAMA_HOST: ${OLLAMA_HOST}`)
  console.log(`   API key set: ${!!OLLAMA_KEY}`)
})