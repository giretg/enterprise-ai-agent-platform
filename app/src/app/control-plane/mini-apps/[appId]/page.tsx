import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import type { MiniAppDataBinding } from '@/domain/mini-app/data-binding'
import { formatMiniAppTime } from '@/domain/mini-app/frame'
import { miniAppHumanAccess } from '@/domain/mini-app/human-access'
import type { WarehouseActor } from '@/domain/warehouse/warehouse-service'
import { Card } from '@/components/ui/shell'
import { warehouseService } from '@/lib/warehouse'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'

type LiveQuery = { alias: string; name: string | null; version: number; currentVersion: number | null; lastLoadAt: string | null }

/** Mely mentett lekérdezésekből dolgozik az app; a nem elérhető lekérdezés sor marad, név nélkül. */
async function describeLiveQueries(actor: WarehouseActor, bindings: MiniAppDataBinding[]): Promise<LiveQuery[]> {
  return Promise.all(
    bindings.map(async (binding) => {
      const found = await warehouseService().getSavedQuery(actor, { queryId: binding.queryId, version: binding.queryVersion }).catch(() => null)
      const freshness = found ? await warehouseService().describeDataset(actor, found.query.dataset).catch(() => null) : null
      return {
        alias: binding.alias,
        name: found?.query.name ?? null,
        version: binding.queryVersion,
        currentVersion: found?.currentVersion ?? null,
        lastLoadAt: freshness?.dataset.publishedAt ?? null,
      }
    }),
  )
}

/** #1083 §6: mit frissít a platform, és mit nem. */
function LiveDataBlock({ queries }: { queries: LiveQuery[] }) {
  if (queries.length === 0) return null
  return (
    <details className="rounded-xl border border-line bg-panel px-4 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-ink">Élő adat: minden megnyitáskor a legutóbbi betöltés adatát mutatja</summary>
      <div className="mt-2 space-y-2 text-ink-soft">
        <p>A számok frissülnek, amikor új adat kerül az adattárházba. A riport kinézete csak akkor változik, ha az AI munkatárs új verziót készít. Gyors linkje legfeljebb 1 óráig érvényes, ez az oldal mindig frissen kér egyet.</p>
        <ul className="space-y-1">
          {queries.map((query) => (
            <li key={query.alias}>
              <code>{query.name ?? query.alias}</code>
              {query.name ? ` · ${query.version}. verzió` : ' · a lekérdezés nem elérhető'}
              {query.currentVersion !== null && query.currentVersion > query.version ? ` · van újabb (${query.currentVersion}.), az app még a régivel dolgozik` : ''}
              {query.lastLoadAt ? ` · Utolsó betöltés: ${formatMiniAppTime(new Date(query.lastLoadAt))}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}

/**
 * #967 §5.3.1: az állandó platform-link. Bejelentkezés után minden megnyitáskor
 * ellenőrzi a hozzáférést (visszavonás, archiválás azonnal érvényes), friss gyors
 * linket kér, és mindig a legfrissebb verziót mutatja.
 */
export default async function MiniAppPermanentPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params
  let ctx
  try {
    ctx = await requireTenantRole('viewer')
  } catch (error) {
    if (error instanceof TenantAuthError) notFound()
    throw error
  }
  const app = /^[0-9a-f-]{36}$/i.test(appId) ? await repositories.miniApps.findById(ctx.activeTenantId, appId) : null
  const access = app
    ? await miniAppHumanAccess(
        {
          findAgentGrant: (input) => repositories.resourceGrants.findAgentGrant(input),
          listActiveShareAgentIds: async (id) => (await repositories.miniApps.listActiveShares(id)).map((s) => s.agentId),
        },
        { tenantId: ctx.activeTenantId, userId: ctx.user.id, role: ctx.activeTenantRole, assumed: ctx.assumed },
        app,
      )
    : null

  if (!app || !access || app.status !== 'active') {
    return (
      <div className="mx-auto max-w-xl space-y-4 py-10">
        <Card title="Nincs hozzáférésed ehhez a mini apphoz">
          <div className="space-y-3 text-sm text-ink-soft">
            <p>
              Lehet, hogy a mini appot archiválták, a megosztást visszavonták, vagy nem látod azt az AI munkatársat,
              aki készítette vagy akivel megosztották.
            </p>
            <p>Kérd meg a munkatárs kezelőjét, hogy adjon hozzáférést, vagy kérj új riportot az AI munkatárstól.</p>
            <Link href="/control-plane" className="font-medium text-coral-deep underline">
              Vissza a Control Plane-re
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  const version = await repositories.miniApps.findVersion(app.id, app.currentVersion)
  if (!version) notFound()
  const links = await services.miniApps.service.issueLinks({ tenantId: ctx.activeTenantId, userId: ctx.user.id }, app, version)
  const liveQueries = await describeLiveQueries({ tenantId: ctx.activeTenantId, userId: ctx.user.id, role: ctx.activeTenantRole, channel: 'ui' }, version.dataBindings)

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[480px] flex-col gap-3">
      <LiveDataBlock queries={liveQueries} />
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/control-plane/agents/${app.ownerAgentId}?section=miniappok`}
          className="text-sm font-medium text-ink-soft hover:text-ink"
        >
          ← Mini appok
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-xl font-semibold">{app.name}</h1>
        <a
          href={links.openUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-medium text-ink hover:border-coral/50"
        >
          Megnyitás új lapon
        </a>
        <a
          href={`/api/control-plane/mini-apps/${app.id}/download`}
          className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-medium text-ink hover:border-coral/50"
        >
          Letöltés .html-ként
        </a>
      </div>
      {/* Nincs külső sandbox: Chrome a nested tartalom-iframe-et különben blokkolja. Az izoláció a keret belső iframe-jén + CSP sandbox. */}
      <iframe
        src={links.openUrl}
        referrerPolicy="no-referrer"
        title={app.name}
        className="w-full flex-1 rounded-xl border border-line bg-white"
      />
    </div>
  )
}
