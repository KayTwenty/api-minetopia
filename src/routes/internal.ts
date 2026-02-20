import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'

const VALID_STATUSES = ['running', 'stopped', 'starting', 'stopping', 'error', 'suspended'] as const

/**
 * Internal routes called by agent watchdogs — NOT accessible to browser clients.
 * Authenticated via the node's agent_token (Bearer), not a user JWT.
 */
export async function internalRoutes(app: FastifyInstance) {

  // POST /internal/servers/:id/status
  // Agent watchdog calls this when it detects a container state change.
  app.post<{
    Params: { id: string }
    Body:   { status: string; lxc_ip?: string }
  }>('/servers/:id/status', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    const token = authHeader.slice(7)

    // Validate this token belongs to a real node
    const { data: node } = await supabase
      .from('nodes')
      .select('id')
      .eq('agent_token', token)
      .single()

    if (!node) return reply.status(401).send({ error: 'Invalid agent token' })

    const { status, lxc_ip } = req.body
    if (!VALID_STATUSES.includes(status as any)) {
      return reply.status(400).send({ error: `Invalid status: ${status}` })
    }

    const { id } = req.params

    const updatePayload: Record<string, any> = { status }
    if (lxc_ip) updatePayload.lxc_ip = lxc_ip

    // Only update if the server belongs to this node (security check)
    const { error } = await supabase
      .from('servers')
      .update(updatePayload)
      .eq('id', id)
      .eq('node_id', node.id)

    if (error) return reply.status(500).send({ error: error.message })

    app.log.info({ serverId: id, status }, '[internal] watchdog status sync')
    return { ok: true }
  })
}
