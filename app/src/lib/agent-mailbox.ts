/**
 * #1029 az agent saját e-mail címe — DB-oldal: identitás betöltése (briefing,
 * get_definition, kimenő aláírás), a tenant postafiókjainak listája, és az
 * AgentMail-postafiók megjelenő nevének szinkronja.
 */
import { prisma } from '@/lib/db'
import {
  effectiveMailDisplayName,
  mailboxConnectorInfo,
  type AgentMailIdentity,
  type MailboxKind,
} from '@/domain/agent-mailbox/agent-mailbox'
import {
  agentMailApiBase,
  inboxIdFromConnectorBaseUrl,
  loadAgentMailOrgKey,
  loadAgentMailRegion,
  updateAgentMailInboxDisplayName,
} from '@/lib/agentmail'

const connectorSelect = { id: true, name: true, type: true, authMode: true, config: true, lifecycleState: true } as const

export async function loadAgentMailIdentity(tenantId: string, agentId: string): Promise<AgentMailIdentity | null> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, tenantId },
    select: {
      name: true,
      mailDisplayName: true,
      mailSignature: true,
      primaryMailboxConnectorId: true,
      primaryMailboxAddress: true,
      agentConnectors: { select: { accessMode: true, connector: { select: connectorSelect } } },
    },
  })
  if (!agent) return null
  let primary: AgentMailIdentity['primary'] = null
  const others: AgentMailIdentity['others'] = []
  let userGmail = false
  for (const binding of agent.agentConnectors) {
    const connector = binding.connector
    if (connector.lifecycleState !== 'active') continue
    if (connector.type === 'gmail' && connector.authMode === 'user_delegated') userGmail = true
    const info = mailboxConnectorInfo(connector)
    if (!info) continue
    if (connector.id === agent.primaryMailboxConnectorId && binding.accessMode === 'write') {
      primary = {
        connectorId: connector.id,
        connectorName: connector.name,
        kind: info.kind,
        address: info.address ?? agent.primaryMailboxAddress,
        displayName: effectiveMailDisplayName(agent),
        signature: agent.mailSignature?.trim() || null,
      }
    } else {
      others.push({
        connectorId: connector.id,
        connectorName: connector.name,
        kind: info.kind,
        address: info.address,
        accessMode: binding.accessMode,
      })
    }
  }
  return {
    primary,
    lostPrimaryAddress: primary ? null : agent.primaryMailboxAddress?.trim() || null,
    others,
    userGmail,
  }
}

export type TenantMailboxRow = {
  connectorId: string
  name: string
  kind: MailboxKind
  address: string | null
  /** Az agent, akinek ez a saját címe (ha van). */
  primaryOf: { agentId: string; agentName: string } | null
  /** Az adott agenthez kötött hozzáférés (ha van). */
  accessMode: 'read' | 'write' | null
  /** #1028: csak olvasásra bekötött tenant-postafiók — nem lehet saját cím. */
  readOnly: boolean
}

export async function listTenantMailboxes(tenantId: string, agentId: string): Promise<TenantMailboxRow[]> {
  const connectors = await prisma.connector.findMany({
    where: { tenantId, lifecycleState: 'active', type: { in: ['http_api', 'gmail'] } },
    select: {
      ...connectorSelect,
      agentConnectors: { where: { agentId }, select: { accessMode: true } },
      primaryForAgents: { select: { id: true, name: true } },
    },
    orderBy: { name: 'asc' },
  })
  return connectors.flatMap((connector) => {
    const info = mailboxConnectorInfo(connector)
    if (!info) return []
    const owner = connector.primaryForAgents[0]
    const mailbox = (connector.config as { mailbox?: { readOnly?: unknown } } | null)?.mailbox
    return [
      {
        connectorId: connector.id,
        name: connector.name,
        kind: info.kind,
        address: info.address,
        primaryOf: owner ? { agentId: owner.id, agentName: owner.name } : null,
        accessMode: connector.agentConnectors[0]?.accessMode ?? null,
        readOnly: mailbox?.readOnly === true,
      },
    ]
  })
}

/** Az agent saját címeinek térképe (agent-lista, kártya). */
export async function loadPrimaryMailboxAddresses(tenantId: string): Promise<Map<string, string>> {
  const agents = await prisma.agent.findMany({
    where: { tenantId, primaryMailboxConnectorId: { not: null } },
    select: { id: true, primaryMailboxAddress: true, primaryMailboxConnector: { select: { lifecycleState: true } } },
  })
  return new Map(
    agents.flatMap((agent) =>
      agent.primaryMailboxAddress && agent.primaryMailboxConnector?.lifecycleState === 'active'
        ? [[agent.id, agent.primaryMailboxAddress] as const]
        : [],
    ),
  )
}

/**
 * Az AgentMail-postafiók `display_name`-je kövesse az agent megjelenő nevét.
 * Fail-soft: false, ha nem sikerült (a mentést nem akasztja meg).
 */
export async function syncAgentMailDisplayName(tenantId: string, agentId: string): Promise<boolean> {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { name: true, mailDisplayName: true, primaryMailboxConnector: { select: connectorSelect } },
    })
    const connector = agent?.primaryMailboxConnector
    if (!agent || !connector || mailboxConnectorInfo(connector)?.kind !== 'agentmail') return true
    const inboxId = inboxIdFromConnectorBaseUrl((connector.config as { baseUrl?: unknown } | null)?.baseUrl)
    const [orgKey, region] = await Promise.all([loadAgentMailOrgKey(tenantId), loadAgentMailRegion(tenantId)])
    if (!inboxId || !orgKey) return false
    await updateAgentMailInboxDisplayName(orgKey, inboxId, effectiveMailDisplayName(agent), agentMailApiBase(region))
    return true
  } catch (e) {
    console.warn('agent_mailbox.display_name_sync_failed', { tenantId, agentId, error: e instanceof Error ? e.message : String(e) })
    return false
  }
}
