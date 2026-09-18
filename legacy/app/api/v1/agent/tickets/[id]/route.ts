import { NextResponse } from 'next/server'
import { authenticateAgentRequest, requireAgentScope } from '@/auth/agent-api-key'
import { repositories } from '@/repositories/postgres'

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateAgentRequest(request.headers.get('authorization'))
  if (!auth) return jsonError('Unauthorized', 401)

  try {
    requireAgentScope(auth, 'ticket:read')
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Forbidden', 403)
  }

  const { id } = await params
  const ticket = await repositories.tickets.findById(id)
  if (!ticket) return jsonError('Ticket not found', 404)

  if (ticket.agentId !== auth.agentId) {
    return jsonError('Ticket not accessible for this agent', 403)
  }

  return NextResponse.json({ success: true, data: ticket })
}
