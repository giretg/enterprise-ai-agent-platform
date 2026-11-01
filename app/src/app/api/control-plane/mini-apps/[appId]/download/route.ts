import { requireTenantRole } from '@/auth/tenant-context'
import { withStaticMiniAppBar } from '@/domain/mini-app/frame'
import { miniAppHumanAccess } from '@/domain/mini-app/human-access'
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
    const html = withStaticMiniAppBar(version.html, {
      name: app.name,
      createdAt: app.createdAt,
      versionCreatedAt: version.createdAt,
      ownerAgentName: owner?.name ?? 'AI munkatárs',
      version: version.version,
      currentVersion: app.currentVersion,
    })
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
