import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { authenticate } from '../middleware/auth'

export async function accountRoutes(app: FastifyInstance) {
  // DELETE /api/account  — permanently delete the authenticated user's account
  app.delete('/', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user

    // Delete all servers belonging to the user first (cascade safety)
    await supabase.from('servers').delete().eq('user_id', user.sub)

    // Delete the auth user via admin API
    const { error } = await supabase.auth.admin.deleteUser(user.sub)
    if (error) return reply.status(500).send({ error: error.message })

    return reply.status(204).send()
  })
}
