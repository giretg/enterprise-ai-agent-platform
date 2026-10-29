/**
 * #984 AI-adattárház végponttól végpontig, valódi (migrált) Postgresen:
 * aktiválás, ügyfél + rendelés import, egyezés + kivétel, recept (AI nélkül),
 * idempotens újraimport, szerkezetváltozás, atomikus közzététel, visszavonás,
 * lekérdezés eredettel, export, cég-elkülönítés.
 * Futtatás: npm run test:warehouse-db (DATABASE_URL + DIRECT_URL egy eldobható DB-re).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PgSchemaProvisioner } from '../src/domain/warehouse/provisioner'
import { prismaWarehouseDatabase, warehouseSchemaName, type WarehouseDatabase } from '../src/domain/warehouse/sql'
import { WarehouseError, WarehouseService, type WarehouseActor } from '../src/domain/warehouse/warehouse-service'
import { PostgresWarehouseRegistry } from '../src/repositories/postgres/warehouse-registry'
import type { AuditAppendInput } from '../src/lib/audit/types'
import { customersXlsx, ordersXlsx } from './warehouse-fixtures'

const customersPlan = {
  schema: 'warehouse.import_plan/v1',
  sheet: 'Ügyfelek',
  dataset: { key: 'ugyfelek', title: 'Ügyfelek', rowMeaning: 'Egy sor = egy ügyfél', temporal: 'master' },
  mode: 'upsert',
  businessKey: ['nev'],
  fields: [
    { source: 'Név', target: 'nev', type: 'text', label: 'Ügyfél neve', required: true },
    { source: 'Város', target: 'varos', type: 'text', label: 'Város' },
    { source: 'Hitelkeret', target: 'hitelkeret', type: 'decimal', label: 'Hitelkeret', currency: 'HUF' },
    { source: 'Felvéve', target: 'felveve', type: 'date', label: 'Felvétel dátuma' },
  ],
}

const ordersPlan = {
  schema: 'warehouse.import_plan/v1',
  sheet: 'Rendelések',
  dataset: { key: 'rendelesek', title: 'Rendelések', rowMeaning: 'Egy sor = egy rendelés', temporal: 'event' },
  mode: 'upsert',
  businessKey: ['szam'],
  fields: [
    { source: 'Rendelés / Szám', target: 'szam', type: 'text', label: 'Rendelésszám', required: true },
    { source: 'Rendelés / Dátum', target: 'datum', type: 'date', label: 'Dátum' },
    { source: 'Ügyfél / Név', target: 'ugyfel_nev', type: 'text', label: 'Ügyfél (forrásnév)' },
    { source: 'Összeg / Nettó', target: 'netto', type: 'decimal', label: 'Nettó összeg', currency: 'HUF', amountBasis: 'net' },
  ],
  links: [{ field: 'ugyfel_nev', toDataset: 'ugyfelek', by: 'name', toField: 'nev', as: 'ugyfel_ref' }],
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof WarehouseError, `expected WarehouseError, got ${e}`)
    assert.equal(e.code, code)
    return true
  })
}

async function main() {
  const suffix = randomUUID()
  const tenant = await prisma.tenant.create({ data: { slug: `wh-test-${suffix}`, displayName: 'Warehouse test' } })
  const other = await prisma.tenant.create({ data: { slug: `wh-other-${suffix}`, displayName: 'Other' } })
  const user = await prisma.user.create({ data: { externalAuthId: suffix, email: `${suffix}@example.invalid`, name: 'WH test' } })
  const audits: AuditAppendInput[] = []
  let failPublishAudit = false
  const baseDb = prismaWarehouseDatabase(prisma)
  let failOn: RegExp | null = null
  // Hiba-befecskendezés a betöltés közepén (AC6/AC7).
  const db: WarehouseDatabase = {
    run: (fn, options) =>
      baseDb.run(
        (sql) =>
          fn({
            query: sql.query.bind(sql),
            exec: async (statement, params) => {
              if (failOn?.test(statement)) throw new Error('injected failure')
              return sql.exec(statement, params)
            },
          }),
        options,
      ),
  }
  const service = new WarehouseService({
    db,
    registry: new PostgresWarehouseRegistry(prisma),
    provisioner: new PgSchemaProvisioner(baseDb),
    audit: { append: async (entry) => {
      if (failPublishAudit && entry.action === 'warehouse.import.published') throw new Error('injected audit outage')
      audits.push(entry)
    } },
    reviewUrl: (id) => `/control-plane/warehouse${id ? `?import=${id}` : ''}`,
  })
  const admin: WarehouseActor = { tenantId: tenant.id, userId: user.id, role: 'admin', channel: 'ui' }
  const ai: WarehouseActor = { tenantId: tenant.id, userId: user.id, role: 'operator', agentId: randomUUID(), channel: 'mcp' }
  const viewer: WarehouseActor = { tenantId: tenant.id, userId: user.id, role: 'viewer', channel: 'mcp' }
  const outsider: WarehouseActor = { tenantId: other.id, userId: user.id, role: 'admin', channel: 'ui' }
  const schema = warehouseSchemaName(tenant.id)

  try {
    // ── AC10: aktiválás idempotens ────────────────────────────────────────
    await expectCode(service.listDatasets(viewer), 'warehouse_not_ready')
    await expectCode(service.activate(viewer), 'warehouse_permission_denied')
    const first = await service.activate(admin)
    assert.equal(first.status, 'ready')
    const again = await service.activate(admin)
    assert.equal(again.status, 'ready')
    assert.equal(again.schemaName, schema)
    assert.equal(await prisma.tenantWarehouse.count({ where: { tenantId: tenant.id } }), 1)
    console.log('  OK  AC10 aktiválás idempotens, ugyanaz a séma')

    // ── AC1: ügyféllista → felfedezhető, értelmezhető ─────────────────────
    const customers = await service.prepareImport(ai, { fileName: 'ugyfelek.xlsx', content: await customersXlsx(), idempotencyKey: 'c1' })
    assert.equal(customers.import.state, 'awaiting_plan')
    const replay = await service.prepareImport(ai, { fileName: 'ugyfelek.xlsx', content: await customersXlsx(), idempotencyKey: 'c1' })
    assert.equal(replay.created, false)
    assert.equal(replay.import.id, customers.import.id)
    // R5: frissítő mód üzleti kulcs nélkül nem hagyható jóvá.
    const noKey = await service.submitPlan(ai, customers.import.id, { ...customersPlan, businessKey: [] }, 'ai')
    assert.ok(noKey.check.errors.some((e) => e.code === 'business_key_required'))
    assert.equal(noKey.import.state, 'awaiting_plan')
    const planned = await service.submitPlan(ai, customers.import.id, customersPlan, 'ai')
    assert.equal(planned.check.ok, true, JSON.stringify(planned.check.errors))
    const cPreview = await service.preview(ai, customers.import.id)
    assert.equal(cPreview.preview.counts.new, 4)
    assert.deepEqual(cPreview.preview.approvalReasons, ['new_dataset'])
    const pending = await service.commit(ai, { importId: customers.import.id, previewHash: cPreview.import.previewHash! })
    assert.equal(pending.status, 'awaiting_approval')
    // Az MCP-csatorna önmagát nem hagyhatja jóvá.
    const selfApprove = await service.commit(ai, { importId: customers.import.id, previewHash: cPreview.import.previewHash!, approve: true })
    assert.equal(selfApprove.status, 'awaiting_approval')
    await expectCode(service.commit({ ...admin, role: 'operator' }, { importId: customers.import.id, previewHash: cPreview.import.previewHash!, approve: true }), 'warehouse_permission_denied')
    const published = await service.commit(admin, { importId: customers.import.id, previewHash: cPreview.import.previewHash!, approve: true })
    assert.equal(published.status, 'published')
    const datasets = await service.listDatasets(viewer)
    assert.equal(datasets[0]!.key, 'ugyfelek')
    assert.equal(datasets[0]!.rows, 4)
    assert.equal(datasets[0]!.definitionStatus, 'proposed')
    const described = await service.describeDataset(viewer, 'ugyfelek')
    assert.equal(described.dataset.fields.find((f) => f.name === 'hitelkeret')!.currency, 'HUF')
    const ids = await service.query(viewer, { dataset: 'ugyfelek', fields: '_id,nev,hitelkeret,felveve', orderBy: 'nev' })
    assert.equal(ids.rows.length, 4)
    assert.match(String(ids.rows[0]![0]), /^[0-9a-f-]{36}$/)
    assert.deepEqual(ids.rows[0]!.slice(1), ['Kovács Borház Kft.', 1500000.5, '2026-10-22'])
    assert.equal(ids.provenance.sources[0]!.fileName, 'ugyfelek.xlsx')
    console.log('  OK  AC1 ügyféllista felfedezhető, belső azonosító + eredet; új adatkészlet emberi jóváhagyással')

    // ── AC2: rendelések kapcsolása, bizonytalan egyezés nem tény ──────────
    const orders = await service.prepareImport(ai, { fileName: 'rendelesek-10.xlsx', content: await ordersXlsx() })
    await service.submitPlan(ai, orders.import.id, ordersPlan, 'ai')
    const oPreview = await service.preview(ai, orders.import.id)
    assert.deepEqual(oPreview.preview.counts.links.ugyfel_ref, { matched: 2, viaAlias: 0, suggested: 1, ambiguous: 0, unmatched: 1, empty: 0 })
    await service.commit(admin, { importId: orders.import.id, previewHash: oPreview.import.previewHash!, approve: true })
    const linked = await service.query(viewer, { dataset: 'rendelesek', fields: 'szam,ugyfel_ref.nev,netto', orderBy: 'szam' })
    assert.deepEqual(linked.rows.map((r) => r[1]), [null, 'Szabó és Társa Bt.', null, 'Nagy Pince Zrt.'])
    const exceptions = await service.listExceptions(viewer, { datasetKey: 'rendelesek' })
    assert.deepEqual(exceptions.map((e) => e.kind).sort(), ['suggested_link', 'unmatched_link'])
    assert.ok(linked.warnings.some((w) => w.code === 'open_exceptions'))
    assert.ok(linked.warnings.some((w) => w.code === 'definitions_not_confirmed'))
    console.log('  OK  AC2 rendelések kapcsolva; „Kovács Borház” csak javaslat, ismeretlen ügyfél kivétel')

    // ── AC3 + AC4: ismert szerkezet AI nélkül, ismétlés nem duplikál ─────
    const repeat = await service.prepareImport(ai, { fileName: 'masik-nev.xlsx', content: await ordersXlsx() })
    assert.equal(repeat.import.state, 'planned')
    assert.equal(repeat.import.planSource, 'recipe')
    assert.equal(repeat.recipe?.version, 1)
    const rPreview = await service.preview(ai, repeat.import.id)
    assert.deepEqual([rPreview.preview.counts.new, rPreview.preview.counts.updated, rPreview.preview.counts.unchanged], [0, 0, 4])
    assert.deepEqual(rPreview.preview.approvalReasons, [])
    const rCommit = await service.commit(ai, { importId: repeat.import.id, previewHash: rPreview.import.previewHash! })
    assert.equal(rCommit.status, 'published')
    const again2 = await service.commit(ai, { importId: repeat.import.id, previewHash: rPreview.import.previewHash! })
    assert.equal(again2.replayed, true)
    const extra = await service.prepareImport(ai, { fileName: 'rendelesek-11.xlsx', content: await ordersXlsx({ extraRow: true }) })
    assert.equal(extra.import.planSource, 'recipe')
    const ePreview = await service.preview(ai, extra.import.id)
    assert.equal(ePreview.preview.counts.new, 1)
    await service.commit(ai, { importId: extra.import.id, previewHash: ePreview.import.previewHash! })
    assert.equal((await service.listDatasets(viewer)).find((d) => d.key === 'rendelesek')!.rows, 5)
    console.log('  OK  AC3/AC4 recept AI nélkül; azonos import 0 új / 0 módosult; új sor hozzáadva')

    // ── AC5: megváltozott szerkezet → eltérés, tisztázás után folytatható ─
    const drifted = await service.prepareImport(ai, { fileName: 'rendelesek-uj.xlsx', content: await ordersXlsx({ renameColumn: true }) })
    assert.equal(drifted.import.state, 'awaiting_plan')
    assert.equal(drifted.drift?.datasetKey, 'rendelesek')
    assert.deepEqual(drifted.drift?.missingColumns, ['Összeg / Nettó'])
    assert.deepEqual(drifted.drift?.newColumns, ['Összeg / Nettó Ft'])
    const fixedPlan = { ...ordersPlan, fields: ordersPlan.fields.map((f) => (f.target === 'netto' ? { ...f, source: 'Összeg / Nettó Ft' } : f)) }
    const fixed = await service.submitPlan(ai, drifted.import.id, fixedPlan, 'ai')
    assert.equal(fixed.check.ok, true)
    const dPreview = await service.preview(ai, drifted.import.id)
    assert.equal(dPreview.preview.counts.unchanged, 4)
    console.log('  OK  AC5 szerkezetváltozás jelezve (hiányzó/új oszlop), új tervvel folytatható')

    // ── Kivétel feloldása + tárolt megfeleltetés; újraimport nem bontja ───
    const suggestion = (await service.listExceptions(viewer, { datasetKey: 'rendelesek' })).find((e) => e.kind === 'suggested_link')!
    await expectCode(service.resolveException(ai, { exceptionId: suggestion.id, decision: 'link', targetId: suggestion.candidates![0]!.id }), 'warehouse_permission_denied')
    await service.resolveException(admin, { exceptionId: suggestion.id, decision: 'link', targetId: suggestion.candidates![0]!.id })
    const afterResolve = await service.query(viewer, { dataset: 'rendelesek', fields: 'szam,ugyfel_ref.nev', filters: '[{"field":"szam","op":"eq","value":"R-001"}]' })
    assert.equal(afterResolve.rows[0]![1], 'Kovács Borház Kft.')
    const reimport = await service.prepareImport(ai, { fileName: 'rendelesek-11b.xlsx', content: await ordersXlsx({ extraRow: true }) })
    const riPreview = await service.preview(ai, reimport.import.id)
    assert.equal(riPreview.preview.counts.links.ugyfel_ref!.viaAlias, 1)
    assert.equal(riPreview.preview.counts.unchanged, 5)
    console.log('  OK  Javaslat emberi megerősítéssel kapcsolat lett; újraimportnál a tárolt megfeleltetés köt')

    // ── AC13: a fájlba írt „utasítás” csak adat ───────────────────────────
    const injected = await service.prepareImport(ai, { fileName: 'injekcio.xlsx', content: await ordersXlsx({ extraRow: true, injection: true }) })
    assert.equal(injected.import.planSource, 'recipe')
    assert.equal(injected.import.plan!.mode, 'upsert')
    const iPreview = await service.preview(ai, injected.import.id)
    assert.equal(iPreview.preview.counts.updated, 1)
    assert.equal(iPreview.preview.counts.links.ugyfel_ref!.unmatched, 2)
    console.log('  OK  AC13 a fájlban lévő utasítás nem változtat a terven')

    // ── AC6/AC7: félbeszakadt betöltés → semmi sem látszik, folytatható ───
    const beforeRows = (await service.listDatasets(viewer)).find((d) => d.key === 'rendelesek')!.rows
    failOn = /_row_history/
    await expectCode(service.commit(ai, { importId: injected.import.id, previewHash: iPreview.import.previewHash! }), 'load_failed')
    failOn = null
    const failed = await service.getImport(viewer, injected.import.id)
    assert.equal(failed.import.state, 'failed')
    assert.equal((await service.listDatasets(viewer)).find((d) => d.key === 'rendelesek')!.rows, beforeRows)
    const r4 = await service.query(viewer, { dataset: 'rendelesek', fields: 'ugyfel_nev', filters: '[{"field":"szam","op":"eq","value":"R-004"}]' })
    assert.equal(r4.rows[0]![0], 'Nagy Pince Zrt.')
    const resumed = await service.preview(ai, injected.import.id)
    const done = await service.commit(ai, { importId: injected.import.id, previewHash: resumed.import.previewHash! })
    assert.equal(done.status, 'published')
    console.log('  OK  AC6/AC7 megszakított betöltés nem látszik; új előnézettel folytatható')

    // ── Katalógus-megerősítés ─────────────────────────────────────────────
    await expectCode(service.confirmDataset(ai, 'rendelesek'), 'warehouse_permission_denied')
    await service.confirmDataset(admin, 'ugyfelek')
    const confirmedQuery = await service.query(viewer, { dataset: 'ugyfelek', aggregates: 'count:*' })
    assert.ok(!confirmedQuery.warnings.some((w) => w.code === 'definitions_not_confirmed'))
    const agg = await service.query(viewer, { dataset: 'rendelesek', groupBy: 'ugyfel_ref.nev', aggregates: 'sum:netto,count:*', orderBy: 'sum:netto desc' })
    assert.deepEqual(agg.rows[0], ['Kovács Borház Kft.', 100000, 1])
    console.log('  OK  Definíció-megerősítés + összesítő lekérdezés kapcsolaton át')

    // ── AC9: export + visszavonás ─────────────────────────────────────────
    const exported = await service.exportDataset(viewer, 'rendelesek')
    assert.equal(exported.rows.length, 5)
    await expectCode(service.rollback(admin, extra.import.id), 'rollback_not_latest')
    const rolled = await service.rollback(admin, injected.import.id)
    assert.equal(rolled.restoredRows, 1)
    const restored = await service.query(viewer, { dataset: 'rendelesek', fields: 'ugyfel_nev', filters: '[{"field":"szam","op":"eq","value":"R-004"}]' })
    assert.equal(restored.rows[0]![0], 'Nagy Pince Zrt.')
    await expectCode(service.rollback(admin, customers.import.id), 'rollback_blocked_by_references')
    console.log('  OK  AC9 export + az utolsó import visszavonása; hivatkozott rekordok védve')

    // ── AC8: cég-elkülönítés ──────────────────────────────────────────────
    await expectCode(service.listDatasets(outsider), 'warehouse_not_ready')
    await service.activate(outsider)
    assert.deepEqual(await service.listDatasets(outsider), [])
    await expectCode(service.getImport(outsider, customers.import.id), 'import_not_found')
    await expectCode(service.query(outsider, { dataset: 'ugyfelek' }), 'dataset_not_found')
    console.log('  OK  AC8 másik cég nem látja az adatokat')

    const usage = await service.usage(viewer)
    assert.ok(usage.storageBytes > 0 && usage.publishedImports === 4)
    assert.ok(audits.some((a) => a.action === 'warehouse.import.published'))
    assert.ok(audits.every((a) => !JSON.stringify(a.metadata).includes('Kovács')), 'audit must not carry business data')
    console.log('  OK  R10 mérés + audit üzleti adat nélkül')

    // A tranzakció utáni audithiba nem írhatja felül a sikeres betöltést.
    const append = await service.prepareImport(ai, { fileName: 'audit.xlsx', content: await customersXlsx() })
    await service.submitPlan(ai, append.import.id, { ...customersPlan, dataset: { key: 'audit_append', title: 'Audit próba' }, mode: 'append', businessKey: [] }, 'ai')
    const ap = await service.preview(ai, append.import.id)
    failPublishAudit = true
    await assert.rejects(service.commit(admin, { importId: append.import.id, previewHash: ap.import.previewHash!, approve: true }), /injected audit outage/)
    failPublishAudit = false
    assert.equal((await service.getImport(viewer, append.import.id)).import.state, 'published')
    await expectCode(service.preview(ai, append.import.id), 'import_invalid_state')
    assert.equal((await service.commit(admin, { importId: append.import.id, previewHash: ap.import.previewHash!, approve: true })).replayed, true)
    assert.deepEqual((await service.query(viewer, { dataset: 'audit_append', aggregates: 'count:*' })).rows, [[4]])
    console.log('  OK  Audithiba után az append import sikeres marad, az ismétlés nem duplikál')

    // A visszavonás visszahozza az előző import döntésre váró kivételeit.
    const originalExceptions = await service.listExceptions(viewer, { datasetKey: 'rendelesek' })
    assert.ok(originalExceptions.length > 0)
    const retry = await service.prepareImport(ai, { fileName: 'rollback-exceptions.xlsx', content: await ordersXlsx({ extraRow: true }) })
    await service.submitPlan(ai, retry.import.id, ordersPlan, 'ai')
    const rp = await service.preview(ai, retry.import.id)
    await service.commit(ai, { importId: retry.import.id, previewHash: rp.import.previewHash! })
    const superseded = await service.listExceptions(viewer, { datasetKey: 'rendelesek', status: 'superseded' })
    assert.ok(originalExceptions.every((e) => superseded.some((x) => x.id === e.id)))
    await service.rollback(admin, retry.import.id)
    const reopened = await service.listExceptions(viewer, { datasetKey: 'rendelesek' })
    assert.deepEqual(reopened.map((e) => e.id).sort(), originalExceptions.map((e) => e.id).sort())
    assert.ok((await service.query(viewer, { dataset: 'rendelesek' })).warnings.some((w) => w.code === 'open_exceptions'))
    console.log('  OK  Visszavonás után a korábbi megoldatlan kapcsolatok újra látszanak')

    // Betöltésre váró feltöltés törölhető (a forrásfájllal együtt); betöltött nem.
    const stray = await service.prepareImport(ai, { fileName: 'tevedes.xlsx', content: await ordersXlsx({ extraRow: true }) })
    await expectCode(service.discardImport(viewer, stray.import.id), 'warehouse_permission_denied')
    await expectCode(service.discardImport(outsider, stray.import.id), 'import_not_found')
    await service.discardImport(ai, stray.import.id)
    await expectCode(service.getImport(viewer, stray.import.id), 'import_not_found')
    const leftover = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${schema}"._source_files WHERE import_id = $1::uuid`, stray.import.id)
    assert.equal(leftover[0]?.n, 0)
    await expectCode(service.discardImport(ai, customers.import.id), 'import_invalid_state')
    await expectCode(service.discardImport(ai, retry.import.id), 'import_invalid_state')
    assert.ok(audits.some((a) => a.action === 'warehouse.import.discarded' && a.targetId === stray.import.id))
    console.log('  OK  Betöltésre váró feltöltés törölhető; betöltött/visszavont nem')

  } finally {
    for (const t of [tenant, other]) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${warehouseSchemaName(t.id)}" CASCADE`)
    }
    await prisma.tenantWarehouse.deleteMany({ where: { tenantId: { in: [tenant.id, other.id] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
  console.log('\nwarehouse-db: minden zöld')
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
