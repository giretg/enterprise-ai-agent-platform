/**
 * Ember→agent kiinduló jogok — explicit grant mátrix.
 *
 * ÜZLETI MODELL: egy kolléga vagy láthat / megszólíthat egy agentet, vagy nem.
 * Nincs „alapból mindenkié” UI-állapot. A kiindulás: a tenant minden (pending/active)
 * tagja mindkét jogot megkapja minden normál (`systemRole: null`) tenant-agentre; az
 * admin ezután pipával vesz el. Rendszer-szerepű agentek (Web-Egress, Futás-elemző, …)
 * deny-by-default kimaradnak — hozzáférésüket a saját materializációjuk adja explicit
 * grantokkal. Kivétel csak a `DEFAULT_GRANTABLE_SYSTEM_ROLES` allowlistben nevesíthető.
 */
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES } from '@/lib/agent-access-graph'
import { DEFAULT_GRANTABLE_SYSTEM_ROLES } from '@/lib/platform-agent-registry'
import { appendAuditInTransaction } from '@/repositories/postgres/audit-repository'

export type MaterializeDefaultGrantsResult = {
  agentsRestricted: number
  grantsCreated: number
}

function grantableAgentWhere(tenantId: string, agentId?: string) {
  const base = {
    tenantId,
    ...(agentId ? { id: agentId } : {}),
  }
  if (DEFAULT_GRANTABLE_SYSTEM_ROLES.length === 0) {
    return { ...base, systemRole: null }
  }
  return {
    ...base,
    OR: [
      { systemRole: null },
      { systemRole: { in: [...DEFAULT_GRANTABLE_SYSTEM_ROLES] } },
    ],
  }
}

/**
 * Hiányzó user→agent élek létrehozása canView+canAddress=true értékkel, és az
 * érintett agentek `inboundRestricted=true` állítása. Meglévő éleket NEM módosít
 * (az admin szűkítése megmarad).
 */
export async function materializeDefaultUserAgentGrants(params: {
  tenantId: string
  actorUserId: string
  /** Csak egy új agenthez — pl. agent.create után. */
  agentId?: string
  /** Csak egy új userhez — pl. provision után. */
  userId?: string
}): Promise<MaterializeDefaultGrantsResult> {
  const { tenantId, actorUserId, agentId, userId } = params

  const [agents, members] = await Promise.all([
    prisma.agent.findMany({
      where: grantableAgentWhere(tenantId, agentId),
      select: { id: true, inboundRestricted: true },
    }),
    prisma.tenantMembership.findMany({
      where: {
        tenantId,
        status: { in: [...AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES] },
        ...(userId ? { userId } : {}),
        user: { status: { in: [...AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES] } },
      },
      select: { userId: true },
    }),
  ])

  if (agents.length === 0 || members.length === 0) {
    return { agentsRestricted: 0, grantsCreated: 0 }
  }

  // Új usernél ne írd felül a tenant összes agent restrictionjét — csak grantokat adj.
  // Restriction-állítás: új agent (agentId) vagy teljes tenant-szinkron (sem user, sem agent).
  const toRestrict =
    userId && !agentId
      ? []
      : agents.filter((a) => !a.inboundRestricted).map((a) => a.id)
  const existing = await prisma.agentAccessGrant.findMany({
    where: {
      tenantId,
      subjectType: 'user',
      subjectUserId: { in: members.map((m) => m.userId) },
      targetAgentId: { in: agents.map((a) => a.id) },
    },
    select: { subjectUserId: true, targetAgentId: true },
  })
  const have = new Set(existing.map((e) => `${e.subjectUserId}:${e.targetAgentId}`))

  const rows: Array<{
    id: string
    tenantId: string
    subjectType: 'user'
    subjectUserId: string
    subjectAgentId: null
    targetAgentId: string
    canView: boolean
    canAddress: boolean
    grantedById: string
  }> = []
  for (const member of members) {
    for (const agent of agents) {
      const key = `${member.userId}:${agent.id}`
      if (have.has(key)) continue
      rows.push({
        id: randomUUID(),
        tenantId,
        subjectType: 'user',
        subjectUserId: member.userId,
        subjectAgentId: null,
        targetAgentId: agent.id,
        canView: true,
        canAddress: true,
        grantedById: actorUserId,
      })
    }
  }

  if (toRestrict.length === 0 && rows.length === 0) {
    return { agentsRestricted: 0, grantsCreated: 0 }
  }

  await prisma.$transaction(
    async (tx) => {
      if (toRestrict.length > 0) {
        await tx.agent.updateMany({
          where: { id: { in: toRestrict } },
          data: { inboundRestricted: true },
        })
      }
      if (rows.length > 0) {
        await tx.agentAccessGrant.createMany({ data: rows, skipDuplicates: true })
      }
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: actorUserId,
        agentVersion: null,
        action: 'agent_access.default_grants.materialize',
        targetType: agentId ? 'agent' : userId ? 'user' : 'tenant',
        targetId: agentId ?? userId ?? tenantId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'materialized',
        tenantId,
        metadata: {
          agentsRestricted: toRestrict.length,
          grantsCreated: rows.length,
          agentId: agentId ?? null,
          userId: userId ?? null,
        },
      })
    },
    { timeout: 60_000 },
  )

  return { agentsRestricted: toRestrict.length, grantsCreated: rows.length }
}
