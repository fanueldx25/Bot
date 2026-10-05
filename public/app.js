// ============ State ============
const STORAGE_KEY = 'nexus.settings.v1'
const state = {
  models: [],
  currentModel: 'gemma4:31b',
  messages: [],
  pendingImages: [], // [{name, dataUrl, base64, mime}]
  isStreaming: false,
  settings: {
    system: '',
    useTools: true,
  },
}

// ============ Elements ============
const els = {
  messages: document.getElementById('messages'),
  welcome: document.getElementById('welcome'),
  form: document.getElementById('chatForm'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('sendBtn'),
  modelBtn: document.getElementById('modelBtn'),
  currentModel: document.getElementById('currentModel'),
  clearBtn: document.getElementById('clearBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  attachBtn: document.getElementById('attachBtn'),
  fileInput: document.getElementById('fileInput'),
  imagePreview: document.getElementById('imagePreview'),

  modelSheet: document.getElementById('modelSheet'),
  sheetBackdrop: document.getElementById('sheetBackdrop'),
  sheetPanel: document.getElementById('sheetPanel'),
  modelList: document.getElementById('modelList'),

  settingsSheet: document.getElementById('settingsSheet'),
  settingsBackdrop: document.getElementById('settingsBackdrop'),
  settingsPanel: document.getElementById('settingsPanel'),
  systemPrompt: document.getElementById('systemPrompt'),
  toolsToggle: document.getElementById('toolsToggle'),
  saveSettings: document.getElementById('saveSettings'),
  resetSettings: document.getElementById('resetSettings'),
}

// ============ Persistence ============
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) Object.assign(state.settings, JSON.parse(raw))
  } catch {}
}
function persistSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)) } catch {}
}

// ============ Init ============
async function init() {
  loadSettings()
  els.systemPrompt.value = state.settings.system
  els.toolsToggle.checked = state.settings.useTools

  await loadModels()
  autoResize()
  bindEvents()
}

async function loadModels() {
  try {
    const res = await fetch('/api/models')
    const data = await res.json()
    state.models = data.models
    renderModelList()
    updateCurrentModelLabel()
  } catch (err) {
    console.error('Failed to load models:', err)
  }
}

