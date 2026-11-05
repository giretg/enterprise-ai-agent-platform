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
import {
  extractStructured,
  extractTextContent,
  htmlToSections,
  extractHtml,
  columnLetter,
  toExtractionMetadata,
  readExtractionBlocks,
  pdfTextQuality,
  pdfPageQuality,
  pdfQualityHint,
  KbFileRejectedError,
  kbFileErrorCode,
} from '../src/lib/kb-extraction'
import { OfficeArchiveError } from '../src/lib/office-archive-guard'
import huMessages from '../src/messages/hu.json'
import enMessages from '../src/messages/en.json'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { buildOkfBundle, chunkOkfBundle, type OkfSourceRef } from '../src/lib/kb-v3'
import ExcelJS from 'exceljs'
import { kbPdfFixtures } from './fixtures/kb-pdf'
import { parsePdfPages, renderPdfPages } from '../src/lib/kb-pdf-images'

async function xlsxCreate(sheets: Array<{ name: string; rows: unknown[][] }>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  for (const sheet of sheets) workbook.addWorksheet(sheet.name).addRows(sheet.rows)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** Kézi PPTX: a diasorrend és a jegyzet-kötés a fájlnevektől függetlenül ellenőrizhető. */
async function handmadePptx(input: {
  order: string[]
  slides: Record<string, string>
  notes?: Record<string, string>
  absoluteTargets?: boolean
}): Promise<Buffer> {
  const zip = new JSZip()
  const target = (name: string) => (input.absoluteTargets ? `/ppt/slides/${name}` : `slides/${name}`)
  zip.file('ppt/presentation.xml', `<p:presentation><p:sldIdLst>${input.order
    .map((name, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${input.order
    .map((name, index) => `<Relationship Target="${target(name)}" Type="${REL}/slide" Id="rId${index + 1}"/>`).join('')}</Relationships>`)
  for (const [name, xml] of Object.entries(input.slides)) zip.file(`ppt/slides/${name}`, xml)
  for (const [name, xml] of Object.entries(input.notes ?? {})) {
    zip.file(`ppt/notesSlides/notes-${name}`, xml)
    zip.file(`ppt/slides/_rels/${name}.rels`, `<Relationships><Relationship Id="rId9" Type="${REL}/notesSlide" Target="../notesSlides/notes-${name}"/></Relationships>`)
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function textShape(text: string, placeholder?: string) {
  const ph = placeholder ? `<p:nvSpPr><p:nvPr><p:ph type="${placeholder}"/></p:nvPr></p:nvSpPr>` : ''
  return `<p:sp>${ph}<p:txBody><a:bodyPr/><a:p><a:pPr/><a:r><a:rPr lang="hu"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
}

const slideXml = (body: string, attrs = '') => `<?xml version="1.0"?><p:sld ${attrs}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`

async function rejectionCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return kbFileErrorCode(error)
  }
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
    const { text: buffer } = await kbPdfFixtures()
    const ex = await extractStructured({ buffer, filename: 'sample.pdf' })
    assert.equal(ex.format, 'pdf')
    assert.ok(ex.blocks.length >= 1, 'legalább egy oldal')
    assert.equal(ex.blocks[0].sourceRef.page, 1, 'oldal-szintű forrás (§4.7)')
    assert.equal(ex.blocks[0].heading, 'Oldal 1')
    assert.ok(ex.blocks[0].text.length > 0, 'oldal szövege kereshető')
  })

  await check('PDF quality: text=ok, scan=no_text, mixed preserves every page and metadata', async () => {
    const fixtures = await kbPdfFixtures()
    for (const [name, expected] of [
      ['text', ['ok']], ['scanned', ['no_text']], ['mixed', ['ok', 'no_text', 'low_text']],
    ] as const) {
      const ex = await extractStructured({ buffer: fixtures[name], filename: `${name}.pdf` })
      const metadata = { extraction: toExtractionMetadata(ex) }
      assert.deepEqual(ex.blocks.map((b) => b.textQuality), expected)
      assert.deepEqual(pdfPageQuality(metadata).map((p) => p.textQuality), expected)
      assert.deepEqual(pdfPageQuality(metadata).map((p) => p.page), expected.map((_, i) => i + 1))
      assert.equal(!!pdfQualityHint(pdfPageQuality(metadata)), name !== 'text')
    }
    assert.equal(pdfTextQuality('  \n '), 'no_text')
    assert.equal(pdfTextQuality('!'.repeat(100) + 'normal words'), 'low_text')
    assert.equal(pdfTextQuality('中文文档内容'.repeat(12)), 'ok')
  })

  await check('PDF page ranges are bounded before expanding or rendering', async () => {
    assert.deepEqual(parsePdfPages('1-3,3,7'), [1, 2, 3, 7])
    assert.deepEqual(parsePdfPages(), [1])
    for (const bad of ['', '0', '-1', '2-1', '1.5', '1,,2', 'Infinity', '9007199254740992']) {
      assert.throws(() => parsePdfPages(bad), { code: 'invalid_pages' })
    }
    for (const bad of ['1-6', '1-5,7', '1-999999999']) {
      assert.throws(() => parsePdfPages(bad), { code: 'too_many_pages' })
    }
    const { mixed } = await kbPdfFixtures()
    await assert.rejects(renderPdfPages(mixed, '4'), { code: 'invalid_pages' })
    const result = await renderPdfPages(mixed, '1-2')
    assert.deepEqual(result.images.map((p) => p.page), [1, 2])
    assert.equal(result.totalPages, 3)
    for (const image of result.images) {
      const png = Buffer.from(image.data, 'base64')
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.ok(Math.max(image.width, image.height) <= 1600)
      assert.ok(png.byteLength < 5 * 1024 * 1024)
    }
    const landscape = await renderPdfPages(mixed, '3')
    assert.ok(Math.max(landscape.images[0].width, landscape.images[0].height) <= 1600)
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

  await check('PPTX: valódi PowerPoint-szerkezetből diánként olvasható szöveg, táblázattal és jegyzettel', async () => {
    const deck = new PptxGenJS()
    const first = deck.addSlide()
    first.addText('Heti státusz', { x: 1, y: 1, w: 6, h: 1 })
    first.addNotes('Ezt élőben mondom el')
    const second = deck.addSlide()
    second.addTable([[{ text: 'Projekt' }, { text: 'Állapot' }], [{ text: 'Alfa' }, { text: 'Kész' }]], { x: 1, y: 1, w: 6 })
    const buffer = Buffer.from((await deck.write({ outputType: 'nodebuffer' })) as Buffer)

    const ex = await extractStructured({ buffer, filename: 'Weekly_Status_02_11.pptx', mimeType: PPTX_MIME })
    assert.equal(ex.format, 'pptx')
    assert.equal(ex.blocks.length, 2)
    assert.equal(ex.blocks[0].heading, '1. dia')
    assert.equal(ex.blocks[0].sourceRef.section, '1. dia')
    assert.match(ex.blocks[0].text, /Heti státusz/)
    assert.match(ex.blocks[0].text, /Előadói jegyzet:\nEzt élőben mondom el/)
    assert.match(ex.blocks[1].text, /Projekt \| Állapot\nAlfa \| Kész/)
    assert.match(ex.markdown, /## 2\. dia\n\nProjekt \| Állapot/)
    assert.ok(!ex.markdown.includes('\u0000'))
    assert.ok(!ex.markdown.includes('PK'))
  })

  await check('PPTX: a sorrendet a prezentáció adja, nem a fájlnév; cím, rejtett dia, zaj és jegyzet', async () => {
    const buffer = await handmadePptx({
      order: ['slide2.xml', 'slide10.xml', 'slide1.xml'],
      absoluteTargets: true,
      slides: {
        'slide1.xml': slideXml(textShape('Harmadik törzs')),
        'slide2.xml': slideXml(
          textShape('Bevezető &amp; cél', 'title') + textShape('El&#337;ször &lt;ez&gt;&#0;') + textShape('12', 'sldNum') + textShape('Lábléc', 'ftr'),
        ),
        'slide10.xml': slideXml(textShape('Tartalék anyag'), 'show="0"'),
      },
      notes: {
        'slide2.xml': slideXml(textShape('Jegyzet a bevezetőhöz', 'body') + textShape('3', 'sldNum')),
      },
    })
    const ex = await extractStructured({ buffer, filename: 'x.pptx' })
    assert.deepEqual(ex.blocks.map((block) => block.heading), ['1. dia: Bevezető & cél', '2. dia (rejtett)', '3. dia'])
    assert.equal(ex.blocks[0].text, 'Először <ez>\n\nElőadói jegyzet:\nJegyzet a bevezetőhöz')
    assert.equal(ex.blocks[1].text, 'Tartalék anyag')
    assert.equal(ex.blocks[2].text, 'Harmadik törzs')
  })

  await check('PPTX: az ismételt diahivatkozás nem sokszorozhatja meg a kibontott tartalmat', async () => {
    const buffer = await handmadePptx({
      order: Array(1000).fill('slide1.xml'),
      slides: { 'slide1.xml': slideXml(textShape('A'.repeat(10_000))) },
    })
    assert.equal(await rejectionCode(() => extractStructured({ buffer, filename: 'ismetelt.pptx' })), 'damaged_file')
  })

  await check('PPTX: több dia sem sokszorozhatja meg ugyanazt a jegyzetfájlt', async () => {
    const buffer = await handmadePptx({
      order: ['slide1.xml', 'slide2.xml'],
      slides: { 'slide1.xml': slideXml(textShape('Első')), 'slide2.xml': slideXml(textShape('Második')) },
      notes: { 'slide1.xml': slideXml(textShape('Jegyzet', 'body')) },
    })
    const zip = await JSZip.loadAsync(buffer)
    zip.file('ppt/slides/_rels/slide2.xml.rels', await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string'))
    const repeatedNotes = await zip.generateAsync({ type: 'nodebuffer' })
    assert.equal(await rejectionCode(() => extractStructured({ buffer: repeatedNotes, filename: 'jegyzet.pptx' })), 'damaged_file')
  })

  await check('PPTX: az XML-prefix nem változtatja meg a szöveget, a sorrendet vagy a jegyzeteket', async () => {
    const buffer = await handmadePptx({
      order: ['slide2.xml', 'slide1.xml'],
      slides: {
        'slide1.xml': slideXml(textShape('Második')),
        'slide2.xml': slideXml(textShape('Első', 'title') + textShape('Törzs')),
      },
      notes: { 'slide2.xml': slideXml(textShape('Jegyzet', 'body')) },
    })
    const zip = await JSZip.loadAsync(buffer)
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      const xml = (await entry.async('string'))
        .replace(/(<\/?)(p|a):/g, (_, start, prefix) => `${start}${prefix === 'p' ? 'x' : 'd'}:`)
        .replace(/r:id=/g, 'link:id=')
        .replace(/<(x:sld|x:presentation)(?=[\s>])/, `<$1 xmlns:x="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:link="${REL}"`)
        .replace(/(<\/?)(Relationships?)(?=[\s>])/g, '$1rel:$2')
        .replace('<rel:Relationships', '<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships"')
      zip.file(path, xml)
    }
    const alternative = await zip.generateAsync({ type: 'nodebuffer' })
    assert.deepEqual(
      await extractStructured({ buffer: alternative, filename: 'prefix.pptx' }),
      await extractStructured({ buffer, filename: 'eredeti.pptx' }),
    )
  })

  await check('PPTX: kiterjesztés nélkül a MIME-típus is elég; szöveg nélküli dia jelölve', async () => {
    const buffer = await handmadePptx({
      order: ['slide1.xml', 'slide2.xml'],
      slides: { 'slide1.xml': slideXml(textShape('Van szöveg')), 'slide2.xml': slideXml('<p:pic/>') },
    })
    const ex = await extractStructured({ buffer, filename: 'feltoltes', mimeType: PPTX_MIME })
    assert.equal(ex.format, 'pptx')
    assert.match(ex.blocks[1].text, /nincs kiolvasható szöveg/)
  })

  await check('PPTX: csak képekből álló prezentáció érthető hibát ad', async () => {
    const buffer = await handmadePptx({ order: ['slide1.xml'], slides: { 'slide1.xml': slideXml('<p:pic/>') } })
    assert.equal(await rejectionCode(() => extractStructured({ buffer, filename: 'kepek.pptx' })), 'no_extractable_text')
    const noSlides = await handmadePptx({ order: [], slides: {} })
    assert.equal(await rejectionCode(() => extractStructured({ buffer: noSlides, filename: 'ures.pptx' })), 'no_extractable_text')
  })

  await check('sérült vagy jelszóval védett PPTX érthető hibát ad', async () => {
    assert.equal(await rejectionCode(() => extractStructured({ buffer: Buffer.from('not a zip'), filename: 'rossz.pptx' })), 'damaged_file')
  })

  await check('nem támogatott bináris fájl azonnali hibát ad, méretétől függetlenül', async () => {
    const binary = Buffer.concat([Buffer.from('\x89PNG'), Buffer.alloc(16), Buffer.from('adat')])
    for (const filename of ['kep.png', 'regi.ppt', 'regi.doc', 'csomag.zip', 'nev-nelkul']) {
      assert.equal(await rejectionCode(() => extractStructured({ buffer: binary, filename })), 'unsupported_file_type', filename)
    }
    assert.equal(await rejectionCode(() => extractStructured({ buffer: binary, filename: 'oldal.html' })), 'unsupported_file_type')
    await assert.rejects(() => extractStructured({ buffer: binary, filename: 'kep.png' }), KbFileRejectedError)
  })

  await check('a szövegfájlok továbbra is átmennek, a régi kódolású ékezetes CSV is', async () => {
    const legacy = Buffer.from([0x4e, 0xe9, 0x76, 0x3b, 0xf5, 0x0a, 0x41, 0x3b, 0x31]) // Név;ő (Windows-1250)
    const csv = await extractStructured({ buffer: legacy, filename: 'lista.csv' })
    assert.equal(csv.format, 'text')
    assert.match(csv.markdown, /A;1/)
    const md = await extractStructured({ buffer: Buffer.from('# Cím\nszöveg'), filename: 'x.md' })
    assert.equal(md.blocks[0].heading, 'Cím')
  })

  await check('kbFileErrorCode: csak a fájl hibáját nevezi meg, az egyéb hibát nem', () => {
    assert.equal(kbFileErrorCode(new OfficeArchiveError()), 'damaged_file')
    assert.equal(kbFileErrorCode(new Error('adatbázis hiba')), null)
  })

  await check('minden új hibakódnak van magyar és angol szövege', () => {
    for (const code of ['unsupported_file_type', 'no_extractable_text', 'damaged_file'] as const) {
      assert.ok(huMessages.ControlPlane.wiki.errors[code], `hu: ${code}`)
      assert.ok(enMessages.ControlPlane.wiki.errors[code], `en: ${code}`)
    }
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exit(1)
}

run()
