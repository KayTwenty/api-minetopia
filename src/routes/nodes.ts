import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { agentClient } from '../lib/agentClient'
import { authenticate } from '../middleware/auth'

// Admin-only: register a new physical game node
export async function nodeRoutes(app: FastifyInstance) {
  app.post('/', { preHandler: authenticate }, async (req, reply) => {
    // TODO: add admin role check
    const body = req.body as any

    const { data, error } = await supabase.from('nodes').insert({
      name:          body.name,
      ip:            body.ip,
      agent_port:    body.agent_port ?? 8080,
      agent_token:   body.agent_token,
      max_servers:   body.max_servers ?? 100,
      total_ram_mb:  body.total_ram_mb,
    }).select().single()

    if (error) return reply.status(500).send({ error: error.message })
    return reply.status(201).send(data)
  })

  app.get('/', { preHandler: authenticate }, async (_req, reply) => {
    const { data, error } = await supabase
      .from('nodes')
      .select('id, name, ip, agent_port, status, allocated_ram_mb, total_ram_mb, max_servers')
    if (error) return reply.status(500).send({ error: error.message })

    // Test agent reachability for each node
    const results = await Promise.all((data ?? []).map(async (node: any) => {
      try {
        const agent = agentClient(node.ip, node.agent_port, node.agent_token)
        await agent.get('/health')
        return { ...node, agent_reachable: true }
      } catch {
        return { ...node, agent_reachable: false }
      }
    }))
    return results
  })

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as any
    const allowed = ['name', 'ip', 'agent_port', 'agent_token', 'max_servers', 'total_ram_mb']
    const updates: Record<string, any> = {}
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key]
    }
    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No valid fields provided' })
    }
    const { data, error } = await supabase
      .from('nodes')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) return reply.status(500).send({ error: error.message })
    return data
  })
}
