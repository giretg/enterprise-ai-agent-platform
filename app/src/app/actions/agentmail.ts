'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'
import { ProvisioningError } from '@/domain/provisioning/errors'
import {
  AgentMailApiError,
  AGENTMAIL_REGIONS,
  agentMailApiBase,
  createAgentMailInbox,
  inboxIdFromConnectorBaseUrl,
  listAgentMailInboxes,
  loadAgentMailOrgKey,
  loadAgentMailRegion,
  parseAgentMailRegion,
  saveAgentMailOrgKey,
  saveAgentMailRegion,
  type AgentMailInbox,
  type AgentMailRegion,
} from '@/lib/agentmail'
import { agentMailConnectors, auditAgentMail, connectAgentMailInbox } from '@/lib/agentmail-connect'

export type AgentMailInboxRow = AgentMailInbox & {
  connectorId: string | null
  /** A platformon bekötött, de az AgentMailben már nem létező postafiók. */
  missing: boolean
  bindings: Array<{ agentId: string; accessMode: 'read' | 'write' }>
}

export type AgentMailOverview = {
  configured: boolean
  region: AgentMailRegion
  loadError: string | null
  inboxes: AgentMailInboxRow[]
  agents: Array<{ id: string; name: string }>
}

function toFail(e: unknown, fallback: string, region?: AgentMailRegion) {
  if (e instanceof AgentMailApiError) {
    if (e.status === 401 || e.status === 403) {
      const where = region ? AGENTMAIL_REGIONS[region].label : 'a választott régió'
      return fail(
        `Az AgentMail elutasította a kulcsot. Ellenőrizd, hogy ${where} szervezet teljes jogú kulcsát adtad meg.`,
      )
    }
    return fail(`AgentMail: ${e.message}`)
  }
  if (e instanceof ProvisioningError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

async function requireOrgKey(tenantId: string): Promise<{ key: string; region: AgentMailRegion }> {
  const [key, region] = await Promise.all([loadAgentMailOrgKey(tenantId), loadAgentMailRegion(tenantId)])
  if (!key) throw new Error('Előbb add meg az AgentMail API kulcsot.')
  return { key, region }
}

export async function getAgentMailOverview() {
  try {
    const user = await requireTenantRole('admin')
    const tenantId = user.activeTenantId
    const [orgKey, region, connectors, agents] = await Promise.all([
      loadAgentMailOrgKey(tenantId),
      loadAgentMailRegion(tenantId),
      agentMailConnectors(tenantId),
      repositories.agents.findMany({ tenantId }),
    ])

    let remote: AgentMailInbox[] = []
    let loadError: string | null = null
    if (orgKey) {
      try {
        remote = await listAgentMailInboxes(orgKey, agentMailApiBase(region))
      } catch (e) {
        const failed = toFail(e, 'Nem sikerült lekérni a postafiókokat', region)
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
      region,
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
  const parsed = z
    .object({
      apiKey: z.string().trim().min(10).max(500),
      region: z.enum(['eu', 'global']).optional().default('eu'),
    })
    .parse(input)
  const region = parseAgentMailRegion(parsed.region)
  const apiBase = agentMailApiBase(region)
  try {
    const user = await requireTenantRole('admin')
    await listAgentMailInboxes(parsed.apiKey, apiBase)
    await saveAgentMailOrgKey(user.activeTenantId, parsed.apiKey)
    await saveAgentMailRegion(user.activeTenantId, region)
    await auditAgentMail(user, 'connector.agentmail.org_key.set', null, { region })
    return ok({ saved: true })
  } catch (e) {
    return toFail(e, 'Nem sikerült menteni az AgentMail kulcsot', region)
  }
}

export async function connectAgentMailInboxAction(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const { inboxId } = z.object({ inboxId: z.string().trim().min(1).max(320) }).parse(input)
    const { key: orgKey, region } = await requireOrgKey(user.activeTenantId)
    const inbox = (await listAgentMailInboxes(orgKey, agentMailApiBase(region))).find((row) => row.inboxId === inboxId)
    if (!inbox) return fail('Ez a postafiók nem található az AgentMail fiókban.')
    return ok({ connectorId: await connectAgentMailInbox(user, inbox, orgKey, region) })
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
    const { key: orgKey, region } = await requireOrgKey(user.activeTenantId)
    const apiBase = agentMailApiBase(region)
    const inbox = await createAgentMailInbox(
      orgKey,
      {
        username: parsed.username || undefined,
        domain: parsed.domain || undefined,
        displayName: parsed.displayName || undefined,
      },
      apiBase,
    )
    await auditAgentMail(user, 'connector.agentmail.inbox.create', null, { region, inboxEmail: inbox.email })
    return ok({ inbox, connectorId: await connectAgentMailInbox(user, inbox, orgKey, region) })
  } catch (e) {
    return toFail(e, 'Nem sikerült létrehozni a postafiókot')
  }
}
