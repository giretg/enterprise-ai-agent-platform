'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  readTenantLanguage,
  withTenantLanguage,
} from '@/lib/tenant-language'
import { setTenantLanguageSchema } from '@/lib/validators/actions'
import { repositories } from '@/repositories/postgres'

export async function getTenantLanguage() {
  try {
    const ctx = await requireTenantRole('viewer')
    const tenant = await repositories.tenants.findById(ctx.activeTenantId!)
    return ok({ language: readTenantLanguage(tenant?.settings) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a tenant nyelvét')
  }
}

export async function setTenantLanguage(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = setTenantLanguageSchema.parse(input)
    await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.activeTenantId },
        select: { settings: true },
      })
      await tx.tenant.update({
        where: { id: ctx.activeTenantId },
        data: { settings: withTenantLanguage(tenant?.settings, parsed.language) },
      })
    }, { timeout: 60_000 })
    return ok({ language: parsed.language })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a tenant nyelvét')
  }
}
