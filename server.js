// =============================================================
//  Nexus Chat — Express backend for Ollama Cloud
//  Features: streaming, vision, system prompt, tools
// =============================================================

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { Ollama } from 'ollama'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json({ limit: '50mb' })) // large for base64 images
app.use(express.static(path.join(__dirname, 'public')))

// ---- Ollama Cloud client ----
const OLLAMA_HOST = process.env.OLLAMA_BASE_URL || 'https://ollama.com'
const OLLAMA_KEY = process.env.OLLAMA_API_KEY

if (!OLLAMA_KEY) console.warn('⚠️  OLLAMA_API_KEY is not set.')

const ollama = new Ollama({
  host: OLLAMA_HOST,
  headers: { Authorization: `Bearer ${OLLAMA_KEY || ''}` },
})

// =============================================================
//  Models
// =============================================================
const AVAILABLE_MODELS = [
  { id: 'gemma4:31b',          name: 'Gemma 4 31B',          provider: 'Google',  vision: true,  tools: true, tag: 'Free' },
  { id: 'gpt-oss:120b',        name: 'GPT-OSS 120B',         provider: 'OpenAI',  vision: false, tools: true, tag: 'Free' },
  { id: 'gpt-oss:20b',         name: 'GPT-OSS 20B',          provider: 'OpenAI',  vision: false, tools: true, tag: 'Free' },
  { id: 'nemotron-3-nano:30b', name: 'Nemotron 3 Nano 30B',  provider: 'NVIDIA',  vision: false, tools: true, tag: 'Free' },
  { id: 'nemotron-3-super',    name: 'Nemotron 3 Super',     provider: 'NVIDIA',  vision: false, tools: true, tag: 'Free' },
  { id: 'nemotron-3-ultra',    name: 'Nemotron 3 Ultra',     provider: 'NVIDIA',  vision: false, tools: true, tag: 'Free' },
]

// =============================================================
//  Tool definitions (OpenAI-compatible JSON schema)
// =============================================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time. Optionally in a specific IANA timezone (e.g. "Africa/Douala", "America/New_York").',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone name. Defaults to UTC if omitted.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression. Supports +, -, *, /, %, **, parentheses, and Math functions like sqrt, sin, cos, log, abs, round, floor, ceil, min, max, pow.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'The math expression to evaluate, e.g. "(2+3)*4" or "sqrt(16) + Math.PI".',
          },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'date_math',
      description: 'Compute a date offset from today. Useful for "what day is it in 2 weeks", "what was the date 30 days ago", "how many days until X".',
      parameters: {
        type: 'object',
        properties: {
          offset_days: { type: 'number', description: 'Number of days from today (can be negative).' },
          offset_weeks: { type: 'number', description: 'Number of weeks from today (can be negative).' },
          offset_months: { type: 'number', description: 'Number of months from today (can be negative).' },
          offset_years: { type: 'number', description: 'Number of years from today (can be negative).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'days_between',
      description: 'Calculate the number of days between two dates (YYYY-MM-DD format). Returns the absolute number of days and the signed difference (date2 - date1).',
      parameters: {
        type: 'object',
        properties: {
          date1: { type: 'string', description: 'First date in YYYY-MM-DD format.' },
          date2: { type: 'string', description: 'Second date in YYYY-MM-DD format.' },
        },
        required: ['date1', 'date2'],
      },
    },
  },
]

