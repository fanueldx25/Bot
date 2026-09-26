const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bot = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== SESSION STATE =====
let sessionState = {
  active: false,
  number: null,
  startedAt: null,
  expiresAt: null,
  pairingCode: null,
  status: 'idle' // idle | awaiting_code | connecting | connected | expired
};

const SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes to enter code

function broadcast() {
  io.emit('state', sessionState);
}

// Expire session automatically
setInterval(() => {
  if (sessionState.active && sessionState.expiresAt && Date.now() > sessionState.expiresAt) {
    console.log('[Session] Expired');
    bot.stopBot();
    sessionState = {
      active: false, number: null, startedAt: null,
      expiresAt: null, pairingCode: null, status: 'expired'
    };
    broadcast();
  }
}, 10 * 1000);

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/state', (req, res) => {
  res.json(sessionState);
});

app.post('/api/connect', async (req, res) => {
  const { number } = req.body;

  if (!number || !/^\d{7,15}$/.test(number)) {
    return res.status(400).json({ error: 'Invalid phone number. Use country code without +, e.g. 15551234567' });
  }

  if (sessionState.active && sessionState.status === 'connected') {
    return res.status(409).json({ error: 'A bot is already connected. Wait for session to expire.' });
  }

  try {
    sessionState = {
      active: true,
      number,
      startedAt: Date.now(),
      expiresAt: Date.now() + SESSION_DURATION_MS,
      pairingCode: null,
      status: 'awaiting_code'
    };
    broadcast();

    bot.startBot(number, {
      onPairingCode: (code) => {
        sessionState.pairingCode = code;
        sessionState.status = 'awaiting_code';
        broadcast();
      },
      onConnected: () => {
        sessionState.status = 'connected';
        broadcast();
      },
      onDisconnected: () => {
        sessionState.active = false;
        sessionState.status = 'idle';
        sessionState.number = null;
        sessionState.pairingCode = null;
        broadcast();
      }
    });

    // Timeout if code isn't entered
    setTimeout(() => {
      if (sessionState.status === 'awaiting_code') {
        bot.stopBot();
        sessionState = {
          active: false, number: null, startedAt: null,
          expiresAt: null, pairingCode: null, status: 'idle'
        };
        broadcast();
      }
    }, PAIRING_TIMEOUT_MS);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  bot.stopBot();
  sessionState = {
    active: false, number: null, startedAt: null,
    expiresAt: null, pairingCode: null, status: 'idle'
  };
  broadcast();
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('state', sessionState);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});