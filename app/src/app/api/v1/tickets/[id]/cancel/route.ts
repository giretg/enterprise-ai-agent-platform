import { requireTenantRole } from '@/auth/tenant-context'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Ticket emergency stop: kooperatív cancelRequested flag.
 * A futó agent loop a következő checkpointon leáll.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireTenantRole>>
  try {
    user = await requireTenantRole('operator')
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await context.params
  const ticket = await repositories.tickets.findById(id)
  if (!ticket) {
    return new Response('Ticket not found', { status: 404 })
  }
  if (ticket.tenantId !== user.activeTenantId) {
    return new Response('Forbidden', { status: 403 })
  }
  if (ticket.state !== 'in_progress') {
    return new Response('Ticket is not in progress', { status: 404 })
  }

  const cancelled = await repositories.tickets.requestCancel(id, user.user.id)
  if (!cancelled) {
    return new Response('Ticket is not in progress', { status: 404 })
  }

  return new Response(null, { status: 202 })
}
