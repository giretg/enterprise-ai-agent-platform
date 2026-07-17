/**
 * document_read tiszta mag — oldal/keresés csatolmányokon.
 * Futtatás: npm run test:document-read
 */
import assert from 'node:assert/strict'
import {
  blocksFromDocument,
  parseDocumentPageRange,
  readDocumentPages,
  attachmentPageCount,
  DOCUMENT_READ_DEFAULT_MAX_CHARS,
} from '../src/lib/document-read'
import type { ExtractedBlock } from '../src/lib/kb-v3'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const sampleBlocks: ExtractedBlock[] = [
  { heading: 'Oldal 1', text: 'Tulajdoni lap fejléc. Helyrajzi szám: 043/15.', sourceRef: { page: 1 } },
  { heading: 'Oldal 2', text: 'Tulajdonos: Kovács János. Terület: 2 ha.', sourceRef: { page: 2 } },
  { heading: 'Oldal 3', text: 'Teher: jelzálog. Bank: XYZ.', sourceRef: { page: 3 } },
  { heading: 'Oldal 4', text: 'Egyéb megjegyzések.', sourceRef: { page: 4 } },
]

function run() {
  console.log('=== document_read ===')

  check('parseDocumentPageRange: single + span + clamp', () => {
    assert.deepEqual(parseDocumentPageRange('2', 10), { start: 2, end: 2 })
    assert.deepEqual(parseDocumentPageRange('1-3', 10), { start: 1, end: 3 })
    assert.deepEqual(parseDocumentPageRange('8-12', 10), { start: 8, end: 10 })
    assert.equal('error' in parseDocumentPageRange('0', 10), true)
    assert.equal('error' in parseDocumentPageRange('99', 10), true)
    assert.equal('error' in parseDocumentPageRange('abc', 10), true)
  })

  check('blocksFromDocument: metadata.extraction.blocks', () => {
    const blocks = blocksFromDocument(
      { extraction: { format: 'pdf', blocks: sampleBlocks } },
      null,
    )
    assert.equal(blocks.length, 4)
    assert.equal(blocks[0].sourceRef.page, 1)
  })

  check('blocksFromDocument: # Oldal N markdown fallback', () => {
    const md = '# Oldal 1\n\nAlpha\n\n# Oldal 2\n\nBeta'
    const blocks = blocksFromDocument({}, md)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].sourceRef.page, 1)
    assert.ok(blocks[0].text.includes('Alpha'))
    assert.ok(blocks[1].text.includes('Beta'))
  })

  check('readDocumentPages: pages range', () => {
    const r = readDocumentPages({
      documentId: 'd1',
      filename: 'deed.pdf',
      blocks: sampleBlocks,
      pages: '2-3',
    })
    assert.equal(r.totalPages, 4)
    assert.equal(r.pages.length, 2)
    assert.equal(r.pages[0].page, 2)
    assert.ok(r.pages[0].text.includes('Kovács'))
    assert.equal(r.truncated, false)
  })

  check('readDocumentPages: query finds page', () => {
    const r = readDocumentPages({
      documentId: 'd1',
      filename: 'deed.pdf',
      blocks: sampleBlocks,
      query: '043/15',
    })
    assert.equal(r.matchCount, 1)
    assert.equal(r.pages.length, 1)
    assert.equal(r.pages[0].page, 1)
  })

  check('readDocumentPages: query + pages intersect', () => {
    const r = readDocumentPages({
      documentId: 'd1',
      filename: 'deed.pdf',
      blocks: sampleBlocks,
      query: 'teher',
      pages: '1-2',
    })
    assert.equal(r.pages.length, 0)
    assert.equal(r.matchCount, 1)
  })

  check('readDocumentPages: default first pages + maxChars truncate', () => {
    const long: ExtractedBlock[] = [
      {
        heading: 'Oldal 1',
        text: 'X'.repeat(DOCUMENT_READ_DEFAULT_MAX_CHARS + 500),
        sourceRef: { page: 1 },
      },
    ]
    const r = readDocumentPages({
      documentId: 'd1',
      filename: 'big.pdf',
      blocks: long,
    })
    assert.equal(r.truncated, true)
    assert.ok(r.pages[0].text.length <= DOCUMENT_READ_DEFAULT_MAX_CHARS)
    assert.ok(r.hint)
  })

  check('attachmentPageCount', () => {
    assert.equal(attachmentPageCount({ extraction: { blocks: sampleBlocks } }, null), 4)
    assert.equal(attachmentPageCount({}, null), 0)
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nAll passed')
}

run()
