'use server'

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { getCurrentUser } from '@/auth'
import { requirePlatformRole, requireTenantRole } from '@/auth/tenant-context'
import { hasMinimumRole } from '@/auth/types'
import { isSuperadmin } from '@/lib/tenant-policy'
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
import { loadAgentDelegatedConnectors } from '@/lib/agent-delegated-connectors-server'
import {
  isDelegatedOAuthStubEnabled,
  resolveGrantOAuthScopes,
} from '@/domain/connector-grant/delegated-oauth-registry'
import { toGoogleOAuthPublicView } from '@/lib/platform-google-oauth-config'

export async function listAgentDelegatedConnectors(agentId: string) {
  try {
    const user = await requireTenantRole('viewer')
    const items = await loadAgentDelegatedConnectors(
      agentId,
      user.user.id,
      user.activeTenantId,
    )
    return ok(items)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load agent connectors')
  }
}

export async function listConnectorGrants() {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Not authenticated')
    await services.connectorGrants.revokeGrantsForNonActiveConnectors(
      user.id,
      user.tenantId,
      user.id,
    )
    const grants = await services.connectorGrants.listForUser(user.id, user.tenantId)
    return ok(grants)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list grants')
  }
}

export async function listConnectorsPanelContext() {
  try {
    const user = await requireTenantRole('viewer')
    const isAdmin = hasMinimumRole(user.activeTenantRole, 'admin')
    await services.connectorGrants.revokeGrantsForNonActiveConnectors(
      user.user.id,
      user.activeTenantId,
      user.user.id,
    )
    const [grants, connectors, googleResolved] = await Promise.all([
      services.connectorGrants.listForUser(user.user.id, user.activeTenantId),
      prisma.connector.findMany({
        where: {
          authMode: 'user_delegated',
          lifecycleState: 'active',
          OR: [{ tenantId: null }, { tenantId: user.activeTenantId }],
        },
        orderBy: { name: 'asc' },
      }),
      services.platformSettings.getGoogleOAuthConfig(),
    ])
    const googleView = toGoogleOAuthPublicView(googleResolved)
    return ok({
      grants,
      connectors,
      isAdmin,
      canManagePlatformOauth: isSuperadmin(user.platformRoles),
      googleOauth: {
        configured: googleView.configured,
        persisted: googleView.persisted,
        source: googleView.source,
      },
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load connectors panel')
  }
}

export async function getPlatformGoogleOAuth() {
  try {
    await requirePlatformRole('platform_auditor')
    const resolved = await services.platformSettings.getGoogleOAuthConfig()
    return ok(toGoogleOAuthPublicView(resolved))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load platform Google OAuth config')
  }
}

export async function getGoogleOAuthConfiguredStatus() {
  try {
    await requireTenantRole('viewer')
    const resolved = await services.platformSettings.getGoogleOAuthConfig()
    return ok({ configured: Boolean(resolved) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load Google OAuth status')
  }
}

export async function upsertPlatformGoogleOAuth(input: {
  clientId: string
  clientSecret?: string
  redirectUri?: string
}) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = z.object({
      clientId: z.string().trim().min(1),
      clientSecret: z.string().trim().optional(),
      redirectUri: z.union([z.literal(''), z.string().trim().url()]).optional(),
    }).parse(input)

    const resolved = await services.platformSettings.upsertGoogleOAuthConfig(
      {
        clientId: parsed.clientId,
        ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
        redirectUri: parsed.redirectUri,
      },
      ctx.user.id,
    )
    return ok(toGoogleOAuthPublicView(resolved))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to save platform Google OAuth config')
  }
}

export async function listUserDelegatedConnectors() {
  try {
    const user = await requireTenantRole('viewer')
    const connectors = await prisma.connector.findMany({
      where: {
        authMode: 'user_delegated',
        lifecycleState: 'active',
        OR: [{ tenantId: null }, { tenantId: user.activeTenantId }],
      },
      orderBy: { name: 'asc' },
    })
    return ok(connectors)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list connectors')
  }
}

export async function startConnectorOAuth(input: {
  connectorId: string
  scopes?: string[]
  /** A grant-hiányon elakadt eszköz — ebből jön a legkisebb szükséges scope. */
  toolName?: string
  returnTo?: { kind: 'conversation' | 'ticket'; id: string; agentId?: string }
}) {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Not authenticated')
    const { connectorId, scopes, toolName, returnTo } = startConnectorOAuthSchema.parse(input)
    const connector = await prisma.connector.findUnique({ where: { id: connectorId } })
    if (!connector) return fail('Connector not found')
    if (connector.authMode !== 'user_delegated') return fail('Connector is not user_delegated')
    if (connector.lifecycleState !== 'active') return fail('Connector is not active')
    if (connector.tenantId && connector.tenantId !== user.tenantId) return fail('Connector not found')

    const { oauthReturnPath } = await import('@/domain/connector-grant/connector-grant-needed')
    const successPath = returnTo ? oauthReturnPath(returnTo) : '/control-plane/connectors?connected=1'

    // A kért scope forrás-igazsága a SZERVER: a `toolName` alapján a
    // provider-regiszter a connector configjából oldja fel a legkisebb
    // szükséges halmazt. A kliens scope-listája csak explicit admin-választásnál
    // (kapcsolatok oldali scope-profil) érvényes, és a szerviz azt is a
    // confighoz validálja.
    const requestedScopes = toolName
      ? resolveGrantOAuthScopes({
          connectorType: connector.type,
          config: connector.config,
          toolName,
        })
      : scopes
    const effectiveScopes = requestedScopes && requestedScopes.length > 0 ? requestedScopes : undefined

    if (isDelegatedOAuthStubEnabled()) {
      const { createOAuthState } = await import('@/lib/crypto/oauth-state')
      const { state } = createOAuthState({
        userId: user.id,
        connectorId: connector.id,
        tenantId: user.tenantId,
        requestedScopes: effectiveScopes,
        ...(returnTo ? { returnTo } : {}),
      })
      await services.connectorGrants.completeOAuthCallback({
        code: 'stub-auth-code',
        state,
        connector,
        actorId: user.id,
      })
      return ok({ url: successPath, stub: true })
    }

    const { url } = await services.connectorGrants.buildAuthorizationUrl({
      connector,
      userId: user.id,
      tenantId: user.tenantId,
      requestedScopes: effectiveScopes,
      ...(returnTo ? { returnTo } : {}),
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
    const user = await requireTenantRole('approver')
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
      actor: { type: 'human', userId: user.user.id, role: user.activeTenantRole },
      note: `Gmail küldés jóváhagyva: ${parsed.draftId}`,
    })

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        payload: { ...payload, gmailSendApproved: parsed.draftId, approvedBy: user.user.id },
      },
    })

    return ok({ ticketId: ticket.id, draftId: parsed.draftId })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve send')
  }
}

