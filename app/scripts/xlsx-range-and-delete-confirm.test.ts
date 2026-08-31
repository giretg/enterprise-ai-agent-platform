/**
 * XLSX A1 range + deliverable delete confirm.
 * Run: npx tsx scripts/xlsx-range-and-delete-confirm.test.ts
 */
import assert from 'node:assert/strict'
import {
  parseA1Range,
  XLSX_MAX_RANGE_CELLS,
} from '../src/domain/file-editor/adapters/xlsx-adapter'
import { requiresDeleteConfirm } from '../src/domain/file-editor/delete-confirm-policy'
import { FileEditorError } from '../src/domain/file-editor/workspace-storage'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

check('single-cell A1 range accepted', () => {
  assert.deepEqual(parseA1Range('A1'), { c1: 1, r1: 1, c2: 1, r2: 1 })
})

check('normal A1:E1 range', () => {
  assert.deepEqual(parseA1Range('A1:E1'), { c1: 1, r1: 1, c2: 5, r2: 1 })
})

check('invalid range still throws', () => {
  assert.throws(() => parseA1Range(''), (err) => err instanceof FileEditorError)
})

check('full-sheet range is rejected (DoS guard)', () => {
  // "A1:XFD1048576" = 16384×1048576 ≈ 17 milliárd cella — plafon nélkül a
  // formázó/elrendezés-ciklus lefagyasztaná a megosztott futásidőt.
  assert.throws(
    () => parseA1Range('A1:XFD1048576'),
    (err) => err instanceof FileEditorError && err.code === 'INVALID_RANGE',
  )
})

check('range just over the cell cap is rejected', () => {
  // 1 oszlop × (plafon+1) sor: pontosan a terület-plafon fölött.
  const rows = XLSX_MAX_RANGE_CELLS + 1
  assert.throws(
    () => parseA1Range(`A1:A${rows}`),
    (err) => err instanceof FileEditorError && err.code === 'INVALID_RANGE',
  )
})

check('range beyond Excel bounds is rejected', () => {
  // Excel-korláton túli sorszám — a módosítás megkezdése előtt hibázik.
  assert.throws(
    () => parseA1Range('A1:A2000000'),
    (err) => err instanceof FileEditorError && err.code === 'INVALID_RANGE',
  )
})

check('realistic table range stays under the cap', () => {
  // 500 sor × 50 oszlop = 25 000 cella — bőven a plafon (250 000) alatt.
  assert.deepEqual(parseA1Range('A1:AX500'), { c1: 1, r1: 1, c2: 50, r2: 500 })
})

check('xlsx/docx/pptx require delete confirm', () => {
  assert.equal(requiresDeleteConfirm('audit.xlsx'), true)
  assert.equal(requiresDeleteConfirm('report.DOCX'), true)
  assert.equal(requiresDeleteConfirm('deck.pptx'), true)
  assert.equal(requiresDeleteConfirm('notes.txt'), false)
  assert.equal(requiresDeleteConfirm('source.pdf'), false)
})

if (failures > 0) {
  console.error(`\n${failures} xlsx-range-and-delete-confirm test(s) failed`)
  process.exit(1)
}
console.log('\nxlsx-range-and-delete-confirm tests passed')
