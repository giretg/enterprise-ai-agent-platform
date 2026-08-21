'use server'

import type { Prisma } from '@prisma/client'
import { requireTenantRole } from '@/auth/tenant-context'
import { efficiencyHintPatch, type EfficiencyPatternKind } from '@/domain/agent/efficiency-advisor'
import { EFFICIENCY_ADVISOR_UNDO_KEY } from '@/domain/agent/efficiency-advisor-query'
import { applyEfficiencyHintSchema } from '@/lib/validators/actions'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function previousValue(config: Record<string, unknown>, key: string): number | null {
  const raw = config[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

export async function applyEfficiencyHint(input: {
  agentId: string
  kind: Extract<EfficiencyPatternKind, 'repeated_reread' | 'context_bloat'>
  revert?: boolean
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = applyEfficiencyHintSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')

    const patch = efficiencyHintPatch(parsed.kind)
    if (!patch) return fail('Ehhez a mintához nincs kapcsoló')

    const current = asRecord(agent.modelConfig)
    const undoMap = asRecord(current[EFFICIENCY_ADVISOR_UNDO_KEY])
    const next = { ...current }
    let previousMeta: Record<string, unknown> = {}
    let nextMeta: Record<string, unknown> | null = patch

    if (parsed.revert) {
      const snapshot = asRecord(undoMap[parsed.kind])
      previousMeta = { ...snapshot }
      for (const key of Object.keys(patch)) {
        if (snapshot[key] === null || snapshot[key] === undefined) delete next[key]
        else next[key] = snapshot[key]
      }
      delete undoMap[parsed.kind]
      nextMeta = null
    } else {
      const existing = asRecord(undoMap[parsed.kind])
      const snapshot: Record<string, number | null> = { ...existing } as Record<string, number | null>
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in snapshot)) snapshot[key] = previousValue(current, key)
        next[key] = value
      }
      previousMeta = snapshot
      undoMap[parsed.kind] = snapshot
    }

    if (Object.keys(undoMap).length === 0) delete next[EFFICIENCY_ADVISOR_UNDO_KEY]
    else next[EFFICIENCY_ADVISOR_UNDO_KEY] = undoMap

    const updated = await repositories.agents.updateModelConfig({
      agentId: parsed.agentId,
      modelConfig: next as Prisma.JsonValue,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: updated.agentVersion,
      action: parsed.revert ? 'agent.efficiency_hint_reverted' : 'agent.efficiency_hint_applied',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: parsed.kind,
      outputRef: `v${updated.agentVersion}`,
      policyDecision: 'allowed',
      metadata: {
        kind: parsed.kind,
        revert: Boolean(parsed.revert),
        previous: previousMeta,
        next: nextMeta,
      } as Prisma.JsonValue,
    })

    return ok({ agentVersion: updated.agentVersion, kind: parsed.kind, reverted: Boolean(parsed.revert) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'A javaslat alkalmazása nem sikerült')
  }
}