// =============================================================
//  Tool implementations
// =============================================================
function safeCalculate(expression) {
  if (typeof expression !== 'string' || expression.length > 500) {
    throw new Error('Invalid expression')
  }

  // Whitelist: digits, operators, spaces, parens, dots, commas and Math.* calls
  const allowedChars = /^[0-9+\-*/%().,\sA-Za-z_]+$/
  if (!allowedChars.test(expression)) {
    throw new Error('Expression contains disallowed characters')
  }

  // Block dangerous identifiers
  const banned = /\b(import|require|eval|Function|process|global|window|this|constructor|__proto__|prototype)\b/
  if (banned.test(expression)) {
    throw new Error('Expression contains disallowed keywords')
  }

  // Replace Math.foo -> safe internal map (only allow listed)
  const mathFns = ['sqrt','cbrt','abs','sin','cos','tan','asin','acos','atan','atan2','log','log2','log10','exp','pow','round','floor','ceil','min','max','random','sign','trunc','PI','E','LN2','LN10','SQRT2']
  const mathRegex = /\bMath\.([A-Za-z0-9_]+)/g
  let m
  while ((m = mathRegex.exec(expression))) {
    if (!mathFns.includes(m[1])) {
      throw new Error(`Math.${m[1]} is not allowed`)
    }
  }

  // Only Math.* prefix allowed for identifiers
  const identRegex = /[A-Za-z_][A-Za-z0-9_]*/g
  const ids = expression.match(identRegex) || []
  for (const id of ids) {
    // Must be preceded by "Math." — check the slice
    const idx = expression.indexOf(id)
    const before = expression.slice(Math.max(0, idx - 5), idx)
    if (!before.endsWith('Math.')) {
      // Allowed: Math itself (as part of Math.something)
      if (id !== 'Math' && before.trim() !== 'Math.') {
        throw new Error(`Unknown identifier: ${id}`)
      }
    }
  }

  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${expression});`)
  const result = fn()
  if (typeof result === 'number' && !isFinite(result)) {
    throw new Error('Result is not finite')
  }
  return result
}

function getCurrentTime({ timezone = 'UTC' } = {}) {
  try {
    const now = new Date()
    const tz = timezone || 'UTC'
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    })
    return {
      iso_utc: now.toISOString(),
      timezone: tz,
      formatted: fmt.format(now),
      unix: Math.floor(now.getTime() / 1000),
    }
  } catch (e) {
    return { error: `Invalid timezone: ${timezone}` }
  }
}

function dateMath({ offset_days = 0, offset_weeks = 0, offset_months = 0, offset_years = 0 } = {}) {
  const d = new Date()
  d.setDate(d.getDate() + Number(offset_days || 0))
  d.setDate(d.getDate() + Number(offset_weeks || 0) * 7)
  d.setMonth(d.getMonth() + Number(offset_months || 0))
  d.setFullYear(d.getFullYear() + Number(offset_years || 0))
  return {
    result_date: d.toISOString().slice(0, 10),
    weekday: d.toLocaleDateString('en-GB', { weekday: 'long' }),
    full: d.toDateString(),
  }
}

function daysBetween({ date1, date2 }) {
  const d1 = new Date(date1 + 'T00:00:00Z')
  const d2 = new Date(date2 + 'T00:00:00Z')
  if (isNaN(d1) || isNaN(d2)) return { error: 'Invalid date format. Use YYYY-MM-DD.' }
  const msPerDay = 86400000
  const diff = Math.round((d2 - d1) / msPerDay)
  return {
    date1,
    date2,
    days_absolute: Math.abs(diff),
    days_signed: diff,
    note: diff >= 0 ? `${date2} is ${diff} days after ${date1}` : `${date2} is ${Math.abs(diff)} days before ${date1}`,
  }
}

async function executeTool(name, args) {
  console.log(`[tool] ${name}`, args)
  try {
    switch (name) {
      case 'get_current_time': return getCurrentTime(args)
      case 'calculate':        return { expression: args.expression, result: safeCalculate(args.expression) }
      case 'date_math':        return dateMath(args)
      case 'days_between':     return daysBetween(args)
      default:                 return { error: `Unknown tool: ${name}` }
    }
  } catch (e) {
    return { error: e.message }
  }
}

// =============================================================
//  Routes
// =============================================================
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

app.get('/api/models', (req, res) => res.json({ models: AVAILABLE_MODELS }))

app.get('/api/debug/models', async (req, res) => {
  try {
    const list = await ollama.list()
    res.json(list)
  } catch (e) {
    console.error('[debug] error:', e)
    res.status(e?.status || 500).json({ error: e?.message, name: e?.name, status: e?.status })
  }
})

// =============================================================
//  POST /api/chat
//  Body: { model, messages, system?, images? }
//  - messages: [{role, content}]
//  - system: optional system prompt string
//  - images: array of base64 (no data: prefix) — will be attached to last user msg
//  - useTools: boolean (default true)
// =============================================================
app.post('/api/chat', async (req, res) => {
  const { model, messages, system, images, useTools = true } = req.body || {}

  console.log(`\n[/api/chat] model=${model} msgs=${messages?.length} imgs=${images?.length || 0} tools=${useTools}`)

  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Body must include { model, messages }' })
  }
  if (!OLLAMA_KEY) {
    return res.status(500).json({ error: 'OLLAMA_API_KEY not configured' })
  }

  // Build full message list with system prompt
  const fullMessages = []
  if (system && system.trim()) {
    fullMessages.push({ role: 'system', content: system.trim() })
  }
  fullMessages.push(...messages)

  // Attach images to last user message
  if (images?.length) {
    for (let i = fullMessages.length - 1; i >= 0; i--) {
      if (fullMessages[i].role === 'user') {
        fullMessages[i].images = images
        break
      }
    }
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  try {
    // ----- Agent loop: allow multiple tool-call rounds -----
    const workingMessages = [...fullMessages]
    const MAX_ROUNDS = 5

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const stream = await ollama.chat({
        model,
        messages: workingMessages,
        tools: useTools ? TOOLS : undefined,
        stream: true,
      })

      let assistantContent = ''
      let assistantThinking = ''
      let toolCalls = []

      for await (const chunk of stream) {
        const msg = chunk?.message || {}

        if (msg.content) {
          assistantContent += msg.content
          send({ content: msg.content })
        }
        if (msg.thinking) {
          assistantThinking += msg.thinking
          send({ thinking: msg.thinking })
        }
        if (msg.tool_calls?.length) {
          // accumulate (usually only sent once, non-streamed)
          toolCalls = msg.tool_calls
        }
      }

      // No tool calls -> we're done
      if (!toolCalls.length) {
        send({ done: true })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // Record the assistant's tool-call turn
      workingMessages.push({
        role: 'assistant',
        content: assistantContent || '',
        tool_calls: toolCalls,
      })

      // Execute each tool, push results
      for (const call of toolCalls) {
        const name = call.function?.name
        let args = {}
        try {
          args = typeof call.function?.arguments === 'string'
            ? JSON.parse(call.function.arguments)
            : (call.function?.arguments || {})
        } catch { /* leave args as {} */ }

        // Notify the client a tool is running (optional UI hint)
        send({ tool_call: { name, args } })

        const result = await executeTool(name, args)

        send({ tool_result: { name, result } })

        workingMessages.push({
          role: 'tool',
          content: JSON.stringify(result),
        })
      }
      // Loop again so model can use the tool results
    }

    // Exceeded rounds
    send({ error: 'Tool loop limit reached' })
    send({ done: true })
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('[chat error]', err)
    if (res.headersSent) {
      send({ error: err?.message || 'stream error' })
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.status(err?.status || 500).json({ error: err?.message || 'chat failed' })
    }
  }
})

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`✅ Nexus Chat on :${PORT}`)
  console.log(`   HOST: ${OLLAMA_HOST}  KEY: ${!!OLLAMA_KEY}`)
})