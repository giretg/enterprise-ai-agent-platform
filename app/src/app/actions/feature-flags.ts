'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePlatformRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

const ROLLOUTS_PATH = '/control-plane/platform/rollouts'
const GENERIC_ERROR = 'load_failed'

const flagKeySchema = z.string().min(1).max(120)

const changeSchema = z.object({
  key: flagKeySchema,
  expectedVersion: z.number().int().min(0),
  mode: z.enum(['off', 'selected', 'all']).optional(),
  tenantAccess: z
    .array(z.object({ tenantId: z.string().uuid(), access: z.enum(['included', 'excluded']).nullable() }))
    .max(5000)
    .optional(),
})

const applySchema = changeSchema.extend({ justification: z.string().max(2000) })

const extendSchema = z.object({
  key: flagKeySchema,
  expectedVersion: z.number().int().min(1),
  removeBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  justification: z.string().max(2000),
})

export async function listRolloutsAction() {
  try {
    await requirePlatformRole('platform_auditor')
    return ok(await services.featureFlags.list())
  } catch {
    return fail(GENERIC_ERROR)
  }
}

export async function getRolloutDetailAction(key: string) {
  try {
    await requirePlatformRole('platform_auditor')
    const detail = await services.featureFlags.detail(flagKeySchema.parse(key))
    if (!detail) return ok(null)
    const actorIds = [...new Set(detail.history.map((entry) => entry.actorId).filter((id): id is string => !!id))]
    const actors = actorIds.length > 0 ? await repositories.users.findManyByIds(actorIds) : []
    const actorNames = Object.fromEntries(actors.map((actor) => [actor.id, actor.name ?? actor.email]))
    return ok({ ...detail, actorNames })
  } catch {
    return fail(GENERIC_ERROR)
  }
}

export async function getRolloutTenantViewAction(tenantId: string | null) {
  try {
    await requirePlatformRole('platform_auditor')
    const tenants = await services.featureFlags.tenants()
    const selected = tenantId ? tenants.find((tenant) => tenant.id === tenantId) ?? null : null
    return ok({ tenants, selected, items: selected ? await services.featureFlags.tenantView(selected.id) : [] })
  } catch {
    return fail(GENERIC_ERROR)
  }
}

export async function previewRolloutChangeAction(input: z.infer<typeof changeSchema>) {
  try {
    const ctx = await requirePlatformRole('platform_operator')
    const parsed = changeSchema.parse(input)
    return ok(await services.featureFlags.preview({ ...parsed, actor: { id: ctx.user.id, platformRoles: ctx.platformRoles } }))
  } catch {
    return fail(GENERIC_ERROR)
  }
}

export async function applyRolloutChangeAction(input: z.infer<typeof applySchema>) {
  try {
    const ctx = await requirePlatformRole('platform_operator')
    const parsed = applySchema.parse(input)
    const result = await services.featureFlags.apply({
      ...parsed,
      actor: { id: ctx.user.id, platformRoles: ctx.platformRoles },
    })
    revalidatePath(ROLLOUTS_PATH, 'layout')
    return ok(result)
  } catch {
    return fail(GENERIC_ERROR)
  }
}

export async function extendRolloutDeadlineAction(input: z.infer<typeof extendSchema>) {
  try {
    const ctx = await requirePlatformRole('platform_operator')
    const parsed = extendSchema.parse(input)
    const removeBy = new Date(`${parsed.removeBy}T23:59:59Z`)
    if (Number.isNaN(removeBy.getTime())) return ok({ status: 'invalid_date' as const })
    const result = await services.featureFlags.extendDeadline({
      ...parsed,
      removeBy,
      actor: { id: ctx.user.id, platformRoles: ctx.platformRoles },
    })
    revalidatePath(ROLLOUTS_PATH, 'layout')
    return ok(result)
  } catch {
    return fail(GENERIC_ERROR)
  }
}
