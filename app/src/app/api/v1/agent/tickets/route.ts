import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import { createInteractionTicketSchema } from '@/lib/validators/actions'

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status })
}

async function systemUserId() {
  const user = await prisma.user.findFirst({
    where: { role: 'admin' },
    orderBy: { createdAt: 'asc' },
  })
  if (!user) throw new Error('No system user configured')
  return user.id
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

    const ticket = await repositories.tickets.create({
      type: 'interaction',
      title: parsed.data.title,
      state: 'in_progress',
      assigneeType: 'human',
      assigneeId: null,
      agentId: auth.agentId,
      payload: parsed.data.payload as Prisma.JsonValue,
      sourceDocumentId: parsed.data.sourceDocumentId ?? null,
      executeAfter: null,
      dueBy: null,
      createdById: await systemUserId(),
    })

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
