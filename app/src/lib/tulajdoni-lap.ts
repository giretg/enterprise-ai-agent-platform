/**
 * Magyar e-hiteles tulajdoni lap (földhivatali TULLAP/INYER PDF) → strukturált adat.
 *
 * A modul TISZTA: bemenete a PDF oldalankénti nyers szövege (`string[]`), így
 * DB és PDF-motor nélkül tesztelhető. A PDF-kinyerés a hívó (broker-handler)
 * dolga.
 *
 * Miért kell ehhez külön logika: a tulajdoni lap nem pillanatfelvétel, hanem
 * teljes történeti napló. Egy eladott hányad bejegyzése NEM tűnik el, csak kap
 * egy „Törlő határozat" mezőt — egy nagy lapon a sorok 70-80%-a már nem
 * hatályos. Ráadásul a ~2025 őszétől iktatott (INYER-es) bejegyzések MÁS
 * mezőcímkéket és csupa nagybetűs neveket használnak; ezek épp a legfrissebbek,
 * tehát a jelen állapot szempontjából a legfontosabbak.
 *
 * Az eredmény önvalidáló: a hatályos tulajdoni hányadok összegének pontosan
 * 1-nek kell lennie (`osszesites.valid`). Ha nem az, a kinyerés hibás vagy a lap
 * különleges — az adatot NEM szabad továbbdolgozni.
 */

// ── Egzakt racionális aritmetika ────────────────────────────────────────────
// A hányadok összege csak egzakt törtaritmetikával ellenőrizhető: lebegőpontosan
// az 1/3 + 1/3 + 1/3 nem lesz pontosan 1, és a validáció hamis riasztást adna.

const ZERO = BigInt(0)
const ONE = BigInt(1)

function gcd(a: bigint, b: bigint): bigint {
  let x = a < ZERO ? -a : a
  let y = b < ZERO ? -b : b
  while (y) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

export class Fraction {
  readonly num: bigint
  readonly den: bigint

  constructor(num: bigint, den: bigint = ONE) {
    if (den === ZERO) throw new Error('Fraction: nulla nevező')
    const sign = den < ZERO ? -ONE : ONE
    const n = num * sign
    const d = den * sign
    const g = gcd(n, d) || ONE
    this.num = n / g
    this.den = d / g
  }

  add(other: Fraction): Fraction {
    return new Fraction(this.num * other.den + other.num * this.den, this.den * other.den)
  }

  isOne(): boolean {
    return this.num === this.den
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den)
  }

  toString(): string {
    return `${this.num}/${this.den}`
  }
}

// ── Típusok ─────────────────────────────────────────────────────────────────

export type TulajdoniLapEntry = {
  resz: 'II' | 'III'
  sorszam: number
  tipus: string | null
  bejegyzoHatarozat: string | null
  torloHatarozat: string | null
  /** Hatályos = nincs törlő határozata. Ez a legfontosabb mező a lapon. */
  hatalyos: boolean
  jogcim?: string
  jogallas?: string
  hanyad?: string
  nev?: string
  cim?: string
  utalas?: string
  eredetiHatarozat?: string
  jogTerjedelme?: string
  hatosag?: string
  hatarozatSzama?: string
  kovetelesOsszege?: string
  szuletesiNev?: string
  szuletesiEv?: string
  anyjaNeve?: string
  szamlalo?: number
  nevezo?: number
  raw: string
}

export type TulajdoniLapOwner = {
  nev: string
  /** Több írásmód (pl. régi Kezdőbetűs + INYER-es CSUPA NAGY) ha volt ilyen. */
  nevValtozatok: string[] | null
  szuletesiEv: string | null
  anyjaNeve: string | null
  cim: string | null
  hanyad: string
  szazalek: number
  bejegyzesSorszamok: number[]
}

export type TulajdoniLapSzeljegy = {
  azonosito: string
  szoveg: string
}

