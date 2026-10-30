'use server'

/**
 * #1028 tenant-szintű postafiók (Gmail / Microsoft 365): az admin egyszer köti be,
 * a postafiók a cégé, és bármelyik agenthez rendelhető `read` / `write` módban.
 */
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { assignConnectorToAgent, unassignConnectorFromAgent } from '@/app/actions/provisioning'
import { BUILTIN_CONNECTOR_TEMPLATES } from '@/domain/connector-template/builtin-templates'
import { materializeGmailConnectorConfig } from '@/domain/connector-template/gmail-connector-config'
import { parseTemplateDescriptor } from '@/domain/connector-template/template-descriptor'
import {
  TENANT_MAILBOX_ASSIGN_WARNING,
  isMicrosoft365Connector,
  microsoftMailboxConfig,
  tenantMailboxOf,
  tenantMailboxScopes,
  type TenantMailboxConfig,
  type TenantMailboxSource,
} from '@/domain/connector-grant/tenant-mailbox'
import { services } from '@/domain/gateway-services'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

export type TenantMailboxStatus = 'active' | 'broken' | 'disconnected' | 'pending'

export type TenantMailboxRow = {
  connectorId: string
  name: string
  address: string | null
  source: TenantMailboxSource
  readOnly: boolean
  requireApproval: boolean
  status: TenantMailboxStatus
  connectedAt: string | null
  bindings: Array<{ agentId: string; accessMode: 'read' | 'write' }>
}

export type TenantMailboxOverview = {
  mailboxes: TenantMailboxRow[]
  /** Aktív Microsoft 365 konnektorok — ezek OAuth-kliensével köthető be Microsoft-postafiók. */
  microsoftBases: Array<{ connectorId: string; name: string }>
  agents: Array<{ id: string; name: string }>
  assignWarning: string
}

type AdminUser = Awaited<ReturnType<typeof requireTenantRole>>

async function audit(user: AdminUser, action: string, targetId: string, metadata: Record<string, unknown>) {
  await repositories.audit.append({
    actorType: 'human',
    actorId: user.user.id,
    agentVersion: null,
    action,
    targetType: 'connector',
    targetId,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: 'allowed',
    metadata,
    tenantId: user.activeTenantId,
  })
}

function errorMessage(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : ''
  if (message === 'connector_not_active') return 'Ez a postafiók már le van választva.'
  if (/missing clientId|client secret/i.test(message)) {
    return 'A Google/Microsoft bejelentkezés nincs beállítva a platformon. Kérd meg a platform üzemeltetőjét.'
  }
  return message || fallback
}

function statusOf(grant: { status: string } | undefined): TenantMailboxStatus {
  if (!grant) return 'pending'
  if (grant.status === 'active') return 'active'
  if (grant.status === 'expired') return 'broken'
  return 'disconnected'
}

const MAILBOX_WHERE = (tenantId: string) =>
  ({
    tenantId,
    authMode: 'service',
    lifecycleState: 'active',
    OR: [
      { config: { path: ['mailbox', 'source'], equals: 'google' } },
      { config: { path: ['mailbox', 'source'], equals: 'microsoft' } },
    ],
  }) satisfies Prisma.ConnectorWhereInput

/** Admin: a tenant közös postafiókjai, állapottal és agent-kötésekkel. */
export async function getTenantMailboxOverview() {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    const [connectors, msCandidates, agents] = await Promise.all([
      prisma.connector.findMany({
        where: MAILBOX_WHERE(tenantId),
        orderBy: { createdAt: 'asc' },
        include: {
          agentConnectors: { select: { agentId: true, accessMode: true } },
          grants: { where: { ownerType: 'tenant' }, orderBy: { grantedAt: 'desc' }, take: 1 },
        },
      }),
      prisma.connector.findMany({
        where: { tenantId, type: 'http_api', authMode: 'user_delegated', lifecycleState: 'active' },
        select: { id: true, name: true, type: true, config: true },
      }),
      repositories.agents.findMany({ tenantId }),
    ])
    const mailboxes = connectors.flatMap((connector): TenantMailboxRow[] => {
      const mailbox = tenantMailboxOf(connector)
      if (!mailbox) return []
      const grant = connector.grants[0]
      return [
        {
          connectorId: connector.id,
          name: connector.name,
          address: grant?.accountLabel ?? mailbox.address ?? null,
          source: mailbox.source,
          readOnly: mailbox.readOnly,
          requireApproval: mailbox.requireApproval,
          status: statusOf(grant),
          connectedAt: grant?.grantedAt.toISOString() ?? null,
          bindings: connector.agentConnectors,
        },
      ]
    })
    return ok<TenantMailboxOverview>({
      mailboxes,
      microsoftBases: msCandidates
        .filter((row) => isMicrosoft365Connector(row))
        .map((row) => ({ connectorId: row.id, name: row.name })),
      agents: agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({ id: agent.id, name: agent.name })),
      assignWarning: TENANT_MAILBOX_ASSIGN_WARNING,
    })
  } catch (e) {
    return fail(errorMessage(e, 'Nem sikerült betölteni a postafiókokat'))
  }
}

