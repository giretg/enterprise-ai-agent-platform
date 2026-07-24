/**
 * tulajdoni_lap oldalforrás — extraction / markdown vs PDF buffer.
 * Run: npx tsx scripts/tulajdoni-lap-pages.test.ts
 */
import assert from 'node:assert/strict'
import {
  bufferLooksLikePdf,
  pagesFromDocumentExtraction,
} from '../src/lib/tulajdoni-lap-pages'
import { parseTulajdoniLap } from '../src/lib/tulajdoni-lap'

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

const MARKDOWN = [
  '# Oldal 1',
  '',
  'INYER/TULLAP/20260716/13866',
  '2026.07.16',
  'Külterület, 43/15 helyrajzi szám',
  'SZÉLJEGYZÉK',
  'Széljegy: INYER/2026/824725',
  'I. RÉSZ',
  '1. Bejegyző határozat, érkezési idő:',
  '39829/2018.06.04',
  '. Szántó 82 8770 1965,4',
  'II. RÉSZ',
  'Bejegyző határozat, érkezési idő:',
  '11111/2010.01.01',
  '1.',
  'Tulajdonjog',
  'Jogállás: TULAJDONOS',
  'Tulajdoni hányad: 1/1',
  'Jogváltozás jogcíme: adásvétel',
  'Név: Kovács Béla, Születési év: 1950, Anyja neve: Nagy Mária',
  'Jogosult címe: 1111 Budapest',
  '',
  '# Oldal 2',
  '',
  'III. RÉSZ',
].join('\n')

check('metadata extraction blocks → ordered page texts', () => {
  const pages = pagesFromDocumentExtraction(
    {
      extraction: {
        format: 'pdf',
        blocks: [
          { heading: 'Oldal 2', text: 'második', sourceRef: { page: 2 } },
          { heading: 'Oldal 1', text: 'első', sourceRef: { page: 1 } },
        ],
      },
    },
    null,
  )
  assert.deepEqual(pages, ['első', 'második'])
})

check('legacy extractedText markdown (# Oldal N) → pages', () => {
  const pages = pagesFromDocumentExtraction(null, MARKDOWN)
  assert.equal(pages.length, 2)
  assert.match(pages[0], /INYER\/TULLAP/)
  assert.match(pages[1], /III\. RÉSZ/)
})

check('chat storage markdown (nem PDF) parse-olható extractionből', () => {
  // Ez a valós hibaút: storageRef = kinyert markdown, nem PDF bináris.
  const pages = pagesFromDocumentExtraction(null, MARKDOWN)
  const parsed = parseTulajdoniLap(pages)
  assert.equal(parsed.meta.ugyazonosito, 'INYER/TULLAP/20260716/13866')
  assert.equal(parsed.osszesites.resz2Hatalyos, 1)
  assert.equal(parsed.tulajdonosok[0]?.nev, 'Kovács Béla')
})

check('bufferLooksLikePdf: valódi fejléc', () => {
  assert.equal(bufferLooksLikePdf(Buffer.from('%PDF-1.7\n…')), true)
  assert.equal(bufferLooksLikePdf(Buffer.from('  \n%PDF-1.4')), true)
})

check('bufferLooksLikePdf: markdown / üres → false', () => {
  assert.equal(bufferLooksLikePdf(Buffer.from(MARKDOWN, 'utf8')), false)
  assert.equal(bufferLooksLikePdf(Buffer.from('')), false)
  assert.equal(bufferLooksLikePdf(Buffer.from('PK\x03\x04')), false)
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
