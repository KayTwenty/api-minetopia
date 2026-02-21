import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import websocket from '@fastify/websocket'
import rateLimit from '@fastify/rate-limit'

import { serverRoutes } from './routes/servers'
import { billingRoutes } from './routes/billing'
import { nodeRoutes } from './routes/nodes'
import { planRoutes } from './routes/plans'
import { internalRoutes } from './routes/internal'
import { versionRoutes } from './routes/versions'
import { accountRoutes } from './routes/account'

//  Startup env validation 
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
] as const

const missingEnv = REQUIRED_ENV.filter(k => !process.env[k])
if (missingEnv.length > 0) {
  console.error(`\x1b[31m✗ Missing required env vars: ${missingEnv.join(', ')}\x1b[0m`)
  process.exit(1)
}

const app = Fastify({
  logger: { level: 'warn' },    // only warnings and errors reach the console
  disableRequestLogging: true,  // suppress per-request noise
})

//  Plugins 
app.register(cors, {
  origin: process.env.PANEL_URL ?? 'http://localhost:3000',
  credentials: true,
})

// Global rate limit — 120 requests per minute per IP
// Individual sensitive routes override this with tighter limits.
app.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({
    error: 'Too many requests — please slow down.',
    statusCode: 429,
  }),
})

app.register(jwt, {
  secret: process.env.JWT_SECRET!,
})

app.register(websocket)

//  Routes 
app.register(serverRoutes, { prefix: '/api/servers' })
app.register(billingRoutes, { prefix: '/api/billing' })
app.register(nodeRoutes,    { prefix: '/api/nodes' })
app.register(planRoutes,    { prefix: '/api/plans' })
app.register(internalRoutes, { prefix: '/internal' })
app.register(versionRoutes, { prefix: '/api' })
app.register(accountRoutes, { prefix: '/api/account' })

app.get('/health', async () => ({ status: 'ok' }))

//  Start 
const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3001
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`\x1b[32m✓ API ready\x1b[0m  → http://localhost:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
