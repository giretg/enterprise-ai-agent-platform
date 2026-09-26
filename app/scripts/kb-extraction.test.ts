/**
 * Determinisztikus teszt a KB-v3 Sprint 2 extraction pipeline-hoz (§7.3/§7.4).
 * Futtatás: npm run test:kb-extraction
 *
 * DB NÉLKÜL fut. A formátumfüggő forrás-provenance-ot igazolja:
 *  - XLSX  → cella-tartomány (`Sheet!A1:..`)  — valós exceljs bufferből,
 *  - PDF   → oldal-szint (`page`)             — valós pdf-lib bufferből,
 *  - DOCX  → heading/section-út               — tiszta HTML→section parser,
 *  - text  → section (heading),
 * majd az end-to-end round-tripet: extraction-blokkok → buildOkfBundle →
 * chunkOkfBundle, ahol a chunk sourceRef megőrzi az oldal/section/cella locus-t.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  extractStructured,
  extractTextContent,
  htmlToSections,
  extractHtml,
  columnLetter,
  toExtractionMetadata,
  readExtractionBlocks,
} from '../src/lib/kb-extraction'
import { buildOkfBundle, chunkOkfBundle, type OkfSourceRef } from '../src/lib/kb-v3'
import ExcelJS from 'exceljs'

async function xlsxCreate(sheets: Array<{ name: string; rows: unknown[][] }>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  for (const sheet of sheets) workbook.addWorksheet(sheet.name).addRows(sheet.rows)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function run() {
  console.log('=== KB-v3 Sprint 2 extraction pipeline teszt ===')

  await check('extractHtml: CSS/SVG/script nélkül, headingek mentén, cellák elválasztva', async () => {
    const html = `<!doctype html><html><head><title>t</title><style>:root{--lila:#5834B2}</style></head>
<body><h1>Branding guide</h1><p>Bevezető</p>
<h2><span class="num">1</span>Színpaletta</h2><table><tr><td>Mély lila</td><td>#5834B2</td></tr></table>
<svg><text>SVGZAJ</text></svg><script>var zaj = 1</script></body></html>`
    const out = extractHtml(html)
    assert.equal(out.format, 'html')
    assert.deepEqual(out.blocks.map((b) => b.heading), ['Branding guide', '1 Színpaletta'])
    assert.doesNotMatch(out.markdown, /--lila|SVGZAJ|var zaj|<\w/)
    assert.match(out.markdown, /Mély lila \| #5834B2/)
    const viaUpload = await extractStructured({ buffer: Buffer.from(html), filename: 'guide.html' })
    assert.equal(viaUpload.format, 'html')
  })

  await check('columnLetter: 1→A, 26→Z, 27→AA', () => {
    assert.equal(columnLetter(1), 'A')
    assert.equal(columnLetter(5), 'E')
    assert.equal(columnLetter(26), 'Z')
    assert.equal(columnLetter(27), 'AA')
    assert.equal(columnLetter(0), 'A') // clamp
  })

  await check('text/markdown → heading-szintű blokkok, section source ref', () => {
    const ex = extractTextContent('# Remote Work\nRules here.\n\n# Onboarding\nSteps here.')
    assert.equal(ex.format, 'text')
    assert.equal(ex.blocks.length, 2)
    assert.equal(ex.blocks[0].heading, 'Remote Work')
    assert.equal(ex.blocks[0].sourceRef.section, 'Remote Work')
    assert.ok(ex.blocks[0].text.includes('Rules here'))
    assert.equal(ex.blocks[1].sourceRef.section, 'Onboarding')
  })

  await check('text heading nélkül → egyetlen „Dokumentum" blokk', () => {
    const ex = extractTextContent('csak sima szöveg, nincs heading')
    assert.equal(ex.blocks.length, 1)
    assert.equal(ex.blocks[0].heading, 'Dokumentum')
    assert.ok(ex.blocks[0].text.includes('sima szöveg'))
  })

  await check('DOCX HTML → section-blokkok (preamble + heading-szekciók)', () => {
    const html =
      '<p>Bevezető mondat.</p>' +
      '<h1>Szabályok</h1><p>Első szabály.</p><ul><li>alpont A</li><li>alpont B</li></ul>' +
      '<h1>Kivételek</h1><p>HR kezeli.</p>'
    const blocks = htmlToSections(html)
    assert.equal(blocks.length, 3, 'bevezetés + 2 szekció')
    assert.equal(blocks[0].heading, 'Bevezetés')
    assert.ok(blocks[0].text.includes('Bevezető mondat'))
    assert.equal(blocks[1].heading, 'Szabályok')
    assert.equal(blocks[1].sourceRef.section, 'Szabályok')
    assert.ok(blocks[1].text.includes('Első szabály'))
    assert.ok(blocks[1].text.includes('- alpont A'), 'lista bulletként')
    assert.equal(blocks[2].heading, 'Kivételek')
  })

  await check('DOCX HTML entity-decode + heading nélküli fallback', () => {
    const one = htmlToSections('<p>A &amp; B &lt;x&gt;</p>')
    assert.equal(one.length, 1)
    assert.equal(one[0].heading, 'Bevezetés')
    assert.ok(one[0].text.includes('A & B <x>'))
    const empty = htmlToSections('')
    assert.equal(empty.length, 1)
    assert.equal(empty[0].heading, 'Dokumentum')
  })

  await check('XLSX → cella-tartomány source ref valós bufferből', async () => {
    const buffer = await xlsxCreate([
      {
        name: 'Dolgozok',
        rows: [
          ['Nev', 'Reszleg', 'Statusz'],
          ['Anna', 'HR', 'aktiv'],
          ['Bela', 'IT', 'aktiv'],
        ],
      },
    ])
    const ex = await extractStructured({ buffer, filename: 'lista.xlsx' })
    assert.equal(ex.format, 'xlsx')
    assert.equal(ex.blocks.length, 1)
    assert.equal(ex.blocks[0].heading, 'Dolgozok')
    assert.equal(ex.blocks[0].sourceRef.cell, 'Dolgozok!A1:C3', 'cella-tartomány (§4.7)')
    assert.ok(ex.blocks[0].text.includes('Reszleg'))
    assert.ok(ex.blocks[0].text.includes('Bela'))
  })

  await check('PDF → oldal-szintű source ref valós PDF-fixture-ből', async () => {
    const buffer = readFileSync(
      path.resolve(__dirname, 'fixtures/file-editor/sample.pdf'),
    )
    const ex = await extractStructured({ buffer, filename: 'sample.pdf' })
    assert.equal(ex.format, 'pdf')
    assert.ok(ex.blocks.length >= 1, 'legalább egy oldal')
    assert.equal(ex.blocks[0].sourceRef.page, 1, 'oldal-szintű forrás (§4.7)')
    assert.equal(ex.blocks[0].heading, 'Oldal 1')
    assert.ok(ex.blocks[0].text.length > 0, 'oldal szövege kereshető')
  })

  await check('end-to-end: blokkok → buildOkfBundle → chunk sourceRef megőrzi a locus-t', () => {
    const bundle = buildOkfBundle({
      filename: 'hr.pdf',
      extractedText: null,
      connectorId: 'kb-conn-1',
      sourceDocumentId: 'doc-1',
      blocks: [
        { heading: 'Oldal 1', text: 'Remote work engedélyezett.', sourceRef: { page: 1 } },
        { heading: 'Oldal 2', text: 'HR kezeli a kivételt.', sourceRef: { page: 2 } },
      ],
    })
    // Minden oldal frontmatterében ott a gép-olvasható source_ref.
    const p1 = bundle.files.find((f) => f.path.endsWith('01-oldal-1.md'))
    assert.ok(p1, 'oldal 1 fájl')
    assert.ok(p1.content.includes('source_ref: {"page":1}'))
    assert.ok(p1.content.includes(', oldal 1'), 'ember-olvasható forrás-locus')

    const source: OkfSourceRef = { documentId: 'doc-1', filename: 'hr.pdf' }
    const chunks = chunkOkfBundle(bundle, source)
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].sourceRef?.page, 1)
    assert.equal(chunks[0].sourceRef?.filename, 'hr.pdf')
    assert.equal(chunks[0].sourceRef?.documentId, 'doc-1')
    assert.equal(chunks[1].sourceRef?.page, 2)
  })

  await check('end-to-end: XLSX cella-ref átmegy a chunkba', () => {
    const bundle = buildOkfBundle({
      filename: 'lista.xlsx',
      extractedText: null,
      connectorId: 'c',
      blocks: [{ heading: 'Sheet1', text: 'A\tB\n1\t2', sourceRef: { cell: 'Sheet1!A1:B2' } }],
    })
    const chunks = chunkOkfBundle(bundle, { documentId: 'd', filename: 'lista.xlsx' })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].sourceRef?.cell, 'Sheet1!A1:B2')
  })

  await check('backward-compat: blocks nélkül heading-split, section-ref', () => {
    const bundle = buildOkfBundle({
      filename: 'legacy.md',
      extractedText: '# Bevezetés\nSzöveg.\n\n# Szabályok\nTöbb szöveg.',
      connectorId: 'c',
    })
    const chunks = chunkOkfBundle(bundle, { documentId: 'd', filename: 'legacy.md' })
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].sourceRef?.section, 'Bevezetés')
    assert.equal(chunks[0].sourceRef?.page, undefined)
  })

  await check('readExtractionMetadata round-trip (metadata → blocks)', () => {
    const ex = extractTextContent('# A\nalfa\n\n# B\nbéta')
    const meta = { extraction: toExtractionMetadata(ex) }
    const back = readExtractionBlocks(meta)
    assert.ok(back)
    assert.equal(back.length, 2)
    assert.equal(back[0].heading, 'A')
    assert.equal(back[0].sourceRef.section, 'A')
    // rossz / hiányzó metadata → null (legacy doc)
    assert.equal(readExtractionBlocks({}), null)
    assert.equal(readExtractionBlocks(null), null)
    assert.equal(readExtractionBlocks({ extraction: { blocks: 'nope' } }), null)
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exit(1)
}

run()
