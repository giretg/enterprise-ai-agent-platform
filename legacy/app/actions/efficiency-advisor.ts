'use server'

import type { Prisma } from '@prisma/client'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import {
  applyEfficiencyHintToModelConfig,
  EFFICIENCY_ADVISOR_DEFAULT_RANGE,
  parseEfficiencyAdvisorRange,
  type EfficiencyAdvisorRange,
  type EfficiencyHintKind,
} from '@/domain/agent/efficiency-advisor'
import {
  EFFICIENCY_ADVISOR_UNDO_KEY,
  loadEfficiencyAdvisorCard,
} from '@/domain/agent/efficiency-advisor-query'
import { isTenantAdmin, tenantUserSubject } from '@/domain/agent-access/tenant-user-subject'
import {
  applyEfficiencyHintSchema,
  getEfficiencyAdvisorCardSchema,
} from '@/lib/validators/actions'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'
import { mergeRunAnalystLoopGuardModelConfig } from '@/domain/agents/run-analyst-role'

/**
 * EFF-10 — hatékonysági kártya betöltése.
 * Megtekintés: ugyanaz a `view` gráf-szabály, mint az agent adatlapé (#142).
 */
export async function getEfficiencyAdvisorCard(input: {
  agentId: string
  range?: EfficiencyAdvisorRange
}) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = getEfficiencyAdvisorCardSchema.parse(input)
    const range = parseEfficiencyAdvisorRange(parsed.range ?? EFFICIENCY_ADVISOR_DEFAULT_RANGE)

    const subject = tenantUserSubject(user)
    if (!subject) return fail('Agent not found')

    const decision = await services.agentAccess.canAccessAgent(subject, parsed.agentId, 'view', {
      subjectIsTenantAdmin: isTenantAdmin(user),
    })
    if (!decision.allowed) return fail('Agent not found')

    const detail = await repositories.agents.findByIdForDisplay(parsed.agentId, user.activeTenantId)
    if (!detail) return fail('Agent not found')

    const view = await loadEfficiencyAdvisorCard({
      agentId: parsed.agentId,
      tenantId: user.activeTenantId,
      range,
    })
    return ok(view)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'A hatékonysági kártya nem tölthető be')
  }
}

/**
 * EFF-12 — egy kattintásos hatékonysági javaslat alkalmazása / visszavonása.
 *
 * Jogosultság: tenant admin (a `taskOnly` / `hiddenFromOperators` mintájára).
 * Minden váltás AuditLog-ba kerül a régi és az új értékkel.
 */
export async function applyEfficiencyHint(input: {
  agentId: string
  kind: EfficiencyHintKind
  revert?: boolean
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = applyEfficiencyHintSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')

    const result = applyEfficiencyHintToModelConfig({
      modelConfig: agent.modelConfig,
      kind: parsed.kind,
      revert: parsed.revert,
      undoKey: EFFICIENCY_ADVISOR_UNDO_KEY,
    })

    const nextModelConfig =
      agent.systemRole === 'run_analyst'
        ? mergeRunAnalystLoopGuardModelConfig(result.modelConfig)
        : result.modelConfig

    const updated = await repositories.agents.updateModelConfig({
      agentId: parsed.agentId,
      modelConfig: nextModelConfig as Prisma.JsonValue,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: updated.agentVersion,
      action: result.reverted ? 'agent.efficiency_hint_reverted' : 'agent.efficiency_hint_applied',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: parsed.kind,
      outputRef: `v${updated.agentVersion}`,
      policyDecision: 'allowed',
      metadata: {
        kind: parsed.kind,
        revert: result.reverted,
        previous: result.previous,
        next: result.next,
      } as Prisma.JsonValue,
    })

    return ok({
      agentVersion: updated.agentVersion,
      kind: parsed.kind,
      reverted: result.reverted,
      previous: result.previous,
      next: result.next,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'A javaslat alkalmazása nem sikerült')
  }
}
