import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { registerRoutes } from './routes.js';
import { botEvents, getSocket } from '../connection.js';
import { commandCount } from '../handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startDashboard(port = 3000) {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketIO(server);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60_000, max: 120 }));
  app.use(session({
    secret: config.sessionSecret,
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', maxAge: 6 * 60 * 60 * 1000 },
  }));

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  registerRoutes(app);

  io.on('connection', (socket) => {
    const sock = getSocket();
    socket.emit('state', {
      connected: !!sock?.user,
      user: sock?.user || null,
      uptime: process.uptime(),
      commands: commandCount,
    });
    botEvents.on('pairing', (p) => socket.emit('pairing', p));
    botEvents.on('qr', (q) => socket.emit('qr', q));
    botEvents.on('open', (i) => socket.emit('open', i));
    botEvents.on('close', (i) => socket.emit('close', i));
  });

  server.listen(port, () => console.log(`🛡️  Dashboard → http://localhost:${port}`));
  return server;
}