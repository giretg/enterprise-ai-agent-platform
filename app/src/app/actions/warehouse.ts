'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { canWarehouse } from '@/domain/warehouse/permissions'
import { WarehouseError, type WarehouseActor } from '@/domain/warehouse/warehouse-service'
import { fail, ok, type ActionResult } from '@/lib/result'
import { warehouseService } from '@/lib/warehouse'

type Ctx = Awaited<ReturnType<typeof requireTenantRole>>

function actor(ctx: Ctx): WarehouseActor {
  return { tenantId: ctx.activeTenantId, userId: ctx.user.id, role: ctx.activeTenantRole, channel: 'ui' }
}

/** Üzleti nyelvű hibaüzenet (a kód a felhasználónak nem mond semmit). */
const MESSAGES: Record<string, string> = {
  warehouse_not_ready: 'Az adattárház még nincs bekapcsolva.',
  warehouse_permission_denied: 'Ehhez a művelethez nincs jogosultságod — kérd egy jóváhagyó vagy admin kollégát.',
  file_too_large: 'A fájl nagyobb 10 MB-nál. Bontsd kisebb részekre.',
  unsafe_archive: 'Az Excel-fájl sérült vagy kicsomagolva túl nagy — nem tároltuk el.',
  unsupported_format: 'Egyelőre csak .xlsx Excel-fájlt tudunk betölteni.',
  unreadable_file: 'Az Excel-fájlt nem sikerült megnyitni. Mentsd el újra .xlsx formátumban.',
  import_invalid_state: 'Ez a lépés most nem végezhető el ezen a betöltésen (frissítsd az oldalt).',
  preview_stale: 'Az adatok az előnézet óta megváltoztak — nézd meg újra az előnézetet.',
  plan_check_failed: 'A betöltési terv nem illik a fájlhoz vagy az adattárházhoz — kérd az AI munkatársat, hogy javítsa.',
  rollback_not_latest: 'Csak az adatkészlet legutóbbi betöltése vonható vissza.',
  rollback_blocked_by_references: 'Más adatok hivatkoznak az ebben a betöltésben létrejött rekordokra — előbb azokat kell visszavonni.',
  exception_not_pending: 'Ezt a tételt már valaki eldöntötte.',
  link_target_not_found: 'A kiválasztott rekord már nem létezik.',
  load_failed: 'A betöltés nem sikerült, semmi sem változott. Nézd meg újra az előnézetet, majd próbáld újra.',
}

async function run<T>(fn: (ctx: Ctx) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const ctx = await requireTenantRole('viewer')
    const data = await fn(ctx)
    revalidatePath('/control-plane/warehouse')
    return ok(data)
  } catch (error) {
    if (error instanceof WarehouseError) return fail(MESSAGES[error.code] ?? 'A művelet nem sikerült.')
    return fail('A művelet nem sikerült.')
  }
}

export async function loadWarehousePageAction(importId?: string) {
  try {
    const ctx = await requireTenantRole('viewer')
    const svc = warehouseService()
    const a = actor(ctx)
    const status = await svc.status(a)
    const permissions = {
      import: canWarehouse(a.role, 'import'),
      schema: canWarehouse(a.role, 'schema'),
      operate: canWarehouse(a.role, 'operate'),
    }
    if (status?.status !== 'ready') return ok({ status, permissions, ready: false as const })
    const [datasets, imports, usage, exceptions, selected] = await Promise.all([
      svc.listDatasets(a),
      svc.listImports(a, 30),
      svc.usage(a),
      svc.listExceptions(a, { status: 'pending', limit: 200 }),
      importId && z.string().uuid().safeParse(importId).success ? svc.getImport(a, importId).catch(() => null) : Promise.resolve(null),
    ])
    const details = await Promise.all(datasets.map((d) => svc.describeDataset(a, d.key)))
    return ok({
      status,
      permissions,
      ready: true as const,
      datasets: details.map((d, i) => ({ ...datasets[i]!, fields: d.dataset.fields, businessKey: d.dataset.businessKey, referencedBy: d.referencedBy })),
      imports: imports.map((i) => ({
        id: i.id,
        state: i.state,
        fileName: i.fileName,
        datasetKey: i.datasetKey,
        planSource: i.planSource,
        createdAt: i.createdAt,
        publishedAt: i.publishedAt,
      })),
      usage,
      exceptions,
      selected,
    })
  } catch (error) {
    if (error instanceof WarehouseError) return fail(MESSAGES[error.code] ?? 'Az adattárház nem tölthető be.')
    return fail('Az adattárház nem tölthető be.')
  }
}

export async function activateWarehouseAction() {
  return run(async (ctx) => {
    const record = await warehouseService().activate(actor(ctx))
    if (record.status !== 'ready') throw new WarehouseError('activation_failed')
    return { status: record.status }
  })
}

export async function uploadWarehouseFileAction(formData: FormData) {
  return run(async (ctx) => {
    const file = formData.get('file')
    if (!(file instanceof File)) throw new WarehouseError('unsupported_format')
    const content = Buffer.from(await file.arrayBuffer())
    const res = await warehouseService().prepareImport(actor(ctx), { fileName: file.name, content })
    return { importId: res.import.id, state: res.import.state, recipe: res.recipe, drift: res.drift }
  })
}

export async function previewImportAction(input: { importId: string }) {
  return run(async (ctx) => {
    const res = await warehouseService().preview(actor(ctx), z.string().uuid().parse(input.importId))
    return { previewHash: res.import.previewHash }
  })
}

export async function commitImportAction(input: { importId: string; previewHash: string; approve: boolean }) {
  return run(async (ctx) => {
    const res = await warehouseService().commit(actor(ctx), {
      importId: z.string().uuid().parse(input.importId),
      previewHash: z.string().min(8).max(64).parse(input.previewHash),
      approve: input.approve,
    })
    return { status: res.status }
  })
}

export async function rollbackImportAction(input: { importId: string }) {
  return run(async (ctx) => warehouseService().rollback(actor(ctx), z.string().uuid().parse(input.importId)))
}

export async function resolveExceptionAction(input: { exceptionId: string; action: 'link' | 'dismiss'; targetId?: string }) {
  return run(async (ctx) =>
    warehouseService().resolveException(actor(ctx), {
      exceptionId: z.string().uuid().parse(input.exceptionId),
      decision: input.action === 'link' ? 'link' : 'dismiss',
      targetId: input.targetId ? z.string().uuid().parse(input.targetId) : undefined,
    }),
  )
}

export async function confirmDatasetAction(input: { datasetKey: string }) {
  return run(async (ctx) => warehouseService().confirmDataset(actor(ctx), z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).parse(input.datasetKey)))
}
