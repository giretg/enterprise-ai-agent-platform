'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { prisma } from '@/lib/db'
import { readTenantMcpIntro, withTenantMcpIntro } from '@/lib/mcp-tenant-context'
import { fail, ok } from '@/lib/result'
import { setTenantMcpIntroSchema } from '@/lib/validators/actions'
import { repositories } from '@/repositories/postgres'

export async function getTenantMcpIntro() {
  try {
    const ctx = await requireTenantRole('viewer')
    const tenant = await repositories.tenants.findById(ctx.activeTenantId!)
    return ok({ mcpIntro: readTenantMcpIntro(tenant?.settings) ?? '' })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni az MCP bemutatkozót')
  }
}

export async function setTenantMcpIntro(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = setTenantMcpIntroSchema.parse(input)
    await prisma.$transaction(async (tx) => {
      const row = await tx.tenant.findUnique({
        where: { id: ctx.activeTenantId },
        select: { settings: true },
      })
      await tx.tenant.update({
        where: { id: ctx.activeTenantId },
        data: { settings: withTenantMcpIntro(row?.settings, parsed.mcpIntro) },
      })
    }, { timeout: 60_000 })
    return ok({ mcpIntro: parsed.mcpIntro.trim() })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni az MCP bemutatkozót')
  }
}
