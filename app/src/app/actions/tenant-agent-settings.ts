'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { envProviderRegistry } from '@/domain/model-gateway/proxy'
import {
  HIRE_DRAFT_AUDIT_ACTION,
  HIRE_DRAFT_COUNTED_DECISION,
  hireDraftQuota,
  suggestHireDraft,
  type HireDraftDeps,
} from '@/domain/agent-hire-draft'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  readTenantAutonomyCeiling,
  withTenantAutonomyCeiling,
} from '@/lib/agent-autonomy'
import { readHireDraftDailyLimit, withHireDraftDailyLimit } from '@/lib/agent-hire-draft'
import {
  setHireDraftDailyLimitSchema,
  setTenantAutonomyCeilingSchema,
  suggestHireDraftSchema,
} from '@/lib/validators/actions'
import { repositories } from '@/repositories/postgres'

/**
 * #957: céges beállítások az AI-munkatársakhoz.
 * - D3: az önállóság felső korlátja (a csúszka és az adatlap ennél többet nem enged)
 * - D1: a „Mondd el” AI-vázlatok napi kerete
 */

async function readTenantSettings(tenantId: string) {
  return (await repositories.tenants.findById(tenantId))?.settings
}

async function updateTenantSettings(
  tenantId: string,
  update: (settings: unknown) => import('@prisma/client').Prisma.InputJsonValue,
): Promise<unknown> {
  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
    await tx.tenant.update({ where: { id: tenantId }, data: { settings: update(tenant?.settings) } })
    return tenant?.settings
  }, { timeout: 60_000 })
}

export async function getTenantAgentSettings() {
  try {
    const ctx = await requireTenantRole('viewer')
    const settings = await readTenantSettings(ctx.activeTenantId)
    return ok({
      autonomyCeiling: readTenantAutonomyCeiling(settings),
      hireDraftDailyLimit: readHireDraftDailyLimit(settings),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a beállításokat')
  }
}

export async function setTenantAutonomyCeiling(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = setTenantAutonomyCeilingSchema.parse(input)
    const before = await updateTenantSettings(ctx.activeTenantId, (settings) =>
      withTenantAutonomyCeiling(settings, parsed.ceiling),
    )
    const previous = readTenantAutonomyCeiling(before)
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'tenant.autonomy_ceiling',
      targetType: 'tenant',
      targetId: ctx.activeTenantId,
      modelUsed: null,
      inputRef: parsed.ceiling,
      outputRef: previous,
      policyDecision: 'updated',
      metadata: { ceiling: parsed.ceiling, previous },
      tenantId: ctx.activeTenantId,
    })
    return ok({ ceiling: parsed.ceiling })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni az önállósági korlátot')
  }
}

export async function setHireDraftDailyLimit(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = setHireDraftDailyLimitSchema.parse(input)
    await updateTenantSettings(ctx.activeTenantId, (settings) => withHireDraftDailyLimit(settings, parsed.limit))
    return ok({ limit: parsed.limit })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a napi keretet')
  }
}

function hireDraftDeps(): HireDraftDeps {
  return {
    readDailyLimit: async (tenantId) => readHireDraftDailyLimit(await readTenantSettings(tenantId)),
    countSince: ({ tenantId, since }) =>
      prisma.auditLog.count({
        where: {
          tenantId,
          action: HIRE_DRAFT_AUDIT_ACTION,
          policyDecision: HIRE_DRAFT_COUNTED_DECISION,
          createdAt: { gte: since },
        },
      }),
    getTenantPolicy: (tenantId) => services.platformSettings.getModelPolicy(tenantId),
    getGlobalFallbackChain: () => services.platformSettings.getFallbackChain(),
    providers: envProviderRegistry(),
    audit: services.audit,
  }
}

/** A varázsló kezdő képernyőjéhez: ma még hány javaslat kérhető. */
export async function getHireDraftQuota() {
  try {
    const ctx = await requireTenantRole('admin')
    return ok(await hireDraftQuota(hireDraftDeps(), ctx.activeTenantId))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a napi keretet')
  }
}

/**
 * „Mondd el egy-két mondatban”: a céges alapmodell vázlata. Semmit nem ment —
 * a javaslat a varázsló lépésein látható és átírható, és ugyanazokon a
 * mentési műveleteken megy át, mint a kézi kitöltés.
 */
export async function suggestHireDraftAction(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = suggestHireDraftSchema.parse(input)
    return ok(
      await suggestHireDraft(hireDraftDeps(), {
        tenantId: ctx.activeTenantId,
        userId: ctx.user.id,
        description: parsed.description,
        locale: parsed.locale,
      }),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült javaslatot készíteni')
  }
}
