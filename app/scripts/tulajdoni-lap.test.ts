/**
 * Tulajdoni lap parser — tiszta unit tesztek (PDF és DB nélkül).
 * Run: npx tsx scripts/tulajdoni-lap.test.ts
 *
 * A fixture egy lekicsinyített, de szerkezetileg valósághű lap: két oldal,
 * ismétlődő fejléc, oldalhatáron átlógó bejegyzés, törölt sor, INYER-es
 * (CSUPA NAGYBETŰS, más címkéjű) bejegyzés, joggyakorló és haszonélvező.
 */
import assert from 'node:assert/strict'
import {
  buildTulajdoniLapView,
  detectLapTipus,
  parseEntries,
  parseTulajdoniLap,
  splitSections,
  stripFurniture,
  TULAJDONI_LAP_SUMMARY_OWNERS,
} from '../src/lib/tulajdoni-lap'

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

const HEADER = ['Nem hiteles tulajdoni lap', 'Budapest Főváros Kormányhivatala', 'Oldal 1']

function page(pageNo: number, body: string): string {
  return [
    'Nem hiteles tulajdoni lap',
    'Budapest Főváros Kormányhivatala',
    `Oldal ${pageNo}`,
    body,
  ].join('\n')
}

// Két tulajdonos 1/2 - 1/2-ben; egy törölt sor; egy INYER-es sor ugyanarra a
// személyre más írásmóddal; egy joggyakorló és egy haszonélvező (nem tulajdonrész).
const PAGE_1 = page(
  1,
  [
    'INYER/TULLAP/20260716/13866',
    '2026.07.16',
    'Külterület, 43/15 helyrajzi szám',
    'SZÉLJEGYZÉK',
    'Széljegy: INYER/2026/824725',
    'Széljegy: INYER/2026/824725 - 2026.06.29. 10:00:00 tulajdonjog bejegyzés',
    'I. RÉSZ',
    '1. Bejegyző határozat, érkezési idő:',
    '39829/2018.06.04',
    '. Szántó 82 8770 1965,4',
    '3 osztály 47 7666 1246,71',
    'II. RÉSZ',
    'Bejegyző határozat, érkezési idő:',
    '11111/2010.01.01',
    '1.',
    'Tulajdonjog',
    'Jogállás: TULAJDONOS',
    'Tulajdoni hányad: 1/2',
    'Jogváltozás jogcíme: adásvétel',
    'Név: Kovács Béla, Születési év: 1950, Anyja neve: Nagy Mária',
    'Jogosult címe: 1111 Budapest',
  ].join('\n'),
)

const PAGE_2 = page(
  2,
  [
    'Folytatás az előző oldalról',
    'Bejegyző határozat, érkezési idő:',
    '22222/2011.02.02',
    'Törlő határozat',
    '33333/2015.03.03',
    '2.',
    'Tulajdonjog',
    'Jogállás: TULAJDONOS',
    'Tulajdoni hányad: 1/4',
    'Név: Szabó Anna, Születési év: 1960, Anyja neve: Kiss Éva',
    'Bejegyző határozat, érkezési idő:',
    '44444/2025.11.11',
    '3.',
    'Tulajdonjog',
    'Jogállás: TULAJDONOS',
    'Tulajdoni hányad: 1/4',
    'Jogcím: ajándékozás',
    'Név: KOVÁCS BÉLA, Születési év: 1950, Anyja neve: NAGY MÁRIA',
    'Jogosult címe: 1111 Budapest',
    'Bejegyző határozat, érkezési idő:',
    '55555/2025.12.12',
    '4.',
    'Tulajdonjog',
    'Jogállás: TULAJDONOS',
    'Tulajdoni hányad: 1/4',
    'Név: Tóth Péter, Születési év: 1970, Anyja neve: Fehér Ilona',
    'Bejegyző határozat, érkezési idő:',
    '66666/2026.01.01',
    '5.',
    'Vagyonkezelői jog',
    'Jogállás: JOGGYAKORLÓ SZERVEZET',
    'Tulajdoni hányad: 1/1',
    'Név: Magyar Állam Kezelő Zrt.',
    'III. RÉSZ',
    'Bejegyző határozat, érkezési idő:',
    '77777/2020.05.05',
    '6.',
    'Jelzálogjog',
    'Követelés összege: 5 000 000 Ft',
    'Név: Bank Zrt.',
    'Folytatás a következő oldalon',
  ].join('\n'),
)