function googleMailboxConfig(mailbox: TenantMailboxConfig): Record<string, unknown> {
  const raw = BUILTIN_CONNECTOR_TEMPLATES.find((template) => template.key === 'google-workspace')
  if (!raw) throw new Error('builtin google-workspace template missing')
  const descriptor = parseTemplateDescriptor(raw)
  const config = materializeGmailConnectorConfig(
    descriptor,
    { authMethodKind: 'user_delegated_oauth2', instanceValues: {}, selectedScopes: tenantMailboxScopes('google', mailbox.readOnly) },
    {},
    { templateKey: descriptor.key, templateOrigin: 'builtin' },
  )
  return {
    ...config,
    oauth: { ...config.oauth, userInfoUrl: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', accountEmailField: 'emailAddress' },
    mailbox,
  }
}

const startSchema = z.object({
  source: z.enum(['google', 'microsoft']),
  readOnly: z.boolean().default(false),
  requireApproval: z.boolean().default(true),
  microsoftBaseConnectorId: z.string().uuid().optional(),
})

/**
 * Új közös postafiók: a konnektor rögtön létrejön (bekötésre vár), majd az admin
 * a postafiók fiókjával belép. Visszatérés: a bejelentkezés URL-je.
 */
export async function startTenantMailboxConnectAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = startSchema.parse(input)
    const tenantId = user.activeTenantId
    const mailbox: TenantMailboxConfig = {
      source: parsed.source,
      readOnly: parsed.readOnly,
      requireApproval: parsed.requireApproval,
    }

    let data: Prisma.ConnectorUncheckedCreateInput
    if (parsed.source === 'google') {
      data = {
        tenantId,
        type: 'gmail',
        name: 'Közös Gmail-postafiók (bekötésre vár)',
        authMode: 'service',
        scope: 'single',
        lifecycleState: 'active',
        config: googleMailboxConfig(mailbox) as Prisma.InputJsonValue,
      }
    } else {
      const base = parsed.microsoftBaseConnectorId
        ? await prisma.connector.findFirst({
            where: { id: parsed.microsoftBaseConnectorId, tenantId, lifecycleState: 'active' },
          })
        : null
      if (!base || !isMicrosoft365Connector(base)) {
        return fail('Előbb aktiváld a Microsoft 365 kapcsolatot a Konnektorok oldalon, és válaszd ki itt.')
      }
      data = {
        tenantId,
        type: 'http_api',
        name: 'Közös Microsoft-postafiók (bekötésre vár)',
        authMode: 'service',
        scope: 'single',
        lifecycleState: 'active',
        secretAlias: base.secretAlias,
        config: microsoftMailboxConfig(base.config as Record<string, unknown>, mailbox) as Prisma.InputJsonValue,
      }
    }
    const connector = await prisma.connector.create({ data })
    // Ha a bejelentkezés el sem indul (pl. nincs platform OAuth), ne maradjon félkész postafiók.
    const started = await services.connectorGrants
      .startTenantMailboxAuthorization({ connector, userId: user.user.id, tenantId })
      .catch(async (error: unknown) => {
        await prisma.connector.delete({ where: { id: connector.id } }).catch(() => {})
        throw error
      })
    if (started.stub) {
      await audit(user, 'connector.mailbox.connect', connector.id, { source: mailbox.source, readOnly: mailbox.readOnly, stub: true })
    }
    return ok({ connectorId: connector.id, url: started.url })
  } catch (e) {
    return fail(errorMessage(e, 'Nem sikerült elindítani a postafiók bekötését'))
  }
}

async function loadMailbox(tenantId: string, connectorId: string) {
  const connector = await prisma.connector.findFirst({ where: { id: connectorId, ...MAILBOX_WHERE(tenantId) } })
  const mailbox = connector ? tenantMailboxOf(connector) : null
  if (!connector || !mailbox) throw new Error('Ez a postafiók nem található.')
  return { connector, mailbox }
}

