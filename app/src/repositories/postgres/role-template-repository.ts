import type { AgentRole, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'

/**
 * Konfigurálható szerep-sablon repository (Feature-spec §3.5).
 *
 * A két beépített sablon (worker | orchestrator) rendszer-szintű (tenant_id NULL).
 * A tenant-specifikus felülírás támogatott: `findByKey` a tenant-sajátot részesíti
 * előnyben, és a rendszer-szintűre esik vissza. A sablon `toolAccessAllowed` mezője
 * a Tool Broker tool-less invariánsának adat-forrása (§6).
 */
export class PostgresRoleTemplateRepository {
  async findByKey(key: AgentRole, tenantId: string | null = null) {
    const templates = await prisma.roleTemplate.findMany({
      where: { key, OR: [{ tenantId }, { tenantId: null }] },
    })
    // tenant-saját felülírja a rendszer-szintűt (NULL)
    return templates.find((t) => t.tenantId === tenantId) ?? templates.find((t) => t.tenantId === null) ?? null
  }

  async findMany(tenantId: string | null = null) {
    return prisma.roleTemplate.findMany({
      where: { OR: [{ tenantId }, { tenantId: null }] },
      orderBy: [{ key: 'asc' }],
    })
  }
}

/** A két beépített rendszer-sablon definíciója (§3.5 invariánsok). */
export const SYSTEM_ROLE_TEMPLATES: Array<{
  key: AgentRole
  displayName: string
  toolAccessAllowed: boolean
  allowedOutbound: string[]
  selfEvolutionAllowed: boolean
}> = [
  {
    key: 'worker',
    displayName: 'Végrehajtó',
    toolAccessAllowed: true,
    allowedOutbound: ['*'],
    selfEvolutionAllowed: true,
  },
  {
    key: 'orchestrator',
    displayName: 'Koordinátor',
    // Tool-less by design (§4.5.1): a Tool Broker minden eszközhívást megtagad,
    // az egyetlen kimenő művelet a ticket-nyitás (delegálás).
    toolAccessAllowed: false,
    allowedOutbound: ['ticket:create'],
    selfEvolutionAllowed: true,
  },
]

/**
 * Idempotens: létrehozza a hiányzó rendszer-szintű (tenant_id NULL) sablonokat.
 * A meglévő sablonok flag-jeit a kanonikus invariánsokra igazítja (önjavítás),
 * hogy egy elrontott `tool_access_allowed` ne nyithassa fel az orchestratort.
 */
export async function ensureSystemRoleTemplates(
  client: Pick<PrismaClient, 'roleTemplate'> = prisma,
) {
  for (const tpl of SYSTEM_ROLE_TEMPLATES) {
    const existing = await client.roleTemplate.findFirst({
      where: { key: tpl.key, tenantId: null },
    })
    if (existing) {
      await client.roleTemplate.update({
        where: { id: existing.id },
        data: {
          displayName: tpl.displayName,
          toolAccessAllowed: tpl.toolAccessAllowed,
          allowedOutbound: tpl.allowedOutbound,
          selfEvolutionAllowed: tpl.selfEvolutionAllowed,
        },
      })
    } else {
      await client.roleTemplate.create({
        data: {
          tenantId: null,
          key: tpl.key,
          displayName: tpl.displayName,
          toolAccessAllowed: tpl.toolAccessAllowed,
          allowedOutbound: tpl.allowedOutbound,
          selfEvolutionAllowed: tpl.selfEvolutionAllowed,
        },
      })
    }
  }
}
