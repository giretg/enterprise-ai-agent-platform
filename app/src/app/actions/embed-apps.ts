'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { prisma } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  isValidEmbedOrigin,
  readEmbedApps,
  slugifyAppName,
  uniqueEmbedAppSlug,
  withEmbedApps,
} from '@/lib/embed-apps'
import { addEmbedAppSchema, removeEmbedAppSchema } from '@/lib/validators/actions'
import { appendAuditInTransaction } from '@/repositories/postgres/audit-repository'

/**
 * Beágyazott agent-chat — „Beágyazó alkalmazások" allowlist (feature-spec #481, D7).
 * Tenant-admin szerkeszti; a lista maga a kapu (üres lista = a beágyazott chat zárva).
 */

export async function getEmbedApps() {
  try {
    const ctx = await requireTenantRole('admin')
    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.activeTenantId },
      select: { settings: true },
    })
    return ok({ apps: readEmbedApps(tenant?.settings) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a beágyazó alkalmazásokat')
  }
}

export async function addEmbedApp(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = addEmbedAppSchema.parse(input)
    if (!isValidEmbedOrigin(parsed.origin)) {
      return fail('Érvénytelen cím — https://cegneve.hu formátumban add meg, path és query nélkül.')
    }

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.activeTenantId },
        select: { settings: true },
      })
      const apps = readEmbedApps(tenant?.settings)
      const slug = uniqueEmbedAppSlug(apps, slugifyAppName(parsed.name))
      const next = [...apps, { slug, name: parsed.name, origin: parsed.origin }]
      await tx.tenant.update({
        where: { id: ctx.activeTenantId },
        data: { settings: withEmbedApps(tenant?.settings, next) },
      })
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'embed.app.changed',
        targetType: 'tenant',
        targetId: ctx.activeTenantId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'allowed',
        metadata: { change: 'create', slug, name: parsed.name, origin: parsed.origin },
        tenantId: ctx.activeTenantId,
      })
      return next
    }, { timeout: 60_000 })

    return ok({ apps: result })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült hozzáadni az alkalmazást')
  }
}

export async function removeEmbedApp(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = removeEmbedAppSchema.parse(input)

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.activeTenantId },
        select: { settings: true },
      })
      const apps = readEmbedApps(tenant?.settings)
      const next = apps.filter((a) => a.slug !== parsed.slug)
      if (next.length === apps.length) return apps
      await tx.tenant.update({
        where: { id: ctx.activeTenantId },
        data: { settings: withEmbedApps(tenant?.settings, next) },
      })
      await appendAuditInTransaction(tx, {
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'embed.app.changed',
        targetType: 'tenant',
        targetId: ctx.activeTenantId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'allowed',
        metadata: { change: 'delete', slug: parsed.slug },
        tenantId: ctx.activeTenantId,
      })
      return next
    }, { timeout: 60_000 })

    return ok({ apps: result })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült törölni az alkalmazást')
  }
}
