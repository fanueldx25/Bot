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
app.listen(PORT, () => console.log(`🖥️  UI on http://localhost:${PORT}`));

// ---- Embedded UI (placeholder — we polish next) ----
const UI_HTML = /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WA Bot Control</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-neutral-950 text-neutral-100 min-h-screen flex items-center justify-center">
  <main class="w-full max-w-md p-6 rounded-2xl bg-neutral-900 border border-neutral-800">
    <h1 class="text-xl font-semibold mb-4">WhatsApp Bot</h1>
    <div id="status" class="text-sm text-neutral-400">Loading…</div>
    <div class="mt-6">
      <label class="block text-xs uppercase tracking-wide text-neutral-500 mb-2">Phone (with country code)</label>
      <input id="phone" class="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 focus:outline-none focus:border-emerald-500" placeholder="2376XXXXXXXX" />
      <button id="pairBtn" class="mt-3 w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium">Request Pairing Code</button>
      <div id="code" class="mt-4 text-center text-2xl font-mono tracking-widest"></div>
    </div>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);

    async function refresh() {
      const r = await fetch('/api/status').then(r => r.json());
      $('status').textContent = r.connected
        ? \`Connected as \${r.ownerJid} • mode: \${r.mode} • up \${r.uptime}s\`
        : \`Disconnected • mode: \${r.mode}\`;
      if (r.pairingCode) $('code').textContent = r.pairingCode;
    }

    $('pairBtn').addEventListener('click', async () => {
      const phone = $('phone').value.trim();
      if (!phone) return;
      const r = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      }).then(r => r.json());
      if (r.code) $('code').textContent = r.code;
      else alert(r.error || 'Failed');
    });

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>
`;