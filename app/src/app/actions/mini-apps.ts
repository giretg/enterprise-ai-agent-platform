'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { canReadPublishedAgent } from '@/domain/agent-definition'
import { services } from '@/domain/gateway-services'
import { miniAppHumanAccess, type MiniAppHumanAccess } from '@/domain/mini-app/human-access'
import { MINI_APP_GUIDE_MAX, type MiniAppListRow } from '@/domain/mini-app/mini-app-service'
import type { MiniAppRecord } from '@/domain/mini-app/types'
import { isDispatchable } from '@/lib/agent-lifecycle'
import { prisma } from '@/lib/db'
import {
  isMiniAppLinkTtl,
  MINI_APP_MAX_BYTES_CEILING,
  readMiniAppSettings,
  withMiniAppSettings,
  type MiniAppLinkTtl,
} from '@/lib/mini-app-settings'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'
import { listMiniAppsForAgentPage } from '@/repositories/postgres/mini-app-repository'

type Ctx = Awaited<ReturnType<typeof requireTenantRole>>

function viewer(ctx: Ctx) {
  return { tenantId: ctx.activeTenantId, userId: ctx.user.id, role: ctx.activeTenantRole, assumed: ctx.assumed }
}

const accessDeps = {
  findAgentGrant: (input: { tenantId: string; userId: string; agentId: string }) =>
    repositories.resourceGrants.findAgentGrant(input),
  listActiveShareAgentIds: async (appId: string) =>
    (await repositories.miniApps.listActiveShares(appId)).map((share) => share.agentId),
}

async function canViewAgent(ctx: Ctx, agentId: string): Promise<boolean> {
  const grant = await repositories.resourceGrants.findAgentGrant({ tenantId: ctx.activeTenantId, userId: ctx.user.id, agentId })
  return canReadPublishedAgent({ role: ctx.activeTenantRole, grant })
}

/** App + a hívó ember joga; idegen tenant / nincs jog → „nem található" (nem árulja el, hogy létezik). */
async function loadWithAccess(ctx: Ctx, appId: string, need: 'view' | 'manage'): Promise<{ app: MiniAppRecord; access: Exclude<MiniAppHumanAccess, null> } | null> {
  if (!z.string().uuid().safeParse(appId).success) return null
  const app = await repositories.miniApps.findById(ctx.activeTenantId, appId)
  if (!app) return null
  const access = await miniAppHumanAccess(accessDeps, viewer(ctx), app)
  if (!access || (need === 'manage' && access !== 'manage')) return null
  return { app, access }
}

/** A Control Plane a tulajdonos agent nevében kezeli az appot (a jog: operate a tulajdonoson). */
function ownerActor(ctx: Ctx, app: MiniAppRecord) {
  return { tenantId: ctx.activeTenantId, agentId: app.ownerAgentId, userId: ctx.user.id }
}

export type AgentMiniAppRow = MiniAppListRow & {
  canManage: boolean
  lintWarnings: string[]
  archivedAt: string | null
}