// ============ Model Picker ============
function renderModelList() {
  els.modelList.innerHTML = state.models
    .map(
      (m) => `
      <div class="model-row ${m.id === state.currentModel ? 'active' : ''}" data-id="${m.id}">
        <div class="flex flex-col min-w-0">
          <span class="text-sm font-medium truncate">${m.name}</span>
          <span class="text-[11px] text-gray-500 mt-0.5">
            ${m.provider}${m.vision ? ' · 👁 Vision' : ''}${m.tools ? ' · 🛠 Tools' : ''}
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-3">
          ${m.tag ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">${m.tag}</span>` : ''}
          ${m.id === state.currentModel ? '<svg class="w-4 h-4 text-accent2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>' : ''}
        </div>
      </div>
    `
    )
    .join('')

  els.modelList.querySelectorAll('.model-row').forEach((row) => {
    row.addEventListener('click', () => selectModel(row.dataset.id))
  })
}

function selectModel(id) {
  state.currentModel = id
  updateCurrentModelLabel()
  renderModelList()
  closeSheet(els.modelSheet, els.sheetBackdrop, els.sheetPanel)
}

function updateCurrentModelLabel() {
  const m = state.models.find((x) => x.id === state.currentModel)
  els.currentModel.textContent = m ? m.name : state.currentModel
}

// ============ Sheets ============
function openSheet(sheet, backdrop, panel) {
  sheet.classList.remove('hidden')
  requestAnimationFrame(() => {
    backdrop.classList.add('opacity-100')
    panel.classList.remove('translate-y-full')
  })
}
function closeSheet(sheet, backdrop, panel) {
  backdrop.classList.remove('opacity-100')
  panel.classList.add('translate-y-full')
  setTimeout(() => sheet.classList.add('hidden'), 250)
}

// ============ Images ============
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      const base64 = String(dataUrl).split(',')[1]
      resolve({ name: file.name, dataUrl, base64, mime: file.type })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function handleFiles(files) {
  const arr = Array.from(files).slice(0, 4)
  for (const f of arr) {
    if (!f.type.startsWith('image/')) continue
    if (f.size > 10 * 1024 * 1024) {
      alert(`${f.name} is larger than 10MB and was skipped.`)
      continue
    }
    const img = await fileToBase64(f)
    state.pendingImages.push(img)
  }
  renderImagePreview()
}

function renderImagePreview() {
  if (!state.pendingImages.length) {
    els.imagePreview.classList.add('hidden')
    els.imagePreview.innerHTML = ''
    return
  }
  els.imagePreview.classList.remove('hidden')
  els.imagePreview.innerHTML = state.pendingImages
    .map(
      (img, i) => `
      <div class="relative shrink-0">
        <img src="${img.dataUrl}" class="w-14 h-14 object-cover rounded-lg border border-border" />
        <button data-idx="${i}" class="remove-img absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full text-[10px] flex items-center justify-center">✕</button>
      </div>`
    )
    .join('')
  els.imagePreview.querySelectorAll('.remove-img').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.pendingImages.splice(Number(btn.dataset.idx), 1)
      renderImagePreview()
    })
  })
}

// ============ Chat ============
function addMessage(role, content) {
  const div = document.createElement('div')
  div.className = 'msg'
  if (role === 'user') {
    div.innerHTML = `<div class="msg-user"></div>`
    div.firstElementChild.textContent = content
  } else {
    div.innerHTML = `<div class="msg-assistant"></div>`
    div.firstElementChild.innerHTML = renderMarkdown(content)
  }
  els.messages.appendChild(div)
  scrollToBottom()
  return div.querySelector(role === 'user' ? '.msg-user' : '.msg-assistant')
}

function addUserMessageWithImages(text, images) {
  const div = document.createElement('div')
  div.className = 'msg'
  const bubble = document.createElement('div')
  bubble.className = 'msg-user'
  if (images?.length) {
    const imgs = document.createElement('div')
    imgs.className = 'flex gap-1 mb-1.5 flex-wrap'
    imgs.innerHTML = images
      .map((img) => `<img src="${img.dataUrl}" class="w-20 h-20 object-cover rounded-lg border border-white/20" />`)
      .join('')
    bubble.appendChild(imgs)
  }
  if (text) {
    const p = document.createElement('div')
    p.textContent = text
    bubble.appendChild(p)
  }
  div.appendChild(bubble)
  els.messages.appendChild(div)
  scrollToBottom()
  return bubble
}

function addTypingIndicator() {
  const div = document.createElement('div')
  div.className = 'msg'
  div.id = 'typing'
  div.innerHTML = `<div class="msg-assistant"><div class="typing"><span></span><span></span><span></span></div></div>`
  els.messages.appendChild(div)
  scrollToBottom()
  return div
}

function removeTypingIndicator() {
  document.getElementById('typing')?.remove()
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight
}

function addToolChip(name, args) {
  const chip = document.createElement('div')
  chip.className = 'tool-chip'
  const icons = {
    get_current_time: '⏰', calculate: '🧮', date_math: '📅', days_between: '📆',
  }
  const icon = icons[name] || '🛠'
  const argText = Object.keys(args || {}).length
    ? Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
    : ''
  chip.innerHTML = `<span class="opacity-80">${icon} ${name}</span>${argText ? ` <span class="opacity-50">(${argText})</span>` : ''}`
  els.messages.appendChild(chip)
  scrollToBottom()
}

async function sendMessage(text) {
  if (state.isStreaming) return
  const content = text.trim()
  const imgs = state.pendingImages.slice()
  if (!content && !imgs.length) return

  // Vision guard
  const currentModel = state.models.find((m) => m.id === state.currentModel)
  if (imgs.length && currentModel && !currentModel.vision) {
    alert(`${currentModel.name} does not support images. Switch to a vision model (e.g. Gemma 4 31B).`)
    return
  }

  els.welcome?.remove()

  // Show user message
  addUserMessageWithImages(content, imgs)

  // Add to history (text only — images are per-turn)
  state.messages.push({ role: 'user', content: content || '(image attached)' })

  // Clear composer + images
  els.input.value = ''
  state.pendingImages = []
  renderImagePreview()
  autoResize()

  const typingEl = addTypingIndicator()
  state.isStreaming = true
  updateSendButton()

  let assistantEl = null
  let assistantText = ''

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.currentModel,
        messages: state.messages,
        system: state.settings.system,
        images: imgs.map((i) => i.base64),
        useTools: state.settings.useTools,
      }),
    })

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}))
      throw new Error(errJson.error || `Server error: ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try {
          const json = JSON.parse(data)

          if (json.content) {
            if (!assistantEl) {
              removeTypingIndicator()
              assistantEl = addMessage('assistant', '')
            }
            assistantText += json.content
            assistantEl.innerHTML = renderMarkdown(assistantText)
            scrollToBottom()
          }

          if (json.tool_call) {
            removeTypingIndicator()
            addToolChip(json.tool_call.name, json.tool_call.args)
            addTypingIndicator()
          }

          if (json.error) {
            if (!assistantEl) {
              removeTypingIndicator()
              assistantEl = addMessage('assistant', '')
            }
            assistantText += `\n\n⚠️ ${json.error}`
            assistantEl.innerHTML = renderMarkdown(assistantText)
          }
        } catch { /* skip malformed */ }
      }
    }

    if (assistantText) state.messages.push({ role: 'assistant', content: assistantText })
    removeTypingIndicator()
  } catch (err) {
    removeTypingIndicator()
    if (!assistantEl) assistantEl = addMessage('assistant', '')
    assistantEl.innerHTML = `<span class="text-red-400">⚠️ ${err.message}</span>`
  } finally {
    removeTypingIndicator()
    state.isStreaming = false
    updateSendButton()
  }
}

