import { getTranslations } from 'next-intl/server'
import type { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { miniAppHumanAccess } from '@/domain/mini-app/human-access'
import { buildAgentProductLinks, type AgentProductLink } from '@/lib/agent-product-links'
import { prisma } from '@/lib/db'
import { hasMinimumRole } from '@/lib/iam-policy'
import { isNavKeyHiddenFor, readNavVisibilityPolicy } from '@/lib/nav-visibility'
import { repositories } from '@/repositories/postgres'
import { listActiveMiniAppsForAgents } from '@/repositories/postgres/mini-app-repository'

type Ctx = Awaited<ReturnType<typeof requireTenantRole>>
type NamedApp = { id: string; name: string }
type OpenableWikis = Awaited<ReturnType<typeof services.wikiConsole.listOpenableAgentWikis>>

/** Az agentek saját és velük megosztott mini appjai, amelyeket a néző meg is nyithat. */
async function openableMiniApps(ctx: Ctx, agentIds: string[]): Promise<Map<string, NamedApp[]>> {
  const apps = await listActiveMiniAppsForAgents(ctx.activeTenantId, agentIds)
  const grants = new Map<string, Promise<{ accessLevel: string } | null>>()
  const deps = {
    findAgentGrant(input: { tenantId: string; userId: string; agentId: string }) {
      let grant = grants.get(input.agentId)
      if (!grant) {
        grant = repositories.resourceGrants.findAgentGrant(input)
        grants.set(input.agentId, grant)
      }
      return grant
    },
    listActiveShareAgentIds: async (appId: string) =>
      apps.find((app) => app.id === appId)?.activeShareAgentIds ?? [],
  }
  const viewer = { tenantId: ctx.activeTenantId, userId: ctx.user.id, role: ctx.activeTenantRole, assumed: ctx.assumed }
  const byAgent = new Map<string, NamedApp[]>()
  for (const app of apps) {
    if (!(await miniAppHumanAccess(deps, viewer, app))) continue
    for (const agentId of new Set([app.ownerAgentId, ...app.activeShareAgentIds])) {
      byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), { id: app.id, name: app.name }])
    }
  }
  return byAgent
}

/** Ugyanaz a kör, mint az Ütemezett feladatok oldalán: admin a szervezetét, más a sajátját látja. */
async function scheduledTaskCounts(ctx: Ctx, agentIds: string[]): Promise<Map<string, number>> {
  const rows = await prisma.scheduledTask.groupBy({
    by: ['agentId'],
    _count: { _all: true },
    where: {
      tenantId: ctx.activeTenantId,
      agentId: { in: agentIds },
      status: { not: 'archived' },
      ...(hasMinimumRole(ctx.activeTenantRole, 'admin')
        ? {}
        : { OR: [{ ownerUserId: ctx.user.id }, { members: { some: { userId: ctx.user.id } } }] }),
    },
  })
  return new Map(rows.map((row) => [row.agentId, row._count._all]))
}

async function latestWorkFileProjectKey(tenantId: string): Promise<string | undefined> {
  const latest = await prisma.workFile.findFirst({
    where: { tenantId },
    orderBy: { updatedAt: 'desc' },
    select: { projectKey: true },
  })
  return latest?.projectKey
}

/**
 * A munkatárs-dobozok gombjai. A gomb csak olyat mutat, amit a néző meg is nyithat; a menüben
 * elrejtett oldalra nem visz. Egy forrás hibája csak a saját gombját veszi el, a dobozt nem.
 */
export async function loadAgentProductLinks(
  ctx: Ctx,
  agents: ReadonlyArray<{ id: string; kind?: string }>,
): Promise<Record<string, AgentProductLink[]>> {
  const agentIds = agents.filter((agent) => agent.kind !== 'public').map((agent) => agent.id)
  if (agentIds.length === 0) return {}
  const fallback = <T,>(value: T) => (error: unknown) => {
    console.warn('[agent-product-links] source failed:', error instanceof Error ? error.message : error)
    return value
  }
  const tenant = await repositories.tenants.findById(ctx.activeTenantId)
  const policy = readNavVisibilityPolicy(tenant?.settings)
  const shows = (navKey: string) => !isNavKeyHiddenFor(policy, ctx.activeTenantRole, navKey)
  const actor = { userId: ctx.user.id, tenantId: ctx.activeTenantId, role: ctx.activeTenantRole, assumed: ctx.assumed }
  const [miniApps, wikis, workFileProject, taskCounts, t] = await Promise.all([
    openableMiniApps(ctx, agentIds).catch(fallback(new Map<string, NamedApp[]>())),
    shows('staff.knowledge')
      ? services.wikiConsole.listOpenableAgentWikis(actor, agentIds).catch(fallback<OpenableWikis>(new Map()))
      : (new Map() as OpenableWikis),
    shows('staff.projects') ? latestWorkFileProjectKey(ctx.activeTenantId).catch(fallback(undefined)) : undefined,
    shows('staff.scheduled-tasks')
      ? scheduledTaskCounts(ctx, agentIds).catch(fallback(new Map<string, number>()))
      : new Map<string, number>(),
    getTranslations('ControlPlane.agents.products'),
  ])
  return Object.fromEntries(
    agentIds.map((agentId) => [
      agentId,
      buildAgentProductLinks({
        agentId,
        miniApps: miniApps.get(agentId) ?? [],
        wikis: (wikis.get(agentId) ?? []).map((wiki) => ({
          connectorId: wiki.connectorId,
          name: wiki.kind === 'catalog' ? t('companyKnowledge') : wiki.name,
          hasPages: wiki.hasPages,
        })),
        latestWorkFileProjectKey: workFileProject,
        scheduledTaskCount: taskCounts.get(agentId) ?? 0,
      }),
    ]),
  )
}
