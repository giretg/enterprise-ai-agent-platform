'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { isSuperadmin } from '@/lib/tenant-policy'
import { ProvisioningError } from '@/domain/provisioning/errors'
import type { ProvisioningActor } from '@/domain/provisioning/provisioning-service'
import {
  AGENTMAIL_TEMPLATE_KEY,
  BUILTIN_CONNECTOR_TEMPLATES,
} from '@/domain/connector-template/builtin-templates'
import { parseTemplateDescriptor } from '@/domain/connector-template/template-descriptor'
import { materializeConnectorConfig } from '@/domain/connector-template/materializer'
import {
  AgentMailApiError,
  agentMailConnectorDescription,
  agentMailInboxPathSegment,
  createAgentInboxApiKey,
  createAgentMailInbox,
  inboxIdFromConnectorBaseUrl,
  listAgentMailInboxes,
  loadAgentMailOrgKey,
  saveAgentMailOrgKey,
  type AgentMailInbox,
} from '@/lib/agentmail'

export type AgentMailInboxRow = AgentMailInbox & {
  connectorId: string | null
  /** A platformon bekötött, de az AgentMailben már nem létező postafiók. */
  missing: boolean
  bindings: Array<{ agentId: string; accessMode: 'read' | 'write' }>
}

export type AgentMailOverview = {
  configured: boolean
  loadError: string | null
  inboxes: AgentMailInboxRow[]
  agents: Array<{ id: string; name: string }>
}

type AdminUser = Awaited<ReturnType<typeof requireTenantRole>>

function actorOf(user: AdminUser): ProvisioningActor {
  return {
    type: 'user',
    userId: user.user.id,
    role: user.activeTenantRole,
    tenantId: user.activeTenantId,
    canManagePlatformConnectors: isSuperadmin(user.platformRoles),
  }
}

function toFail(e: unknown, fallback: string) {
  if (e instanceof AgentMailApiError) {
    if (e.status === 401 || e.status === 403) {
      return fail(
        'Az AgentMail elutasította a kulcsot. Ellenőrizd, hogy EU régiós (api.agentmail.eu) szervezet teljes jogú kulcsát adtad meg.',
      )
    }
    return fail(`AgentMail: ${e.message}`)
  }
  if (e instanceof ProvisioningError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

async function requireOrgKey(tenantId: string): Promise<string> {
  const key = await loadAgentMailOrgKey(tenantId)
  if (!key) throw new Error('Előbb add meg az AgentMail API kulcsot.')
  return key
}

function agentMailConnectors(tenantId: string) {
  return prisma.connector.findMany({
    where: {
      tenantId,
      type: 'http_api',
      lifecycleState: 'active',
      config: { path: ['provider'], equals: AGENTMAIL_TEMPLATE_KEY },
    },
    select: {
      id: true,
      config: true,
      agentConnectors: { select: { agentId: true, accessMode: true } },
    },
  })
}

async function audit(user: AdminUser, action: string, targetId: string | null, metadata: Record<string, unknown>) {
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

export async function getAgentMailOverview() {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    const [orgKey, connectors, agents] = await Promise.all([
      loadAgentMailOrgKey(tenantId),
      agentMailConnectors(tenantId),
      repositories.agents.findMany({ tenantId }),
    ])

    let remote: AgentMailInbox[] = []
    let loadError: string | null = null
    if (orgKey) {
      try {
        remote = await listAgentMailInboxes(orgKey)
      } catch (e) {
        const failed = toFail(e, 'Nem sikerült lekérni a postafiókokat')
        loadError = failed.success ? null : failed.error
      }
    }

    const byInbox = new Map(
      connectors.flatMap((c) => {
        const inboxId = inboxIdFromConnectorBaseUrl((c.config as { baseUrl?: unknown } | null)?.baseUrl)
        return inboxId ? [[inboxId, c] as const] : []
      }),
    )
    const rows: AgentMailInboxRow[] = remote.map((inbox) => {
      const connector = byInbox.get(inbox.inboxId)
      byInbox.delete(inbox.inboxId)
      return {
        ...inbox,
        connectorId: connector?.id ?? null,
        missing: false,
        bindings: connector?.agentConnectors ?? [],
      }
    })
    if (!loadError) {
      for (const [inboxId, connector] of byInbox) {
        rows.push({
          inboxId,
          email: inboxId,
          displayName: null,
          connectorId: connector.id,
          missing: true,
          bindings: connector.agentConnectors,
        })
      }
    }

    return ok<AgentMailOverview>({
      configured: Boolean(orgKey),
      loadError,
      inboxes: rows,
      agents: agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({ id: agent.id, name: agent.name })),
    })
  } catch (e) {
    return toFail(e, 'Nem sikerült betölteni az AgentMail beállításokat')
  }
}

export async function saveAgentMailApiKeyAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { apiKey } = z.object({ apiKey: z.string().trim().min(10).max(500) }).parse(input)
    await listAgentMailInboxes(apiKey)
    await saveAgentMailOrgKey(user.activeTenantId, apiKey)
    await audit(user, 'connector.agentmail.org_key.set', null, { region: 'eu' })
    return ok({ saved: true })
  } catch (e) {
    return toFail(e, 'Nem sikerült menteni az AgentMail kulcsot')
  }
}

