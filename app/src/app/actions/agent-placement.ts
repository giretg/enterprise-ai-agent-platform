'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import {
  hasPlacementOverrides,
  parsePlacementOverrides,
  PLACEMENT_OVERRIDE_MAX,
  PLACEMENT_ROW_KEYS,
} from '@/lib/agent-knowledge-placement'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

const schema = z.object({
  agentId: z.string().uuid(),
  rows: z.record(z.enum(PLACEMENT_ROW_KEYS), z.string().max(PLACEMENT_OVERRIDE_MAX)),
})

/** A „hová mit ments” tábla agentenkénti felülírása — publikálás után lép életbe (snapshot.placementOverrides). */
export async function updateAgentPlacementOverridesAction(input: z.input<typeof schema>) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = schema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, ctx.activeTenantId)
    if (!existing) return fail('A munkatárs nem található.')
    const overrides = parsePlacementOverrides(parsed.rows)
    const updated = await repositories.agents.updatePlacementOverrides({
      agentId: parsed.agentId,
      placementOverrides: hasPlacementOverrides(overrides) ? overrides : null,
    })
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'agent.placement_overrides',
      targetType: 'agent',
      targetId: updated.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      metadata: {
        before: Object.keys(parsePlacementOverrides(existing.placementOverrides)),
        after: Object.keys(overrides),
      },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(`/control-plane/agents/${parsed.agentId}`)
    return ok({ placementOverrides: overrides })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a táblát')
  }
}
