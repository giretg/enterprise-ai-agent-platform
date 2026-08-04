/**
 * Tulajdoni lap ↔ nyilvántartás egyeztetés — a párosítás és a kimeneti tábla
 * TISZTA magja (issue #161).
 *
 * Miért van erre külön modul: a folyamat korábban a chatben, sok LLM-körben
 * zajlott (lapozás, ad-hoc JSON, cellánkénti Excel-írás). Ez a párosítás
 * azonban determinisztikus szabály, nem ítélet — az LLM-kör csak költséget és
 * hibalehetőséget adott hozzá. Innentől a döntési szabály itt él, tesztelve,
 * és egyetlen eszközhívás futtatja le.
 *
 * A modul semmit nem ír és nem olvas: bemenet a két oldal, kimenet a sorok +
 * összegzés + a munkafüzet leírása.
 */

import type { TulajdoniLapEntry, TulajdoniLapOwner, TulajdoniLapResult } from './tulajdoni-lap'
import { COMMON_HTTP_PAGE_SIZES } from './http-api-pagination-signals'

/** A nyilvántartásunk egy tulajdonosi rekordja (a hívó tölti ki az API-válaszból). */
export type EgyeztetesNyilvantartasSor = {
  nev: string
  szuletesiEv?: string | number | null
  anyjaNeve?: string | null
  /** Tört alakban, pl. „3/4". Százalék NEM fogadható el — l. `parseHanyad`. */
  hanyad?: string | null
  cim?: string | null
  azonosito?: string | null
  megjegyzes?: string | null
}

function firstPresent(
  row: Record<string, unknown>,
  keys: string[],
): string | number | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  const value = firstPresent(row, keys)
  return value == null ? null : String(value)
}

/**
 * API / extract sor → kanonikus egyeztető mezők.
 * Az Ostoros Föld ownership válasz gyakran `partnerNev` / `id` / `jogcim`
 * alakú — ezeket elfogadjuk, hogy ne kelljen modelloldali mezőátnevezés.
 */
export function normalizeNyilvantartasRow(
  row: Record<string, unknown>,
): EgyeztetesNyilvantartasSor | null {
  const nev = firstString(row, ['nev', 'partnerNev', 'partnerName', 'name', 'teljesNev', 'fullName'])
  if (!nev) return null
  return {
    nev,
    szuletesiEv: firstPresent(row, ['szuletesiEv', 'szuletesi_ev', 'birthYear', 'szulEv']),
    anyjaNeve: firstString(row, ['anyjaNeve', 'anyja_neve', 'motherName', 'anyja']),
    hanyad: firstString(row, ['hanyad', 'ownershipShare', 'share', 'tulajdoniHanyad']),
    cim: firstString(row, ['cim', 'address', 'lakcim']),
    // Ownership rekord ID (PATCH/DELETE path). NE partnerId — az a partner, nem az ownership.
    azonosito: firstString(row, ['azonosito', 'ownershipId', 'id', 'uuid']),
    megjegyzes: firstString(row, ['megjegyzes', 'jogcim', 'note', 'title', 'jogallas']),
  }
}

export function normalizeNyilvantartasRows(rows: unknown[]): EgyeztetesNyilvantartasSor[] {
  const out: EgyeztetesNyilvantartasSor[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const normalized = normalizeNyilvantartasRow(row as Record<string, unknown>)
    if (normalized) out.push(normalized)
  }
  return out
}

export type EgyeztetesStatusz =
  | 'Rendben'
  | 'Módosítás szükséges'
  | 'Törlés szükséges'
  | 'Új rekord'

export type EgyeztetesForras = 'Tulajdoni lap' | 'Nyilvántartás' | 'Mindkettő'