export type TulajdoniLapIngatlan = {
  raw: string
  minosegiOsztalyok?: Array<{ osztaly: string; teruletHa: string; ak: string }>
  alreszletek?: Array<{
    jel: string | null
    muvelesiAg: string
    teruletHa: string
    ak: string
  }>
  muvelesiAgak?: string[]
  teruletHaOsszesen?: string
  akOsszesen?: string
}

export type TulajdoniLapResult = {
  meta: {
    oldalak: number
    ugyazonosito?: string
    kelt?: string
    ingatlanMegnevezes?: string
  }
  szeljegyek: TulajdoniLapSzeljegy[]
  ingatlan: TulajdoniLapIngatlan | Record<string, never>
  tulajdoniBejegyzesek: TulajdoniLapEntry[]
  terhek: TulajdoniLapEntry[]
  tulajdonosok: TulajdoniLapOwner[]
  osszesites: {
    resz2Osszes: number
    resz2Hatalyos: number
    resz2Torolt: number
    resz3Osszes: number
    resz3Hatalyos: number
    szeljegyDb: number
    egyediTulajdonos: number
    hatalyosHanyadOsszeg: string
    hatalyosHanyadOsszegSzazalek: number
    valid: boolean
    megjegyzes: string
  }
}

// ── 1. Oldal-szemét eltávolítása ────────────────────────────────────────────

const FOOTER_PATTERNS = ['Folytatás a következő oldalon', 'Folytatás az előző oldalról']

/**
 * Vízszintes whitespace-futamok összevonása soronként.
 *
 * A PDF-szövegkinyerők eltérően kezelik az oszlopközöket: a pdf.js (`pdf-parse`)
 * összevonja a szóköz-futamokat, a pypdf megtartja őket. Enélkül ugyanaz a lap
 * kinyerőnként más `cim`/`anyja neve` értéket adna (pl. „Bóta Gizella  Irma"),
 * és a két futás eredménye nem lenne összehasonlítható.
 *
 * A sortöréseket NEM bántjuk: azokon áll az egész szakasz- és bejegyzés-bontás.
 * Az oszlop-regexek `+` kvantorral illesztenek, így az egyetlen megmaradó szóköz
 * elég elválasztónak.
 */
function normalizeHorizontalWhitespace(page: string): string {
  return page
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').replace(/[^\S\n]+$/, ''))
    .join('\n')
}

/**
 * A minden oldalon ismétlődő fejléc hosszát keresi meg (sorokban).
 *
 * Soronként hasonlítunk, és az oldalszámot tartalmazó sort jokerként kezeljük —
 * ez általánosabb, mint egy adott földhivatal fejlécére illeszteni.
 */
function commonPrefixLines(pages: string[]): number {
  if (pages.length < 2) return 0

  // Az 1. oldal fejléce eltérhet, ezért alapból kihagyjuk az összehasonlításból.
  // DE: pontosan 2 oldalnál így EGYETLEN lista maradna, amin minden sor triviálisan
  // „azonos" — a ciklus sosem állna meg, és az egész 2. oldalt fejlécnek hinnénk.
  // Ilyenkor mindkét oldalt hasonlítjuk: a közös prefix a törzs első eltérésénél véget ér.
  const lineLists = (pages.length >= 3 ? pages.slice(1) : pages).map((p) => p.split('\n'))
  const shortest = Math.min(...lineLists.map((x) => x.length))
  // Biztonsági plafon: a fejléc sosem a lap fele. Enélkül egy elrontott felismerés
  // némán tartalmat nyelne el — ami pont a legveszélyesebb hibamód.
  const maxHeader = Math.floor(shortest / 2)
  let n = 0
  for (let i = 0; i < maxHeader; i += 1) {
    const vals = new Set(lineLists.map((ll) => ll[i].trim()))
    if (vals.size === 1) {
      n += 1
      continue
    }
    // Az oldalszámot tartalmazó sor oldalanként más — ez is fejléc.
    if ([...vals].every((v) => /Oldal\s*\d+|\/\d+\s*Oldal/.test(v))) {
      n += 1
      continue
    }
    break
  }
  return n
}

