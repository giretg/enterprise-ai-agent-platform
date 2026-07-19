/**
 * Nagy PDF pdf_read policy — tiszta unit tesztek (pdf-parse nélkül).
 * Run: npx tsx scripts/pdf-read-policy.test.ts
 */
import assert from 'node:assert/strict'
import {
  PDF_READ_MAX_PAGES_PER_CALL,
  PDF_READ_UNRANGED_PAGE_CAP,
  resolvePdfReadWindow,
} from '../src/domain/file-editor/adapters/pdf-read-policy'

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

check('kis PDF page_range nélkül: teljes olvasás', () => {
  const w = resolvePdfReadWindow({ numPages: 8 })
  assert.deepEqual(w, { start: 1, end: 8, truncated: false, notice: null })
})

check('nagy PDF page_range nélkül: prefix + truncated', () => {
  const w = resolvePdfReadWindow({ numPages: 237 })
  assert.equal(w.start, 1)
  assert.equal(w.end, PDF_READ_UNRANGED_PAGE_CAP)
  assert.equal(w.truncated, true)
  assert.match(w.notice ?? '', /page_range/)
})

check('page_range a max alatt: változatlan', () => {
  const w = resolvePdfReadWindow({ numPages: 100, pageRange: '40-50' })
  assert.deepEqual(w, { start: 40, end: 50, truncated: false, notice: null })
})

check('túl széles page_range: max oldal / hívás', () => {
  const w = resolvePdfReadWindow({ numPages: 237, pageRange: '1-237' })
  assert.equal(w.start, 1)
  assert.equal(w.end, PDF_READ_MAX_PAGES_PER_CALL)
  assert.equal(w.truncated, true)
  assert.match(w.notice ?? '', /max/)
})

check('egyetlen oldal page_range', () => {
  const w = resolvePdfReadWindow({ numPages: 50, pageRange: '12' })
  assert.deepEqual(w, { start: 12, end: 12, truncated: false, notice: null })
})

if (failures > 0) {
  console.error(`\n${failures} pdf-read-policy test(s) failed`)
  process.exit(1)
}
console.log('\npdf-read-policy tests passed')
