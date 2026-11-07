/**
 * #1136 §6: az illesztési szabály, a részlet és a maszkolás DB nélkül.
 * A szótöveket a Postgres `ts_lexize` adja; itt a mért értékeket rögzítjük (a valódi
 * szótárral a `wiki-search-db.test.ts` fut). Futtatás: npm run test:kb-text-match
 */
import assert from 'node:assert/strict'
import {
  KB_FOLD_FROM,
  KB_FOLD_TO,
  foldKbText,
  kbLiteralPattern,
  kbMatchRanges,
  kbQueryTerms,
  kbSnippet,
  kbStemForm,
  kbStripMarkdown,
  kbTermMatches,
  kbTermPattern,
  kbTextTerm,
} from '../src/lib/kb-text-match'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.stack : error}`)
  }
}

/** `ts_lexize('hungarian_stem', …)` mért eredménye. */
const HU: Record<string, string> = {
  kártyák: 'kártya',
  kártyát: 'kárty',
  kártya: 'kártya',
  levél: 'levél',
  levelek: 'level',
  ügyfelek: 'ügyfel',
  kódok: 'kód',
  terminálok: 'terminál',
  terminál: 'term',
  bank: 'ba',
  adat: 'ad',
  díja: 'dí',
  díjak: 'díj',
  szerződésben: 'szerződés',
  szerződés: 'szerződés',
  kockázat: 'kockáz',
  karton: 'kart',
  termék: 'terme',
}
const term = (word: string) => kbTextTerm(word, HU[word] ?? null)

console.log('=== #1136 kb-text-match ===')

check('a hajtogatás 1:1, így a találat helye visszavetíthető', () => {
  for (const text of ['Kártyaelfogadás ŐRÜLT ÁRVÍZTŰRŐ', 'İstanbul ß ẞ', 'emoji 😀 után', 'Ñandú Żółć']) {
    assert.equal(foldKbText(text).length, text.length, text)
  }
  assert.equal(foldKbText('ÁRVÍZTŰRŐ tükörfúrógép'), 'arvizturo tukorfurogep')
})

check('a SQL translate és a JS ugyanazt a térképet használja', () => {
  assert.equal([...KB_FOLD_FROM].length, [...KB_FOLD_TO].length)
  ;[...KB_FOLD_FROM].forEach((char, index) => {
    assert.equal(foldKbText(char), KB_FOLD_TO[index])
    assert.equal(foldKbText(char.toUpperCase()), KB_FOLD_TO[index], 'a nagybetűs alakot a lower() viszi a térképre')
  })
})

check('kbQueryTerms: kisbetű, vágás nem betűnél, dedup, min. 2 karakter', () => {
  assert.deepEqual(kbQueryTerms('Kártya  KÁRTYA, ISO-8583 a 3DS'), ['kártya', 'iso', '8583', '3ds'])
  assert.deepEqual(kbQueryTerms('   '), [])
  assert.deepEqual(kbQueryTerms('Kártya'), ['kártya'], 'a kombinált ékezet egy betű marad')
})

check('tőalak: a túl rövid és a túl messzi tő nem használható', () => {
  assert.equal(kbStemForm('bank', 'ba'), null, 'bank ≠ ba')
  assert.equal(kbStemForm('visa', 'vis'), null, 'visa: 5 karakter alatt nincs tőalak')
  assert.equal(kbStemForm('terminál', 'term'), null, 'a különbség legfeljebb 3 karakter')
  assert.equal(kbStemForm('fizetés', 'fizetés'), null, 'azonos alaknál a betű szerinti elég')
  assert.equal(kbStemForm('kártyák', 'kártya'), 'kartya')
  assert.equal(kbStemForm('kódok', 'kód'), 'kod')
  assert.equal(kbStemForm('nem', ''), null, 'stopszó')
  assert.equal(kbStemForm('alma', 'korte'), null, 'a szó a tővel kezdődik')
})

check('szóhossz szerinti betűszerinti mód', () => {
  assert.equal(kbLiteralPattern(term('ai')), '\\mai\\M')
  assert.equal(kbLiteralPattern(term('pos')), '\\mpos')
  assert.equal(kbLiteralPattern(term('kártya')), 'kartya')
  assert.equal(kbTermPattern(term('kártyák')), 'kartyak|\\mkartya')
})

const finds: Array<[string, string]> = [
  ['kartya', 'kártyák'],
  ['szerzodes', 'szerződésben'],
  ['kártyák', 'kártya'],
  ['levél', 'levelek'],
  ['levelek', 'levél'],
  ['ügyfelek', 'ügyfél'],
  ['kódok', 'kód'],
  ['terminálok', 'terminál'],
  ['elfogadás', 'kártyaelfogadás'],
  ['8583', 'ISO-8583'],
  ['nem', 'nem elfogadott'],
  ['kártya', 'kártyák'],
  ['kártyát', 'kártyák'],
  ['szerződés', 'szerződésben'],
  ['szerződésben', 'szerződés'],
  ['díjak', 'díj'],
  ['3ds', '3DS2'],
  ['kockázat', 'kockázatok'],
  ['bank', 'bankok'],
  ['bank', 'bankkártya'],
  ['adat', 'adatok'],
  ['terminál', 'terminálok'],
  ['fizetés', 'fizetési'],
  ['kereskedő', 'kereskedők'],
]
for (const [word, text] of finds) {
  check(`találat: ${word} → ${text}`, () => assert.equal(kbTermMatches(term(word), text), true))
}

const misses: Array<[string, string]> = [
  ['bank', 'barát, baj'],
  ['adat', 'adó, adott'],
  ['terminál', 'termék, termelés'],
  ['visa', 'visszatérítés'],
  ['díja', 'dísz'],
  ['ai', 'fail mail'],
  ['pos', 'kompost'],
]
for (const [word, text] of misses) {
  check(`nincs találat: ${word} → ${text}`, () => assert.equal(kbTermMatches(term(word), text), false))
}

check('a találat a teljes szót jelöli, az eredeti szöveg helyén', () => {
  const text = 'A bankkártyát és a Kártyákat.'
  const ranges = kbMatchRanges(foldKbText(text), [term('kártya')])
  assert.deepEqual(ranges.map((range) => text.slice(range.start, range.end)), ['bankkártyát', 'Kártyákat'])
})

check('Markdown nélküli látható szöveg, a HTML szövegként marad', () => {
  assert.equal(
    kbStripMarkdown('# Cím\n\n**Vastag** [link](https://x.y/z) és [[concepts/a-b.md|Címke]] meg [[concepts/masik.md]]\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>x</script>'),
    'Cím Vastag link és Címke meg masik A B 1 2 <script>x</script>',
  )
})

check('részlet: a legtöbb különböző szót tartalmazó ablak', () => {
  const padding = 'lorem ipsum dolor sit amet '.repeat(30)
  const body = `${padding} kártya ${padding} kártya és elfogadás együtt ${padding} elfogadás`
  const snippet = kbSnippet({ body, fallback: 'x', terms: [term('kártya'), kbTextTerm('elfogadás')] })
  assert.match(snippet.text, /kártya és elfogadás együtt/)
  assert.equal(snippet.ranges.length, 2)
  assert.ok(snippet.text.length <= 165, `hossz: ${snippet.text.length}`)
  assert.deepEqual(snippet.ranges.map(([start, end]) => snippet.text.slice(start, end)), ['kártya', 'elfogadás'])
  assert.ok(snippet.text.startsWith('…') && snippet.text.endsWith('…'))
})

check('részlet: a tartományok a maszkolás után számolódnak', () => {
  const snippet = kbSnippet({ body: 'A 4111 1111 1111 1111 kártya elfogadott szám.', fallback: 'x', terms: [term('kártya')] })
  assert.ok(!snippet.text.includes('4111 1111'), snippet.text)
  assert.match(snippet.text, /•••• •••• •••• 1111 kártya/)
  const [[start, end]] = snippet.ranges
  assert.equal(snippet.text.slice(start, end), 'kártya')
})

check('részlet: a HTML nem HTML-ként jön vissza, csak szöveg és tartomány', () => {
  const snippet = kbSnippet({ body: 'Figyelem <script>alert(1)</script> kártya', fallback: 'x', terms: [term('kártya')] })
  assert.match(snippet.text, /<script>alert\(1\)<\/script>/)
  assert.ok(snippet.ranges.every(([start, end]) => snippet.text.slice(start, end) === 'kártya'))
})

check('részlet: ha a látható szövegben nincs találat, az összefoglaló jön kiemelés nélkül', () => {
  const snippet = kbSnippet({ body: 'Csak [[kartya/lap.md|egy link]].', fallback: 'Az összefoglaló 4111 1111 1111 1111 szöveg', terms: [term('kártya')] })
  assert.equal(snippet.text, 'Az összefoglaló •••• •••• •••• 1111 szöveg')
  assert.deepEqual(snippet.ranges, [])
})

check('részlet: a hosszú összefoglaló is rövid marad', () => {
  const snippet = kbSnippet({ body: 'semmi', fallback: 'szó '.repeat(100), terms: [term('kártya')] })
  assert.ok(snippet.text.length <= 161, `hossz: ${snippet.text.length}`)
  assert.ok(snippet.text.endsWith('…'))
})

if (failures) {
  console.log(`\n${failures} teszt elbukott.`)
  process.exit(1)
}
console.log('\nMinden teszt zöld.')
