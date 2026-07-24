'use server'

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { getCurrentUser } from '@/auth'
import { requireTenantRole } from '@/auth/tenant-context'
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
import { loadAgentDelegatedConnectors } from '@/lib/agent-delegated-connectors-server'
import {
  readTenantGoogleOAuthConfig,
  upsertTenantGoogleOAuthConfig,
} from '@/lib/tenant-google-oauth-config'

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
    const [grants, connectors, tenant] = await Promise.all([
      services.connectorGrants.listForUser(user.user.id, user.activeTenantId),
      prisma.connector.findMany({
        where: {
          authMode: 'user_delegated',
          lifecycleState: 'active',
          OR: [{ tenantId: null }, { tenantId: user.activeTenantId }],
        },
        orderBy: { name: 'asc' },
      }),
      repositories.tenants.findById(user.activeTenantId),
    ])
    const googleOauth = readTenantGoogleOAuthConfig(tenant?.settings)
    return ok({
      grants,
      connectors,
      isAdmin,
      googleOauth: {
        configured: Boolean(googleOauth),
        clientIdHint: googleOauth?.clientId ? `${googleOauth.clientId.slice(0, 14)}...` : null,
        // A client ID nem titok (az OAuth flow-ban a böngészőbe kerül), de csak adminnak
        // adjuk vissza teljes egészében, hogy a szerkesztő űrlap előtölthető legyen.
        clientId: isAdmin ? googleOauth?.clientId ?? null : null,
        redirectUri: googleOauth?.redirectUri ?? null,
      },
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load connectors panel')
  }
}

export async function upsertTenantGoogleOAuth(input: {
  clientId: string
  clientSecret?: string
  redirectUri?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z.object({
      clientId: z.string().trim().min(1),
      // Üresen hagyva a meglévő secret marad érvényben — így a client ID vagy a
      // redirect URI önmagában is szerkeszthető, secret újragépelés nélkül.
      clientSecret: z.string().trim().optional(),
      redirectUri: z.union([z.literal(''), z.string().trim().url()]).optional(),
    }).parse(input)

    const tenant = await repositories.tenants.findById(user.activeTenantId)
    if (!tenant) return fail('Tenant not found')
    const existing = readTenantGoogleOAuthConfig(tenant.settings)
    const clientSecret = parsed.clientSecret || existing?.clientSecret
    if (!clientSecret) {
      return fail('Client Secret szükséges az első beállításhoz.')
    }
    // undefined = nem küldték → marad a meglévő; '' = törlés; egyébként új érték.
    const redirectUri =
      parsed.redirectUri === undefined ? existing?.redirectUri : parsed.redirectUri || undefined
    const settings = upsertTenantGoogleOAuthConfig(tenant.settings, {
      clientId: parsed.clientId,
      clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    })
    await repositories.tenants.update(user.activeTenantId, { settings })
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'tenant.oauth.google.update',
      targetType: 'tenant',
      targetId: user.activeTenantId,
      modelUsed: null,
      inputRef: 'google',
      outputRef: parsed.clientId,
      policyDecision: existing ? 'updated' : 'configured',
      metadata: {
        redirectUri: redirectUri ?? null,
        secretRotated: Boolean(parsed.clientSecret),
        source: 'connectors_panel',
      } as Prisma.JsonValue,
      tenantId: user.activeTenantId,
    })
    return ok({ configured: true, clientId: parsed.clientId, redirectUri: redirectUri ?? null })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to save tenant Google OAuth config')
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

export async function startConnectorOAuth(input: { connectorId: string; scopes?: string[] }) {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Not authenticated')
    const { connectorId, scopes } = startConnectorOAuthSchema.parse(input)
    const connector = await prisma.connector.findUnique({ where: { id: connectorId } })
    if (!connector) return fail('Connector not found')
    if (connector.authMode !== 'user_delegated') return fail('Connector is not user_delegated')
    if (connector.lifecycleState !== 'active') return fail('Connector is not active')
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

    const { url } = await services.connectorGrants.buildAuthorizationUrl({
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
