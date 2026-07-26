import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { prisma } from '@/lib/db'
import { assertAgentWorkTenantOperable } from '@/lib/agent-work-tenant-gate'
import {
  buildAgentInteractionTicketInput,
  resolveInteractionTicketCreatorId,
} from '@/lib/agent-interaction-ticket'
import { repositories } from '@/repositories/postgres'
import { createInteractionTicketSchema } from '@/lib/validators/actions'

function jsonError(message: string, status: number, data?: unknown) {
  return NextResponse.json({ success: false, error: message, data }, { status })
}

/** A `resolveInteractionTicketCreatorId` prisma-hátterű portjai (lásd ott az invariánst). */
async function findTenantMember(args: { tenantId: string; adminOnly: boolean }) {
  const membership = await prisma.tenantMembership.findFirst({
    where: {
      tenantId: args.tenantId,
      status: 'active',
      user: { status: 'active' },
      ...(args.adminOnly ? { role: 'admin' } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  })
  return membership?.userId ?? null
}

async function findGlobalAdmin() {
  const user = await prisma.user.findFirst({
    // Csak AKTÍV admin — ugyanaz az elvárás, mint a tenant-oldali ágon. Egy
    // felfüggesztett / még aktiválatlan admin neve alatt keletkező ticket
    // félrevezető audit-nyomot hagyna.
    where: { role: 'admin', status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  return user?.id ?? null
}

export async function POST(request: Request) {
  const auth = await authenticateAgentRequest(request.headers.get('authorization'))
  if (!auth) return jsonError('Unauthorized', 401)

  try {
    requireAgentScope(auth, 'ticket:create')
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Forbidden', 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  const parsed = createInteractionTicketSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.message, 400)
  }

  if (parsed.data.agentId !== auth.agentId) {
    return jsonError('Agent ID mismatch', 403)
  }

  try {
    const agent = await repositories.agents.findById(auth.agentId)
    if (!agent) return jsonError('Agent not found', 404)

    // A felfüggesztett / offboardolt / archivált tenant automata útjai sem
    // hozhatnak létre ticketet (ugyanaz a kapu, mint a tool-invoke úton).
    const tenantGate = await assertAgentWorkTenantOperable({ agentId: auth.agentId })
    if (!tenantGate.ok) {
      return jsonError(`Tenant is not operable (${tenantGate.tenantStatus})`, 403, tenantGate)
    }

    const createdById = await resolveInteractionTicketCreatorId(agent.tenantId, {
      findTenantMember,
      findGlobalAdmin,
    })

    const ticket = await repositories.tickets.create(
      buildAgentInteractionTicketInput({
        agent: { id: auth.agentId, tenantId: agent.tenantId },
        data: parsed.data,
        createdById,
      }),
    )

    const awaiting = await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'awaiting_human',
      actor: { type: 'agent', agentId: auth.agentId },
      agentVersion: agent.currentVersion,
    })

    return NextResponse.json({ success: true, data: awaiting })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Failed to create ticket', 500)
  }
}