export async function listAgentMiniAppsAction(input: { agentId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const agentId = z.string().uuid().parse(input.agentId)
    if (!(await canViewAgent(ctx, agentId))) return fail('Nincs hozzáférésed ehhez a munkatárshoz.')
    const apps = await listMiniAppsForAgentPage(ctx.activeTenantId, agentId)
    const rows = await services.miniApps.service.describe(ctx.activeTenantId, apps, agentId)
    const settings = readMiniAppSettings((await repositories.tenants.findById(ctx.activeTenantId))?.settings)
    const enriched: AgentMiniAppRow[] = await Promise.all(
      rows.map(async (row, index) => {
        const app = apps[index]!
        const [access, current] = await Promise.all([
          miniAppHumanAccess(accessDeps, viewer(ctx), app),
          repositories.miniApps.findVersion(app.id, app.currentVersion),
        ])
        return {
          ...row,
          canManage: access === 'manage',
          lintWarnings: current?.lintWarnings ?? [],
          archivedAt: app.archivedAt?.toISOString() ?? null,
        }
      }),
    )
    return ok({
      own: enriched.filter((row) => row.relation === 'owner'),
      shared: enriched.filter((row) => row.relation === 'shared'),
      organization: enriched.filter((row) => row.relation === 'organization'),
      linkTtl: settings.linkTtl,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a mini appokat')
  }
}

export async function openMiniAppLinkAction(input: { appId: string; version?: number }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const loaded = await loadWithAccess(ctx, input.appId, 'view')
    if (!loaded || loaded.app.status !== 'active') return fail('A mini app nem található, vagy nincs hozzáférésed.')
    const version = await repositories.miniApps.findVersion(loaded.app.id, input.version ?? loaded.app.currentVersion)
    if (!version) return fail('Ez a verzió nem található.')
    const links = await services.miniApps.service.issueLinks(
      { tenantId: ctx.activeTenantId, userId: ctx.user.id },
      loaded.app,
      version,
    )
    return ok(links)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült megnyitni a mini appot')
  }
}

export async function listMiniAppVersionsAction(input: { appId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const loaded = await loadWithAccess(ctx, input.appId, 'view')
    if (!loaded) return fail('A mini app nem található, vagy nincs hozzáférésed.')
    const versions = await repositories.miniApps.listVersions(loaded.app.id)
    return ok({
      versions: versions.map((v) => ({
        version: v.version,
        createdAt: v.createdAt.toISOString(),
        byteSize: v.byteSize,
        changeNote: v.changeNote,
        lintWarnings: v.lintWarnings,
      })),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a verziókat')
  }
}

export async function getMiniAppSharesAction(input: { appId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const loaded = await loadWithAccess(ctx, input.appId, 'manage')
    if (!loaded) return fail('A megosztást csak az kezelheti, aki a készítő munkatársat működtetheti.')
    const shares = await repositories.miniApps.listActiveShares(loaded.app.id)
    const agents = await repositories.agents.findMany({ tenantId: ctx.activeTenantId, unbounded: true })
    const users = await Promise.all([...new Set(shares.map((s) => s.sharedByUserId))].map((id) => repositories.users.findById(id)))
    const userName = new Map(users.filter((u) => u !== null).map((u) => [u.id, u.name || u.email]))
    const visible = await Promise.all(
      agents
        .filter((agent) => agent.id !== loaded.app.ownerAgentId && isDispatchable(agent.status))
        .map(async (agent) => ((await canViewAgent(ctx, agent.id)) ? { id: agent.id, name: agent.name } : null)),
    )
    const agentName = new Map(agents.map((agent) => [agent.id, agent.name]))
    const settings = readMiniAppSettings((await repositories.tenants.findById(ctx.activeTenantId))?.settings)
    return ok({
      visibility: loaded.app.visibility,
      linkTtl: settings.linkTtl,
      shares: shares.map((share) => ({
        agentId: share.agentId,
        agentName: agentName.get(share.agentId) ?? 'ismeretlen munkatárs',
        sharedBy: userName.get(share.sharedByUserId) ?? 'ismeretlen',
        createdAt: share.createdAt.toISOString(),
      })),
      candidates: visible.filter((row) => row !== null),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a megosztásokat')
  }
}

const shareSchema = z.object({
  appId: z.string().uuid(),
  agentIds: z.array(z.string().uuid()).max(20).default([]),
  organization: z.boolean().default(false),
})

export async function shareMiniAppAction(input: z.input<typeof shareSchema>) {
  try {
    const ctx = await requireTenantRole('viewer')
    const parsed = shareSchema.parse(input)
    const loaded = await loadWithAccess(ctx, parsed.appId, 'manage')
    if (!loaded) return fail('A megosztást csak az kezelheti, aki a készítő munkatársat működtetheti.')
    const res = await services.miniApps.service.share(ownerActor(ctx, loaded.app), {
      appId: loaded.app.id,
      toAgentIds: parsed.agentIds,
      organization: parsed.organization,
      checkTarget: async (agentId) => {
        const agent = await repositories.agents.findById(agentId, ctx.activeTenantId)
        if (!agent || !isDispatchable(agent.status)) return 'not_visible'
        return (await canViewAgent(ctx, agentId)) ? 'ok' : 'not_visible'
      },
    })
    if (!res.ok) return fail(shareErrorText(res.code))
    revalidatePath(`/control-plane/agents/${loaded.app.ownerAgentId}`)
    return ok({ visibility: res.visibility })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült megosztani')
  }
}

export async function unshareMiniAppAction(input: z.input<typeof shareSchema>) {
  try {
    const ctx = await requireTenantRole('viewer')
    const parsed = shareSchema.parse(input)
    const loaded = await loadWithAccess(ctx, parsed.appId, 'manage')
    if (!loaded) return fail('A megosztást csak az kezelheti, aki a készítő munkatársat működtetheti.')
    const res = await services.miniApps.service.unshare(ownerActor(ctx, loaded.app), {
      appId: loaded.app.id,
      fromAgentIds: parsed.agentIds,
      organization: parsed.organization,
    })
    if (!res.ok) return fail(shareErrorText(res.code))
    revalidatePath(`/control-plane/agents/${loaded.app.ownerAgentId}`)
    return ok({ visibility: res.visibility })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült visszavonni a megosztást')
  }
}

export async function setMiniAppArchivedAction(input: { appId: string; archived: boolean }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const loaded = await loadWithAccess(ctx, input.appId, 'manage')
    if (!loaded) return fail('Archiválni csak az tud, aki a készítő munkatársat működtetheti.')
    const actor = ownerActor(ctx, loaded.app)
    const res = input.archived
      ? await services.miniApps.service.archive(actor, { appId: loaded.app.id, reason: 'control_plane' })
      : await services.miniApps.service.restore(actor, { appId: loaded.app.id })
    if (!res.ok) return fail('Nem sikerült módosítani a mini appot.')
    revalidatePath(`/control-plane/agents/${loaded.app.ownerAgentId}`)
    return ok({ archived: input.archived })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült módosítani a mini appot')
  }
}

function shareErrorText(code: string): string {
  if (code === 'share_target_not_visible') return 'Az egyik kiválasztott munkatárs nem elérhető, vagy nem látod.'
  if (code === 'share_target_required') return 'Válassz legalább egy munkatársat, vagy kapcsold be a szervezeti láthatóságot.'
  if (code === 'mini_app_archived') return 'Archivált mini appot nem lehet megosztani.'
  return 'Nem sikerült a megosztás.'
}

const guideSchema = z.object({ agentId: z.string().uuid(), guide: z.string().max(MINI_APP_GUIDE_MAX) })

/** #967 D12: az agent mini app útmutatója — publikálás után lép életbe (snapshot.miniAppGuide). */
export async function updateAgentMiniAppGuideAction(input: z.input<typeof guideSchema>) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = guideSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, ctx.activeTenantId)
    if (!existing) return fail('A munkatárs nem található.')
    const guide = parsed.guide.trim()
    const updated = await repositories.agents.updateMiniAppGuide({ agentId: parsed.agentId, miniAppGuide: guide })
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'agent.mini_app_guide',
      targetType: 'agent',
      targetId: updated.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      metadata: { beforeChars: existing.miniAppGuide.length, afterChars: guide.length },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(`/control-plane/agents/${parsed.agentId}`)
    return ok({ miniAppGuide: updated.miniAppGuide })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni az útmutatót')
  }
}

export async function getMiniAppSettingsAction() {
  try {
    const ctx = await requireTenantRole('viewer')
    const tenant = await repositories.tenants.findById(ctx.activeTenantId)
    return ok(readMiniAppSettings(tenant?.settings))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a mini app beállításokat')
  }
}

const settingsSchema = z.object({
  linkTtl: z.custom<MiniAppLinkTtl>((value) => isMiniAppLinkTtl(value)),
  maxBytes: z.number().int().min(64 * 1024).max(MINI_APP_MAX_BYTES_CEILING),
})

export async function setMiniAppSettingsAction(input: z.input<typeof settingsSchema>) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = settingsSchema.parse(input)
    const before = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: ctx.activeTenantId }, select: { settings: true } })
      const previous = readMiniAppSettings(tenant?.settings)
      await tx.tenant.update({
        where: { id: ctx.activeTenantId },
        data: { settings: withMiniAppSettings(tenant?.settings, parsed) },
      })
      return previous
    }, { timeout: 60_000 })
    if (before.linkTtl !== parsed.linkTtl || before.maxBytes !== parsed.maxBytes) {
      await services.audit.append({
        actorType: 'human',
        actorId: ctx.user.id,
        agentVersion: null,
        action: 'platform_setting.mini_app_link_ttl_changed',
        targetType: 'tenant',
        targetId: ctx.activeTenantId,
        modelUsed: null,
        inputRef: before.linkTtl,
        outputRef: parsed.linkTtl,
        policyDecision: 'updated',
        metadata: { before, after: parsed },
        tenantId: ctx.activeTenantId,
      })
    }
    return ok(parsed)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a mini app beállításokat')
  }
}
