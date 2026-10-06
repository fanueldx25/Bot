import config from './config.js'
import { initDb, Sessions } from './db.js'
import { createServer } from './server.js'
import { bootstrapCommands, startBot } from './bot.js'

async function main() {
  if (!config.databaseUrl) {
    console.error('❌ DATABASE_URL is required')
    process.exit(1)
  }
  if (!config.jwtSecret || config.jwtSecret === 'change-me-in-prod') {
    console.warn('⚠️  Set a strong JWT_SECRET in production!')
  }
  
  await initDb()
  await bootstrapCommands()
  
  /* Restore any previously-connected sessions */
  const all = await Sessions.all()
  for (const s of all) {
    if (s.status === 'connected' && s.creds) {
      startBot(s.id).catch((e) => console.error('[restore]', s.id, e.message))
    }
  }
  
  const app = createServer()
  app.listen(config.port, () =>
    console.log(`🌐 Server listening on :${config.port}`),
  )
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})