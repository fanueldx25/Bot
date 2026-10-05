// ============ State ============
const state = {
  models: [],
  currentModel: 'gemma4:31b',
  messages: [],
  isStreaming: false,
};

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
  modelSheet: document.getElementById('modelSheet'),
  sheetBackdrop: document.getElementById('sheetBackdrop'),
  sheetPanel: document.getElementById('sheetPanel'),
  modelList: document.getElementById('modelList'),
};

// ============ Init ============
async function init() {
  await loadModels();
  autoResize();
  bindEvents();
}

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    state.models = data.models;
    renderModelList();
    updateCurrentModelLabel();
  } catch (err) {
    console.error('Failed to load models:', err);
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
            ${m.provider}${m.vision ? ' · 👁 Vision' : ''}
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-3">
          ${m.tag ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">${m.tag}</span>` : ''}
          ${m.id === state.currentModel ? '<svg class="w-4 h-4 text-accent2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>' : ''}
        </div>
      </div>
    `
    )
    .join('');

  els.modelList.querySelectorAll('.model-row').forEach((row) => {
    row.addEventListener('click', () => selectModel(row.dataset.id));
  });
}

function selectModel(id) {
  state.currentModel = id;
  updateCurrentModelLabel();
  renderModelList();
  closeSheet();
}

function updateCurrentModelLabel() {
  const m = state.models.find((x) => x.id === state.currentModel);
  els.currentModel.textContent = m ? m.name : state.currentModel;
}

function openSheet() {
  els.modelSheet.classList.remove('hidden');
  requestAnimationFrame(() => {
    els.sheetBackdrop.classList.add('opacity-100');
    els.sheetPanel.classList.remove('translate-y-full');
  });
}

function closeSheet() {
  els.sheetBackdrop.classList.remove('opacity-100');
  els.sheetPanel.classList.add('translate-y-full');
  setTimeout(() => els.modelSheet.classList.add('hidden'), 250);
}

// ============ Chat ============
function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = 'msg';
  if (role === 'user') {
    div.innerHTML = `<div class="msg-user"></div>`;
    div.firstElementChild.textContent = content;
  } else {
    div.innerHTML = `<div class="msg-assistant"></div>`;
    div.firstElementChild.innerHTML = renderMarkdown(content);
  }
  els.messages.appendChild(div);
  scrollToBottom();
  return div.querySelector(role === 'user' ? '.msg-user' : '.msg-assistant');
}

function addTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'msg';
  div.id = 'typing';
  div.innerHTML = `<div class="msg-assistant"><div class="typing"><span></span><span></span><span></span></div></div>`;
  els.messages.appendChild(div);
  scrollToBottom();
  return div;
}

function removeTypingIndicator() {
  document.getElementById('typing')?.remove();
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function sendMessage(text) {
  if (state.isStreaming) return;

  const content = text.trim();
  if (!content) return;

  // Hide welcome
  els.welcome?.remove();

  // Add user message
  addMessage('user', content);
  state.messages.push({ role: 'user', content });

  // Clear input
  els.input.value = '';
  autoResize();

  // Typing indicator
  const typingEl = addTypingIndicator();
  state.isStreaming = true;
  updateSendButton();

  let assistantEl = null;
  let assistantText = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.currentModel,
        messages: state.messages,
      }),
    });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          if (json.content) {
            if (!assistantEl) {
              removeTypingIndicator();
              assistantEl = addMessage('assistant', '');
            }
            assistantText += json.content;
            assistantEl.innerHTML = renderMarkdown(assistantText);
            scrollToBottom();
          }
        } catch (e) {
          // ignore
        }
      }
    }

    if (assistantText) {
      state.messages.push({ role: 'assistant', content: assistantText });
    }
  } catch (err) {
    removeTypingIndicator();
    if (!assistantEl) {
      assistantEl = addMessage('assistant', '');
    }
    assistantEl.innerHTML = `<span class="text-red-400">⚠️ Error: ${err.message}</span>`;
  } finally {
    removeTypingIndicator();
    state.isStreaming = false;
    updateSendButton();
  }
}

// ============ Markdown Lite ============
function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============ UI Helpers ============
function autoResize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 128) + 'px';
}

function updateSendButton() {
  els.sendBtn.disabled = state.isStreaming || !els.input.value.trim();
}

function clearChat() {
  state.messages = [];
  els.messages.innerHTML = '';
  els.messages.appendChild(els.welcome.cloneNode(true));
  els.welcome = document.getElementById('welcome');
  bindSuggestions();
}

function bindSuggestions() {
  document.querySelectorAll('.suggestion').forEach((btn) => {
    btn.addEventListener('click', () => {
      els.input.value = btn.textContent.trim().replace(/^[^\w]+/, '').trim();
      autoResize();
      updateSendButton();
      els.input.focus();
    });
  });
}

// ============ Events ============
function bindEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(els.input.value);
  });

  els.input.addEventListener('input', () => {
    autoResize();
    updateSendButton();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 768) {
      e.preventDefault();
      sendMessage(els.input.value);
    }
  });

  els.modelBtn.addEventListener('click', openSheet);
  els.sheetBackdrop.addEventListener('click', closeSheet);
  els.clearBtn.addEventListener('click', clearChat);

  bindSuggestions();
}

// ============ Start ============
init();