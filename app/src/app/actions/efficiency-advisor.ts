'use server'

import type { Prisma } from '@prisma/client'
import { requireTenantRole } from '@/auth/tenant-context'
import {
  applyEfficiencyHintToModelConfig,
  type EfficiencyHintKind,
} from '@/domain/agent/efficiency-advisor'
import { EFFICIENCY_ADVISOR_UNDO_KEY } from '@/domain/agent/efficiency-advisor-query'
import { applyEfficiencyHintSchema } from '@/lib/validators/actions'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

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

    const updated = await repositories.agents.updateModelConfig({
      agentId: parsed.agentId,
      modelConfig: result.modelConfig as Prisma.JsonValue,
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
