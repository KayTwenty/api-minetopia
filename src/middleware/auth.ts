import { FastifyRequest, FastifyReply } from 'fastify'
import { createClient } from '@supabase/supabase-js'

/**
 * Singleton anon client used only for token verification.
 * Created once at module load — not once per request — to avoid the overhead
 * of constructing a new client on every authenticated call.
 */
const authClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
)

/**
 * Verifies the Supabase JWT by calling supabase.auth.getUser().
 * Attaches the verified user to req.user for downstream route handlers.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }

  const token = authHeader.slice(7)
  const { data: { user }, error } = await authClient.auth.getUser(token)

  if (error || !user) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }

  // Attach user to request so routes can access req.user.sub / req.user.email
  ;(req as any).user = { sub: user.id, email: user.email, ...user }
}
