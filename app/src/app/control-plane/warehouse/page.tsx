import { notFound } from 'next/navigation'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { getWarehouseAgentAccessAction, loadWarehousePageAction } from '@/app/actions/warehouse'
import { WarehouseAgentAccessPanel, WarehouseStorageCard } from '@/components/warehouse/warehouse-access-panels'
import { WarehousePanel } from './warehouse-panel'

export const dynamic = 'force-dynamic'

/** #984 AI-adattárház: aktiválás, Excel-feltöltés, jóváhagyás, kivételek, katalógus, export. */
export default async function WarehousePage({ searchParams }: { searchParams: Promise<{ import?: string }> }) {
  try {
    await requireTenantRole('viewer')
  } catch (error) {
    if (error instanceof TenantAuthError) notFound()
    throw error
  }
  const { import: importId } = await searchParams
  const [result, access] = await Promise.all([loadWarehousePageAction(importId), getWarehouseAgentAccessAction()])
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Adattárház</h1>
        <p className="mt-2 max-w-3xl text-ink-soft">
          Töltsd fel a céges Excel-táblákat (ügyfelek, rendelések…), és az AI munkatársaid kérdezhetnek róluk. Az AI javasolja,
          melyik oszlop mit jelent; a platform ellenőrzi és tölti be. Ugyanilyen szerkezetű következő fájlt már AI nélkül betölt.
        </p>
      </div>
      {result.success ? (
        <WarehousePanel data={result.data} selectedImportId={importId ?? null} />
      ) : (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {result.error}
        </p>
      )}
      {access.success ? <WarehouseAgentAccessPanel data={access.data} /> : null}
      {access.success && access.data.canEdit ? <WarehouseStorageCard storage={access.data.storage} /> : null}
    </div>
  )
}
