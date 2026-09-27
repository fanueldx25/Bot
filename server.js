import express from 'express';
import { startBot, requestPairing, state } from './bot.js';

const app = express();
app.use(express.json());

// ---- Boot bot ----
startBot().catch((err) => console.error('Bot boot failed:', err));

// ---- API ----
app.get('/api/status', (req, res) => {
  res.json({
    connected: state.connected,
    mode: state.mode,
    ownerJid: state.ownerJid,
    pairingCode: state.pairingCode,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    needsPairing: !state.connected && !state.ownerJid,
  });
});

app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const code = await requestPairing(phone);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['private', 'public'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode' });
  }
  state.mode = mode;
  res.json({ ok: true, mode });
});

// ---- UI ----
app.get('/', (req, res) => {
  res.type('html').send(UI_HTML);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🖥️  UI on http://0.0.0.0:${PORT}`));

// ---- Embedded Tailwind UI ----
const UI_HTML = /* html */ `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WA Bot Control</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            wa: {
              green: '#25D366',
              dark: '#128C7E',
              light: '#DCF8C6',
              gray: '#F0F0F0',
              darkgray: '#667781',
              chatbg: '#EFEAE2',
            }
          }
        }
      }
    }
  </script>
</head>
<body class="bg-neutral-950 text-neutral-100 min-h-screen flex items-center justify-center p-4">
  <main class="w-full max-w-md space-y-4">

    <!-- Header -->
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-wa-green flex items-center justify-center text-neutral-900 font-bold text-lg">W</div>
      <div>
        <h1 class="text-lg font-semibold">WhatsApp Bot</h1>
        <p class="text-xs text-neutral-500">Control Panel</p>
      </div>
      <div id="statusBadge" class="ml-auto px-3 py-1 rounded-full text-xs font-medium bg-neutral-800 text-neutral-400">
        Checking…
      </div>
    </div>

    <!-- Pairing Card (shown when not connected) -->
    <div id="pairingCard" class="rounded-2xl bg-neutral-900 border border-neutral-800 p-5 space-y-4">
      <div>
        <h2 class="text-sm font-medium text-neutral-300">Pair Device</h2>
        <p class="text-xs text-neutral-500 mt-1">Enter your phone number with country code (no + or spaces).</p>
      </div>
      <div class="flex gap-2">
        <input id="phone" type="tel" placeholder="2376XXXXXXXX"
          class="flex-1 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm focus:outline-none focus:border-wa-green transition-colors" />
        <button id="pairBtn"
          class="px-4 py-2 rounded-lg bg-wa-green hover:bg-wa-dark text-neutral-900 text-sm font-medium transition-colors disabled:opacity-50">
          Pair
        </button>
      </div>
      <div id="codeBox" class="hidden">
        <p class="text-xs text-neutral-500 mb-1">Enter this code in WhatsApp → Linked Devices → Link with phone number:</p>
        <div class="flex items-center gap-2">
          <div id="codeValue" class="flex-1 py-3 px-4 rounded-lg bg-neutral-800 border border-neutral-700 text-center text-2xl font-mono tracking-[0.3em] text-wa-green"></div>
          <button id="copyBtn" class="p-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 transition-colors" title="Copy">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
        </div>
      </div>
      <p id="pairError" class="hidden text-xs text-red-400"></p>
    </div>

    <!-- Status Card (shown when connected) -->
    <div id="statusCard" class="hidden rounded-2xl bg-neutral-900 border border-neutral-800 p-5 space-y-4">
      <div>
        <h2 class="text-sm font-medium text-neutral-300">Bot Status</h2>
        <p class="text-xs text-neutral-500 mt-1">Connected and running</p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-lg bg-neutral-800 p-3">
          <p class="text-[10px] uppercase tracking-wide text-neutral-500">Owner JID</p>
          <p id="ownerJid" class="text-xs font-mono mt-1 truncate">—</p>
        </div>
        <div class="rounded-lg bg-neutral-800 p-3">
          <p class="text-[10px] uppercase tracking-wide text-neutral-500">Uptime</p>
          <p id="uptime" class="text-xs font-mono mt-1">—</p>
        </div>
      </div>
      <div class="flex items-center justify-between pt-2 border-t border-neutral-800">
        <span class="text-sm text-neutral-400">Mode</span>
        <div class="flex gap-1 bg-neutral-800 rounded-lg p-1">
          <button data-mode="private" class="modeBtn px-3 py-1 rounded-md text-xs font-medium transition-colors">Private</button>
          <button data-mode="public" class="modeBtn px-3 py-1 rounded-md text-xs font-medium transition-colors">Public</button>
        </div>
      </div>
    </div>

    <p class="text-center text-[10px] text-neutral-600">Auto-refreshes every 3s</p>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    let currentMode = 'private';

    function fmtUptime(s) {
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    function setModeUI(mode) {
      currentMode = mode;
      document.querySelectorAll('.modeBtn').forEach(btn => {
        const active = btn.dataset.mode === mode;
        btn.className = 'modeBtn px-3 py-1 rounded-md text-xs font-medium transition-colors ' +
          (active ? 'bg-wa-green text-neutral-900' : 'text-neutral-400 hover:text-neutral-200');
      });
    }

    async function refresh() {
      try {
        const r = await fetch('/api/status').then(r => r.json());

        const badge = $('statusBadge');
        if (r.connected) {
          badge.textContent = 'Online';
          badge.className = 'ml-auto px-3 py-1 rounded-full text-xs font-medium bg-wa-green/20 text-wa-green';
          $('pairingCard').classList.add('hidden');
          $('statusCard').classList.remove('hidden');
          $('ownerJid').textContent = r.ownerJid || '—';
          $('uptime').textContent = fmtUptime(r.uptime);
          setModeUI(r.mode);
        } else {
          badge.textContent = 'Offline';
          badge.className = 'ml-auto px-3 py-1 rounded-full text-xs font-medium bg-red-500/20 text-red-400';
          $('pairingCard').classList.remove('hidden');
          $('statusCard').classList.add('hidden');

          if (r.pairingCode) {
            $('codeBox').classList.remove('hidden');
            $('codeValue').textContent = r.pairingCode;
          }
        }
      } catch (e) {
        console.error('Status fetch failed', e);
      }
    }

    $('pairBtn').addEventListener('click', async () => {
      const phone = $('phone').value.trim();
      if (!phone) return;
      $('pairError').classList.add('hidden');
      $('pairBtn').disabled = true;
      $('pairBtn').textContent = 'Requesting…';

      try {
        const r = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        }).then(r => r.json());

        if (r.code) {
          $('codeBox').classList.remove('hidden');
          $('codeValue').textContent = r.code;
        } else {
          $('pairError').textContent = r.error || 'Failed to request code';
          $('pairError').classList.remove('hidden');
        }
      } catch (e) {
        $('pairError').textContent = 'Network error';
        $('pairError').classList.remove('hidden');
      } finally {
        $('pairBtn').disabled = false;
        $('pairBtn').textContent = 'Pair';
      }
    });

    $('copyBtn').addEventListener('click', async () => {
      const code = $('codeValue').textContent;
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.replace(/-/g, ''));
        $('copyBtn').title = 'Copied!';
        setTimeout(() => $('copyBtn').title = 'Copy', 1500);
      } catch (e) {
        console.error('Copy failed', e);
      }
    });

    document.querySelectorAll('.modeBtn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mode = btn.dataset.mode;
        if (mode === currentMode) return;
        setModeUI(mode);
        await fetch('/api/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
      });
    });

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>
`;