/** Megszakadt vagy félbehagyott bekötés: ugyanazzal a postafiókkal újra be kell lépni. */
export async function reconnectTenantMailboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { connectorId } = z.object({ connectorId: z.string().uuid() }).parse(input)
    const { connector } = await loadMailbox(user.activeTenantId, connectorId)
    const started = await services.connectorGrants.startTenantMailboxAuthorization({
      connector,
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok({ url: started.url })
  } catch (e) {
    return fail(errorMessage(e, 'Nem sikerült elindítani az újracsatlakoztatást'))
  }
}

/** Leválasztás: a token törlődik, az agentek elveszítik a hozzáférést, a postafiók eltűnik a listából. */
export async function disconnectTenantMailboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { connectorId } = z.object({ connectorId: z.string().uuid() }).parse(input)
    const { connector, mailbox } = await loadMailbox(user.activeTenantId, connectorId)
    const bindings = await prisma.agentConnector.findMany({ where: { connectorId }, select: { agentId: true } })
    for (const { agentId } of bindings) {
      const res = await unassignConnectorFromAgent({ connectorId, agentId, reason: 'tenant_mailbox_disconnect' })
      if (!res.success) return res
    }
    const grant = await repositories.connectorGrants.findLatestTenantGrant({ tenantId: user.activeTenantId, connectorId })
    if (grant && grant.status !== 'revoked') {
      await services.connectorGrants.revokeGrant({
        grantId: grant.id,
        actorId: user.user.id,
        actorType: 'human',
        expectedTenantId: user.activeTenantId,
        reason: 'tenant_mailbox_disconnect',
      })
    }
    await prisma.connector.update({ where: { id: connectorId }, data: { lifecycleState: 'archived' } })
    await audit(user, 'connector.mailbox.disconnect', connectorId, {
      address: grant?.accountLabel ?? mailbox.address ?? null,
      source: mailbox.source,
      unassignedAgentIds: bindings.map((row) => row.agentId),
      connectorName: connector.name,
    })
    return ok({ disconnected: true })
  } catch (e) {
    return fail(errorMessage(e, 'Nem sikerült leválasztani a postafiókot'))
  }
}

const assignSchema = z.object({
  connectorId: z.string().uuid(),
  agentId: z.string().uuid(),
  access: z.enum(['none', 'read', 'write']),
  /** A „minden használó olvashatja” figyelmeztetés elfogadása — hozzáadáskor kötelező. */
  confirmed: z.boolean().default(false),
})

export async function assignTenantMailboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = assignSchema.parse(input)
    const { mailbox } = await loadMailbox(user.activeTenantId, parsed.connectorId)
    if (parsed.access !== 'none' && !parsed.confirmed) {
      return fail('A hozzárendeléshez el kell fogadnod a figyelmeztetést.')
    }
    if (parsed.access === 'write' && mailbox.readOnly) {
      return fail('Ez a postafiók csak olvasásra van bekötve, ezért agent nem küldhet belőle.')
    }
    const res =
      parsed.access === 'none'
        ? await unassignConnectorFromAgent({ connectorId: parsed.connectorId, agentId: parsed.agentId })
        : await assignConnectorToAgent({
            connectorId: parsed.connectorId,
            agentId: parsed.agentId,
            accessMode: parsed.access,
            mailboxConfirmed: parsed.confirmed,
          })
    if (!res.success) return res
    await audit(user, 'connector.mailbox.assign', parsed.connectorId, {
      agentId: parsed.agentId,
      access: parsed.access,
      address: mailbox.address ?? null,
      ...(parsed.access !== 'none' ? { warningAccepted: TENANT_MAILBOX_ASSIGN_WARNING } : {}),
    })
    return ok({ access: parsed.access })
  } catch (e) {
    return fail(errorMessage(e, 'Nem sikerült menteni a hozzárendelést'))
  }
}

/** Kikényszerített jóváhagyás: bekapcsolva az agent írási módja sem küldhet jóváhagyás nélkül. */
export async function setTenantMailboxApprovalAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z.object({ connectorId: z.string().uuid(), requireApproval: z.boolean() }).parse(input)
    const { connector, mailbox } = await loadMailbox(user.activeTenantId, parsed.connectorId)
    await prisma.connector.update({
      where: { id: connector.id },
      data: {
        config: {
          ...((connector.config ?? {}) as Prisma.JsonObject),
          mailbox: { ...mailbox, requireApproval: parsed.requireApproval },
        },
      },
    })
    await audit(user, 'connector.mailbox.approval', connector.id, {
      requireApproval: parsed.requireApproval,
      address: mailbox.address ?? null,
    })
    return ok({ requireApproval: parsed.requireApproval })
  } catch (e) {
    return fail(errorMessage(e, 'Nem sikerült menteni a beállítást'))
  }
}
