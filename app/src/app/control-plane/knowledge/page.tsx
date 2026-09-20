import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'
import { listKnowledgeCatalog } from '@/app/actions/platform'
import { KnowledgeCatalogManager } from '@/components/knowledge/knowledge-catalog-manager'

export const dynamic = 'force-dynamic'

export default async function KnowledgeCatalogPage() {
  const ctx = await getAuthContext()
  const canView = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  if (!canView) {
    return (
      <Card>
        <p className="text-sm text-ink-faint">
          A tudásbázis megtekintéséhez legalább operátor jogosultság szükséges.
        </p>
      </Card>
    )
  }
  const res = await listKnowledgeCatalog()
  const canManage = hasMinimumRole(ctx?.activeTenantRole, 'admin')

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Katalógus</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">Tudásbázis</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          Közös dokumentumtár: egyszer töltöd fel, aztán az agentek adatlapján egy
          kattintással hozzákötöd ahhoz, akinek szüksége van rá. A hozzákötés másolatot
          készít — a későbbi katalógus-frissítés nem írja át az agentnél lévőt.
        </p>
      </div>

      {!res.success ? (
        <Card>
          <p className="text-sm text-coral">{res.error ?? 'A katalógus betöltése sikertelen.'}</p>
        </Card>
      ) : (
        <KnowledgeCatalogManager documents={res.data} canManage={canManage} />
      )}
    </div>
  )
}
