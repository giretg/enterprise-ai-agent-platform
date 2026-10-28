/**
 * AI-adattárház (#984) tiszta logika: magyar érték-elemzés, profilozás valódi
 * XLSX-en (AC11), zip-bomba kapu (AC12), terv-ellenőrzés (R5, AC13), egyszerű
 * egyezés (R1/AC2), lekérdezés-fordító (R3).
 * Futtatás: npm run test:warehouse
 */
import assert from 'node:assert/strict'
import { assertWarehouseUpload, readWorkbookGrid, WarehouseFileError } from '../src/domain/warehouse/excel-reader'
import { checkPlan, parseImportPlan, type CatalogDataset } from '../src/domain/warehouse/plan'
import { profileWorkbook } from '../src/domain/warehouse/profiler'
import { buildQuerySpec, compileQuery, QueryError } from '../src/domain/warehouse/query'
import { qi, UnsafeIdentifierError, warehouseSchemaName } from '../src/domain/warehouse/sql'
import { buildLinkIndex, matchLink, prepareRows } from '../src/domain/warehouse/transform'
import { convertCell, nameWithoutLegalForm, parseHuDate, parseHuNumber } from '../src/domain/warehouse/value-parse'
import { canWarehouse } from '../src/domain/warehouse/permissions'
import { customersXlsx, ordersXlsx, zipBombXlsx } from './warehouse-fixtures'
import type { AgentDefinition } from '../src/domain/agent-definition'
import type { WarehouseAgentAccess } from '../src/lib/warehouse-settings'
import { readWarehouseSettings, warehouseAccessForAgent } from '../src/lib/warehouse-settings'
import { hermesWarehouseTools } from '../src/lib/agent-checkout'
import { invokeWarehouseTool, toCsv, WAREHOUSE_READ_ONLY_TOOLS, WAREHOUSE_TOOLS, warehouseInputSchemas, type WarehouseMcpDeps } from '../src/domain/warehouse/mcp'
import { WarehouseService, type WarehouseRegistry } from '../src/domain/warehouse/warehouse-service'
import type { WarehouseDatabase } from '../src/domain/warehouse/sql'
import { z } from 'zod'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
  }
}

const TENANT = '11111111-1111-4111-8111-111111111111'

