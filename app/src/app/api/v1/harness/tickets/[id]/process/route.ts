import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { resolveTicketProcessRoute } from '@/lib/ticket-process-route'
import { readJson } from '@/lib/api-response'

function jsonError(
  message: string,
  status: number,
  opts?: { category?: 'permanent' | 'transient'; code?: string },
) {
  return NextResponse.json(
    { success: false, error: message, category: opts?.category, code: opts?.code },
    { status },
  )
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateAgentRequest(request.headers.get('authorization'))
  if (!auth) return jsonError('Unauthorized', 401, { category: 'permanent', code: 'UNAUTHORIZED' })

  try {
    requireAgentScope(auth, 'tool:invoke')
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Forbidden', 403, {
      category: 'permanent',
      code: 'MISSING_SCOPE',
    })
  }

  let body: { agentId?: string } = {}
  try {
    const parsed = (await readJson(request)) as { agentId?: string }
    body = parsed ?? {}
  } catch {
    // üres body is elfogadható — auth.agentId a forrás
  }

  const agentId = body.agentId?.trim() || auth.agentId
  if (agentId !== auth.agentId) {
    return jsonError('Agent mismatch for harness process', 403, {
      category: 'permanent',
      code: 'AGENT_MISMATCH',
    })
  }

  const { id: ticketId } = await params
  const ticket = await repositories.tickets.findById(ticketId)
  if (!ticket) return jsonError('Ticket not found', 404)
  if (ticket.agentId !== agentId) {
    return jsonError('Ticket not assigned to this agent', 403, {
      category: 'permanent',
      code: 'TICKET_AGENT_MISMATCH',
    })
  }

  try {
    const route = resolveTicketProcessRoute(ticket.payload)
    const result =
      route === 'general'
        ? await services.generalTask.processTicket({ ticketId, agentId })
        : await services.wiki.processTicket({ ticketId, agentId })
    return NextResponse.json({ success: true, data: result })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Ticket process failed', 500)
  }
}