const PAGES = [PAGE_1, PAGE_2]

check('fejléc és lábléc eltávolítása', () => {
  const text = stripFurniture(PAGES)
  for (const line of HEADER.slice(0, 2)) {
    assert.ok(!text.includes(line), `a fejléc bennmaradt: ${line}`)
  }
  assert.ok(!text.includes('Folytatás a következő oldalon'))
  assert.ok(!text.includes('Folytatás az előző oldalról'))
})

check('szakaszokra bontás', () => {
  const sections = splitSections(stripFurniture(PAGES))
  assert.ok(sections.szeljegyzek?.includes('INYER/2026/824725'))
  assert.ok(sections.resz1?.includes('Szántó'))
  assert.ok(sections.resz2?.includes('Kovács Béla'))
  assert.ok(sections.resz3?.includes('Jelzálogjog'))
})

check('bejegyzések: hatályos / törölt szétválasztás', () => {
  const r = parseTulajdoniLap(PAGES)
  assert.equal(r.osszesites.resz2Osszes, 5)
  assert.equal(r.osszesites.resz2Torolt, 1, 'a törlő határozatos sort törötnek kell látni')
  assert.equal(r.osszesites.resz2Hatalyos, 4)
  const torolt = r.tulajdoniBejegyzesek.find((e) => !e.hatalyos)
  assert.equal(torolt?.sorszam, 2)
  assert.equal(torolt?.torloHatarozat, '33333/2015.03.03')
})

check('oldalhatáron átlógó bejegyzés nem csonkul', () => {
  // A 2. sorszámú bejegyzés a 2. oldalon kezdődik, de a szakasz az 1. oldalon —
  // ha oldalanként parse-olnánk, elveszne.
  const r = parseTulajdoniLap(PAGES)
  const e2 = r.tulajdoniBejegyzesek.find((e) => e.sorszam === 2)
  assert.equal(e2?.nev, 'Szabó Anna')
})

check('INYER-es (nagybetűs, más címkéjű) sor ugyanahhoz a személyhez kerül', () => {
  const r = parseTulajdoniLap(PAGES)
  const kovacs = r.tulajdonosok.find((o) => o.nev.toLowerCase().startsWith('kovács'))
  assert.ok(kovacs, 'Kovács Bélát meg kell találni')
  // 1/2 (régi) + 1/4 (INYER-es, CSUPA NAGY) = 3/4 — külön vödörben 1/2 lenne.
  assert.equal(kovacs.hanyad, '3/4')
  assert.deepEqual(kovacs.bejegyzesSorszamok, [1, 3])
  assert.ok(kovacs.nevValtozatok && kovacs.nevValtozatok.length === 2)
  // Megjelenítéshez az olvashatóbb, nem csupa-nagybetűs alakot választjuk.
  assert.equal(kovacs.nev, 'Kovács Béla')
})

check('Jogcím és Jogváltozás jogcíme egyaránt jogcímként jön be', () => {
  const r = parseTulajdoniLap(PAGES)
  assert.equal(r.tulajdoniBejegyzesek.find((e) => e.sorszam === 1)?.jogcim, 'adásvétel')
  assert.equal(r.tulajdoniBejegyzesek.find((e) => e.sorszam === 3)?.jogcim, 'ajándékozás')
})

check('joggyakorló szervezet NEM önálló tulajdonos', () => {
  const r = parseTulajdoniLap(PAGES)
  assert.ok(
    !r.tulajdonosok.some((o) => o.nev.includes('Kezelő')),
    'a joggyakorló 1/1-e duplán számolna',
  )
})

