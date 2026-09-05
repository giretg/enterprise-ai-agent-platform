'use server'

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
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
  parseDelegatedGrantScopes,
  resolveGrantOAuthScopes,
} from '@/domain/connector-grant/delegated-oauth-registry'
import { toGoogleOAuthPublicView, toGoogleDrivePickerPublicView } from '@/lib/platform-google-oauth-config'
import { toolsRequiringConnector } from '@/domain/tool-broker/tool-connector-requirements'
import { agentDisplayName } from '@/lib/agent-persona'
import { GoogleDriveApiClient } from '@/domain/connector-grant/google-drive-api-client'
import {
  readGoogleDriveGrantMetadata,
  removeGoogleDrivePickerSelection,
  saveGoogleDrivePickerSelections as persistGoogleDrivePickerSelections,
} from '@/domain/connector-grant/google-drive-grant-store'
import {
  driveScopeProfile,
  driveScopeProfileRequiresAdmin,
} from '@/domain/connector-grant/google-drive-scopes'

function activeDelegatedConnectorWhere(tenantId: string): Prisma.ConnectorWhereInput {
  return {
    authMode: 'user_delegated',
    lifecycleState: 'active',
    OR: [{ tenantId: null }, { tenantId }],
  }
}

async function listActiveDelegatedConnectors(tenantId: string) {
  return prisma.connector.findMany({
    where: activeDelegatedConnectorWhere(tenantId),
    orderBy: { name: 'asc' },
  })
}

async function googleOAuthSummary() {
  const resolved = await services.platformSettings.getGoogleOAuthConfig()
  const view = toGoogleOAuthPublicView(resolved)
  return {
    configured: view.configured,
    persisted: view.persisted,
    source: view.source,
  }
}

async function googleDriveOAuthSummary() {
  const resolved = await services.platformSettings.getGoogleDriveOAuthConfig()
  const view = toGoogleOAuthPublicView(resolved)
  return {
    configured: view.configured,
    persisted: view.persisted,
    source: view.source,
  }
}

async function googleDrivePickerSummary() {
  const resolved = await services.platformSettings.getGoogleDrivePickerConfig()
  const view = toGoogleDrivePickerPublicView(resolved)
  return {
    configured: view.configured,
    persisted: view.persisted,
    source: view.source,
    appId: view.appId,
  }
}

async function delegatedConnectorUsage(
  connectors: Awaited<ReturnType<typeof listActiveDelegatedConnectors>>,
  tenantId: string,
) {
  const links = await prisma.agentConnector.findMany({
    where: {
      connectorId: { in: connectors.map((connector) => connector.id) },
      agent: { tenantId, status: 'active' },
    },
    select: {
      connectorId: true,
      agent: {
        select: {
          name: true,
          personaNickname: true,
          capabilities: {
            where: { allowed: true },
            select: { toolName: true },
          },
        },
      },
    },
  })

  return Object.fromEntries(
    connectors.map((connector) => {
      const requiredTools = new Set<string>(toolsRequiringConnector(connector.type))
      const connectorLinks = links.filter((link) => link.connectorId === connector.id)
      const capableAgents = connectorLinks.filter((link) =>
        link.agent.capabilities.some((capability) => requiredTools.has(capability.toolName)),
      )
      const capableAgentDisplayNames = capableAgents
        .map((link) => agentDisplayName(link.agent.name, link.agent))
        .sort((a, b) => a.localeCompare(b, 'hu'))
      return [
        connector.id,
        {
          assignedAgentCount: connectorLinks.length,
          capableAgentCount: capableAgents.length,
          capableAgentDisplayNames,
        },
      ]
    }),
  )
}

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
    const ctx = await requireTenantRole('viewer')
    await services.connectorGrants.revokeGrantsForNonActiveConnectors(
      ctx.user.id,
      ctx.activeTenantId,
      ctx.user.id,
    )
    const grants = await services.connectorGrants.listForUser(ctx.user.id, ctx.activeTenantId)
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
    const [grants, connectors, googleOauth, drivePicker] = await Promise.all([
      services.connectorGrants.listForUser(user.user.id, user.activeTenantId),
      listActiveDelegatedConnectors(user.activeTenantId),
      googleOAuthSummary(),
      services.platformSettings.getGoogleDrivePickerConfig(),
    ])
    const connectorUsage = await delegatedConnectorUsage(connectors, user.activeTenantId)
    return ok({
      grants,
      connectors,
      connectorUsage,
      isAdmin,
      canManagePlatformOauth: isSuperadmin(user.platformRoles),
      googleOauth,
      drivePickerConfigured: Boolean(drivePicker),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load connectors panel')
  }
}