async function connectInbox(user: AdminUser, inbox: AgentMailInbox, orgKey: string): Promise<string> {
  const tenantId = user.activeTenantId
  const existing = (await agentMailConnectors(tenantId)).find(
    (c) => inboxIdFromConnectorBaseUrl((c.config as { baseUrl?: unknown } | null)?.baseUrl) === inbox.inboxId,
  )
  if (existing) return existing.id

  const raw = BUILTIN_CONNECTOR_TEMPLATES.find((t) => t.key === AGENTMAIL_TEMPLATE_KEY)!
  const descriptor = parseTemplateDescriptor(raw)
  const config = materializeConnectorConfig(
    descriptor,
    { authMethodKind: 'bearer', instanceValues: { inboxId: agentMailInboxPathSegment(inbox.inboxId) } },
    {},
    { templateKey: descriptor.key, templateVersion: 1, templateOrigin: 'builtin' },
  )

  for (const host of descriptor.egressHosts) {
    await services.platformSettings.extendEgressAllowlist(tenantId, host, user.user.id, {
      sourceType: 'official',
    })
  }

  const actor = actorOf(user)
  const draft = await services.provisioning.createConnectorDraft(
    {
      name: `AgentMail · ${inbox.email}`,
      sourceType: 'template',
      sourceRef: `${descriptor.key}@1`,
      generatedConfig: { ...config, description: agentMailConnectorDescription(inbox) },
      connectorType: 'http_api',
    },
    actor,
  )
  await services.provisioning.validateConnectorDraft({ draftId: draft.draftId }, actor)
  const tested = await services.provisioning.testConnectorDraft({ draftId: draft.draftId }, actor)
  if (!tested.ok) throw new Error(`Az AgentMail nem érhető el (${tested.detail ?? tested.statusCode ?? '?'}).`)
  await services.provisioning.reviewConnectorDraft({ draftId: draft.draftId, decision: 'approve' }, actor)

  const inboxKey = await createAgentInboxApiKey(orgKey, inbox.inboxId, `platform · ${inbox.email}`)
  await services.provisioning.activateConnector({ draftId: draft.draftId, apiKey: inboxKey }, actor)
  await audit(user, 'connector.materialize', draft.connectorId, {
    templateKey: descriptor.key,
    templateVersion: 1,
    templateOrigin: 'builtin',
    inboxEmail: inbox.email,
  })
  return draft.connectorId
}

export async function connectAgentMailInboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { inboxId } = z.object({ inboxId: z.string().trim().min(1).max(320) }).parse(input)
    const orgKey = await requireOrgKey(user.activeTenantId)
    const inbox = (await listAgentMailInboxes(orgKey)).find((row) => row.inboxId === inboxId)
    if (!inbox) return fail('Ez a postafiók nem található az AgentMail fiókban.')
    return ok({ connectorId: await connectInbox(user, inbox, orgKey) })
  } catch (e) {
    return toFail(e, 'Nem sikerült bekötni a postafiókot')
  }
}

export async function createAgentMailInboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        username: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'A felhasználónév csak kisbetűt, számot, pontot, kötőjelet tartalmazhat.')
          .optional()
          .or(z.literal('')),
        domain: z.string().trim().toLowerCase().max(253).optional().or(z.literal('')),
        displayName: z.string().trim().max(120).optional().or(z.literal('')),
      })
      .parse(input)
    const orgKey = await requireOrgKey(user.activeTenantId)
    const inbox = await createAgentMailInbox(orgKey, {
      username: parsed.username || undefined,
      domain: parsed.domain || undefined,
      displayName: parsed.displayName || undefined,
    })
    await audit(user, 'connector.agentmail.inbox.create', null, { inboxEmail: inbox.email })
    return ok({ inbox, connectorId: await connectInbox(user, inbox, orgKey) })
  } catch (e) {
    return toFail(e, 'Nem sikerült létrehozni a postafiókot')
  }
}
