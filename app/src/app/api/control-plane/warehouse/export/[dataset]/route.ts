import { requireTenantRole } from '@/auth/tenant-context'
import { WarehouseError } from '@/domain/warehouse/warehouse-service'
import { warehouseService } from '@/lib/warehouse'

export const runtime = 'nodejs'

/** #984 AC9: adatkészlet letöltése Excelként (bejelentkezett, olvasási joggal; auditált). */
export async function GET(_request: Request, context: { params: Promise<{ dataset: string }> }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { dataset } = await context.params
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(dataset)) return new Response('Nem található.', { status: 404 })
    const res = await warehouseService().exportDataset(
      { tenantId: ctx.activeTenantId, userId: ctx.user.id, role: ctx.activeTenantRole, channel: 'ui' },
      dataset,
    )
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(dataset.slice(0, 31))
    sheet.addRow(res.columns)
    sheet.getRow(1).font = { bold: true }
    for (const row of res.rows) {
      // Szöveg sosem képlet: a forrásból jövő „=…” érték adatként marad.
      sheet.addRow(row.map((v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : v)))
    }
    const meta = workbook.addWorksheet('Eredet')
    meta.addRow(['Adatkészlet', dataset])
    meta.addRow(['Frissesség', res.provenance.freshness ?? '—'])
    for (const source of res.provenance.sources) meta.addRow(['Forrásfájl', source.fileName, source.publishedAt ?? ''])
    for (const warning of res.warnings) meta.addRow(['Figyelmeztetés', warning.code, warning.dataset])
    if (res.hasMore) meta.addRow(['Csonkolva', 'Az export legfeljebb 100 000 sort tartalmaz.'])
    const body = Buffer.from(await workbook.xlsx.writeBuffer())
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${dataset}.xlsx"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof WarehouseError && error.code === 'warehouse_permission_denied') return new Response('Nincs jogosultság.', { status: 403 })
    return new Response('Nem található.', { status: 404 })
  }
}
