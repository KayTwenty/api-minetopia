import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { authenticate } from '../middleware/auth'

//  Helpers 

/** Generate deterministic fake invoices from each server's creation date up to now. */
function buildInvoices(servers: { id: string; name: string; created_at: string; plans: { name: string; price_cents: number } | null }[]) {
  type Invoice = {
    id: string
    period: string           // e.g. "Jan 2026"
    amount_cents: number
    status: 'paid' | 'upcoming'
    items: { label: string; amount_cents: number }[]
  }

  // Collect per-month totals across all servers
  const byMonth = new Map<string, Invoice>()
  const now     = new Date()

  for (const server of servers) {
    const price = server.plans?.price_cents ?? 0
    if (price === 0) continue

    const start = new Date(server.created_at)
    // Walk from server start month to the current month (inclusive)
    const cur = new Date(start.getFullYear(), start.getMonth(), 1)
    while (cur <= now) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`
      const period = cur.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      const isUpcoming = cur.getFullYear() === now.getFullYear() && cur.getMonth() === now.getMonth()

      if (!byMonth.has(key)) {
        byMonth.set(key, {
          id: key,
          period,
          amount_cents: 0,
          status: isUpcoming ? 'upcoming' : 'paid',
          items: [],
        })
      }

      const inv = byMonth.get(key)!
      inv.amount_cents += price
      inv.items.push({ label: `${server.name} — ${server.plans?.name ?? 'Plan'}`, amount_cents: price })
      cur.setMonth(cur.getMonth() + 1)
    }
  }

  return [...byMonth.values()]
    .sort((a, b) => b.id.localeCompare(a.id))  // newest first
    .slice(0, 12)                                // cap at 12 months
}

//  Routes 

export async function billingRoutes(app: FastifyInstance) {

  //  GET /api/billing 
  // Returns user's servers+plans, all available plans, monthly total, and invoice history.
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const user = (req as any).user

    const [{ data: servers }, { data: plans }] = await Promise.all([
      supabase
        .from('servers')
        .select('id, name, status, server_type, mc_version, plan_id, created_at, plans(*)')
        .eq('user_id', user.sub)
        .order('created_at', { ascending: true }),
      supabase
        .from('plans')
        .select('*')
        .eq('is_active', true)
        .order('price_cents', { ascending: true }),
    ])

    const serverList = (servers ?? []) as any[]
    const planList   = (plans ?? []) as any[]

    const total_cents = serverList.reduce((sum, s) => sum + (s.plans?.price_cents ?? 0), 0)
    const invoices    = buildInvoices(serverList)

    return { servers: serverList, plans: planList, total_cents, invoices }
  })

  //  POST /api/billing/servers/:id/plan 
  // Change the plan on a server (no payment required yet — payment gating added later).
  app.post<{ Params: { id: string } }>(
    '/servers/:id/plan',
    { preHandler: authenticate },
    async (req, reply) => {
      const user   = (req as any).user
      const schema = z.object({ plan_id: z.string().uuid() })
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: 'plan_id is required' })

      // Verify the server belongs to the user
      const { data: server } = await supabase
        .from('servers')
        .select('id, plan_id, ram_mb')
        .eq('id', req.params.id)
        .eq('user_id', user.sub)
        .single()
      if (!server) return reply.status(404).send({ error: 'Server not found' })

      // Fetch the new plan
      const { data: plan } = await supabase
        .from('plans')
        .select('*')
        .eq('id', parsed.data.plan_id)
        .eq('is_active', true)
        .single()
      if (!plan) return reply.status(404).send({ error: 'Plan not found' })

      // Update the server record
      const { error } = await supabase
        .from('servers')
        .update({
          plan_id:   plan.id,
          ram_mb:    plan.ram_mb,
          cpu_limit: plan.cpu_limit,
          disk_gb:   plan.disk_gb,
        })
        .eq('id', server.id)

      if (error) return reply.status(500).send({ error: error.message })

      // Tell the agent to update the LXC cgroup limits immediately.
      // Fetch node info since the server row doesn't join nodes by default here.
      const { data: fullServer } = await supabase
        .from('servers')
        .select('*, nodes(*)')
        .eq('id', server.id)
        .single()

      if (fullServer?.nodes) {
        const { ip, agent_port, agent_token } = fullServer.nodes as any
        const { agentClient } = await import('../lib/agentClient')
        try {
          await agentClient(ip, agent_port, agent_token).post(
            `/servers/${server.id}/resize`,
            { ram_mb: plan.ram_mb, cpu_limit: plan.cpu_limit, disk_gb: plan.disk_gb, plan_name: plan.name },
          )
        } catch (agentErr: any) {
          // Non-fatal — DB is already updated; limits will apply on next server start
          app.log.warn({ serverId: server.id }, `Agent resize failed (will apply on restart): ${agentErr?.message}`)
        }
      }

      return { ok: true, plan }
    },
  )
}