/**
 * Fejléc/lábléc eltávolítása, majd az oldalak EGYETLEN szöveggé fűzése.
 *
 * Az összefűzés azért kell, mert a bejegyzések átlógnak oldalhatáron: oldalanként
 * parse-olva a határon lévő bejegyzések csonkulnának.
 */
export function stripFurniture(pages: string[]): string {
  const headerLen = commonPrefixLines(pages)
  const cleaned = pages.map((page) => {
    const lines = page.split('\n').slice(headerLen)
    return lines
      .filter((line) => {
        const s = line.trim()
        return !FOOTER_PATTERNS.some((pat) => s === pat || s.startsWith(pat))
      })
      .join('\n')
  })
  return cleaned.join('\n')
}

// ── 2. Szakaszokra bontás ───────────────────────────────────────────────────

const SECTION_MARKERS: Array<[string, RegExp]> = [
  ['szeljegyzek', /^SZÉLJEGYZÉK\s*$/],
  ['resz1', /^I\.\s*RÉSZ\s*$/],
  ['resz2', /^II\.\s*RÉSZ\s*$/],
  ['resz3', /^III\.\s*RÉSZ\s*$/],
]

export function splitSections(text: string): Record<string, string> {
  const lines = text.split('\n')
  const marks: Array<{ idx: number; name: string }> = []
  lines.forEach((line, i) => {
    const s = line.trim()
    for (const [name, pat] of SECTION_MARKERS) {
      if (pat.test(s)) {
        marks.push({ idx: i, name })
        break
      }
    }
  })
  const sections: Record<string, string> = {}
  marks.forEach((mark, j) => {
    const end = j + 1 < marks.length ? marks[j + 1].idx : lines.length
    sections[mark.name] = lines.slice(mark.idx + 1, end).join('\n')
  })
  return sections
}

// ── 3. Bejegyzések ──────────────────────────────────────────────────────────

const ENTRY_DELIM = 'Bejegyző határozat, érkezési idő:'

/**
 * Ugyanaz a fogalom kétféle címkével szerepel, mert a ~2025 őszétől iktatott
 * (INYER-es) bejegyzések új sablont használnak. Mindkettőt ismernünk kell,
 * különben a legfrissebb — és a jelen állapot szempontjából legfontosabb —
 * bejegyzések némán kimaradnának.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  jogcim: ['Jogváltozás jogcíme', 'Jogcím'],
  jogallas: ['Jogállás'],
  hanyad: ['Tulajdoni hányad'],
  nev: ['Név'],
  cim: ['Jogosult címe'],
  utalas: ['Utalás a törölt bejegyzésre', 'Utalás az eredeti bejegyzésre', 'Utalás'],
  eredetiHatarozat: ['Eredeti bejegyzés/szerzés iktatószáma', 'Eredeti határozat'],
  jogTerjedelme: ['Jog terjedelme'],
  hatosag: ['A felhívást kiadó hatóság adatai', 'Hatóság megnevezése'],
  hatarozatSzama: ['Határozat száma'],
  kovetelesOsszege: ['Követelés összege'],
}

const HANYAD_RE = /(\d[\d\s]*)\s*\/\s*(\d[\d\s]*)/
const NEV_RE = new RegExp(
  'Név:\\s*(?<nev>[^,\\n]+?)' +
    '(?:,\\s*Születési név:\\s*(?<szuletesiNev>[^,\\n]+?))?' +
    '(?:,\\s*Születési év:\\s*(?<szuletesiEv>\\d{4}))?' +
    '(?:,\\s*Anyja neve:\\s*(?<anyjaNeve>[^,\\n]+?))?' +
    '[^\\S\\n]*$',
  'm',
)

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Egy mező értéke a bejegyzés szövegéből, az összes ismert címke-variánssal. */
function findField(block: string, key: string): string | null {
  for (const label of FIELD_ALIASES[key]) {
    const m = new RegExp(`^${escapeRe(label)}:\\s*(.+)$`, 'm').exec(block)
    if (m) return m[1].trim()
  }
  return null
}

