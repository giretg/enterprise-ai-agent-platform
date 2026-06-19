import type { Agent, Connector, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'

export function knowledgeBaseConnectorName(agentId: string): string {
  return `kb:${agentId}`
}

export function knowledgeBaseDisplayName(agentName: string): string {
  return `${agentName} tudásbázis`
}

/**
 * Ensures a worker agent has a dedicated knowledge_base connector and kb_search capability.
 * Orchestrators are skipped — they remain tool-less by design.
 */
export async function ensureAgentKnowledgeBase(
  agent: Pick<Agent, 'id' | 'name' | 'role'>,
  db: PrismaClient = prisma,
): Promise<Connector | null> {
  if (agent.role === 'orchestrator') return null

  // Egy meglévő KB-kötés (akár a régi megosztott connector) elsőbbséget élvez,
  // így a megosztott modell (many-to-many, §4.9.1) megmarad.
  const existingLink = await db.agentConnector.findFirst({
    where: {
      agentId: agent.id,
      connector: { type: 'knowledge_base' },
    },
    include: { connector: true },
  })
  if (existingLink) return existingLink.connector

  // Determinisztikus név + upsert: párhuzamos hívásnál (agent-create, seed,
  // dokumentum-feldolgozás) sem dob unique-constraint hibát.
  const connector = await db.connector.upsert({
    where: {
      type_name: { type: 'knowledge_base', name: knowledgeBaseConnectorName(agent.id) },
    },
    create: {
      type: 'knowledge_base',
      name: knowledgeBaseConnectorName(agent.id),
      scope: 'single',
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

  await db.capability.upsert({
    where: { agentId_toolName: { agentId: agent.id, toolName: 'kb_search' } },
    create: { agentId: agent.id, toolName: 'kb_search', allowed: true },
    update: { allowed: true },
  })

  return connector
}
