import type { Agent, Connector, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { upsertConnectorByTypeName } from '@/lib/connector-upsert'
import { toolsRequiringConnector } from '@/domain/tool-broker/tool-broker-authorizer'

export function knowledgeBaseConnectorName(agentId: string): string {
  return `kb:${agentId}`
}

export function knowledgeBaseDisplayName(agentName: string): string {
  return `${agentName} tudásbázis`
}

/** Az agent saját (kb:{agentId}) tudásbázis-connectora — megosztott linkeket nem ad vissza. */
export async function findOwnedKnowledgeBaseConnector(
  agent: Pick<Agent, 'id' | 'role'>,
  db: PrismaClient = prisma,
): Promise<Connector | null> {
  if (agent.role === 'orchestrator') return null

  const link = await db.agentConnector.findFirst({
    where: {
      agentId: agent.id,
      connector: { type: 'knowledge_base', name: knowledgeBaseConnectorName(agent.id) },
    },
    include: { connector: true },
  })
  return link?.connector ?? null
}

/**
 * Ensures a worker agent has a dedicated knowledge_base connector and kb_search capability.
 * Orchestrators are skipped — they remain tool-less by design.
 *
 * Mindig a saját kb:{agentId} connectort hozza létre / adja vissza. A régi, közös
 * (pl. „Excellence Pay belső tudásbázis”) linkek megmaradhatnak kb_search unióhoz,
 * de feltöltés / listázás / megosztás kizárólag a saját connectoron történik.
 */
export async function ensureAgentKnowledgeBase(
  agent: Pick<Agent, 'id' | 'name' | 'role'> & Partial<Pick<Agent, 'tenantId'>>,
  db: PrismaClient = prisma,
): Promise<Connector | null> {
  if (agent.role === 'orchestrator') return null

  const owned = await findOwnedKnowledgeBaseConnector(agent, db)
  if (owned) return owned

  // Determinisztikus név + upsert: párhuzamos hívásnál (agent-create, seed,
  // dokumentum-feldolgozás) sem dob unique-constraint hibát.
  const connector = await upsertConnectorByTypeName(db, {
    create: {
      type: 'knowledge_base',
      name: knowledgeBaseConnectorName(agent.id),
      scope: 'single',
      tenantId: agent.tenantId ?? null,
      config: {
        agentId: agent.id,
        displayName: knowledgeBaseDisplayName(agent.name),
        memoryBacked: true,
      },
    },
    update: {},
  })

  await db.agentConnector.upsert({
    where: { agentId_connectorId: { agentId: agent.id, connectorId: connector.id } },
    create: {
      agentId: agent.id,
      connectorId: connector.id,
      accessMode: 'read',
    },
    update: {},
  })

  // kb_search + a KB-v3 OKF-navigációs toolok (§9.2/§9.3): a keresés utáni
  // többkörös bejárás (kb_list_index → kb_get_page) elsődleges retrieval-út (D-I).
  for (const toolName of toolsRequiringConnector('knowledge_base')) {
    await db.capability.upsert({
      where: { agentId_toolName: { agentId: agent.id, toolName } },
      create: { agentId: agent.id, toolName, allowed: true },
      update: { allowed: true },
    })
  }

  return connector
}