/**
 * Bejegyzések listája egy szakaszból.
 *
 * A bejegyzés a „Bejegyző határozat, érkezési idő:" sorral kezdődik; a törlés
 * ténye („Törlő határozat") a sorszám ELŐTT, a fejléc-dobozban áll — ezért a
 * törlés-vizsgálatot a sorszám előtti részen kell végezni, nem a törzsben.
 */
export function parseEntries(sectionText: string, sectionName: 'II' | 'III'): TulajdoniLapEntry[] {
  const chunks = sectionText.split(ENTRY_DELIM).slice(1)
  const entries: TulajdoniLapEntry[] = []

  for (const chunk of chunks) {
    // A sorszám ("17.") önálló sorban választja el a fejléc-dobozt a törzstől.
    const m = /^[^\S\n]*(\d+)\.[^\S\n]*$/m.exec(chunk)
    if (!m) continue
    const head = chunk.slice(0, m.index)
    const body = chunk.slice(m.index + m[0].length)
    const sorszam = parseInt(m[1], 10)

    let torlo: string | null = null
    const tm = /Törlő határozat\s*\n\s*(.+)/.exec(head)
    if (tm) torlo = tm[1].trim()

    const bejegyzoLines = head.split('Törlő határozat')[0].trim().split('\n')
    const bejegyzo = bejegyzoLines.map((b) => b.trim()).find((b) => b.length > 0) ?? null

    const bodyLines = body.split('\n').filter((l) => l.trim())
    const tipus = bodyLines.length > 0 ? bodyLines[0].trim() : null

    const entry: TulajdoniLapEntry = {
      resz: sectionName,
      sorszam,
      tipus,
      bejegyzoHatarozat: bejegyzo,
      torloHatarozat: torlo,
      hatalyos: torlo === null,
      raw: body.trim(),
    }

    for (const key of Object.keys(FIELD_ALIASES)) {
      const val = findField(body, key)
      if (val) (entry as Record<string, unknown>)[key] = val
    }

    const hm = HANYAD_RE.exec(entry.hanyad ?? '')
    if (hm) {
      entry.szamlalo = parseInt(hm[1].replace(/\s/g, ''), 10)
      entry.nevezo = parseInt(hm[2].replace(/\s/g, ''), 10)
    }

    const nm = NEV_RE.exec(body)
    if (nm?.groups) {
      for (const [k, v] of Object.entries(nm.groups)) {
        if (v) (entry as Record<string, unknown>)[k] = v.trim()
      }
    }

    entries.push(entry)
  }
  return entries
}

/**
 * Széljegyek: folyamatban lévő, MÉG NEM hatályos ügyek.
 *
 * Külön kell kezelni őket: a széljegy azt jelenti, hogy egy beadvány érkezett,
 * de a földhivatal még nem jegyezte be — a MAI tulajdoni állapotot tehát nem
 * módosítja, viszont előrevetíti a következő változást.
 *
 * Egy széljegy jellemzően KÉT „Széljegy:" sorral kezdődik (azonosító, majd
 * azonosító + időbélyeg), ezért azonosító szerint össze kell vonni — különben
 * duplán számolnánk őket.
 */
export function parseSzeljegyek(text: string): TulajdoniLapSzeljegy[] {
  if (!text) return []
  const blocks = text.split(/\n(?=Széljegy:)/)
  const merged = new Map<string, TulajdoniLapSzeljegy>()

  for (const raw of blocks) {
    const b = raw.trim()
    if (!b) continue
    const first = b.split('\n')[0].replace('Széljegy:', '').trim()
    const base = first.split(' - ')[0].trim()
    const existing = merged.get(base)
    if (existing) existing.szoveg += `\n${b}`
    else merged.set(base, { azonosito: base, szoveg: b })
  }
  return [...merged.values()]
}