export type EgyeztetesSor = {
  forras: EgyeztetesForras
  nev: string
  szuletesiEv: string | null
  anyjaNeve: string | null
  jogallas: string | null
  hanyadLap: string | null
  szazalekLap: number | null
  hanyadNyilvantartas: string | null
  statusz: EgyeztetesStatusz
  megjegyzes: string
  /** A lap II. részének sorszámai, amikből a hányad összeáll (visszakereséshez). */
  bejegyzesSorszamok: number[]
  /**
   * Nyilvántartásbeli ownership / rekord ID (PATCH/DELETE).
   * Új rekordnál null — ott még nincs ownership id.
   */
  azonosito: string | null
}

export type EgyeztetesOsszegzes = {
  osszesSor: number
  rendben: number
  modositas: number
  torles: number
  ujRekord: number
  /** Nem teljes kulcson (hiányzó szül. év / anyja neve) alapuló párosítások. */
  bizonytalanParositas: number
  /** Emberi döntést igénylő tételek — a válaszban ezeket kell felsorolni. */
  figyelmet_igenyel: string[]
}

export type NyilvantartasCompletenessVerdict = {
  /** true → ne készüljön Excel / ok:false (csonka lista gyanúja). */
  block: boolean
  /** true → Excel készülhet, de a válaszban kötelező jelezni. */
  warn: boolean
  indok: string | null
}

/**
 * Csonka nyilvántartás-detektor (http_api_get első oldal anti-minta).
 *
 * Tipikus hiba: ownerships-re sima get → 50 sor → extract → egyeztetés →
 * százas nagyságrendű hamis „Új rekord". A tábla hitelesnek látszana.
 *
 * `sourceLooksComplete`: a forrás http_api_get_all archívum (végiglapozott).
 * `confirmedComplete`: a hívó tudatosan felülírja a védelmet.
 */
export function assessNyilvantartasCompleteness(input: {
  lapTulajdonosDb: number
  nyilvantartasDb: number
  ujRekordDb: number
  sourceLooksComplete?: boolean
  confirmedComplete?: boolean
}): NyilvantartasCompletenessVerdict {
  if (input.confirmedComplete) {
    return { block: false, warn: false, indok: null }
  }

  const lap = input.lapTulajdonosDb
  const reg = input.nyilvantartasDb
  const uj = input.ujRekordDb
  if (lap < 10) {
    return { block: false, warn: false, indok: null }
  }

  let gyanus = false
  let indok: string | null = null

  if (reg === 0) {
    gyanus = true
    indok =
      `A nyilvántartás 0 sort tartalmaz, miközben a lapon ${lap} hatályos tulajdonos van. ` +
      'Ez tipikusan rossz hrsz / üres lekérdezés — NE egyeztess így. ' +
      'Hívd http_api_get_all-lal a helyes /ownerships (vagy ekvivalens) végpontot, ' +
      'ellenőrizd a hrsz formátumát, majd futtasd újra. ' +
      'Ha a lista tényleg üres: confirmNyilvantartasComplete=true.'
  } else {
    const ujArany = uj / lap
    const looksLikeSinglePage = COMMON_HTTP_PAGE_SIZES.has(reg)
    const registryMuchSmaller = reg < lap * 0.35
    if (
      (looksLikeSinglePage && ujArany >= 0.4 && uj > reg) ||
      (registryMuchSmaller && ujArany >= 0.5)
    ) {
      gyanus = true
      indok =
        `A nyilvántartás csak ${reg} sort tartalmaz, a lapon ${lap} tulajdonos van ` +
        `(Új rekord: ${uj}). Ez tipikusan egyetlen http_api_get oldal (gyakori pageSize: 10/25/50/100), ` +
        'nem a teljes lista — a tábla hamis „Új rekord" sorokkal telne meg. ' +
        'Hívd ÚJRA http_api_get_all-lal a /ownerships (vagy ekvivalens) path-ot, ' +
        'add át a tool-outputs/…http_api_get_all… fájlt nyilvantartasPath-ként, ' +
        'majd futtasd újra az egyeztetést. ' +
        'Ha get_all után is ennyi a sor: confirmNyilvantartasComplete=true.'
    }
  }

  if (!gyanus || !indok) {
    return { block: false, warn: false, indok: null }
  }

  if (input.sourceLooksComplete) {
    return { block: false, warn: true, indok }
  }
  return { block: true, warn: false, indok }
}

