// ============================================================================
// server.js — Express + Socket.io dashboard + pairing API
// ============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const state = require('./state');
const connection = require('./connection');
const collection = require('./collection');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

state.io = io;

// ---------- Snapshot helper ----------
function snapshot() {
  return {
    state: state.connectionState,
    code: state.pairingCode,
    number: state.currentNumber,
    jid: state.botJid,
    admin: state.ADMIN_NUMBER ? '+' + state.ADMIN_NUMBER : null,
    uptime: Math.floor(process.uptime())
  };
}

// ---------- POST /api/connect ----------
app.post('/api/connect', async (req, res) => {
  const { number } = req.body || {};
  
  // first-level validation
  const v = connection.validateNumber(number);
  if (!v.ok) {
    return res.status(400).json({ ok: false, error: v.error });
  }
  
  try {
    const result = await connection.startBot(v.clean);
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }
    res.json({ ok: true, number: v.clean });
  } catch (e) {
    console.error('[API /connect]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- GET /api/state ----------
app.get('/api/state', (req, res) => {
  res.json(snapshot());
});

// ---------- POST /api/disconnect ----------
app.post('/api/disconnect', (req, res) => {
  try {
    connection.stopBot();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- GET /api/commands ----------
app.get('/api/commands', (req, res) => {
  res.json(collection.all());
});

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.emit('state', snapshot());
  socket.on('request_state', () => socket.emit('state', snapshot()));
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  state.loadState();
  connection.loadBanner();
});