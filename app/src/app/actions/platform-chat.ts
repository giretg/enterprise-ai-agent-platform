'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePlatformRole, requireTenantRole } from '@/auth/tenant-context'
import { platformChatGatewayStore } from '@/auth/platform-chat-deps'
import { platformChatBudgetStatus } from '@/domain/platform-chat/gateway'
import { services } from '@/domain/gateway-services'
import { isPrivilegedAgentReader } from '@/domain/agent-definition'
import { isAvailableOnMcp } from '@/lib/agent-lifecycle'
import { prisma } from '@/lib/db'
import { loadOpenRouterTenantKey } from '@/lib/openrouter-tenant-key'
import {
  isValidPlatformChatBudget,
  readPlatformChatSettings,
  withPlatformChatSettings,
  type PlatformChatTenantSettings,
} from '@/lib/platform-chat-settings'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

export type PlatformChatAdminView = {
  settings: PlatformChatTenantSettings
  keyConfigured: boolean
  spentTodayUsd: number
}

async function keyConfigured(tenantId: string): Promise<boolean> {
  return Boolean((await loadOpenRouterTenantKey(tenantId))?.trim())
}

/** #1004 D2/D14: a Beállítások → Beszélgetés a platformon panel adatai. */
export async function getPlatformChatSettingsAction() {
  try {
    const ctx = await requireTenantRole('admin')
    const tenant = await repositories.tenants.findById(ctx.activeTenantId)
    const settings = readPlatformChatSettings(tenant?.settings)
    const [hasKey, budget] = await Promise.all([
      keyConfigured(ctx.activeTenantId),
      platformChatBudgetStatus({ store: platformChatGatewayStore }, { tenantId: ctx.activeTenantId, budgetUsd: settings.dailyBudgetUsd }),
    ])
    return ok<PlatformChatAdminView>({ settings, keyConfigured: hasKey, spentTodayUsd: budget.spentUsd })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'load_failed')
  }
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  dailyBudgetUsd: z.number().nullable(),
})

export async function setPlatformChatSettingsAction(input: z.input<typeof settingsSchema>) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = settingsSchema.parse(input)
    if (parsed.dailyBudgetUsd !== null && !isValidPlatformChatBudget(parsed.dailyBudgetUsd)) {
      return fail('A napi keret 0-nál nagyobb, legfeljebb 10 000 USD lehet.')
    }
    if (parsed.enabled) {
      if (!(await keyConfigured(ctx.activeTenantId))) {
        return fail('A bekapcsoláshoz előbb add meg a céges modell-kulcsot (Céges kulcsok).')
      }
      if (parsed.dailyBudgetUsd === null) return fail('A bekapcsoláshoz add meg a napi keretet.')
    }
    const { before, after } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: ctx.activeTenantId }, select: { settings: true } })
      const previous = readPlatformChatSettings(tenant?.settings)
      const nextSettings = withPlatformChatSettings(tenant?.settings, {
        enabled: parsed.enabled,
        dailyBudgetUsd: parsed.dailyBudgetUsd,
      })
      await tx.tenant.update({ where: { id: ctx.activeTenantId }, data: { settings: nextSettings } })
      return { before: previous, after: readPlatformChatSettings(nextSettings) }
    }, { timeout: 60_000 })
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'platform_setting.platform_chat_changed',
      targetType: 'tenant',
      targetId: ctx.activeTenantId,
      modelUsed: null,
      inputRef: String(before.enabled),
      outputRef: String(after.enabled),
      policyDecision: 'updated',
      metadata: {
        before: { enabled: before.enabled, dailyBudgetUsd: before.dailyBudgetUsd },
        after: { enabled: after.enabled, dailyBudgetUsd: after.dailyBudgetUsd },
      },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane', 'layout')
    return ok(after)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'save_failed')
  }
}

/** #1004 D3: agentenkénti „Elérhető a platform-chatben” kapcsoló. */
export async function setAgentPlatformChatAction(input: { agentId: string; enabled: boolean }) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = z.object({ agentId: z.string().uuid(), enabled: z.boolean() }).parse(input)
    const updated = await prisma.agent.updateMany({
      where: { id: parsed.agentId, tenantId: ctx.activeTenantId },
      data: { platformChatEnabled: parsed.enabled },
    })
    if (updated.count === 0) return fail('A munkatárs nem található.')
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'agent.platform_chat',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: String(parsed.enabled),
      policyDecision: 'updated',
      metadata: { enabled: parsed.enabled },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(`/control-plane/agents/${parsed.agentId}`)
    return ok({ enabled: parsed.enabled })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'save_failed')
  }
}

export type PlatformChatInsightRow = { tenantId: string; slug: string; displayName: string; chatEnabled: boolean; adminInsight: boolean }

/** #1004 D15: csak superadmin látja és állítja, tenantonként. */
export async function listPlatformChatInsightAction() {
  try {
    await requirePlatformRole('superadmin')
    const tenants = await prisma.tenant.findMany({
      select: { id: true, slug: true, displayName: true, settings: true },
      orderBy: { displayName: 'asc' },
    })
    return ok<PlatformChatInsightRow[]>(
      tenants.map((t) => {
        const s = readPlatformChatSettings(t.settings)
        return { tenantId: t.id, slug: t.slug, displayName: t.displayName, chatEnabled: s.enabled, adminInsight: s.adminInsight }
      }),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'load_failed')
  }
}

export async function setPlatformChatAdminInsightAction(input: { tenantId: string; enabled: boolean }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = z.object({ tenantId: z.string().uuid(), enabled: z.boolean() }).parse(input)
    const before = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: parsed.tenantId }, select: { settings: true } })
      if (!tenant) return null
      await tx.tenant.update({
        where: { id: parsed.tenantId },
        data: { settings: withPlatformChatSettings(tenant.settings, { adminInsight: parsed.enabled }) },
      })
      return readPlatformChatSettings(tenant.settings).adminInsight
    }, { timeout: 60_000 })
    if (before === null) return fail('A cég nem található.')
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'platform_setting.platform_chat_admin_insight',
      targetType: 'tenant',
      targetId: parsed.tenantId,
      modelUsed: null,
      inputRef: String(before),
      outputRef: String(parsed.enabled),
      policyDecision: 'updated',
      metadata: { before, after: parsed.enabled },
      tenantId: parsed.tenantId,
    })
    revalidatePath('/control-plane/platform/tenants')
    return ok({ adminInsight: parsed.enabled })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'save_failed')
  }
}

/** A fejléc Chat gombja: csak bekapcsolt tenantnál és legalább egy elérhető munkatárssal (#1004 §2). */
export async function getPlatformChatAvailabilityAction() {
  try {
    const ctx = await requireTenantRole('viewer')
    const tenant = await repositories.tenants.findById(ctx.activeTenantId)
    if (!readPlatformChatSettings(tenant?.settings).enabled) return ok({ available: false })
    const agents = (await repositories.agents.findMany({ tenantId: ctx.activeTenantId, unbounded: true }))
      .filter(isAvailableOnMcp)
      .filter((a) => a.platformChatEnabled)
    if (agents.length === 0) return ok({ available: false })
    if (isPrivilegedAgentReader(ctx.activeTenantRole)) return ok({ available: true })
    const granted = new Set(
      await repositories.resourceGrants.listAgentIdsGrantedToUser({ tenantId: ctx.activeTenantId, userId: ctx.user.id }),
    )
    return ok({ available: agents.some((a) => granted.has(a.id)) })
  } catch {
    return ok({ available: false })
  }
}