check('hányadösszeg validáció: pontosan 1', () => {
  const r = parseTulajdoniLap(PAGES)
  // 3/4 (Kovács) + 1/4 (Tóth) = 1; a törölt 1/4 és a joggyakorló 1/1 kimarad.
  assert.equal(r.osszesites.hatalyosHanyadOsszeg, '1/1')
  assert.equal(r.osszesites.valid, true)
  assert.equal(r.osszesites.egyediTulajdonos, 2)
})

check('hibás lap: a validáció bukik és figyelmeztet', () => {
  // Egy hatályos hányad eltüntetése → az összeg már nem 1.
  const romlott = PAGES.map((p) => p.replace('Tulajdoni hányad: 1/4\nNév: Tóth Péter', 'Név: Tóth Péter'))
  const r = parseTulajdoniLap(romlott)
  assert.equal(r.osszesites.valid, false)
  assert.match(r.osszesites.megjegyzes, /FIGYELEM/)
  const view = buildTulajdoniLapView(r)
  assert.ok(view.figyelmeztetes, 'a nézetnek hangosan jeleznie kell')
})

check('széljegy: a két „Széljegy:" sor egy ügybe vonódik', () => {
  const r = parseTulajdoniLap(PAGES)
  assert.equal(r.szeljegyek.length, 1, 'azonosító szerint össze kell vonni')
  assert.equal(r.szeljegyek[0].azonosito, 'INYER/2026/824725')
})

check('terhek (III. rész) külön szakaszba kerülnek', () => {
  const r = parseTulajdoniLap(PAGES)
  assert.equal(r.osszesites.resz3Osszes, 1)
  assert.equal(r.terhek[0].tipus, 'Jelzálogjog')
  assert.equal(r.terhek[0].kovetelesOsszege, '5 000 000 Ft')
})

check('ingatlan: terület és AK kinyerése', () => {
  const r = parseTulajdoniLap(PAGES)
  const ing = r.ingatlan as { minosegiOsztalyok?: unknown[]; alreszletek?: unknown[] }
  assert.ok(ing.minosegiOsztalyok && ing.minosegiOsztalyok.length >= 1)
})

check('nézet: alapból összefoglaló, raw nélkül', () => {
  const r = parseTulajdoniLap(PAGES)
  const v = buildTulajdoniLapView(r)
  assert.equal(v.nezet, 'osszefoglalo')
  assert.ok(v.tulajdonosok && v.tulajdonosok.length <= TULAJDONI_LAP_SUMMARY_OWNERS)
  assert.ok(v.szeljegyek, 'a széljegy az összefoglalóban is kell')
  assert.ok(!('raw' in (v.ingatlan ?? {})), 'az ingatlan raw kimarad')
})

check('nézet: bejegyzések alapból csak hatályos, raw nélkül', () => {
  const r = parseTulajdoniLap(PAGES)
  const v = buildTulajdoniLapView(r, { nezet: 'bejegyzesek' })
  assert.equal(v.bejegyzesek?.length, 4)
  assert.ok(v.bejegyzesek?.every((e) => e.hatalyos))
  assert.ok(v.bejegyzesek?.every((e) => e.raw === undefined), 'a raw alapból kimarad')
})

check('nézet: csakHatalyos=false a törölteket is hozza, raw=true a szöveget', () => {
  const r = parseTulajdoniLap(PAGES)
  const v = buildTulajdoniLapView(r, { nezet: 'bejegyzesek', csakHatalyos: false, raw: true })
  assert.equal(v.bejegyzesek?.length, 5)
  assert.ok(v.bejegyzesek?.some((e) => !e.hatalyos))
  assert.ok(v.bejegyzesek?.every((e) => typeof e.raw === 'string'))
})

check('nézet: lapozás', () => {
  const r = parseTulajdoniLap(PAGES)
  const v = buildTulajdoniLapView(r, { nezet: 'bejegyzesek', limit: 2, offset: 0 })
  assert.equal(v.bejegyzesek?.length, 2)
  assert.deepEqual(v.lapozas, { osszesen: 4, offset: 0, limit: 2, kovetkezoOffset: 2 })
  const last = buildTulajdoniLapView(r, { nezet: 'bejegyzesek', limit: 2, offset: 2 })
  assert.equal(last.lapozas?.kovetkezoOffset, null)
})