/**
 * Csak a Tool Broker által az `http_api_get_all` válaszába tett struktúrált
 * eredet-metaadat igazolja, hogy a lista végig lett lapozva. Fájlnév sosem
 * bizonyíték: a munkaterületre tetszőleges nevű JSON kerülhet.
 */
export function hasCompleteHttpApiGetAllProvenance(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const provenance = (value as { provenance?: unknown }).provenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return false
  const record = provenance as { sourceTool?: unknown; paginationComplete?: unknown }
  return record.sourceTool === 'http_api_get_all' && record.paginationComplete === true
}

const HANYAD_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*$/

/** Tört → arány. Százalék, üres és értelmezhetetlen érték `null`. */
export function parseHanyad(value: string | null | undefined): number | null {
  if (!value) return null
  const match = HANYAD_RE.exec(value)
  if (!match) return null
  const denominator = Number(match[2])
  if (!denominator) return null
  return Number(match[1]) / denominator
}

/**
 * Névnormalizálás a párosításhoz: kisbetű, többes szóköz össze, a magyar
 * ékezetek megtartva (két külön ember neve különbözhet CSAK ékezetben).
 * A CSUPA NAGYBETŰS (INYER) és a Kezdőbetűs alak így egy kulcsra esik.
 */
export function normalizeNev(value: string | null | undefined): string {
  return (value ?? '').toLocaleLowerCase('hu-HU').replace(/\s+/g, ' ').trim()
}

function normalizeEv(value: string | number | null | undefined): string | null {
  if (value == null) return null
  const text = String(value).trim()
  const match = /(\d{4})/.exec(text)
  return match ? match[1] : null
}

type MatchStrength = 'teljes' | 'részleges' | 'nincs'

/**
 * Párosítási erősség. A név ÖNMAGÁBAN nem azonosító: ugyanazon a lapon
 * előfordul apa és fia alig eltérő névvel. Ezért:
 *   - teljes    — név + születési év + anyja neve mind egyezik,
 *   - részleges — a név egyezik, és a másik két kulcs közül ami MEGVAN, az
 *                 egyezik (a hiányzó régi bejegyzéseknél gyakori),
 *   - nincs     — a név egyezik, de egy meglévő kulcs ténylegesen ELTÉR
 *                 (= két különböző ember), vagy a név sem egyezik.
 */
export function matchStrength(
  lap: { nev: string; nevValtozatok?: string[] | null; szuletesiEv: string | null; anyjaNeve: string | null },
  reg: EgyeztetesNyilvantartasSor,
): MatchStrength {
  const lapNevek = new Set(
    [lap.nev, ...(lap.nevValtozatok ?? [])].map(normalizeNev).filter(Boolean),
  )
  if (!lapNevek.has(normalizeNev(reg.nev))) return 'nincs'

  const lapEv = normalizeEv(lap.szuletesiEv)
  const regEv = normalizeEv(reg.szuletesiEv)
  const lapAnyja = normalizeNev(lap.anyjaNeve)
  const regAnyja = normalizeNev(reg.anyjaNeve)

  if (lapEv && regEv && lapEv !== regEv) return 'nincs'
  if (lapAnyja && regAnyja && lapAnyja !== regAnyja) return 'nincs'
  if (lapEv && regEv && lapAnyja && regAnyja) return 'teljes'
  return 'részleges'
}

/** Eltérés csak akkor, ha MINDKÉT oldalon van érték, és azok különböznek. */
function mindkettoMegvanEsElter<T>(
  a: T | null | undefined,
  b: T | null | undefined,
  normalize: (value: T | null | undefined) => string | null,
): boolean {
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return false
  return left !== right
}

function formatSorszamok(sorszamok: number[]): string {
  return sorszamok.map((n) => `II/${n}`).join(' + ')
}

/**
 * A két oldal UNIÓJA sorokká. Fontos, hogy unió: ha csak a lapból generálnánk,
 * a „Törlés szükséges" eset — jellemzően a legértékesebb találat — sosem
 * jelenhetne meg.
 */
