'use server'

import { getCurrentUser, requireRole } from '@/auth'
import { services } from '@/domain'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  approveGmailSendSchema,
  connectorGrantIdSchema,
  connectorIdSchema,
} from '@/lib/validators/actions'

export async function listConnectorGrants() {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Not authenticated')
    const grants = await services.connectorGrants.listForUser(user.id, user.tenantId)
    return ok(grants)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list grants')
  }
}

export async function listUserDelegatedConnectors() {
  try {
    await requireRole('viewer')
    const connectors = await prisma.connector.findMany({
      where: { authMode: 'user_delegated' },
      orderBy: { name: 'asc' },
    })
    return ok(connectors)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list connectors')
  }
}

export async function startConnectorOAuth(input: { connectorId: string }) {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Not authenticated')
    const { connectorId } = connectorIdSchema.parse(input)
    const connector = await prisma.connector.findUnique({ where: { id: connectorId } })
    if (!connector) return fail('Connector not found')
    if (connector.authMode !== 'user_delegated') return fail('Connector is not user_delegated')

    if (process.env.GMAIL_OAUTH_STUB === 'true') {
      const { createOAuthState } = await import('@/lib/crypto/oauth-state')
      const { state } = createOAuthState({
        userId: user.id,
        connectorId: connector.id,
        tenantId: user.tenantId,
      })
      await services.connectorGrants.completeOAuthCallback({
        code: 'stub-auth-code',
        state,
        connector,
        actorId: user.id,
      })
      return ok({ url: '/control-plane/connectors?connected=1', stub: true })
    }

    const { url } = services.connectorGrants.buildAuthorizationUrl({
      connector,
      userId: user.id,
      tenantId: user.tenantId,
    })
    return ok({ url })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to start OAuth')
  }
}

export async function revokeConnectorGrant(input: { grantId: string }) {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Not authenticated')
    const { grantId } = connectorGrantIdSchema.parse(input)
    const grant = await prisma.connectorGrant.findUnique({ where: { id: grantId } })
    if (!grant) return fail('Grant not found')
    if (grant.userId !== user.id && user.role !== 'admin') {
      return fail('Forbidden')
    }

    await services.connectorGrants.revokeGrant({
      grantId,
      actorId: user.id,
      actorType: user.role === 'admin' && grant.userId !== user.id ? 'human' : 'human',
    })
    return ok({ revoked: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke grant')
  }
}

export async function approveGmailSend(input: { ticketId: string; draftId: string }) {
  try {
    const user = await requireRole('approver')
    const parsed = approveGmailSendSchema.parse(input)
    const ticket = await prisma.ticket.findUnique({ where: { id: parsed.ticketId } })
    if (!ticket) return fail('Ticket not found')

    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? { ...(ticket.payload as Record<string, unknown>) }
        : {}

    await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'approved',
      actor: { type: 'human', userId: user.id, role: user.role },
      note: `Gmail küldés jóváhagyva: ${parsed.draftId}`,
    })

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        payload: { ...payload, gmailSendApproved: parsed.draftId, approvedBy: user.id },
      },
    })

    return ok({ ticketId: ticket.id, draftId: parsed.draftId })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve send')
  }
}