check('kinyerő-függetlenség: extra szóközök nem változtatják az eredményt', () => {
  // A pypdf megtartja az oszlopköz-futamokat, a pdf.js összevonja őket.
  const tagolt = PAGES.map((p) => p.replace(/: /g, ':    '))
  const a = parseTulajdoniLap(PAGES)
  const b = parseTulajdoniLap(tagolt)
  assert.deepEqual(b.tulajdonosok, a.tulajdonosok)
  assert.deepEqual(b.osszesites, a.osszesites)
})

// A jogosult személy-mezői a PDF vizuális tördelésétől függően egy sorba
// kerülhetnek vesszővel, külön sorokba, vagy vegyesen. A `szuletesiEv` és az
// `anyjaNeve` a tulajdonos-azonosítás kulcsa; ha tördelés miatt kiesik, a
// hányadösszeg-validáció NEM veszi észre (a hányadok akkor is 1-re jönnek ki).
const SZEMELY_FEJ =
  'Bejegyző határozat, érkezési idő:\n11111/2010.01.01\n1.\n' +
  'Tulajdonjog\nJogállás: TULAJDONOS\nTulajdoni hányad: 1/1\n'

const TORDELESEK: Array<[string, string]> = [
  ['egy soron, vesszővel', 'Név: Kovács Béla, Születési név: Nagy Anna, Születési év: 1980, Anyja neve: Szabó Mária'],
  ['külön sorokban, sorvégi vesszővel', 'Név: Kovács Béla,\nSzületési név: Nagy Anna,\nSzületési év: 1980,\nAnyja neve: Szabó Mária'],
  ['külön sorokban, vessző nélkül', 'Név: Kovács Béla\nSzületési név: Nagy Anna\nSzületési év: 1980\nAnyja neve: Szabó Mária'],
  ['vegyes tördelés', 'Név: Kovács Béla, Születési név: Nagy Anna\nSzületési év: 1980, Anyja neve: Szabó Mária'],
]

for (const [nev, blokk] of TORDELESEK) {
  check(`személy-mezők tördeléstől függetlenül: ${nev}`, () => {
    const e = parseEntries(`${SZEMELY_FEJ}${blokk}\nJogosult címe: 1111 Budapest`, 'II')[0]
    assert.equal(e.nev, 'Kovács Béla')
    assert.equal(e.szuletesiNev, 'Nagy Anna')
    assert.equal(e.szuletesiEv, '1980', 'a születési év a párosítási kulcs része')
    assert.equal(e.anyjaNeve, 'Szabó Mária', 'az anyja neve a párosítási kulcs része')
    assert.equal(e.cim, '1111 Budapest')
  })
}

check('személy-mezők: szervezetnél nincs születési év, és ez nem hiba', () => {
  const e = parseEntries(`${SZEMELY_FEJ}Név: EGYETÉRTÉS MGTSZ\nJogosult címe: 3326 OSTOROS`, 'II')[0]
  assert.equal(e.nev, 'EGYETÉRTÉS MGTSZ')
  assert.equal(e.szuletesiEv, undefined)
  assert.equal(e.anyjaNeve, undefined)
})

check('a „Név" címke nem illeszkedik a „Születési név" végére', () => {
  const e = parseEntries(`${SZEMELY_FEJ}Születési név: Nagy Anna\nNév: Kovács Béla`, 'II')[0]
  assert.equal(e.nev, 'Kovács Béla')
  assert.equal(e.szuletesiNev, 'Nagy Anna')
})

// A lap a kitöltetlen mezőt kötőjellel jelöli, nem üresen hagyva. Ha ezt
// értékként vennénk át, a „- -" bekerülne a tulajdonos-azonosító kulcsba, és két
// különböző, anyja-név nélküli személy egy vödörbe esne.
check('kitöltetlen mező (kötőjel) hiányzó adat, nem érték', () => {
  const e = parseEntries(
    `${SZEMELY_FEJ}Név: Bögös László, Anyja neve: - -\nJogosult címe: -`,
    'II',
  )[0]
  assert.equal(e.nev, 'Bögös László')
  assert.equal(e.anyjaNeve, undefined, 'a „- -" nem anyja neve')
  assert.equal(e.cim, undefined, 'a „-" nem cím')
})