// ── I. RÉSZ — az ingatlan fizikai adatai ────────────────────────────────────
//
// A pypdf/pdf.js a táblázat oszlopsorrendjét összekeverheti (a „Földrészlet
// összesen" sorban pl. az AK és a terület összeragad), ezért a SORONKÉNTI
// adatsorokat olvassuk ki, nem az összesítő sort.
//
// `[^\S\n]` = vízszintes whitespace: a sima `\s` átlógna a sortörésen és az
// előző sor végét is beszippantaná.
// A „ha" rész opcionális: 1 hektárnál kisebb tételnél csak a nm szerepel
// (pl. „6 osztály 7792 9,51" = 0,7792 ha).

const H = '[^\\S\\n]'
const OSZTALY_RE = new RegExp(
  `^(\\d+)${H}*osztály${H}+(?:(\\d+)${H}+)?(\\d{4})${H}+([\\d,]+)${H}*$`,
  'gm',
)
const ALRESZLET_RE = new RegExp(
  `^([^\\d\\n]*?)${H}*([^\\d\\n]+?)${H}+(?:(\\d+)${H}+)?(\\d{4})${H}+([\\d,]+)${H}*$`,
  'gm',
)

/** Magyar tizedesvessző → pont. */
function num(s: string): string {
  return s.replace(',', '.')
}

/** "82" + "8770" → "82.8770";  undefined + "7792" → "0.7792". */
function ha(haPart: string | undefined, nmPart: string): string {
  return `${haPart ?? 0}.${nmPart}`
}

export function parseIngatlan(text: string): TulajdoniLapIngatlan | Record<string, never> {
  if (!text) return {}
  const out: TulajdoniLapIngatlan = { raw: text.trim() }

  const osztalyok: NonNullable<TulajdoniLapIngatlan['minosegiOsztalyok']> = []
  for (const m of text.matchAll(OSZTALY_RE)) {
    osztalyok.push({ osztaly: m[1], teruletHa: ha(m[2], m[3]), ak: num(m[4]) })
  }
  if (osztalyok.length > 0) out.minosegiOsztalyok = osztalyok

  const alreszletek: NonNullable<TulajdoniLapIngatlan['alreszletek']> = []
  for (const m of text.matchAll(ALRESZLET_RE)) {
    const ag = (m[2] ?? '').replace(/^[\s.]+|[\s.]+$/g, '')
    if (!ag || ag.includes('osztály') || ag.toLowerCase().includes('összesen')) continue
    alreszletek.push({
      jel: (m[1] ?? '').replace(/^[\s.]+|[\s.]+$/g, '') || null,
      muvelesiAg: ag,
      teruletHa: ha(m[3], m[4]),
      ak: num(m[5]),
    })
  }

  if (alreszletek.length > 0) {
    out.alreszletek = alreszletek
    out.muvelesiAgak = [...new Set(alreszletek.map((a) => a.muvelesiAg))].sort()
    // Egy alrészlet esetén az a földrészlet egésze; többnél összegzünk.
    out.teruletHaOsszesen =
      alreszletek.length === 1
        ? alreszletek[0].teruletHa
        : alreszletek.reduce((s, a) => s + parseFloat(a.teruletHa), 0).toFixed(4)
    out.akOsszesen =
      alreszletek.length === 1
        ? alreszletek[0].ak
        : alreszletek.reduce((s, a) => s + parseFloat(a.ak), 0).toFixed(2)
  }
  return out
}

// ── 4. Összesítés + validáció ───────────────────────────────────────────────

/**
 * Névkulcs egységesítése.
 *
 * Az újabb (INYER-es) bejegyzések CSUPA NAGYBETŰVEL írják a nevet, a régiek
 * Kezdőbetűsen — ugyanaz a személy így két külön vödörbe esne, és a
 * tulajdonrésze megosztva, ALÁBECSÜLVE jelenne meg.
 */
