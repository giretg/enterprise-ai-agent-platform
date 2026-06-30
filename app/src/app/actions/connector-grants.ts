'use server'

import type { Prisma } from '@prisma/client'
import { getCurrentUser, requireRole } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { services } from '@/domain'
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import {
  approveGmailSendSchema,
  authorizeTicketRunAsSchema,
  connectorGrantIdSchema,
  startConnectorOAuthSchema,
} from '@/lib/validators/actions'
import {
  buildRunAsAuthorization,
  isRunAsAuthorized,
  readRunAsAuthorizedBy,
  removeRunAsAuthorization,
} from '@/lib/run-as-payload'

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
    const user = await requireRole('viewer')
    const connectors = await prisma.connector.findMany({
      where: {
        authMode: 'user_delegated',
        OR: [{ tenantId: null }, ...(user.tenantId ? [{ tenantId: user.tenantId }] : [])],
      },
      orderBy: { name: 'asc' },
    })
    return ok(connectors)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list connectors')
  }
}

export async function startConnectorOAuth(input: { connectorId: string; scopes?: string[] }) {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Not authenticated')
    const { connectorId, scopes } = startConnectorOAuthSchema.parse(input)
    const connector = await prisma.connector.findUnique({ where: { id: connectorId } })
    if (!connector) return fail('Connector not found')
    if (connector.authMode !== 'user_delegated') return fail('Connector is not user_delegated')
    if (connector.tenantId && connector.tenantId !== user.tenantId) return fail('Connector not found')

    if (process.env.GMAIL_OAUTH_STUB === 'true') {
      const { createOAuthState } = await import('@/lib/crypto/oauth-state')
      const { state } = createOAuthState({
        userId: user.id,
        connectorId: connector.id,
        tenantId: user.tenantId,
        requestedScopes: scopes,
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
      requestedScopes: scopes,
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
    if (
      user.role === 'admin' &&
      user.tenantId &&
      grant.userId !== user.id &&
      grant.tenantId !== user.tenantId
    ) {
      return fail('Forbidden')
    }

    await services.connectorGrants.revokeGrant({
      grantId,
      actorId: user.id,
      actorType: 'human',
      expectedUserId: grant.userId === user.id ? user.id : undefined,
      expectedTenantId:
        user.role === 'admin' && grant.userId !== user.id
          ? (user.tenantId ?? undefined)
          : user.tenantId,
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

export async function authorizeTicketRunAs(input: { ticketId: string }) {
  try {
    const user = await requireRole('operator')
    const { ticketId } = authorizeTicketRunAsSchema.parse(input)

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
    if (!ticket) return fail('Ticket not found')
    if (ticket.assigneeType !== 'agent') return fail('Run-as can only be authorized for agent tickets')
    if (!['backlog', 'ready', 'in_progress'].includes(ticket.state)) {
      return fail('Run-as can only be authorized before the ticket is closed')
    }

    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? { ...(ticket.payload as Record<string, unknown>) }
        : {}
    if (isRunAsAuthorized(payload)) return fail('Run-as is already authorized for this ticket')

    const runAs = buildRunAsAuthorization({ userId: user.id })
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { payload: { ...payload, ...runAs } as Prisma.InputJsonValue },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'ticket.runas.authorize',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.agentId ?? null,
      outputRef: user.id,
      policyDecision: 'authorized',
      metadata: { runAsUserId: user.id } as Prisma.JsonValue,
    })

    return ok({ ticketId: ticket.id, runAsUserId: user.id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to authorize run-as')
  }
}

export async function revokeTicketRunAs(input: { ticketId: string }) {
  try {
    const user = await requireRole('operator')
    const { ticketId } = authorizeTicketRunAsSchema.parse(input)

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
    if (!ticket) return fail('Ticket not found')

    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? { ...(ticket.payload as Record<string, unknown>) }
        : {}
    if (!isRunAsAuthorized(payload)) return fail('Run-as is not authorized for this ticket')
    const authorizedBy = readRunAsAuthorizedBy(payload)
    if (authorizedBy !== user.id && !hasMinimumRole(user.role, 'admin')) {
      return fail('Only the authorizing user or an admin can revoke this run-as grant')
    }

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { payload: removeRunAsAuthorization(payload) as Prisma.InputJsonValue },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'ticket.runas.revoke',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.agentId ?? null,
      outputRef: user.id,
      policyDecision: 'revoked',
      metadata: { revokedBy: user.id } as Prisma.JsonValue,
    })

    return ok({ ticketId: ticket.id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke run-as')
  }
}
