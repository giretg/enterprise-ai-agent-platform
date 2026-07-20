/**
 * XLSX legördülő választólista (data validation) — formula-építés + tartomány-alkalmazás.
 * Run: npx tsx scripts/xlsx-data-validation.test.ts
 */
import assert from 'node:assert/strict'
import {
  dataValidationFormula,
  xlsxApplyLayout,
  xlsxCreate,
  XLSX_DATA_VALIDATION_MAX_FORMULA,
} from '../src/domain/file-editor/adapters/xlsx-adapter'
import { FileEditorError } from '../src/domain/file-editor/workspace-storage'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  const done = (e?: unknown) => {
    if (e) {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
    } else console.log(`  ✅ ${name}`)
  }
  try {
    const r = fn()
    if (r instanceof Promise) return r.then(() => done()).catch(done)
    done()
  } catch (e) {
    done(e)
  }
  return Promise.resolve()
}

const STATUSES = ['Rendben', 'Módosítás szükséges', 'Törlés szükséges', 'Új rekord']

async function loadSheet(buf: Buffer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('exceljs')
  const wb = new (mod.default?.Workbook ?? mod.Workbook)()
  await wb.xlsx.load(buf)
  return wb.getWorksheet(name)
}

async function main() {
  // ── formula-építés ────────────────────────────────────────────────────────
  await check('a lista idézőjelbe zárt, vesszővel elválasztott formulává áll össze', () => {
    assert.equal(dataValidationFormula(['a', 'b']), '"a,b"')
  })

  await check('az egyeztetési státuszok beleférnek a 255-ös korlátba', () => {
    const f = dataValidationFormula(STATUSES)
    assert.ok(f.length <= XLSX_DATA_VALIDATION_MAX_FORMULA, `${f.length} karakter`)
  })

  await check('üres lista elutasítva', () => {
    assert.throws(() => dataValidationFormula([]), (e) => e instanceof FileEditorError)
  })

  await check('vesszős érték elutasítva (kettészakadna két opcióra)', () => {
    assert.throws(
      () => dataValidationFormula(['Rendben', 'Módosítás, sürgős']),
      (e) => e instanceof FileEditorError && /vessz/i.test(e.message),
    )
  })

  await check('idézőjeles érték elutasítva', () => {
    assert.throws(
      () => dataValidationFormula(['a"b']),
      (e) => e instanceof FileEditorError,
    )
  })

  await check('255 karakter fölött elutasítva, nem csonkolva', () => {
    const many = Array.from({ length: 40 }, (_, i) => `hosszu-ertek-${i}`)
    assert.throws(
      () => dataValidationFormula(many),
      (e) => e instanceof FileEditorError && /255/.test(e.message),
    )
  })

  // ── tartomány-alkalmazás ──────────────────────────────────────────────────
  const base = await xlsxCreate([{ name: 'Egyeztetés', rows: [['Tulajdonos', 'Státusz']] }])

  await check('a legördülő a megadott tartomány MINDEN cellájára felkerül', async () => {
    const out = await xlsxApplyLayout(
      base,
      { dataValidations: [{ range: 'B2:B50', values: STATUSES, errorTitle: 'Érvénytelen' }] },
      'Egyeztetés',
    )
    const ws = await loadSheet(out, 'Egyeztetés')
    for (const cell of ['B2', 'B25', 'B50']) {
      const dv = ws.getCell(cell).dataValidation
      assert.ok(dv, `${cell}: nincs validáció`)
      assert.equal(dv.type, 'list')
      assert.deepEqual(dv.formulae, ['"Rendben,Módosítás szükséges,Törlés szükséges,Új rekord"'])
    }
    assert.equal(ws.getCell('B2').dataValidation.errorTitle, 'Érvénytelen')
  })

  await check('a tartományon kívülre NEM kerül validáció', async () => {
    const out = await xlsxApplyLayout(
      base,
      { dataValidations: [{ range: 'B2:B50', values: STATUSES }] },
      'Egyeztetés',
    )
    const ws = await loadSheet(out, 'Egyeztetés')
    assert.ok(!ws.getCell('B51').dataValidation, 'B51 alá is beszivárgott')
    assert.ok(!ws.getCell('A2').dataValidation, 'A oszlopba is beszivárgott')
  })

  await check('allowBlank alapból igaz — a kitöltetlen sor nem hibás', async () => {
    const out = await xlsxApplyLayout(
      base,
      { dataValidations: [{ range: 'B2:B3', values: STATUSES }] },
      'Egyeztetés',
    )
    const ws = await loadSheet(out, 'Egyeztetés')
    assert.equal(ws.getCell('B2').dataValidation.allowBlank, true)
  })

  await check('allowBlank: false — az üres cella nem engedett', async () => {
    // OOXML-ben az `allowBlank` alapértéke hamis, ezért a generált XML-ből az
    // attribútum KIMARAD, ha false. Visszaolvasva emiatt `undefined` — a
    // jelentés viszont helyes. A szemantikára állítunk, nem a reprezentációra.
    const out = await xlsxApplyLayout(
      base,
      { dataValidations: [{ range: 'B2:B3', values: STATUSES, allowBlank: false }] },
      'Egyeztetés',
    )
    const ws = await loadSheet(out, 'Egyeztetés')
    assert.ok(!ws.getCell('B2').dataValidation.allowBlank)
  })

  await check('érvénytelen lista esetén a munkafüzet NEM módosul félig', async () => {
    // A formula-hiba a tartomány bejárása előtt jön; az első (érvényes) validáció
    // sem íródhat ki, ha a másodikban hiba van.
    await assert.rejects(
      xlsxApplyLayout(
        base,
        {
          dataValidations: [
            { range: 'B2:B3', values: STATUSES },
            { range: 'C2:C3', values: ['jó', 'rossz, nagyon'] },
          ],
        },
        'Egyeztetés',
      ),
      (e) => e instanceof FileEditorError,
    )
  })

  await check('a meglévő elrendezés (autoFilter, freeze) megmarad mellette', async () => {
    const out = await xlsxApplyLayout(
      base,
      {
        autoFilter: 'A1:B1',
        freeze: { rows: 1 },
        columnWidths: [{ column: 'A', width: 30 }],
        dataValidations: [{ range: 'B2:B10', values: STATUSES }],
      },
      'Egyeztetés',
    )
    const ws = await loadSheet(out, 'Egyeztetés')
    assert.equal(ws.autoFilter, 'A1:B1')
    assert.equal(ws.views[0].state, 'frozen')
    assert.equal(ws.getColumn(1).width, 30)
    assert.ok(ws.getCell('B5').dataValidation)
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
