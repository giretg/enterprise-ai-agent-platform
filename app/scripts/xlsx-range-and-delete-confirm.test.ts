/**
 * XLSX A1 range + deliverable delete confirm.
 * Run: npx tsx scripts/xlsx-range-and-delete-confirm.test.ts
 */
import assert from 'node:assert/strict'
import { parseA1Range } from '../src/domain/file-editor/adapters/xlsx-adapter'
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
