/**
 * Agent-hozzáférési gráf él-tára (Access-Policy §agent-scope, issue #142).
 *
 * Két dolgot GARANTÁL, amit a hívó nem tud:
 *  1. a cross-table tenant-invariáns tranzakciós ellenőrzését (ezt PostgreSQL `CHECK`
 *     nem tudja kifejezni: a subject membershipje / a subject-agent és a target-agent
 *     tenantja három különböző tábla);
 *  2. hogy az él-írás és az audit-esemény UGYANABBAN a tranzakcióban történik — nincs
 *     olyan állapot, ahol a policy megváltozott, de nyoma nincs.
 *
 * Fail-closed: bármelyik invariáns sérül → nem jön létre él, és nem keletkezik audit.
 */
import { Prisma } from '@prisma/client'
import type { AgentAccessGrant } from '@prisma/client'
import { AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES } from '@/lib/agent-access-graph'
import { prisma } from '@/lib/db'
import type {
  AgentAccessGrantDeleteResult,
  AgentAccessGrantKey,
  AgentAccessGrantRepository,
  AgentAccessGrantWriteResult,
  UpsertAgentAccessGrantInput,
} from '../interfaces'
import { appendAuditInTransaction } from './audit-repository'

/**
 * A subject-oszlopok szűrője. A `subjectType` diszkriminál: `user` alanynál a
 * user-oszlopra szűrünk ÉS az agent-oszlop null, `agent` alanynál fordítva. Így egy
 * user-alanyú lekérdezés sosem talál rá egy agent-alanyú sorra (és viszont).
 */
function subjectWhere(key: Omit<AgentAccessGrantKey, 'targetAgentId'>): Prisma.AgentAccessGrantWhereInput {
  return key.subjectType === 'user'
    ? { subjectType: 'user', subjectUserId: key.subjectUserId ?? '__missing__', subjectAgentId: null }
    : { subjectType: 'agent', subjectAgentId: key.subjectAgentId ?? '__missing__', subjectUserId: null }
}

function edgeWhere(key: AgentAccessGrantKey): Prisma.AgentAccessGrantWhereInput {
  return {
    tenantId: key.tenantId,
    targetAgentId: key.targetAgentId,
    ...subjectWhere(key),
  }
}

export class PostgresAgentAccessGrantRepository implements AgentAccessGrantRepository {
  async findEdge(key: AgentAccessGrantKey): Promise<AgentAccessGrant | null> {
    // A UUID-alakot a hívó validálja; a `__missing__` szentinel csak azért van, hogy
    // egy hiányzó subject-id ne szűrés NÉLKÜLI (fail-open) lekérdezést eredményezzen.
    if (key.subjectType === 'user' && !key.subjectUserId) return null
    if (key.subjectType === 'agent' && !key.subjectAgentId) return null
    return prisma.agentAccessGrant.findFirst({ where: edgeWhere(key) })
  }

  async listBySubject(key: Omit<AgentAccessGrantKey, 'targetAgentId'>): Promise<AgentAccessGrant[]> {
    if (key.subjectType === 'user' && !key.subjectUserId) return []
    if (key.subjectType === 'agent' && !key.subjectAgentId) return []
    return prisma.agentAccessGrant.findMany({
      where: { tenantId: key.tenantId, ...subjectWhere(key) },
    })
  }

  async listByTarget(tenantId: string, targetAgentId: string): Promise<AgentAccessGrant[]> {
    return prisma.agentAccessGrant.findMany({ where: { tenantId, targetAgentId } })
  }

  async listAgentEdgesForTenant(tenantId: string): Promise<AgentAccessGrant[]> {
    return prisma.agentAccessGrant.findMany({
      where: { tenantId, subjectType: 'agent', subjectAgentId: { not: null } },
    })
  }

  async listForTenant(tenantId: string): Promise<AgentAccessGrant[]> {
    return prisma.agentAccessGrant.findMany({
      where: { tenantId },
      orderBy: { grantedAt: 'asc' },
    })
  }

