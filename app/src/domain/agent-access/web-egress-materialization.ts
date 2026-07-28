/**
 * Tenantonkénti Web-Egress materializáció (Access-Policy §agent-scope / „Platform-agentek",
 * issue #142).
 *
 * ÜZLETI JELENTÉS: eddig egyetlen, `tenantId = null` Web-Egress worker szolgálta ki az
 * összes tenantot, és a „`tenantId = null` minden tenantból elérhető" tool-kivétel miatt
 * bármely tenant bármely agentje elérte. Ez két bajt okozott:
 *  - egy tenant webes forgalma a MEGOSZTOTT connector kulcsán ment ki (nincs elszámolás,
 *    nincs tenant-szintű házirend);
 *  - a webes kimenet nem volt tudatos, tenant-admin által engedélyezett opt-in.
 *
 * A megoldás: minden tenant SAJÁT Web-Egress példányt kap, ami NORMÁL tenant-agent és
 * teljes gráfcsomópont, de provisioningkor `inboundRestricted = true` és
 * `outboundRestricted = true` — tehát alapból SENKI nem éri el. A tenant admin explicit
 * agent→Web-Egress `address` granttal engedélyezi, agentenként.
 *
 * A példány NEM jelenik meg az operátori katalógusban, a felelős-választóban és a
 * chat-indítóban (`isAdminOnlyGraphNode`), csak az org-ábrán és az admin kormányzási
 * felületen.
 */
import type { Agent } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  PROVISIONING_DISCOVER_CAPABILITIES,
  WEB_EGRESS_ROLE_TEMPLATE,
  WEB_EGRESS_TOOL_CAPABILITIES,
  WEB_RESEARCH_SERVE_CAPABILITIES,
} from '@/domain/agents/web-egress-role'
import { ensureTenantWebSearchConnector } from '@/domain/web-search/web-search-connector-service'

/** A tenant Web-Egress példányának capability-halmaza (deny-by-default → allowed). */
const TENANT_WEB_EGRESS_CAPABILITIES: string[] = [
  ...WEB_EGRESS_TOOL_CAPABILITIES,
  ...PROVISIONING_DISCOVER_CAPABILITIES,
  ...WEB_RESEARCH_SERVE_CAPABILITIES,
]

/**
 * A tenant Web-Egress agentje, ha már létezik. Névre keres a tenanton belül — a
 * platform-szintű (`tenantId = null`) példány NEM számít találatnak.
 */
export async function findTenantWebEgressAgent(tenantId: string): Promise<Agent | null> {
  return prisma.agent.findFirst({
    where: { tenantId, name: WEB_EGRESS_ROLE_TEMPLATE.name },
  })
}

/**
 * Idempotens materializáció. Létrehozza (vagy meglévőnél ellenőrzi) a tenant
 * Web-Egress agentjét a kötelező `inboundRestricted`/`outboundRestricted` alapértékkel,
 * a capability-sorokkal és a tenant web_search connector-bekötésével.
 *
 * FONTOS: meglévő példánynál NEM állítjuk vissza a restriction-kapcsolókat — ha a
 * tenant admin tudatosan lazított rajtuk, azt egy újrafutó provisioning nem írhatja
 * felül. Csak a hiányzó capability-ket és connector-kötést pótoljuk.
 */
export async function ensureTenantWebEgressAgent(params: {
  tenantId: string
  /** Az agent memóriájának első verzióját jóváhagyó user (audit-attribúció). */
  approvedById: string
}): Promise<Agent> {
  const existing = await findTenantWebEgressAgent(params.tenantId)
  if (existing) {
    await ensureCapabilities(existing.id)
    await ensureWebSearchLink(existing.id, params.tenantId)
    return existing
  }

  const t = WEB_EGRESS_ROLE_TEMPLATE
  const memory = await prisma.memory.create({ data: {} })
  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content:
        'Web-Egress Worker — capability-izolált agent; megbízhatatlan webtartalmat ADATKÉNT dolgoz fel.',
      status: 'active',
      source: 'provisioning',
      approvedById: params.approvedById,
    },
  })
  await prisma.memory.update({
    where: { id: memory.id },
    data: { currentVersionId: memoryVersion.id },
  })

  const modelConfig = { ...t.modelConfig }
  const agent = await prisma.agent.create({
    data: {
      name: t.name,
      roleInstruction: t.roleInstruction,
      behaviorProfile: t.behaviorProfile,
      behaviorProfileOverlay: t.behaviorProfile,
      modelConfig,
      status: 'active',
      role: t.role,
      tenantId: params.tenantId,
      // A gráf lényege: a webes kimenet ALAPBÓL zárt, mindkét irányban. A tenant admin
      // agentenként, explicit `address` granttal nyitja meg.
      inboundRestricted: true,
      outboundRestricted: true,
      // A napi operátori felületeken (katalógus, felelős-választó, chat-indító) nem
      // jelenhet meg: a webes kutatást agent kéri agenttől, nem ember címzi közvetlenül.
      hiddenFromOperators: true,
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: t.roleInstruction,
      behaviorProfileSnapshot: t.behaviorProfile,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: modelConfig,
      memoryVersionId: memoryVersion.id,
    },
  })

  await ensureCapabilities(agent.id)
  await ensureWebSearchLink(agent.id, params.tenantId)
  return agent
}

async function ensureCapabilities(agentId: string): Promise<void> {
  for (const toolName of TENANT_WEB_EGRESS_CAPABILITIES) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }
}

/**
 * A tenant SAJÁT web_search connectorára köti a példányt — így a webes forgalom a tenant
 * saját kulcsán és házirendjén megy ki, nem a megosztott platform-connectoron.
 */
async function ensureWebSearchLink(agentId: string, tenantId: string): Promise<void> {
  const connector = await ensureTenantWebSearchConnector(tenantId)
  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: connector.id } },
    create: { agentId, connectorId: connector.id, accessMode: 'read' },
    update: { accessMode: 'read' },
  })
}