function normName(s: string | undefined | null): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Egy jogállás akkor NEM önálló tulajdonrész, ha joggyakorló szervezet vagy
 * haszonélvező: a joggyakorló ugyanahhoz a Magyar Állam-hányadhoz tartozik
 * (összeadva duplán számolna), a haszonélvezet pedig nem tulajdonjog.
 */
function isNonOwnerJogallas(jogallas: string | undefined): boolean {
  const j = (jogallas ?? '').toUpperCase()
  return j.includes('JOGGYAKORL') || j.includes('GYAKORLÓ') || j.includes('HASZONÉLVEZ')
}

function roundTo(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/**
 * Tulajdonosonkénti hatályos hányad.
 *
 * Egy személy jellemzően TÖBB bejegyzésben szerepel (pl. évek alatt felvásárolt
 * részarányok), ezért az aktuális tulajdonrész csak a hatályos sorok összegéből
 * jön ki — egyetlen bejegyzés önmagában félrevezető.
 *
 * A kulcs név + születési év + anyja neve, mert azonos nevű, de különböző
 * személyek is előfordulnak ugyanazon a lapon (pl. apa és fia).
 */
export function summarizeOwners(entries: TulajdoniLapEntry[]): TulajdoniLapOwner[] {
  type Bucket = {
    hanyad: Fraction
    bejegyzesek: number[]
    nevValtozatok: Set<string>
    szuletesiEv: string | null
    cim: string | null
    anyjaNeve: string | null
  }
  const buckets = new Map<string, Bucket>()

  for (const e of entries) {
    if (!e.hatalyos) continue
    if (e.szamlalo === undefined || e.nevezo === undefined || !e.nev) continue
    if (isNonOwnerJogallas(e.jogallas)) continue

    const key = [normName(e.nev), e.szuletesiEv ?? '', normName(e.anyjaNeve)].join(' ')
    let b = buckets.get(key)
    if (!b) {
      b = {
        hanyad: new Fraction(ZERO),
        bejegyzesek: [],
        nevValtozatok: new Set(),
        szuletesiEv: e.szuletesiEv ?? null,
        cim: null,
        anyjaNeve: null,
      }
      buckets.set(key, b)
    }
    b.hanyad = b.hanyad.add(new Fraction(BigInt(e.szamlalo), BigInt(e.nevezo)))
    b.bejegyzesek.push(e.sorszam)
    b.nevValtozatok.add(e.nev.trim())
    b.cim = e.cim ?? null
    b.anyjaNeve = e.anyjaNeve ?? null
  }

  const owners: TulajdoniLapOwner[] = []
  for (const b of buckets.values()) {
    const variants = [...b.nevValtozatok].sort()
    // Megjelenítéshez a nem csupa-nagybetűs alak olvashatóbb, ha van ilyen.
    const display = variants.find((n) => n !== n.toUpperCase()) ?? variants[0]
    owners.push({
      nev: display,
      nevValtozatok: variants.length > 1 ? variants : null,
      szuletesiEv: b.szuletesiEv || null,
      anyjaNeve: b.anyjaNeve,
      cim: b.cim,
      hanyad: b.hanyad.toString(),
      szazalek: roundTo(b.hanyad.toNumber() * 100, 6),
      bejegyzesSorszamok: [...b.bejegyzesek].sort((x, y) => x - y),
    })
  }
  owners.sort((a, b) => b.szazalek - a.szazalek)
  return owners
}

function validate(entries: TulajdoniLapEntry[]) {
  let total = new Fraction(ZERO)
  for (const e of entries) {
    if (!e.hatalyos) continue
    if (e.szamlalo === undefined || e.nevezo === undefined) continue
    if (isNonOwnerJogallas(e.jogallas)) continue
    total = total.add(new Fraction(BigInt(e.szamlalo), BigInt(e.nevezo)))
  }
  const valid = total.isOne()
  return {
    hatalyosHanyadOsszeg: total.toString(),
    hatalyosHanyadOsszegSzazalek: roundTo(total.toNumber() * 100, 9),
    valid,
    megjegyzes: valid
      ? 'A hatályos tulajdoni hányadok összege pontosan 1 — a kinyerés konzisztens.'
      : 'FIGYELEM: az összeg nem 1. A kinyerés hibás, vagy a lap különleges ' +
        '(pl. haszonélvezet/joggyakorló besorolás). Ne dolgozz tovább, amíg nem tisztázott.',
  }
}

// ── 5. Fő belépési pont ─────────────────────────────────────────────────────

const META_PATTERNS: Array<[keyof TulajdoniLapResult['meta'], RegExp]> = [
  ['ugyazonosito', /(INYER\/TULLAP\/\d+\/\d+)/],
  ['kelt', /\n(\d{4}\.\d{2}\.\d{2})\n/],
  ['ingatlanMegnevezes', /\n([^\n]*helyrajzi szám)\n/],
]

/** PDF oldalankénti nyers szövege → strukturált, validált tulajdoni lap.
 *
 * A `raw` mezők SZÁNDÉKOSAN szó szerintiek (ellenőrizhetőség), ezért kinyerő-
 * motoronként eltérhet bennük az üres sorok száma. Minden STRUKTURÁLT mező
 * ellenben azonos pypdf és pdf.js kinyerés esetén is.
 */
export function parseTulajdoniLap(rawPages: string[]): TulajdoniLapResult {
  // Kinyerő-független alap: pypdf és pdf.js ugyanarra a normalizált szövegre fut.
  const pages = rawPages.map(normalizeHorizontalWhitespace)
  const rawFirst = pages.length > 0 ? pages[0] : ''
  const text = stripFurniture(pages)
  const sections = splitSections(text)

  const resz2 = parseEntries(sections.resz2 ?? '', 'II')
  const resz3 = parseEntries(sections.resz3 ?? '', 'III')
  const owners = summarizeOwners(resz2)
  const szeljegyek = parseSzeljegyek(sections.szeljegyzek ?? '')

  const meta: TulajdoniLapResult['meta'] = { oldalak: pages.length }
  for (const [key, pat] of META_PATTERNS) {
    const m = pat.exec(rawFirst)
    if (m) (meta as Record<string, unknown>)[key] = m[1].trim()
  }

  return {
    meta,
    szeljegyek,
    ingatlan: parseIngatlan(sections.resz1 ?? ''),
    tulajdoniBejegyzesek: resz2,
    terhek: resz3,
    tulajdonosok: owners,
    osszesites: {
      resz2Osszes: resz2.length,
      resz2Hatalyos: resz2.filter((e) => e.hatalyos).length,
      resz2Torolt: resz2.filter((e) => !e.hatalyos).length,
      resz3Osszes: resz3.length,
      resz3Hatalyos: resz3.filter((e) => e.hatalyos).length,
      szeljegyDb: szeljegyek.length,
      egyediTulajdonos: owners.length,
      ...validate(resz2),
    },
  }
}

// ── 6. Nézetek (kontextus-takarékos kimenet) ────────────────────────────────
//
// Egy nagy lapon 600+ bejegyzés van. Ha a tool mindent visszaadna, pontosan azt
// a kontextus-égetést csinálnánk, ami miatt a programmatikus kinyerés egyáltalán
// kell. Ezért a tool alapból ÖSSZEFOGLALÓT ad, és az agent kér részletet.

export type TulajdoniLapNezet = 'osszefoglalo' | 'tulajdonosok' | 'bejegyzesek' | 'terhek'

export type TulajdoniLapViewArgs = {
  nezet?: TulajdoniLapNezet
  /** Bejegyzés-nézeteknél: csak a hatályos sorok (alapértelmezés: igen). */
  csakHatalyos?: boolean
  limit?: number
  offset?: number
  /** Kérd a szó szerinti bejegyzés-szöveget is (alapból elhagyjuk, nagy). */
  raw?: boolean
}

export const TULAJDONI_LAP_DEFAULT_LIMIT = 50
export const TULAJDONI_LAP_MAX_LIMIT = 250
/** Az összefoglalóban ennyi legnagyobb tulajdonost mutatunk meg. */
export const TULAJDONI_LAP_SUMMARY_OWNERS = 10

export type TulajdoniLapView = {
  nezet: TulajdoniLapNezet
  meta: TulajdoniLapResult['meta']
  osszesites: TulajdoniLapResult['osszesites']
  /** Hangos figyelmeztetés, ha a hányadösszeg nem 1 — ilyenkor NE dolgozz tovább. */
  figyelmeztetes: string | null
  ingatlan?: Omit<TulajdoniLapIngatlan, 'raw'> | Record<string, never>
  szeljegyek?: TulajdoniLapSzeljegy[]
  tulajdonosok?: TulajdoniLapOwner[]
  bejegyzesek?: Array<Omit<TulajdoniLapEntry, 'raw'> & { raw?: string }>
  lapozas?: { osszesen: number; offset: number; limit: number; kovetkezoOffset: number | null }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return TULAJDONI_LAP_DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), TULAJDONI_LAP_MAX_LIMIT)
}