  async upsertEdge(input: UpsertAgentAccessGrantInput): Promise<AgentAccessGrantWriteResult> {
    if (!input.canView && !input.canAddress) return { ok: false, reason: 'no_verb' }
    if (input.subjectType === 'user' && !input.subjectUserId) {
      return { ok: false, reason: 'subject_not_in_tenant' }
    }
    if (input.subjectType === 'agent' && !input.subjectAgentId) {
      return { ok: false, reason: 'subject_not_in_tenant' }
    }
    if (input.subjectType === 'agent' && input.subjectAgentId === input.targetAgentId) {
      return { ok: false, reason: 'self_edge' }
    }

    return prisma.$transaction(async (tx) => {
      // Cross-table tenant-invariáns (I7). A cél MINDIG a grant tenantjában van;
      // user alanynál érvényes (active VAGY pending — első belépés előtt előkészített)
      // tagság kell, agent alanynál egyező agent-tenant.
      const target = await tx.agent.findUnique({
        where: { id: input.targetAgentId },
        select: { tenantId: true },
      })
      if (!target || target.tenantId !== input.tenantId) {
        return { ok: false as const, reason: 'target_not_in_tenant' as const }
      }

      if (input.subjectType === 'user') {
        const membership = await tx.tenantMembership.findFirst({
          where: {
            tenantId: input.tenantId,
            userId: input.subjectUserId!,
            status: { in: [...AGENT_ACCESS_SUBJECT_MEMBERSHIP_STATUSES] },
          },
          select: { id: true },
        })
        if (!membership) return { ok: false as const, reason: 'subject_not_in_tenant' as const }
      } else {
        const source = await tx.agent.findUnique({
          where: { id: input.subjectAgentId! },
          select: { tenantId: true },
        })
        if (!source || source.tenantId !== input.tenantId) {
          return { ok: false as const, reason: 'subject_not_in_tenant' as const }
        }
      }

      const existing = await tx.agentAccessGrant.findFirst({ where: edgeWhere(input) })
      const previous = existing ? { canView: existing.canView, canAddress: existing.canAddress } : null

      const grant = existing
        ? await tx.agentAccessGrant.update({
            where: { id: existing.id },
            data: { canView: input.canView, canAddress: input.canAddress },
          })
        : await tx.agentAccessGrant.create({
            data: {
              tenantId: input.tenantId,
              subjectType: input.subjectType,
              subjectUserId: input.subjectType === 'user' ? input.subjectUserId! : null,
              subjectAgentId: input.subjectType === 'agent' ? input.subjectAgentId! : null,
              targetAgentId: input.targetAgentId,
              canView: input.canView,
              canAddress: input.canAddress,
              grantedById: input.grantedById,
            },
          })

      await appendAuditInTransaction(
        tx,
        input.buildAudit({
          grantId: grant.id,
          previous,
          next: { canView: grant.canView, canAddress: grant.canAddress },
        }),
      )

      return { ok: true as const, grant, previous }
    }, { timeout: 60_000 })
  }

  async deleteEdge(
    key: AgentAccessGrantKey & { buildAudit: UpsertAgentAccessGrantInput['buildAudit'] },
  ): Promise<AgentAccessGrantDeleteResult> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.agentAccessGrant.findFirst({ where: edgeWhere(key) })
      if (!existing) return { ok: false as const, reason: 'not_found' as const }

      await tx.agentAccessGrant.delete({ where: { id: existing.id } })
      await appendAuditInTransaction(
        tx,
        key.buildAudit({
          grantId: existing.id,
          previous: { canView: existing.canView, canAddress: existing.canAddress },
          next: { canView: false, canAddress: false },
        }),
      )

      return {
        ok: true as const,
        grantId: existing.id,
        previous: { canView: existing.canView, canAddress: existing.canAddress },
      }
    }, { timeout: 60_000 })
  }
}
