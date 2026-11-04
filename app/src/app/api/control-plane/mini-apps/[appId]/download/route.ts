import { requireTenantRole } from '@/auth/tenant-context'
import { serializeLiveData } from '@/domain/mini-app/data-binding'
import { buildMiniAppLiveDocument, withStaticMiniAppBar } from '@/domain/mini-app/frame'
import { miniAppHumanAccess } from '@/domain/mini-app/human-access'
import { checkLiveAccess, liveDeniedMessage, loadLiveData } from '@/domain/mini-app/live-data'
import { writeAudit } from '@/lib/audit/types'
import { miniAppLiveDeps } from '@/lib/mini-app-live'
import { repositories } from '@/repositories/postgres'

export const runtime = 'nodejs'

/**
 * #967 §5.3: letöltés .html-ként, a sávval statikus HTML-ként a `<body>` elején.
 * Bejelentkezett ember, minden letöltéskor hozzáférés-ellenőrzéssel.
 */
export async function GET(request: Request, context: { params: Promise<{ appId: string }> }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { appId } = await context.params
    if (!/^[0-9a-f-]{36}$/i.test(appId)) return new Response('Nem található.', { status: 404 })
    const app = await repositories.miniApps.findById(ctx.activeTenantId, appId)
    if (!app) return new Response('Nem található.', { status: 404 })
    const access = await miniAppHumanAccess(
      {
        findAgentGrant: (input) => repositories.resourceGrants.findAgentGrant(input),
        listActiveShareAgentIds: async (id) => (await repositories.miniApps.listActiveShares(id)).map((s) => s.agentId),
      },
      { tenantId: ctx.activeTenantId, userId: ctx.user.id, role: ctx.activeTenantRole, assumed: ctx.assumed },
      app,
    )
    if (!access) return new Response('Nem található.', { status: 404 })
    const requested = Number(new URL(request.url).searchParams.get('version') ?? app.currentVersion)
    const version = await repositories.miniApps.findVersion(app.id, Number.isInteger(requested) ? requested : app.currentVersion)
    if (!version) return new Response('Nem található.', { status: 404 })
    const owner = await repositories.agents.findById(app.ownerAgentId, app.tenantId)
    const bar = {
      name: app.name,
      createdAt: app.createdAt,
      versionCreatedAt: version.createdAt,
      ownerAgentName: owner?.name ?? 'AI munkatárs',
      version: version.version,
      currentVersion: app.currentVersion,
    }
    let html: string
    if (version.dataBindings.length > 0) {
      // #1083 §4.4: a letöltés pillanatának adata kerül a fájlba, a saját CSP-jével, és auditot ír.
      const access = await checkLiveAccess(miniAppLiveDeps, app, ctx.user.id)
      if (!access.ok) {
        await writeAudit(repositories.audit, {
          actorType: 'human',
          actorId: ctx.user.id,
          action: 'warehouse.export',
          targetType: 'mini_app',
          targetId: app.id,
          policyDecision: 'denied',
          metadata: { source: 'mini_app_download', version: version.version, deniedCode: access.code },
          tenantId: app.tenantId,
        })
        return new Response(liveDeniedMessage(access.code), { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
      }
      const live = await loadLiveData(miniAppLiveDeps, { app, userId: ctx.user.id, role: access.role, bindings: version.dataBindings, purpose: 'download' })
      const withBar = withStaticMiniAppBar(version.html, { ...bar, live: { ...live.bar, dataTakenAt: new Date() } })
      html = buildMiniAppLiveDocument(withBar, { dataJson: serializeLiveData(live.data), meta: true }).html
      await writeAudit(repositories.audit, {
        actorType: 'human',
        actorId: ctx.user.id,
        action: 'warehouse.export',
        targetType: 'mini_app',
        targetId: app.id,
        policyDecision: 'allowed',
        metadata: { source: 'mini_app_download', version: version.version, rows: live.rows, bindings: version.dataBindings.map(({ alias, queryId, queryVersion }) => ({ alias, queryId, queryVersion })) },
        tenantId: app.tenantId,
      })
    } else {
      html = withStaticMiniAppBar(version.html, bar)
    }
    const filename = `${app.name.replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || 'mini-app'}-v${version.version}.html`
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="mini-app-v${version.version}.html"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // Ha a böngésző mégis megjelenítené: hálózat és szkript nélkül, opaque originben.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      },
    })
  } catch {
    return new Response('Nem található.', { status: 404 })
  }
}
