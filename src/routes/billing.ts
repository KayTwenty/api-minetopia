import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { authenticate } from '../middleware/auth'

// Billing is stubbed out — Stripe will be wired up later.
// For now, server creation goes directly through /api/servers.
export async function billingRoutes(app: FastifyInstance) {
  // GET /api/billing/subscription/:serverId
  // Returns the subscription record for a server (placeholder)
  app.get<{ Params: { serverId: string } }>(
    '/subscription/:serverId',
    { preHandler: authenticate },
    async (req, reply) => {
      const user = (req as any).user
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('server_id', req.params.serverId)
        .eq('user_id', user.sub)
        .single()

      if (error || !data) return reply.status(404).send({ error: 'No subscription found' })
      return data
    }
  )
}

