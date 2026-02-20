import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { WebSocket } from 'ws'
import { supabase } from '../lib/supabase'
import { agentClient } from '../lib/agentClient'
import { authenticate } from '../middleware/auth'

const CreateServerSchema = z.object({
  name:       z.string().min(3).max(32),
  plan_id:    z.string().uuid(),
  mc_version: z.string().default('1.21.4'),
  server_type: z.enum(['vanilla']).default('vanilla'), // expand later
  port:       z.number().int().min(1024).max(65535).optional(),
})

export async function serverRoutes(app: FastifyInstance) {
  //  Port availability check 
  // Called by the deploy page to validate a chosen port before submitting.
  // Checks across ALL nodes (ports are globally unique in this system).
  app.get('/port-check', { preHandler: authenticate }, async (req, reply) => {
    const raw  = (req.query as any).port
    const port = parseInt(raw, 10)
    if (isNaN(port) || port < 1024 || port > 65535) {
      return reply.status(400).send({ error: 'Port must be between 1024 and 65535' })
    }
    const { data } = await supabase
      .from('servers')
      .select('id')
      .eq('port', port)
      .limit(1)
      .maybeSingle()
    return { available: !data }
  })

  //  List user's servers 
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user
    const { data, error } = await supabase
      .from('servers')
      .select('*, plans(*), nodes(ip, public_ip)')
      .eq('user_id', user.sub)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return data
  })

  //  Get single server 
  app.get<{ Params: { id: string } }>('/:id', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user
    const { data, error } = await supabase
      .from('servers')
      .select('*, plans(*), nodes(ip, public_ip, agent_port)')
      .eq('id', req.params.id)
      .eq('user_id', user.sub)
      .single()

    if (error || !data) return reply.status(404).send({ error: 'Server not found' })
    return data
  })

  //  Create server 
  // 5 creates per hour per IP — prevents abuse even if billing isn't gated yet
  app.post('/', { preHandler: authenticate, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = (req as any).user
    const body = CreateServerSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })

    // 1. Fetch plan
    const { data: plan } = await supabase.from('plans').select('*').eq('id', body.data.plan_id).single()
    if (!plan) return reply.status(404).send({ error: 'Plan not found' })

    // 1b. Enforce per-user server limit (errored servers are excluded so they can be cleaned up)
    const { count: serverCount } = await supabase
      .from('servers')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.sub)
      .neq('status', 'error')

    if ((serverCount ?? 0) >= 5) {
      return reply.status(403).send({ error: 'Server limit reached (5 max). Delete an existing server to create a new one.' })
    }

    // 2. Pick best available node (least allocated RAM, with enough free capacity)
    const { data: node } = await supabase
      .from('nodes')
      .select('*')
      .eq('status', 'online')
      .order('allocated_ram_mb', { ascending: true })
      .limit(1)
      .single()

    if (!node) return reply.status(503).send({ error: 'No nodes available' })

    // 3. Find a free port on that node (prefer user-requested port if free)
    const { data: usedPorts } = await supabase
      .from('servers')
      .select('port')
      .eq('node_id', node.id)

    const takenPorts = new Set((usedPorts ?? []).map((s: any) => s.port))
    const requestedPort = body.data.port
    let port = requestedPort && !takenPorts.has(requestedPort) ? requestedPort : 25565
    while (takenPorts.has(port)) port++

    // 4. Create DB record — retry on port collision (DB unique constraint closes the race window)
    let server: any = null
    let insertAttempts = 0
    while (!server && insertAttempts < 10) {
      const { data: inserted, error: insertErr } = await supabase
        .from('servers')
        .insert({
          user_id:     user.sub,
          node_id:     node.id,
          plan_id:     plan.id,
          name:        body.data.name,
          port,
          ram_mb:      plan.ram_mb,
          cpu_limit:   plan.cpu_limit,
          disk_gb:     plan.disk_gb,
          mc_version:  body.data.mc_version,
          server_type: body.data.server_type,
          status:      'installing',
        })
        .select()
        .single()

      if (!insertErr) { server = inserted; break }

      // Unique constraint violation on (node_id, port) — another request grabbed this port first
      if ((insertErr as any).code === '23505') {
        port++
        insertAttempts++
        continue
      }

      return reply.status(500).send({ error: insertErr.message })
    }

    if (!server) return reply.status(500).send({ error: 'Failed to allocate a free port after 10 attempts' })

    // 5. Reserve RAM on node
    await supabase
      .from('nodes')
      .update({ allocated_ram_mb: node.allocated_ram_mb + plan.ram_mb })
      .eq('id', node.id)

    // 6. Tell the agent to provision the container
    const agent = agentClient(node.ip, node.agent_port, node.agent_token)
    try {
      await agent.post('/servers/create', {
        server_id:  server.id,
        name:       server.name,
        ram_mb:     plan.ram_mb,
        cpu_limit:  plan.cpu_limit,
        disk_gb:    plan.disk_gb,
        port,
        mc_version: body.data.mc_version,
        server_type: body.data.server_type,
      })
    } catch (err: any) {
      // Mark as error but keep DB record for retry
      await supabase.from('servers').update({ status: 'error' }).eq('id', server.id)
      const url = `http://${node.ip}:${node.agent_port}`
      app.log.warn(`Agent unreachable at ${url}: ${err?.message ?? err}`)
      return reply.status(502).send({ error: `Agent unreachable (${url}) — is the agent running?` })
    }

    // 7. Log the action
    await supabase.from('server_logs').insert({
      server_id:    server.id,
      action:       'create',
      triggered_by: user.sub,
    })

    return reply.status(201).send(server)
  })

  //  Power actions 
  const powerAction = async (action: 'start' | 'stop' | 'restart', req: any, reply: any) => {
    const user = req.user
    const { data: server } = await supabase
      .from('servers')
      .select('*, nodes(*)')
      .eq('id', req.params.id)
      .eq('user_id', user.sub)
      .single()

    if (!server) return reply.status(404).send({ error: 'Server not found' })
    if (server.status === 'suspended') return reply.status(403).send({ error: 'Server is suspended' })

    const agent = agentClient(server.nodes.ip, server.nodes.agent_port, server.nodes.agent_token)
    try {
      await agent.post(`/servers/${server.id}/${action}`)
    } catch {
      return reply.status(502).send({ error: 'Agent unreachable — try again shortly' })
    }

    // Only update DB status after the agent confirms the action was received
    await supabase.from('servers').update({
      status: action === 'stop' ? 'stopping' : 'starting'
    }).eq('id', server.id)

    await supabase.from('server_logs').insert({
      server_id: server.id, action, triggered_by: user.sub,
    })

    return { ok: true }
  }

  // 20 power actions per minute per IP — enough for normal use, blocks hammering
  const powerOpts = { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }
  app.post<{ Params: { id: string } }>('/:id/start',   powerOpts, (req, reply) => powerAction('start',   req, reply))
  app.post<{ Params: { id: string } }>('/:id/stop',    powerOpts, (req, reply) => powerAction('stop',    req, reply))
  app.post<{ Params: { id: string } }>('/:id/restart', powerOpts, (req, reply) => powerAction('restart', req, reply))

  //  Metrics (proxied from agent) 
  app.get<{ Params: { id: string } }>('/:id/metrics', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user
    const { data: server } = await supabase
      .from('servers')
      .select('*, nodes(*)')
      .eq('id', req.params.id)
      .eq('user_id', user.sub)
      .single()

    if (!server) return reply.status(404).send({ error: 'Server not found' })

    const agent = agentClient(server.nodes.ip, server.nodes.agent_port, server.nodes.agent_token)
    try {
      const { data: metrics } = await agent.get(`/servers/${server.id}/metrics`)
      return metrics
    } catch {
      return reply.status(503).send({ error: 'Metrics unavailable' })
    }
  })

  //  Server properties (proxied from agent) 
  app.get<{ Params: { id: string } }>('/:id/properties', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user
    const { data: server } = await supabase
      .from('servers')
      .select('*, nodes(*)')
      .eq('id', req.params.id)
      .eq('user_id', user.sub)
      .single()
    if (!server) return reply.status(404).send({ error: 'Server not found' })
    const agent = agentClient(server.nodes.ip, server.nodes.agent_port, server.nodes.agent_token)
    try {
      const { data: props } = await agent.get(`/servers/${server.id}/properties`)
      return props
    } catch {
      return reply.status(503).send({ error: 'Properties unavailable' })
    }
  })

  app.put<{ Params: { id: string }; Body: Record<string, string> }>('/:id/properties', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user
    const { data: server } = await supabase
      .from('servers')
      .select('*, nodes(*)')
      .eq('id', req.params.id)
      .eq('user_id', user.sub)
      .single()
    if (!server) return reply.status(404).send({ error: 'Server not found' })
    const agent = agentClient(server.nodes.ip, server.nodes.agent_port, server.nodes.agent_token)
    try {
      await agent.put(`/servers/${server.id}/properties`, req.body)
      return { ok: true }
    } catch {
      return reply.status(503).send({ error: 'Could not save properties' })
    }
  })

  //  Delete server 
  app.delete<{ Params: { id: string } }>('/:id', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user
    const { data: server } = await supabase
      .from('servers')
      .select('*, nodes(*)')
      .eq('id', req.params.id)
      .eq('user_id', user.sub)
      .single()

    if (!server) return reply.status(404).send({ error: 'Server not found' })

    // Block deletion while the server is active — would orphan the MC process
    if (server.status === 'running' || server.status === 'starting') {
      return reply.status(409).send({ error: 'Stop the server before deleting it' })
    }

    const agent = agentClient(server.nodes.ip, server.nodes.agent_port, server.nodes.agent_token)
    try {
      await agent.delete(`/servers/${server.id}`)
    } catch {
      // Agent may be unreachable — still remove the DB record so the user isn't stuck
      app.log.warn({ serverId: server.id }, 'Agent unreachable during delete — removing DB record anyway')
    }

    // Re-fetch current allocated_ram_mb to avoid stale-snapshot race condition
    const { data: freshNode } = await supabase
      .from('nodes')
      .select('allocated_ram_mb')
      .eq('id', server.node_id)
      .single()
    await supabase
      .from('nodes')
      .update({ allocated_ram_mb: Math.max(0, (freshNode?.allocated_ram_mb ?? 0) - server.ram_mb) })
      .eq('id', server.node_id)

    await supabase.from('servers').delete().eq('id', server.id)

    return { ok: true }
  })

  //  Console WebSocket proxy 
  // Browsers can't send custom headers with WebSocket, so auth happens via the
  // first message the client sends: { token: "<supabase-jwt>" }
  app.get('/:id/console', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string }

    const deny = (msg: string) => {
      socket.send(JSON.stringify({ type: 'error', message: msg }))
      socket.close()
    }

    // Wait for the first message which must carry the JWT
    socket.once('message', async (raw) => {
      let token: string | undefined
      try {
        const parsed = JSON.parse(raw.toString())
        token = parsed.token
      } catch {
        return deny('Invalid auth message')
      }

      if (!token) return deny('Missing token')

      // Verify Supabase JWT
      const { createClient: createSupabaseClient } = await import('@supabase/supabase-js')
      const anonClient = createSupabaseClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_ANON_KEY!,
      )
      const { data: { user }, error } = await anonClient.auth.getUser(token)
      if (error || !user) return deny('Unauthorized')

      // Verify the server belongs to this user
      const { data: server } = await supabase
        .from('servers')
        .select('*, nodes(*)')
        .eq('id', id)
        .eq('user_id', user.id)
        .single()

      if (!server) return deny('Server not found')

      const { ip, agent_port, agent_token } = server.nodes
      const agentWsUrl = `ws://${ip}:${agent_port}/servers/${id}/console?token=${agent_token}`
      const agentWs = new WebSocket(agentWsUrl)

      agentWs.on('open', () => {
        socket.send(JSON.stringify({ type: 'log', line: '— Console connected —' }))
      })

      // agent → browser
      agentWs.on('message', (data) => {
        if (socket.readyState === socket.OPEN) socket.send(data.toString())
      })

      // browser → agent (commands typed in the console panel)
      socket.on('message', (data) => {
        if (agentWs.readyState === agentWs.OPEN) agentWs.send(data.toString())
      })

      agentWs.on('error', () => deny('Agent connection failed'))
      agentWs.on('close', () => socket.close())
      socket.on('close', () => agentWs.close())
    })
  })
}
