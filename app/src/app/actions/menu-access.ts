'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { allNavKeys } from '@/lib/control-plane-nav'
import {
  NAV_VISIBILITY_ROLES,
  readNavVisibilityPolicy,
  sanitizeNavVisibilityPolicy,
  withNavVisibilityPolicy,
  type NavVisibilityPolicy,
} from '@/lib/nav-visibility'
import { setNavVisibilitySchema } from '@/lib/validators/actions'
import { appendAuditInTransaction } from '@/repositories/postgres/audit-repository'
import { repositories } from '@/repositories/postgres'

/**
 * Menü-hozzáférés — szerepkörönkénti fejléc-menü kurálás (tenant admin).
 *
 * A `sanitizeNavVisibilityPolicy` a kizárási invariánst kényszeríti ki (az admin elől
 * nem rejthető el maga ez a szerkesztő), az ismeretlen kulcsok pedig kiesnek: a
 * mentett policy sosem hivatkozhat olyan menüpontra, ami már nem létezik.
 */

function dropUnknownKeys(policy: NavVisibilityPolicy): NavVisibilityPolicy {
  const known = new Set(allNavKeys())
  const next = sanitizeNavVisibilityPolicy(policy)
  for (const role of NAV_VISIBILITY_ROLES) {
    next[role] = next[role].filter((key) => known.has(key))
  }
  return next
}

export async function getNavVisibility() {
  try {
    const ctx = await requireTenantRole('admin')
    const tenant = await repositories.tenants.findById(ctx.activeTenantId!)
    return ok({ policy: dropUnknownKeys(readNavVisibilityPolicy(tenant?.settings)) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a menü-beállításokat')
  }
}

export async function setNavVisibility(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = setNavVisibilitySchema.parse(input)
    const policy = dropUnknownKeys(sanitizeNavVisibilityPolicy(parsed.policy))

    await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.activeTenantId },
        select: { settings: true },
      })
      const previous = readNavVisibilityPolicy(tenant?.settings)
      await tx.tenant.update({
        where: { id: ctx.activeTenantId },
        data: { settings: withNavVisibilityPolicy(tenant?.settings, policy) },
      })
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'tenant.nav_visibility.update',
        targetType: 'tenant',
        targetId: ctx.activeTenantId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'allowed',
        // A teljes előtte/utána állapot: a menü-kurálás vitatható döntés, az audit
        // sorból rekonstruálhatónak kell lennie, ki mit vett el melyik szerepkörtől.
        metadata: { previous, next: policy },
        tenantId: ctx.activeTenantId,
      })
    }, { timeout: 60_000 })

    return ok({ policy })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a menü-beállításokat')
  }
}