check('két anyja-név nélküli, azonos nevű személy NEM olvad össze', () => {
  // Eltérő születési év → két külön tulajdonos, akkor is, ha az anyja neve
  // mindkettőnél kitöltetlen.
  const lap = [
    'II. RÉSZ',
    'Bejegyző határozat, érkezési idő:\n1/2000\n1.\nTulajdonjog\nJogállás: TULAJDONOS',
    'Tulajdoni hányad: 1/2\nNév: Kiss János, Születési év: 1950, Anyja neve: -',
    'Bejegyző határozat, érkezési idő:\n2/2000\n2.\nTulajdonjog\nJogállás: TULAJDONOS',
    'Tulajdoni hányad: 1/2\nNév: Kiss János, Születési év: 1975, Anyja neve: -',
  ].join('\n')
  const r = parseTulajdoniLap([lap])
  assert.equal(r.osszesites.egyediTulajdonos, 2, 'apa és fia külön tulajdonos')
  assert.equal(r.osszesites.valid, true)
})

// Mindkét fajta lap alján ott a magyarázó mondat, ami MINDKÉT szót tartalmazza.
// Szabad szavas kereséssel a teljes lap is „szemlének" látszik — ez valódi hiba
// volt, ezért kap külön tesztet.
const BOILERPLATE =
  'Az E-hiteles tulajdoni lap másolat tartalma a kiadást megelőző napig megegyezik az\n' +
  'ingatlan-nyilvántartásban szereplő adatokkal. A szemle másolat a fennálló bejegyzéseket,\n' +
  'a teljes másolat valamennyi bejegyzést tartalmazza.'

check('laptípus: a magyarázó szöveg nem téveszti meg a felismerést', () => {
  assert.equal(detectLapTipus([`Tulajdonilap-másolat\n(teljes)\n${BOILERPLATE}`]), 'teljes')
  assert.equal(
    detectLapTipus([`${BOILERPLATE}\nE-hiteles tulajdoni lap - Szemle másolat`]),
    'szemle',
  )
  assert.equal(detectLapTipus([BOILERPLATE]), 'ismeretlen', 'csak a magyarázat nem típusjelölés')
})

check('laptípus felismerése és a hibaüzenet konkrét', () => {
  assert.equal(detectLapTipus(['Tulajdonilap-másolat\n(teljes)']), 'teljes')
  assert.equal(detectLapTipus(['E-hiteles tulajdoni lap - Szemle másolat']), 'szemle')
  assert.equal(detectLapTipus(['valami más']), 'ismeretlen')

  // Szemle: felismerhető bejegyzés nélkül konkrét, cselekvésre váltható üzenet.
  const szemle = parseTulajdoniLap(['E-hiteles tulajdoni lap - Szemle másolat\nnév: MAGYAR ÁLLAM'])
  assert.equal(szemle.meta.tipus, 'szemle')
  assert.equal(szemle.osszesites.valid, false)
  assert.match(szemle.osszesites.megjegyzes, /SZEMLE/)
  assert.match(szemle.osszesites.megjegyzes, /TELJES másolatot/)

  // Ismeretlen dokumentum: szintén konkrét, nem „különleges a lap".
  const ismeretlen = parseTulajdoniLap(['Számla\nÖsszeg: 1000 Ft'])
  assert.equal(ismeretlen.meta.tipus, 'ismeretlen')
  assert.match(ismeretlen.osszesites.megjegyzes, /egyetlen tulajdoni bejegyzést sem/)
})

check('a valódi teljes lap típusa felismerhető és a régi üzenet marad', () => {
  const r = parseTulajdoniLap(PAGES.map((p) => `${p}\nTulajdonilap-másolat\n(teljes)`))
  assert.equal(r.meta.tipus, 'teljes')
  assert.equal(r.osszesites.valid, true)
  assert.match(r.osszesites.megjegyzes, /pontosan 1/)
})

console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
process.exit(failures === 0 ? 0 : 1)
