/**
 * DB-regressziós tesztek tenant-fixture takarítása.
 * A tenant törlése nem cascade-el mindent — explicit sorrend kell.
 */
import type { PrismaClient } from '@prisma/client'

/** Ismert teszt-slug minták (egyszeri takarító scripthez). */
export const TEST_TENANT_SLUG_PATTERNS: RegExp[] = [
  /^ra-[0-9a-f]{8}$/,
  /^ra-iso-a-[0-9a-f]{8}$/,
  /^ra-iso-b-[0-9a-f]{8}$/,
  /^duag-[0-9a-f]{8}$/,
  /^t-a-[0-9a-f]{8}$/,
  /^t-b-[0-9a-f]{8}$/,
  /^smap-[0-9a-f]{8}$/,
  /^val-shred-[0-9a-f]{8}$/,
  /^apg08-a-[0-9a-f]{8}$/,
  /^apg08-b-[0-9a-f]{8}$/,
  /^agent-turn-test-[0-9a-f-]{36}$/,
]

export function isKnownTestTenantSlug(slug: string): boolean {
  return TEST_TENANT_SLUG_PATTERNS.some((pattern) => pattern.test(slug))
}

export async function deleteTestTenants(
  prisma: PrismaClient,
  tenantIds: string[],
): Promise<void> {
  const ids = [...new Set(tenantIds.filter(Boolean))]
  if (ids.length === 0) return

  const agents = await prisma.agent.findMany({
    where: { tenantId: { in: ids } },
    select: { id: true, memoryId: true },
  })
  const agentIds = agents.map((a) => a.id)
  const memoryIds = [...new Set(agents.map((a) => a.memoryId).filter(Boolean) as string[])]

  if (agentIds.length > 0) {
    await prisma.agentSkill.deleteMany({ where: { agentId: { in: agentIds } } })
    await prisma.capability.deleteMany({ where: { agentId: { in: agentIds } } })
    await prisma.modelCall.deleteMany({ where: { agentId: { in: agentIds } } })
    await prisma.toolCall.deleteMany({ where: { agentId: { in: agentIds } } })
  }

  const conversations = await prisma.conversation.findMany({
    where: { tenantId: { in: ids } },
    select: { id: true },
  })
  const conversationIds = conversations.map((c) => c.id)
  if (conversationIds.length > 0) {
    await prisma.agentTurn.deleteMany({ where: { conversationId: { in: conversationIds } } })
    await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } })
  }

  await prisma.conversation.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.ticket.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.processInstance.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.playbookVersionV2.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.playbookV2.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.agentAccessGrant.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.surrogateMap.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.conversationPrivacyKey.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.conversationObserveEntity.deleteMany({ where: { tenantId: { in: ids } } })

  if (agentIds.length > 0) {
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } })
  }

  if (memoryIds.length > 0) {
    await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: memoryIds } } })
    await prisma.memoryChunk.deleteMany({ where: { memoryId: { in: memoryIds } } })
    await prisma.memoryCandidate.deleteMany({ where: { memoryId: { in: memoryIds } } })
    await prisma.memory.deleteMany({ where: { id: { in: memoryIds } } })
  }

  const memberships = await prisma.tenantMembership.findMany({
    where: { tenantId: { in: ids } },
    select: { userId: true },
  })
  const directUsers = await prisma.user.findMany({
    where: { tenantId: { in: ids } },
    select: { id: true },
  })
  const userIds = [...new Set([...memberships.map((m) => m.userId), ...directUsers.map((u) => u.id)])]

  await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } })
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } })
}