/** Tenant-admin: a szervezetben elérhető delegált connectorok + platform OAuth állapot. */
export async function listDelegatedConnectorsAdminView() {
  try {
    const user = await requireTenantRole('admin')
    const [connectors, googleOauth, googleDriveOauth, googleDrivePicker] = await Promise.all([
      listActiveDelegatedConnectors(user.activeTenantId),
      googleOAuthSummary(),
      googleDriveOAuthSummary(),
      googleDrivePickerSummary(),
    ])
    return ok({
      connectors: connectors.map((connector) => ({
        id: connector.id,
        name: connector.name,
        type: connector.type,
        authMode: connector.authMode,
        tenantId: connector.tenantId,
        canDecommission:
          connector.tenantId === user.activeTenantId || isSuperadmin(user.platformRoles),
      })),
      canManagePlatformOauth: isSuperadmin(user.platformRoles),
      googleOauth,
      googleDriveOauth,
      googleDrivePicker,
      hasGoogleDriveConnector: connectors.some((connector) => connector.type === 'google_drive'),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load delegated connectors')
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

export async function getGoogleDriveOAuthConfiguredStatus() {
  try {
    await requireTenantRole('viewer')
    const resolved = await services.platformSettings.getGoogleDriveOAuthConfig()
    return ok({ configured: Boolean(resolved) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load Google Drive OAuth status')
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

export async function getPlatformGoogleDriveOAuthConfig() {
  try {
    await requirePlatformRole('platform_auditor')
    const resolved = await services.platformSettings.getGoogleDriveOAuthConfig()
    return ok(toGoogleOAuthPublicView(resolved))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load platform Google Drive OAuth config')
  }
}

export async function upsertPlatformGoogleDriveOAuth(input: {
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

    const resolved = await services.platformSettings.upsertGoogleDriveOAuthConfig(
      {
        clientId: parsed.clientId,
        ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
        redirectUri: parsed.redirectUri,
      },
      ctx.user.id,
    )
    return ok(toGoogleOAuthPublicView(resolved))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to save platform Google Drive OAuth config')
  }
}

export async function getPlatformGoogleDrivePickerConfig() {
  try {
    await requirePlatformRole('platform_auditor')
    const resolved = await services.platformSettings.getGoogleDrivePickerConfig()
    return ok(toGoogleDrivePickerPublicView(resolved))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load Google Drive Picker config')
  }
}

export async function upsertPlatformGoogleDrivePickerConfig(input: { apiKey: string; appId: string }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = z
      .object({
        apiKey: z.string().trim().min(1),
        appId: z.string().trim().min(1),
      })
      .parse(input)
    const resolved = await services.platformSettings.upsertGoogleDrivePickerConfig(parsed, ctx.user.id)
    return ok(toGoogleDrivePickerPublicView({ config: resolved.config, source: resolved.source }))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to save Google Drive Picker config')
  }
}

export async function getGoogleDrivePickerSession(input: { grantId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { grantId } = connectorGrantIdSchema.parse(input)
    const grant = await prisma.connectorGrant.findUnique({
      where: { id: grantId },
      include: { connector: true },
    })
    if (!grant || grant.userId !== ctx.user.id || grant.status !== 'active') {
      return fail('Grant not found')
    }
    if (grant.connector.type !== 'google_drive') {
      return fail('A Picker csak Google Drive granthez érhető el.')
    }
    if (driveScopeProfile(grant.scopes) !== 'selected_write') {
      return fail('A Picker csak az „olvasás + írás kijelölt fájlokon” profilnál szükséges.')
    }
    const pickerConfig = await services.platformSettings.getGoogleDrivePickerConfig()
    if (!pickerConfig) {
      return fail('A Google Picker nincs platform-szinten beállítva (API key + App ID).')
    }
    const accessToken = await services.connectorGrants.resolveAccessToken({
      connector: grant.connector,
      grantId: grant.id,
      tokenRef: grant.tokenRef,
      actingUserId: ctx.user.id,
      tenantId: grant.tenantId ?? ctx.activeTenantId,
    })
    const origin =
      process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '') ?? 'http://localhost:3000'
    return ok({
      accessToken,
      apiKey: pickerConfig.config.apiKey,
      appId: pickerConfig.config.appId,
      origin,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to start Google Picker session')
  }
}

export async function saveGoogleDrivePickerSelections(input: {
  grantId: string
  selections: Array<{ fileId: string; name: string; mimeType: string }>
}) {
  try {
    const ctx = await requireTenantRole('viewer')
    const parsed = z
      .object({
        grantId: z.string().uuid(),
        selections: z
          .array(
            z.object({
              fileId: z.string().trim().min(1).max(200),
              name: z.string().trim().min(1).max(500),
              mimeType: z.string().trim().min(1).max(200),
            }),
          )
          .min(1)
          .max(50),
      })
      .parse(input)
    const grant = await prisma.connectorGrant.findUnique({
      where: { id: parsed.grantId },
      include: { connector: true },
    })
    if (!grant || grant.userId !== ctx.user.id || grant.status !== 'active') {
      return fail('Grant not found')
    }
    if (grant.connector.type !== 'google_drive') {
      return fail('Érvénytelen connector típus.')
    }
    if (driveScopeProfile(grant.scopes) !== 'selected_write') {
      return fail('A kiválasztás csak selected-write profilnál menthető.')
    }

    const accessToken = await services.connectorGrants.resolveAccessToken({
      connector: grant.connector,
      grantId: grant.id,
      tokenRef: grant.tokenRef,
      actingUserId: ctx.user.id,
      tenantId: grant.tenantId ?? ctx.activeTenantId,
    })
    const drive = new GoogleDriveApiClient(accessToken)
    const validated: Array<{ fileId: string; name: string; mimeType: string }> = []
    for (const selection of parsed.selections) {
      const file = await drive.getFile({ fileId: selection.fileId })
      validated.push({
        fileId: file.id,
        name: file.name || selection.name,
        mimeType: file.mimeType || selection.mimeType,
      })
    }

    const metadata = await persistGoogleDrivePickerSelections({
      grantId: grant.id,
      selections: validated,
    })
    return ok({ metadata })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to save Picker selections')
  }
}

export async function removeGoogleDrivePickerSelectionAction(input: {
  grantId: string
  fileId: string
}) {
  try {
    const ctx = await requireTenantRole('viewer')
    const parsed = z
      .object({
        grantId: z.string().uuid(),
        fileId: z.string().trim().min(1).max(200),
      })
      .parse(input)
    const grant = await prisma.connectorGrant.findUnique({ where: { id: parsed.grantId } })
    if (!grant || grant.userId !== ctx.user.id || grant.status !== 'active') {
      return fail('Grant not found')
    }
    const metadata = await removeGoogleDrivePickerSelection({
      grantId: grant.id,
      fileId: parsed.fileId,
    })
    return ok({ metadata })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to remove Picker selection')
  }
}

export async function getGoogleDriveGrantManifest(input: { grantId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { grantId } = connectorGrantIdSchema.parse(input)
    const grant = await prisma.connectorGrant.findUnique({ where: { id: grantId } })
    if (!grant || grant.userId !== ctx.user.id) return fail('Grant not found')
    const metadata = await readGoogleDriveGrantMetadata(grantId)
    return ok({
      metadata,
      profile: driveScopeProfile(grant.scopes),
      pickerConfigured: Boolean(await services.platformSettings.getGoogleDrivePickerConfig()),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load Drive grant manifest')
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
  returnTo?: { kind: 'conversation' | 'ticket'; id: string; agentId?: string; originPath?: string }
}) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { connectorId, scopes, toolName, returnTo } = startConnectorOAuthSchema.parse(input)
    const connector = await prisma.connector.findUnique({ where: { id: connectorId } })
    if (!connector) return fail('Connector not found')
    if (connector.authMode !== 'user_delegated') return fail('Connector is not user_delegated')
    if (connector.lifecycleState !== 'active') return fail('Connector is not active')
    // Membership / superadmin assume — ne a legacy User.tenantId.
    if (connector.tenantId && connector.tenantId !== ctx.activeTenantId) return fail('Connector not found')

    const { oauthReturnPath } = await import('@/domain/connector-grant/connector-grant-needed')
    const successPath = returnTo ? oauthReturnPath(returnTo) : '/control-plane/account?connected=1'

    // A kért scope forrás-igazsága a SZERVER: a `toolName` alapján a
    // provider-regiszter a connector configjából oldja fel a legkisebb
    // szükséges halmazt. A kliens scope-listája csak explicit admin-választásnál
    // (Kapcsolt fiókok oldali scope-profil) érvényes, és a szerviz azt is a
    // confighoz validálja.
    const requestedScopes = toolName
      ? resolveGrantOAuthScopes({
          connectorType: connector.type,
          config: connector.config,
          toolName,
        })
      : scopes
    // Least-privilege tool-scope + már megadott grant uniója: különben a
    // gmail_send kártya [send]-only OAuth-ja felülírná a korábbi readonly/modify-t.
    // Csak a connector configjában még érvényes scope-okat tartjuk meg.
    const existingGrant = await repositories.connectorGrants.findActiveGrant({
      tenantId: connector.tenantId ?? ctx.activeTenantId,
      connectorId: connector.id,
      userId: ctx.user.id,
    })
    const configured = new Set(
      resolveGrantOAuthScopes({
        connectorType: connector.type,
        config: connector.config,
      }),
    )
    const existingScopes = parseDelegatedGrantScopes(existingGrant?.scopes).filter((scope) =>
      configured.has(scope),
    )
    const mergedRequested = [...new Set([...(requestedScopes ?? []), ...existingScopes])]
    const effectiveScopes = mergedRequested.length > 0 ? mergedRequested : undefined

    // A „Teljes olvasás + írás" (full `drive`) Drive-profil admin-döntés. A
    // kliens a profil-választót elrejti a nem-adminok elől, de a server action
    // közvetlenül is hívható (tetszőleges `scopes` tömbbel), ezért a kaput ITT,
    // a szerveren is meg kell húzni — különben az „elrejtés" puszta UI-dísz, és
    // egy alacsony jogú felhasználó (vagy kompromittált session) a teljes Drive
    // írási jogát szerezhetné meg, megkerülve a Picker-alapú, kijelölt-fájlos
    // korlátozást.
    if (
      connector.type === 'google_drive' &&
      driveScopeProfileRequiresAdmin(effectiveScopes ?? []) &&
      !hasMinimumRole(ctx.activeTenantRole, 'admin')
    ) {
      return fail(
        'A „Teljes olvasás + írás" Google Drive hozzáférést csak tenant-admin kérheti. ' +
          'Válaszd az „Olvasás + írás kijelölt fájlokon" profilt, és a Kapcsolt fiókok oldalon jelöld ki a szerkeszthető fájlokat.',
      )
    }

    if (isDelegatedOAuthStubEnabled()) {
      const { createOAuthState } = await import('@/lib/crypto/oauth-state')
      const { state } = createOAuthState({
        userId: ctx.user.id,
        connectorId: connector.id,
        tenantId: ctx.activeTenantId,
        requestedScopes: effectiveScopes,
        ...(returnTo ? { returnTo } : {}),
      })
      await services.connectorGrants.completeOAuthCallback({
        code: 'stub-auth-code',
        state,
        connector,
        actorId: ctx.user.id,
      })
      return ok({ url: successPath, stub: true })
    }

    const { url } = await services.connectorGrants.buildAuthorizationUrl({
      connector,
      userId: ctx.user.id,
      tenantId: ctx.activeTenantId,
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
    const ctx = await requireTenantRole('viewer')
    const { grantId } = connectorGrantIdSchema.parse(input)
    const grant = await prisma.connectorGrant.findUnique({ where: { id: grantId } })
    if (!grant) return fail('Grant not found')
    const isAdmin = hasMinimumRole(ctx.activeTenantRole, 'admin')
    if (grant.userId !== ctx.user.id && !isAdmin) {
      return fail('Forbidden')
    }
    if (isAdmin && grant.userId !== ctx.user.id && grant.tenantId !== ctx.activeTenantId) {
      return fail('Forbidden')
    }

    await services.connectorGrants.revokeGrant({
      grantId,
      actorId: ctx.user.id,
      actorType: 'human',
      expectedUserId: grant.userId === ctx.user.id ? ctx.user.id : undefined,
      expectedTenantId: ctx.activeTenantId,
    })
    return ok({ revoked: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke grant')
  }
}

function assertTicketTenantScope(
  ticket: { tenantId: string | null },
  activeTenantId: string,
): void {
  if (ticket.tenantId !== activeTenantId) {
    throw new Error('Ticket not found')
  }
}

export async function approveGmailSend(input: { ticketId: string; draftId: string }) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = approveGmailSendSchema.parse(input)
    const ticket = await prisma.ticket.findUnique({ where: { id: parsed.ticketId } })
    if (!ticket) return fail('Ticket not found')
    assertTicketTenantScope(ticket, user.activeTenantId)

    await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'approved',
      actor: { type: 'human', userId: user.user.id, role: user.activeTenantRole },
      note: `Gmail küldés jóváhagyva: ${parsed.draftId}`,
    })

    // A transition frissítheti a payloadot (pl. transitionNote) — ne a stale
    // előolvasással írjuk felül, különben elveszik a transition mellékhatása.
    const fresh = await prisma.ticket.findUnique({ where: { id: ticket.id } })
    if (!fresh) return fail('Ticket not found')
    const payload =
      typeof fresh.payload === 'object' && fresh.payload !== null && !Array.isArray(fresh.payload)
        ? { ...(fresh.payload as Record<string, unknown>) }
        : {}

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
    assertTicketTenantScope(ticket, user.activeTenantId)
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
    assertTicketTenantScope(ticket, user.activeTenantId)

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