export function egyeztetesSorok(input: {
  lapTulajdonosok: TulajdoniLapOwner[];
  nyilvantartas: EgyeztetesNyilvantartasSor[]
  /** Van-e a lapon széljegy — ilyenkor az eltérés jogos is lehet. */
  vanSzeljegy?: boolean
}): { sorok: EgyeztetesSor[]; osszegzes: EgyeztetesOsszegzes } {
  const sorok: EgyeztetesSor[] = []
  const figyelmet_igenyel: string[] = []
  const parositottRegisztraciok = new Set<number>()
  let bizonytalanParositas = 0

  const szeljegyMegjegyzes = input.vanSzeljegy
    ? 'A lapon széljegy (folyamatban lévő ügy) van — az eltérés emiatt is lehet jogos.'
    : ''

  for (const owner of input.lapTulajdonosok) {
    const jeloltek = input.nyilvantartas
      .map((reg, index) => ({ reg, index, strength: matchStrength(owner, reg) }))
      .filter((c) => c.strength !== 'nincs' && !parositottRegisztraciok.has(c.index))
    const teljes = jeloltek.find((c) => c.strength === 'teljes')
    const parositott = teljes ?? jeloltek[0]

    const megjegyzesek: string[] = []
    if (owner.bejegyzesSorszamok.length > 1) {
      megjegyzesek.push(`${formatSorszamok(owner.bejegyzesSorszamok)} összege`)
    }
    if (szeljegyMegjegyzes) megjegyzesek.push(szeljegyMegjegyzes)

    if (!parositott) {
      sorok.push({
        forras: 'Tulajdoni lap',
        nev: owner.nev,
        szuletesiEv: owner.szuletesiEv,
        anyjaNeve: owner.anyjaNeve,
        jogallas: 'TULAJDONOS',
        hanyadLap: owner.hanyad,
        szazalekLap: owner.szazalek,
        hanyadNyilvantartas: null,
        statusz: 'Új rekord',
        megjegyzes: megjegyzesek.join(' '),
        bejegyzesSorszamok: owner.bejegyzesSorszamok,
        azonosito: null,
      })
      figyelmet_igenyel.push(`Új rekord: ${owner.nev}`)
      continue
    }

    parositottRegisztraciok.add(parositott.index)
    if (parositott.strength === 'részleges') {
      bizonytalanParositas += 1
      megjegyzesek.push(
        'A párosítás nem teljes kulcson alapul (hiányzó születési év vagy anyja neve) — emberi ellenőrzés kell.',
      )
      figyelmet_igenyel.push(`Bizonytalan párosítás: ${owner.nev}`)
    }

    const lapArany = parseHanyad(owner.hanyad)
    const regArany = parseHanyad(parositott.reg.hanyad)
    const hanyadEgyezik = lapArany != null && regArany != null && lapArany === regArany
    if (parositott.reg.hanyad && regArany == null) {
      megjegyzesek.push(
        `A nyilvántartás hányada nem tört alakú („${parositott.reg.hanyad}") — nem összehasonlítható.`,
      )
    }
    // Eltérés CSAK ott van, ahol mindkét oldalon van érték. A nyilvántartásból
    // hiányzó születési év / anyja neve nem eltérés, hanem hiányos rekord — azt
    // a bizonytalan párosítás jelöli. (A ténylegesen ELTÉRŐ kulcs egyébként sem
    // jut idáig: abból `matchStrength` szerint nincs párosítás.)
    const eltéroMezok = [
      mindkettoMegvanEsElter(owner.szuletesiEv, parositott.reg.szuletesiEv, normalizeEv)
        ? 'születési év'
        : null,
      mindkettoMegvanEsElter(owner.anyjaNeve, parositott.reg.anyjaNeve, normalizeNev)
        ? 'anyja neve'
        : null,
      mindkettoMegvanEsElter(owner.cim, parositott.reg.cim, normalizeNev) ? 'cím' : null,
    ].filter((value): value is string => value != null)
    const adatEltér = eltéroMezok.length > 0

    let statusz: EgyeztetesStatusz = 'Rendben'
    if (!hanyadEgyezik) {
      statusz = 'Módosítás szükséges'
      megjegyzesek.push(
        `Hányad eltér: lap ${owner.hanyad ?? '—'} / nyilvántartás ${parositott.reg.hanyad ?? '—'}.`,
      )
    } else if (adatEltér) {
      statusz = 'Módosítás szükséges'
      megjegyzesek.push(`A hányad stimmel, de eltér: ${eltéroMezok.join(', ')}.`)
    }
    if (parositott.reg.megjegyzes) megjegyzesek.push(parositott.reg.megjegyzes)

    sorok.push({
      forras: 'Mindkettő',
      nev: owner.nev,
      szuletesiEv: owner.szuletesiEv ?? normalizeEv(parositott.reg.szuletesiEv),
      anyjaNeve: owner.anyjaNeve ?? parositott.reg.anyjaNeve ?? null,
      jogallas: 'TULAJDONOS',
      hanyadLap: owner.hanyad,
      szazalekLap: owner.szazalek,
      hanyadNyilvantartas: parositott.reg.hanyad ?? null,
      statusz,
      megjegyzes: megjegyzesek.join(' '),
      bejegyzesSorszamok: owner.bejegyzesSorszamok,
      azonosito: parositott.reg.azonosito ?? null,
    })
    if (statusz !== 'Rendben') {
      figyelmet_igenyel.push(`Módosítás: ${owner.nev}`)
    }
  }

  input.nyilvantartas.forEach((reg, index) => {
    if (parositottRegisztraciok.has(index)) return
    sorok.push({
      forras: 'Nyilvántartás',
      nev: reg.nev,
      szuletesiEv: normalizeEv(reg.szuletesiEv),
      anyjaNeve: reg.anyjaNeve ?? null,
      jogallas: null,
      hanyadLap: null,
      szazalekLap: null,
      hanyadNyilvantartas: reg.hanyad ?? null,
      statusz: 'Törlés szükséges',
      megjegyzes: [
        'A hatályos tulajdoni lapon nem szerepel tulajdonosként.',
        reg.megjegyzes ?? '',
        szeljegyMegjegyzes,
      ]
        .filter(Boolean)
        .join(' '),
      bejegyzesSorszamok: [],
      azonosito: reg.azonosito ?? null,
    })
    figyelmet_igenyel.push(`Törlés szükséges: ${reg.nev}`)
  })

  const osszegzes: EgyeztetesOsszegzes = {
    osszesSor: sorok.length,
    rendben: sorok.filter((r) => r.statusz === 'Rendben').length,
    modositas: sorok.filter((r) => r.statusz === 'Módosítás szükséges').length,
    torles: sorok.filter((r) => r.statusz === 'Törlés szükséges').length,
    ujRekord: sorok.filter((r) => r.statusz === 'Új rekord').length,
    bizonytalanParositas,
    figyelmet_igenyel,
  }

  return { sorok, osszegzes }
}

