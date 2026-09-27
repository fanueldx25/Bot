import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { requestPairingCode, logout, restart, getSocket } from '../connection.js';
import { commandCount } from '../handler.js';

const requireAuth = (req, res, next) =>
  req.session?.user ? next() : res.redirect('/login');

export function registerRoutes(app) {
  app.get('/login', (req, res) => res.render('login', { error: null }));

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const ok = username === config.adminUser &&
               await bcrypt.compare(password, config.adminPassHash);
    if (!ok) return res.render('login', { error: 'Invalid credentials' });
    req.session.user = username;
    res.redirect('/');
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

  app.get('/', requireAuth, (req, res) => {
    const sock = getSocket();
    res.render('dashboard', {
      botName: config.botName,
      prefixes: config.prefixes.join(' '),
      connected: !!sock?.user,
      user: sock?.user?.id || null,
      uptime: Math.floor(process.uptime()),
      commandCount,
    });
  });

  app.post('/api/pair', requireAuth, async (req, res) => {
    const { phone } = req.body;
    if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone' });
    await requestPairingCode(phone);
    res.json({ ok: true });
  });

  app.post('/api/logout', requireAuth, async (_q, r) => { await logout(); r.json({ ok: true }); });
  app.post('/api/restart', requireAuth, async (_q, r) => { await restart(); r.json({ ok: true }); });
}