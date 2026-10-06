import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import config from './config.js'
import { Users, Sessions } from './db.js'
import { startBot, stopBot, isActive } from './bot.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createServer() {
  const app = express()
  
  app.use(
    helmet({
      contentSecurityPolicy: false, // allow inline scripts in the single-file frontend
    }),
  )
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  
  /* Rate limits */
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30 })
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 120 })
  
  app.use('/api/', apiLimiter)
  
  /* -------- auth helpers -------- */
  const signToken = (userId) =>
    jwt.sign({ uid: userId }, config.jwtSecret, { expiresIn: '7d' })
  
  const setCookie = (res, token) =>
    res.cookie(config.cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
  
  function auth(req, res, next) {
    try {
      const token = req.cookies[config.cookieName]
      if (!token) return res.status(401).json({ error: 'Not authenticated' })
      const { uid } = jwt.verify(token, config.jwtSecret)
      req.userId = uid
      next()
    } catch {
      res.status(401).json({ error: 'Invalid session' })
    }
  }
  
  /* -------- auth routes -------- */
  app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body ?? {}
      if (!email || !password || password.length < 8)
        return res.status(400).json({ error: 'Email + password (8+ chars) required' })
      
      const hash = await bcrypt.hash(password, 12)
      const user = await Users.create(email, hash)
      setCookie(res, signToken(user.id))
      res.json({ user })
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Email taken' })
      res.status(500).json({ error: e.message })
    }
  })
  
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body ?? {}
      const user = await Users.findByEmail(email ?? '')
      if (!user || !(await bcrypt.compare(password ?? '', user.password_hash)))
        return res.status(401).json({ error: 'Invalid credentials' })
      
      setCookie(res, signToken(user.id))
      res.json({ user: { id: user.id, email: user.email } })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
  
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(config.cookieName)
    res.json({ ok: true })
  })
  
  app.get('/api/me', auth, async (req, res) => {
    const user = await Users.findById(req.userId)
    res.json({ user })
  })
  
  /* -------- sessions -------- */
  app.get('/api/sessions', auth, async (req, res) => {
    const list = await Sessions.listByUser(req.userId)
    res.json({
      sessions: list.map((s) => ({ ...s, active: isActive(s.id) })),
    })
  })
  
  app.post('/api/sessions', auth, async (req, res) => {
    try {
      const phone = String(req.body?.phone ?? '').replace(/\D/g, '')
      if (phone.length < 8) return res.status(400).json({ error: 'Invalid phone' })
      
      const session = await Sessions.create(req.userId, phone)
      
      // Start bot, wait for pairing code
      const pairingPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Pairing code timeout')),
          20_000,
        )
        startBot(session.id, {
          onPairingCode: (code, err) => {
            clearTimeout(timer)
            if (err) reject(err)
            else resolve(code)
          },
        }).catch(reject)
      })
      
      const code = await pairingPromise
      res.json({ session: { id: session.id, phone_number: phone }, code })
    } catch (e) {
      console.error('[POST /sessions]', e)
      res.status(500).json({ error: e.message })
    }
  })
  
  app.delete('/api/sessions/:id', auth, async (req, res) => {
    const id = Number(req.params.id)
    const session = await Sessions.get(id, req.userId)
    if (!session) return res.status(404).json({ error: 'Not found' })
    
    await stopBot(id)
    await Sessions.delete(id, req.userId)
    res.json({ ok: true })
  })
  
  /* -------- static frontend -------- */
  app.use(express.static(path.join(__dirname, 'public')))
  app.get('*', (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')),
  )
  
  return app
}