// ============ Markdown Lite ============
function renderMarkdown(text) {
  if (!text) return ''
  let html = escapeHtml(text)

  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.trim()}</code></pre>`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')

  return html
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ============ UI helpers ============
function autoResize() {
  els.input.style.height = 'auto'
  els.input.style.height = Math.min(els.input.scrollHeight, 128) + 'px'
}

function updateSendButton() {
  els.sendBtn.disabled = state.isStreaming || (!els.input.value.trim() && !state.pendingImages.length)
}

function clearChat() {
  state.messages = []
  state.pendingImages = []
  renderImagePreview()
  els.messages.innerHTML = ''
  const w = document.getElementById('welcome') || els.welcome
  if (w) els.messages.appendChild(w.cloneNode(true))
  els.welcome = document.getElementById('welcome')
  bindSuggestions()
}

function bindSuggestions() {
  document.querySelectorAll('.suggestion').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.input.value = btn.textContent.trim().replace(/^[^\w]+/, '').trim()
      autoResize()
      updateSendButton()
      els.input.focus()
    })
  })
}

// ============ Events ============
function bindEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault()
    sendMessage(els.input.value)
  })

  els.input.addEventListener('input', () => { autoResize(); updateSendButton() })

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
      e.preventDefault()
      sendMessage(els.input.value)
    }
  })

  els.modelBtn.addEventListener('click', () => openSheet(els.modelSheet, els.sheetBackdrop, els.sheetPanel))
  els.sheetBackdrop.addEventListener('click', () => closeSheet(els.modelSheet, els.sheetBackdrop, els.sheetPanel))

  els.settingsBtn.addEventListener('click', () => {
    els.systemPrompt.value = state.settings.system
    els.toolsToggle.checked = state.settings.useTools
    openSheet(els.settingsSheet, els.settingsBackdrop, els.settingsPanel)
  })
  els.settingsBackdrop.addEventListener('click', () => closeSheet(els.settingsSheet, els.settingsBackdrop, els.settingsPanel))

  els.saveSettings.addEventListener('click', () => {
    state.settings.system = els.systemPrompt.value
    state.settings.useTools = els.toolsToggle.checked
    persistSettings()
    closeSheet(els.settingsSheet, els.settingsBackdrop, els.settingsPanel)
  })
  els.resetSettings.addEventListener('click', () => {
    state.settings.system = ''
    state.settings.useTools = true
    els.systemPrompt.value = ''
    els.toolsToggle.checked = true
    persistSettings()
  })

  els.clearBtn.addEventListener('click', clearChat)

  els.attachBtn.addEventListener('click', () => els.fileInput.click())
  els.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files)
    e.target.value = ''
  })

  // Paste images from clipboard
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files = []
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length) handleFiles(files)
  })

  bindSuggestions()
}

init()