function page<T>(items: T[], offset: number, limit: number) {
  const start = Math.max(0, Math.floor(offset))
  const slice = items.slice(start, start + limit)
  const next = start + limit < items.length ? start + limit : null
  return {
    slice,
    lapozas: { osszesen: items.length, offset: start, limit, kovetkezoOffset: next },
  }
}

function stripRaw(
  entries: TulajdoniLapEntry[],
  keepRaw: boolean,
): Array<Omit<TulajdoniLapEntry, 'raw'> & { raw?: string }> {
  return entries.map(({ raw, ...rest }) => (keepRaw ? { ...rest, raw } : rest))
}

/** Strukturált lap → az agentnek visszaadott, méretezett nézet. */
export function buildTulajdoniLapView(
  result: TulajdoniLapResult,
  args: TulajdoniLapViewArgs = {},
): TulajdoniLapView {
  const nezet = args.nezet ?? 'osszefoglalo'
  const limit = clampLimit(args.limit)
  const offset = args.offset ?? 0
  const csakHatalyos = args.csakHatalyos ?? true

  const base = {
    nezet,
    meta: result.meta,
    osszesites: result.osszesites,
    figyelmeztetes: result.osszesites.valid ? null : result.osszesites.megjegyzes,
  }

  if (nezet === 'tulajdonosok') {
    const { slice, lapozas } = page(result.tulajdonosok, offset, limit)
    return { ...base, tulajdonosok: slice, lapozas }
  }

  if (nezet === 'bejegyzesek' || nezet === 'terhek') {
    const source = nezet === 'bejegyzesek' ? result.tulajdoniBejegyzesek : result.terhek
    const filtered = csakHatalyos ? source.filter((e) => e.hatalyos) : source
    const { slice, lapozas } = page(filtered, offset, limit)
    return { ...base, bejegyzesek: stripRaw(slice, args.raw === true), lapozas }
  }

  // Összefoglaló: minden, ami egy első kérdés megválaszolásához kell.
  // Az ingatlan `raw` (teljes I. rész szövege) kimarad — nagy, és a strukturált
  // mezők ugyanazt hordozzák.
  const ingatlan: Omit<TulajdoniLapIngatlan, 'raw'> = { ...result.ingatlan }
  delete (ingatlan as Partial<TulajdoniLapIngatlan>).raw
  return {
    ...base,
    ingatlan,
    szeljegyek: result.szeljegyek,
    tulajdonosok: result.tulajdonosok.slice(0, TULAJDONI_LAP_SUMMARY_OWNERS),
    lapozas: {
      osszesen: result.tulajdonosok.length,
      offset: 0,
      limit: TULAJDONI_LAP_SUMMARY_OWNERS,
      kovetkezoOffset:
        result.tulajdonosok.length > TULAJDONI_LAP_SUMMARY_OWNERS
          ? TULAJDONI_LAP_SUMMARY_OWNERS
          : null,
    },
  }
}