export const EGYEZTETES_FEJLEC = [
  'Forrás',
  'Tulajdonos',
  'Születési év',
  'Anyja neve',
  'Jogállás',
  'Hányad (lap)',
  '% (lap)',
  'Hányad (nyilv.)',
  'Terület (ha)',
  'AK',
  'Ellenőrzési státusz',
  'Megjegyzés',
] as const

export const EGYEZTETES_STATUSZOK: EgyeztetesStatusz[] = [
  'Rendben',
  'Módosítás szükséges',
  'Törlés szükséges',
  'Új rekord',
]

type CellValue = string | number | null

/**
 * A munkafüzet TELJES tartalma egy adatszerkezetben — a fájlt ebből egyetlen
 * menetben írjuk ki, nem cellánként, körönként.
 *
 * Az I/J oszlop szándékosan képlet: a terület és az AK az Ingatlan munkalap
 * B5/B6 cellájából jön, így az ellenőrző ember ott javíthat egy helyen.
 */
export type EgyeztetesMunkafuzet = {
  egyeztetesSorok: CellValue[][]
  ingatlanSorok: CellValue[][]
  /** Az utolsó adatsor száma (1-alapú), a fejléccel együtt. */
  utolsoAdatSor: number
  osszegSor: number
}

export function buildEgyeztetesMunkafuzet(input: {
  sorok: EgyeztetesSor[]
  parsed: Pick<TulajdoniLapResult, 'meta' | 'osszesites' | 'szeljegyek'> & {
    ingatlan?: { teruletHaOsszesen?: string; akOsszesen?: string; muvelesiAgak?: string[] }
    terhek?: TulajdoniLapEntry[]
  }
}): EgyeztetesMunkafuzet {
  const rows: CellValue[][] = [[...EGYEZTETES_FEJLEC]]
  input.sorok.forEach((sor, index) => {
    const excelRow = index + 2
    const lapOldali = sor.forras !== 'Nyilvántartás'
    rows.push([
      sor.forras,
      sor.nev,
      sor.szuletesiEv,
      sor.anyjaNeve,
      sor.jogallas,
      sor.hanyadLap,
      sor.szazalekLap,
      sor.hanyadNyilvantartas,
      // A % / terület / AK csak a lap-oldali sorra értelmes — a „Törlés
      // szükséges" sorokba nem találunk ki értéket.
      lapOldali ? `=G${excelRow}/100*Ingatlan!$B$5` : null,
      lapOldali ? `=G${excelRow}/100*Ingatlan!$B$6` : null,
      sor.statusz,
      sor.megjegyzes,
    ])
  })

  const utolsoAdatSor = input.sorok.length + 1
  const osszegSor = utolsoAdatSor + 1
  rows.push([
    'Összesen',
    null,
    null,
    null,
    null,
    null,
    input.sorok.length > 0 ? `=SUM(G2:G${utolsoAdatSor})` : 0,
    null,
    null,
    null,
    null,
    'A lap-oldali százalékok összege — pontosan 100 kell legyen.',
  ])

  const ingatlan = input.parsed.ingatlan ?? {}
  const ingatlanSorok: CellValue[][] = [
    ['Mező', 'Érték'],
    ['Ingatlan megnevezése', input.parsed.meta.ingatlanMegnevezes ?? null],
    ['Ügyazonosító', input.parsed.meta.ugyazonosito ?? null],
    ['Lap kelte', input.parsed.meta.kelt ?? null],
    ['Lap típusa', input.parsed.meta.tipus ?? null],
    ['Terület (ha)', numberOrNull(ingatlan.teruletHaOsszesen)],
    ['AK', numberOrNull(ingatlan.akOsszesen)],
    ['Művelési ágak', (ingatlan.muvelesiAgak ?? []).join(', ') || null],
    ['Hatályos hányadok összege', input.parsed.osszesites.hatalyosHanyadOsszeg],
    ['Ellenőrzés', input.parsed.osszesites.valid ? 'rendben (összeg = 1)' : 'BUKOTT — az összeg nem 1'],
    [null, null],
    ['Széljegyek', null],
  ]
  for (const szeljegy of input.parsed.szeljegyek ?? []) {
    ingatlanSorok.push([szeljegy.azonosito, szeljegy.szoveg])
  }
  ingatlanSorok.push([null, null], ['Terhek (III. RÉSZ) — csak a hatályosak', null])
  for (const teher of input.parsed.terhek ?? []) {
    if (!teher.hatalyos) continue
    ingatlanSorok.push([
      `III/${teher.sorszam}`,
      [teher.tipus, teher.jogcim, teher.nev, teher.jogTerjedelme].filter(Boolean).join(' · '),
    ])
  }

  return { egyeztetesSorok: rows, ingatlanSorok, utolsoAdatSor, osszegSor }
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) return null
  const normalized = Number(value.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(normalized) ? normalized : null
}