export async function authorizeTicketRunAs(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('operator')
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

    const runAs = buildRunAsAuthorization({ userId: user.user.id })
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { payload: { ...payload, ...runAs } as Prisma.InputJsonValue },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'ticket.runas.authorize',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.agentId ?? null,
      outputRef: user.user.id,
      policyDecision: 'authorized',
      metadata: { runAsUserId: user.user.id } as Prisma.JsonValue,
    })

    return ok({ ticketId: ticket.id, runAsUserId: user.user.id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to authorize run-as')
  }
}

export async function revokeTicketRunAs(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { ticketId } = authorizeTicketRunAsSchema.parse(input)

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
    if (!ticket) return fail('Ticket not found')

    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? { ...(ticket.payload as Record<string, unknown>) }
        : {}
    if (!isRunAsAuthorized(payload)) return fail('Run-as is not authorized for this ticket')
    const authorizedBy = readRunAsAuthorizedBy(payload)
    if (authorizedBy !== user.user.id && !hasMinimumRole(user.activeTenantRole, 'admin')) {
      return fail('Only the authorizing user or an admin can revoke this run-as grant')
    }

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { payload: removeRunAsAuthorization(payload) as Prisma.InputJsonValue },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'ticket.runas.revoke',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: ticket.agentId ?? null,
      outputRef: user.user.id,
      policyDecision: 'revoked',
      metadata: { revokedBy: user.user.id } as Prisma.JsonValue,
    })

    return ok({ ticketId: ticket.id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke run-as')
  }
}