async function main() {
  await check('R6: magyar számok (tizedesvessző, szóközös ezres, Ft, negatív)', () => {
    assert.deepEqual(parseHuNumber('1 500 000,50 Ft'), { value: 1500000.5, currency: 'HUF', percent: false })
    assert.equal(parseHuNumber('1.234.567,89')?.value, 1234567.89)
    assert.equal(parseHuNumber('1,234,567')?.value, 1234567)
    assert.equal(parseHuNumber('-12,5')?.value, -12.5)
    assert.equal(parseHuNumber('(300)')?.value, -300)
    assert.equal(parseHuNumber('12,5%')?.percent, true)
    assert.equal(parseHuNumber('250 000 HUF')?.value, 250000)
    assert.equal(parseHuNumber('12a'), null)
    assert.equal(parseHuNumber('1,2,3'), null)
  })

  await check('Szöveges értékek nem csonkulnak, az eltérő azonosítók megmaradnak', () => {
    for (const suffix of ['A', 'B']) {
      const value = 'x'.repeat(4_000) + suffix
      assert.deepEqual(convertCell(value, 'text'), { ok: true, value })
    }
  })

  await check('R6: magyar dátumok', () => {
    assert.equal(parseHuDate('2026.10.22.'), '2026-10-22')
    assert.equal(parseHuDate('2026. 10. 22.'), '2026-10-22')
    assert.equal(parseHuDate('2026-10-22'), '2026-10-22')
    assert.equal(parseHuDate('22.10.2026'), '2026-10-22')
    assert.equal(parseHuDate('2026. október 22.'), '2026-10-22')
    assert.equal(parseHuDate('2026.02.30.'), null)
    assert.equal(convertCell('nem', 'boolean').ok && (convertCell('nem', 'boolean') as { value: unknown }).value, false)
    assert.deepEqual(convertCell('3,5', 'integer'), { ok: false, reason: 'not_an_integer' })
  })

  await check('AC11: ügyféllista profil — címsor átugrása, típusok, rejtett lap, ujjlenyomat', async () => {
    const buf = await customersXlsx()
    assertWarehouseUpload(buf, 'ugyfelek.xlsx')
    const profile = profileWorkbook(await readWorkbookGrid(buf))
    const sheet = profile.sheets.find((s) => s.name === 'Ügyfelek')!
    assert.deepEqual(sheet.headerRows, { start: 3, end: 3 })
    assert.deepEqual(sheet.columns.map((c) => c.header), ['Név', 'Város', 'Hitelkeret', 'Felvéve'])
    assert.equal(sheet.dataRowCount, 4)
    assert.equal(sheet.columns[2]!.inferredType, 'decimal')
    assert.ok(sheet.columns[2]!.hints.includes('decimal_comma'))
    assert.ok(sheet.columns[2]!.hints.includes('currency_HUF'))
    assert.equal(sheet.columns[3]!.inferredType, 'date')
    assert.ok(sheet.columns[3]!.hints.includes('hu_date'))
    assert.equal(sheet.columns[0]!.candidateKey, true)
    const hidden = profile.sheets.find((s) => s.name === 'Segéd')!
    assert.equal(hidden.hidden, true)
    assert.ok(hidden.warnings.includes('hidden_sheet'))
    // Ugyanaz a szerkezet más adattal → ugyanaz az ujjlenyomat (a fájlnév nem számít).
    const other = profileWorkbook(await readWorkbookGrid(await customersXlsx([['X Kft.', 'Pécs', '1', '2026.01.01.']])))
    assert.equal(other.sheets[0]!.fingerprint, sheet.fingerprint)
  })

  await check('AC11: rendelések — összevont, kétsoros fejléc, képlet-eredmény, összesen-sor, blokkhatár', async () => {
    const profile = profileWorkbook(await readWorkbookGrid(await ordersXlsx()))
    const sheet = profile.sheets[0]!
    assert.deepEqual(sheet.headerRows, { start: 1, end: 2 })
    assert.deepEqual(sheet.columns.map((c) => c.header), ['Rendelés / Szám', 'Rendelés / Dátum', 'Ügyfél / Név', 'Összeg / Nettó', 'Összeg / Bruttó'])
    assert.equal(sheet.dataRowCount, 4)
    assert.ok(sheet.warnings.includes('multi_row_header'))
    assert.ok(sheet.warnings.includes('total_rows_skipped'))
    assert.ok(sheet.warnings.includes('multiple_blocks'))
    assert.ok(sheet.warnings.includes('formula_results_used'))
    assert.equal(sheet.columns[4]!.formulaCells, 4)
    assert.equal(sheet.columns[4]!.inferredType, 'decimal')
    assert.equal(sheet.columns[1]!.inferredType, 'date')
    assert.equal(sheet.columns[0]!.candidateKey, true)
  })

  await check('AC12: zip-bomba és nem-XLSX elutasítva a kitömörítés előtt', async () => {
    const bomb = await zipBombXlsx()
    assert.ok(bomb.byteLength < 2 * 1024 * 1024)
    assert.throws(() => assertWarehouseUpload(bomb, 'bomba.xlsx'), (e: unknown) => e instanceof WarehouseFileError && e.code === 'unsafe_archive')
    assert.throws(() => assertWarehouseUpload(Buffer.from('a,b\n1,2'), 'x.csv'), (e: unknown) => e instanceof WarehouseFileError && e.code === 'unsupported_format')
    assert.throws(() => assertWarehouseUpload(Buffer.alloc(11 * 1024 * 1024), 'x.xlsx'), (e: unknown) => e instanceof WarehouseFileError && e.code === 'file_too_large')
  })

  const ordersPlan = {
    schema: 'warehouse.import_plan/v1',
    sheet: 'Rendelések',
    dataset: { key: 'rendelesek', title: 'Rendelések' },
    mode: 'upsert',
    businessKey: ['szam'],
    fields: [
      { source: 'Rendelés / Szám', target: 'szam', type: 'text', label: 'Rendelésszám' },
      { source: 'Rendelés / Dátum', target: 'datum', type: 'date', label: 'Dátum' },
      { source: 'Ügyfél / Név', target: 'ugyfel_nev', type: 'text', label: 'Ügyfél' },
      { source: 'D', target: 'netto', type: 'decimal', label: 'Nettó', currency: 'HUF', amountBasis: 'net' },
    ],
    links: [{ field: 'ugyfel_nev', toDataset: 'ugyfelek', by: 'name', toField: 'nev', as: 'ugyfel_ref' }],
  }
  const customersCatalog: CatalogDataset = {
    key: 'ugyfelek',
    tableName: 'ds_ugyfelek',
    title: 'Ügyfelek',
    purpose: null,
    rowMeaning: null,
    temporal: null,
    status: 'proposed',
    structureVersion: 1,
    businessKey: [],
    mode: 'append',
    publishedAt: null,
    lastImportId: null,
    rowCount: 4,
    fields: [{ name: 'nev', type: 'text', label: 'Név', meaning: null, unit: null, currency: null, amountBasis: null, role: 'data', linkDataset: null, linkBy: null, linkField: null, status: 'proposed', sourceHeader: 'Név' }],
  }

  await check('R5 + AC13: terv-séma szigorú, üzleti kulcs kötelező frissítő módban', async () => {
    const injected = parseImportPlan({ ...ordersPlan, runSql: 'DROP TABLE x' })
    assert.equal(injected.ok, false)
    const badKey = parseImportPlan({ ...ordersPlan, dataset: { key: 'x"; drop', title: 't' } })
    assert.equal(badKey.ok, false)
    const parsed = parseImportPlan({ ...ordersPlan, businessKey: [] })
    assert.ok(parsed.ok)
    const profile = profileWorkbook(await readWorkbookGrid(await ordersXlsx()))
    const result = checkPlan(parsed.plan, profile.sheets[0]!, new Map([['ugyfelek', customersCatalog]]))
    assert.ok(result.errors.some((e) => e.code === 'business_key_required'))
  })

  await check('Terv-ellenőrzés: hiányzó oszlop, ismeretlen kapcsolt adatkészlet, szerkezetváltozás jelzése', async () => {
    const profile = profileWorkbook(await readWorkbookGrid(await ordersXlsx()))
    const parsed = parseImportPlan(ordersPlan)
    assert.ok(parsed.ok)
    const missingTarget = checkPlan(parsed.plan, profile.sheets[0]!, new Map())
    assert.ok(missingTarget.errors.some((e) => e.code === 'link_dataset_not_found'))
    const ok = checkPlan(parsed.plan, profile.sheets[0]!, new Map([['ugyfelek', customersCatalog]]))
    assert.equal(ok.ok, true, JSON.stringify(ok.errors))
    assert.equal(ok.structure.newDataset, true)
    const wrong = parseImportPlan({ ...ordersPlan, fields: [...ordersPlan.fields, { source: 'Nincs ilyen', target: 'x', type: 'text', label: 'x' }] })
    assert.ok(wrong.ok)
    assert.ok(checkPlan(wrong.plan, profile.sheets[0]!, new Map([['ugyfelek', customersCatalog]])).errors.some((e) => e.code === 'source_column_not_found'))
  })

  await check('Meglévő kapcsolat célmezője és egyezési módja nem változtatható', async () => {
    const profile = profileWorkbook(await readWorkbookGrid(await ordersXlsx()))
    const parsed = parseImportPlan(ordersPlan)
    assert.ok(parsed.ok)
    const link = { ...customersCatalog.fields[0]!, name: 'ugyfel_ref', type: 'link' as const, role: 'link' as const, linkDataset: 'ugyfelek', linkBy: 'name' as const, linkField: 'nev' }
    const orders: CatalogDataset = { ...customersCatalog, key: 'rendelesek', mode: 'upsert', businessKey: ['szam'], fields: [link] }
    const customers: CatalogDataset = { ...customersCatalog, mode: 'upsert', businessKey: ['nev'], fields: [...customersCatalog.fields, { ...customersCatalog.fields[0]!, name: 'varos' }] }
    const catalog = new Map([['rendelesek', orders], ['ugyfelek', customers]])
    assert.equal(checkPlan(parsed.plan, profile.sheets[0]!, catalog).ok, true)
    for (const change of [{ toField: 'varos' }, { by: 'key' as const }]) {
      const plan = { ...parsed.plan, links: parsed.plan.links.map((l) => ({ ...l, ...change })) }
      assert.ok(checkPlan(plan, profile.sheets[0]!, catalog).errors.some((e) => e.code === 'link_change_not_allowed'))
    }
  })

  await check('R1/AC2: pontos név → kapcsolat; cégforma-eltérés → csak javaslat; több jelölt → függő', () => {
    const index = buildLinkIndex(
      [
        { id: 'a', value: 'Kovács Borház Kft.' },
        { id: 'b', value: 'Szabó és Társa Bt.' },
        { id: 'c', value: 'Nagy Pince Zrt.' },
        { id: 'd', value: 'Nagy Pince Kft.' },
      ],
      'name',
    )
    assert.deepEqual(matchLink('  szabó és  társa bt. ', index, 'name'), { status: 'matched', id: 'b', method: 'normalized_name' })
    assert.deepEqual(matchLink('Kovács Borház', index, 'name'), { status: 'suggested', candidates: ['a'] })
    assert.deepEqual(matchLink('Nagy Pince', index, 'name'), { status: 'ambiguous', candidates: ['c', 'd'] })
    assert.deepEqual(matchLink('Ismeretlen Kft.', index, 'name'), { status: 'unmatched' })
    assert.deepEqual(matchLink(null, index, 'name'), { status: 'empty' })
    assert.equal(nameWithoutLegalForm('Kovács Borház Kft.'), 'kovács borház')
  })

  await check('Transzformáció: típusos sorok, üzleti kulcs, hibás érték kivétel', async () => {
    const grid = (await readWorkbookGrid(await ordersXlsx())).sheets[0]!
    const parsed = parseImportPlan(ordersPlan)
    assert.ok(parsed.ok)
    const prepared = prepareRows(grid, parsed.plan)!
    assert.equal(prepared.rows.length, 4)
    assert.equal(prepared.rows[0]!.values.netto, 100000)
    assert.equal(prepared.rows[1]!.values.netto, 20000.5)
    assert.equal(prepared.rows[0]!.values.datum, '2026-10-01')
    assert.equal(prepared.rows[0]!.bk, '["R-001"]')
    const asInt = parseImportPlan({ ...ordersPlan, fields: ordersPlan.fields.map((f) => (f.target === 'netto' ? { ...f, type: 'integer' } : f)) })
    assert.ok(asInt.ok)
    const strict = prepareRows(grid, asInt.plan)!
    assert.equal(strict.rows.length, 3)
    assert.deepEqual(strict.issues.map((i) => [i.kind, i.field, i.detail]), [['invalid_value', 'netto', 'not_an_integer']])
  })

  await check('Utolsó ismétlődő sor nyer, az első helyen levő rekordnál is', () => {
    const parsed = parseImportPlan({ schema: 'warehouse.import_plan/v1', sheet: 'Adatok', dataset: { key: 'adatok', title: 'Adatok' }, mode: 'upsert', businessKey: ['id'], duplicates: 'last_wins', fields: [
      { source: 'Azonosító', target: 'id', type: 'text', label: 'Azonosító' },
      { source: 'Érték', target: 'ertek', type: 'integer', label: 'Érték' },
    ] })
    assert.ok(parsed.ok)
    const prepared = prepareRows({ name: 'Adatok', state: 'visible', merges: [], formulaCells: {}, errorCells: 0, truncatedRows: false, truncatedColumns: false, rows: [
      { rowNumber: 1, cells: ['Azonosító', 'Érték'] },
      { rowNumber: 2, cells: ['A', 1] },
      { rowNumber: 3, cells: ['B', 2] },
      { rowNumber: 4, cells: ['A', 3] },
      { rowNumber: 5, cells: ['A', 4] },
    ] }, parsed.plan)!
    assert.deepEqual(prepared.rows.map((r) => r.values), [{ id: 'A', ertek: 4 }, { id: 'B', ertek: 2 }])
    assert.equal(prepared.issues.length, 2)
  })

  await check('R3/AC8: lekérdezés-fordító — csak katalógus-mező, paraméteres érték, séma a tenantból', () => {
    const schema = warehouseSchemaName(TENANT)
    assert.equal(schema, 'wh_11111111111141118111111111111111')
    const orders: CatalogDataset = {
      ...customersCatalog,
      key: 'rendelesek',
      tableName: 'ds_rendelesek',
      fields: [
        { ...customersCatalog.fields[0]!, name: 'netto', type: 'decimal' },
        { ...customersCatalog.fields[0]!, name: 'ugyfel_ref', type: 'link', role: 'link', linkDataset: 'ugyfelek' },
      ],
    }
    const catalog = new Map([['ugyfelek', customersCatalog], ['rendelesek', orders]])
    const compiled = compileQuery(
      schema,
      buildQuerySpec({ dataset: 'rendelesek', groupBy: 'ugyfel_ref.nev', aggregates: 'sum:netto,count:*', orderBy: 'sum:netto desc', filters: '[{"field":"netto","op":"gte","value":"1000; DROP TABLE x"}]' }),
      catalog,
    )
    assert.ok(compiled.sql.includes(`LEFT JOIN "${schema}"."ds_ugyfelek" j0 ON j0._id = t."ugyfel_ref"`))
    assert.ok(!compiled.sql.includes('DROP'))
    assert.deepEqual(compiled.params[0], '1000; DROP TABLE x')
    assert.deepEqual(compiled.columns, ['ugyfel_ref.nev', 'sum:netto', 'count'])
    assert.throws(() => compileQuery(schema, buildQuerySpec({ dataset: 'rendelesek', fields: 'netto;drop' }), catalog), QueryError)
    assert.throws(() => compileQuery(schema, buildQuerySpec({ dataset: 'masik' }), catalog), QueryError)
    assert.throws(() => qi('a"b'), UnsafeIdentifierError)
    assert.throws(() => warehouseSchemaName('../../etc'), UnsafeIdentifierError)
  })

  await check('Széles adatkészlet lekérdezése és exportja minden mezőt megőriz', () => {
    const fields = Array.from({ length: 150 }, (_, i) => ({ ...customersCatalog.fields[0]!, name: `field${i}` }))
    const wide = { ...customersCatalog, fields }
    const compiled = compileQuery(warehouseSchemaName(TENANT), buildQuerySpec({ dataset: wide.key }), new Map([[wide.key, wide]]))
    assert.deepEqual(compiled.columns, ['_id', ...fields.map((f) => f.name)])
  })

  await check('§8: külön jogosultság — olvasás / import / szerkezet / üzemeltetés', () => {
    assert.equal(canWarehouse('viewer', 'read'), true)
    assert.equal(canWarehouse('viewer', 'import'), false)
    assert.equal(canWarehouse('operator', 'import'), true)
    assert.equal(canWarehouse('operator', 'schema'), false)
    assert.equal(canWarehouse('approver', 'schema'), true)
    assert.equal(canWarehouse('approver', 'operate'), false)
    assert.equal(canWarehouse('admin', 'operate'), true)
    assert.equal(canWarehouse(null, 'read'), false)
  })

  await check('AC8 MCP: hamis cégazonosító a tool-argumentumban hatástalan; szerep-kapu; nincs tömb a sémában', async () => {
    const AGENT = '22222222-2222-4222-8222-222222222222'
    const DEF = '55555555-5555-4555-8555-555555555555'
    const OTHER = '99999999-9999-4999-8999-999999999999'
    const definition: AgentDefinition = {
      definitionId: DEF,
      agentId: AGENT,
      version: 1,
      tenantId: TENANT,
      status: 'active',
      publishedAt: '2026-10-27T00:00:00.000Z',
      snapshot: { name: 'Réka', roleInstruction: 'x', skills: [], connectors: [], capabilities: [] },
    }
    const seenTenants: string[] = []
    const registry: WarehouseRegistry = {
      find: async (tenantId) => {
        seenTenants.push(tenantId)
        return { tenantId, status: 'ready', provisioner: 'pg_schema', schemaName: warehouseSchemaName(tenantId), internalVersion: 1, lastError: null, attempts: 1, readyAt: null }
      },
      ensure: async () => {
        throw new Error('not used')
      },
      update: async () => {
        throw new Error('not used')
      },
    }
    const queried: string[] = []
    const db: WarehouseDatabase = {
      run: async (fn) =>
        fn({
          query: async (sql: string) => {
            queried.push(sql)
            return []
          },
          exec: async () => 0,
        }),
    }
    const audit: unknown[] = []
    const deps: WarehouseMcpDeps = {
      loadDefinition: async ({ definitionId }) => (definitionId === DEF ? definition : null),
      findCurrentDefinitionId: async () => DEF,
      findAgentGrant: async () => ({ accessLevel: 'operate' }),
      audit: { append: async (row) => void audit.push(row) },
      warehouse: new WarehouseService({ db, registry, provisioner: { kind: 'pg_schema', provision: async () => { throw new Error('x') }, verify: async () => ({ ok: true }) }, reviewUrl: () => '/x' }),
      pageUrl: (path) => `https://app.example${path}`,
      agentAccess: async () => agentAccess,
    }
    let agentAccess: WarehouseAgentAccess = 'import'
    const call = async (role: string, tool: string, args: Record<string, unknown>) => {
      const res = await invokeWarehouseTool(deps, { principal: { userId: AGENT, tenantId: TENANT, role, assumed: false }, toolName: tool, args })
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>
    }
    const listed = await call('viewer', 'warehouse.list_datasets', { definitionId: DEF, tenantId: OTHER, schema: 'wh_99999999999949999999999999999999' })
    assert.equal(listed.ok, true)
    assert.deepEqual(seenTenants, [TENANT])
    assert.ok(queried.every((q) => q.includes(warehouseSchemaName(TENANT)) && !q.includes('9999999999')))
    const denied = await call('viewer', 'warehouse.prepare_import', { definitionId: DEF, fileName: 'a.xlsx', fileBase64: 'AA==' })
    assert.equal(denied.code, 'warehouse_permission_denied')
    const badPlan = await call('operator', 'warehouse.submit_import_plan', { definitionId: DEF, importId: DEF, plan: 'nem json' })
    assert.equal(badPlan.code, 'invalid_plan')
    // Agentenkénti szint: csak szűkít, az ember szerepétől függetlenül.
    agentAccess = 'read'
    const readOnlyImport = await call('admin', 'warehouse.prepare_import', { definitionId: DEF, fileName: 'a.xlsx', fileBase64: 'AA==' })
    assert.equal(readOnlyImport.code, 'warehouse_agent_read_only')
    assert.equal((await call('admin', 'warehouse.list_datasets', { definitionId: DEF })).ok, true)
    agentAccess = 'off'
    const off = await call('admin', 'warehouse.list_datasets', { definitionId: DEF })
    assert.equal(off.code, 'warehouse_agent_disabled')
    assert.ok(String(off.settingsUrl).includes('/control-plane/warehouse'))
    agentAccess = 'import'
    for (const tool of WAREHOUSE_TOOLS) {
      const json = JSON.stringify(z.toJSONSchema(warehouseInputSchemas[tool]))
      assert.ok(!json.includes('"array"'), `${tool} advertises an array`)
    }
    assert.equal(toCsv(['a', 'b'], [['=HYPERLINK("x")', -5], ['x,y', null]]), `a,b\n"'=HYPERLINK(""x"")",-5\n"x,y",`)
    assert.equal(toCsv(['value'], [['-1+2'], ['-5'], ['+1+2'], ['@SUM(A1)'], ['\t=1+2'], [-5], [1.5]]), "value\n'-1+2\n'-5\n'+1+2\n'@SUM(A1)\n'\t=1+2\n-5\n1.5")
  })

  await check('agentenkénti hozzáférés: alapérték, felülírás, hibás érték eldobva', () => {
    const settings = readWarehouseSettings({ warehouse: { defaultAgentAccess: 'read', agentAccess: { a1: 'off', a2: 'bogus' } } })
    assert.equal(warehouseAccessForAgent(settings, 'a1'), 'off')
    assert.equal(warehouseAccessForAgent(settings, 'a2'), 'read')
    assert.equal(warehouseAccessForAgent(readWarehouseSettings(null), 'x'), 'import')
  })

  await check('Hermes Bot eszközlistája a munkatárs adattárház-szintjét követi', () => {
    assert.deepEqual(hermesWarehouseTools('off'), [])
    assert.ok(hermesWarehouseTools('read').includes('warehouse.query_dataset'))
    assert.ok(!hermesWarehouseTools('read').some((tool) => !WAREHOUSE_READ_ONLY_TOOLS.has(tool)))
    assert.deepEqual([...hermesWarehouseTools('import')].sort(), [...WAREHOUSE_TOOLS].sort())
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nMinden warehouse teszt zöld')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
