import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'

// Public — no auth needed, anyone can browse plans
export async function planRoutes(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .order('price_cents', { ascending: true })

    if (error) return reply.status(500).send({ error: error.message })
    return data ?? []
  })
}
