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
  /**
   * Párosított személykulcsok (név|év|anyja) — sibling DELETE megjegyzéshez.
   * Csak a név nem elég: apa/fia azonos névvel eltérő születési évnél nem összevonás.
   */
  const parositottSzemelyek: Array<{
    nev: string
    szuletesiEv: string | null
    anyjaNeve: string | null
  }> = []
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
    parositottSzemelyek.push({
      nev: owner.nev,
      szuletesiEv: owner.szuletesiEv ?? normalizeEv(parositott.reg.szuletesiEv),
      anyjaNeve: owner.anyjaNeve ?? parositott.reg.anyjaNeve ?? null,
    })
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
    // Összevonás csak akkor, ha van párosított személy UGYANAZZAL a névvel, és
    // a meglévő kulcsok (év / anyja neve) nem mondanak ellent — különben más ember.
    const osszevonas = parositottSzemelyek.some((paired) => {
      if (normalizeNev(paired.nev) !== normalizeNev(reg.nev)) return false
      const pairedEv = normalizeEv(paired.szuletesiEv)
      const regEv = normalizeEv(reg.szuletesiEv)
      const pairedAnyja = normalizeNev(paired.anyjaNeve)
      const regAnyja = normalizeNev(reg.anyjaNeve)
      if (pairedEv && regEv && pairedEv !== regEv) return false
      if (pairedAnyja && regAnyja && pairedAnyja !== regAnyja) return false
      return true
    })
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
        osszevonas
          ? 'Összevonás: ugyanezen tulajdonos másik nyilvántartási sora — a lap összesített hányada a párosított sorra (Módosítás/Rendben) kerül; ezt a sort kötelező törölni (DELETE), különben a hányad duplázódik.'
          : 'A hatályos tulajdoni lapon nem szerepel tulajdonosként.',
        reg.megjegyzes ?? '',
        szeljegyMegjegyzes,
      ]
        .filter(Boolean)
        .join(' '),
      bejegyzesSorszamok: [],
      azonosito: reg.azonosito ?? null,
    })
    figyelmet_igenyel.push(
      osszevonas
        ? `Törlés szükséges (összevonás): ${reg.nev}`
        : `Törlés szükséges: ${reg.nev}`,
    )
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

// ── Föld műveleti terv (determinisztikus, modell nélkül) ─────────────────────

export type FoldElteroSor = {
  nev: string
  statusz: string
  hanyadLap: string | null
  hanyadNyilvantartas?: string | null
  azonosito: string | null
}

export type FoldMuveletAction = 'delete' | 'patch' | 'post'

export type FoldMuveletItem = {
  action: FoldMuveletAction
  method: 'DELETE' | 'PATCH' | 'POST'
  statusFromEgyeztetes: string
  nev: string
  ownershipId: string | null
  /** Path `{parcelId}` placeholderral, ha a parcelId még nincs meg. */
  path: string
  body: Record<string, unknown> | null
  megjegyzes: string | null
}

export type FoldMuveletekPlan = {
  parcelId: string | null
  proposalId: null
  source: 'egyeztetes-eltero.json'
  /** Jóváhagyáskor / draft-írásnál kötelező: DELETE → PATCH → POST. */
  executionOrder: readonly ['delete', 'patch', 'post']
  summary: { delete: number; patch: number; post: number; total: number }
  items: FoldMuveletItem[]
}

const FOLD_STATUS_TO_ACTION: Record<string, FoldMuveletAction | null> = {
  'Törlés szükséges': 'delete',
  'Módosítás szükséges': 'patch',
  'Új rekord': 'post',
  Rendben: null,
}

const FOLD_ACTION_ORDER: Record<FoldMuveletAction, number> = {
  delete: 0,
  patch: 1,
  post: 2,
}

/**
 * Eltérő egyeztető sorok → végrehajtható Föld Ownership terv.
 * Sorrend: DELETE, majd PATCH, majd POST — a Föld hányadösszeg-invariánsához.
 * Az `items` a forrásigazság: a modell NE cserélje / NE találjon ki ownership id-t.
 */
export function buildFoldMuveletekFromEltero(input: {
  eltero: FoldElteroSor[]
  parcelId?: string | null
}): FoldMuveletekPlan {
  const parcelId = input.parcelId?.trim() || null
  const parcelSegment = parcelId ?? '{parcelId}'
  const parcelPlaceholderNote = parcelId
    ? null
    : 'HIÁNYZÓ parcelId — a path `{parcelId}` placeholdert a Föld parcel-keresés után cseréld; ne hívd literálisan.'
  const items: FoldMuveletItem[] = []

  for (const row of input.eltero) {
    const action = FOLD_STATUS_TO_ACTION[row.statusz] ?? null
    if (!action) continue

    if (action === 'post') {
      items.push({
        action: 'post',
        method: 'POST',
        statusFromEgyeztetes: row.statusz,
        nev: row.nev,
        ownershipId: null,
        path: `/parcels/${parcelSegment}/ownerships`,
        body: row.hanyadLap ? { hanyad: row.hanyadLap } : null,
        megjegyzes: [
          'Új ownership — partnerId a Föld partner-keresés / POST /partners után.',
          parcelPlaceholderNote,
        ]
          .filter(Boolean)
          .join(' '),
      })
      continue
    }

    const ownershipId = row.azonosito?.trim() || null
    if (!ownershipId) {
      items.push({
        action,
        method: action === 'delete' ? 'DELETE' : 'PATCH',
        statusFromEgyeztetes: row.statusz,
        nev: row.nev,
        ownershipId: null,
        path: `/parcels/${parcelSegment}/ownerships/{ownershipId}`,
        body: action === 'patch' && row.hanyadLap ? { hanyad: row.hanyadLap } : null,
        megjegyzes: ['HIÁNYZÓ ownership id — ne tippelj; állj meg.', parcelPlaceholderNote]
          .filter(Boolean)
          .join(' '),
      })
      continue
    }

    items.push({
      action,
      method: action === 'delete' ? 'DELETE' : 'PATCH',
      statusFromEgyeztetes: row.statusz,
      nev: row.nev,
      ownershipId,
      path: `/parcels/${parcelSegment}/ownerships/${ownershipId}`,
      body: action === 'patch' && row.hanyadLap ? { hanyad: row.hanyadLap } : null,
      megjegyzes: [
        action === 'delete' && !row.hanyadLap
          ? 'Összevonás vagy felesleges sor — DELETE kötelező, ha a névnek van PATCH/Rendben párja is.'
          : null,
        parcelPlaceholderNote,
      ]
        .filter(Boolean)
        .join(' ') || null,
    })
  }

  items.sort((a, b) => FOLD_ACTION_ORDER[a.action] - FOLD_ACTION_ORDER[b.action])

  const summary = {
    delete: items.filter((i) => i.action === 'delete').length,
    patch: items.filter((i) => i.action === 'patch').length,
    post: items.filter((i) => i.action === 'post').length,
    total: items.length,
  }

  return {
    parcelId,
    proposalId: null,
    source: 'egyeztetes-eltero.json',
    executionOrder: ['delete', 'patch', 'post'],
    summary,
    items,
  }
}

export type FoldMuveletekCoverage = {
  ok: boolean
  expected: number
  applied: number
  missing: Array<{ ownershipId: string; nev: string; action: FoldMuveletAction }>
  /** Alkalmazott id, ami NINCS a tervben — tipikusan hallucinált cuid. */
  extra: string[]
  message: string
}

/**
 * Proposal / HTTP invoke sor: ténylegesen alkalmazott Ownership írás.
 * A magyar változatok is kellenek: a Föld-tool kimenetek vegyesen használják az
 * angol HTTP igét és a magyar szót — a hiányuk NÉMA hamis „hiányzó DELETE”
 * riasztást adna, amitől az agent újraírná a már meglévő tételeket.
 * A státusz-mondatok (`Törlés szükséges`) SZÁNDÉKOSAN nincsenek benne: azok az
 * egyeztető terv-sorai, nem alkalmazott írások.
 */
const APPLIED_OWNERSHIP_WRITE_MUVELETEK = new Set([
  'DELETE',
  'PATCH',
  'PUT',
  'UPDATE',
  'TORLES',
  'MODOSITAS',
])

/** Ékezet + kisbetű nélküli alak — `Módosítás` és `MODOSITAS` ugyanaz. */
function normalizeMuvelet(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
}

function isFoldMuveletekPlanShape(rec: Record<string, unknown>): boolean {
  // A terv (fold_muveletek.json) NEM alkalmazott proposal — ha „applied”-ként
  // adjuk be, a path / ownershipId mezők hamis lefedettség-OK-ot adnának, és a
  // hiányzó sibling DELETE validate/submitig eljutna.
  if (rec.source === 'egyeztetes-eltero.json') return true
  if (Array.isArray(rec.executionOrder) && Array.isArray(rec.items)) return true
  return false
}

/**
 * Egyeztető eltérés-sor (nev + statusz + azonosito) — terv, nem alkalmazás.
 * A `statusz` értékét is nézzük: egy valódi proposal tételnek is lehet státusza
 * (pl. `draft`), azt nem szabad emiatt eldobni.
 */
function isElteroRowShape(rec: Record<string, unknown>): boolean {
  if (typeof rec.statusFromEgyeztetes === 'string') return true
  return (
    typeof rec.statusz === 'string' &&
    (EGYEZTETES_STATUSZOK as string[]).includes(rec.statusz.trim())
  )
}

/**
 * Rossz fájl a `coverageAppliedPath`-on? → közérthető indok, különben null.
 *
 * Enélkül a terv/eltérés-lista beadása „hiányzik mind a N id” üzenetet adna,
 * ami rossz irányba tereli az agentet (újraír), holott csak a fájlt tévesztette.
 */
export function describeInvalidAppliedSource(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (isFoldMuveletekPlanShape(rec)) {
    return 'ez a fold_muveletek terv, nem a Föld proposal tételeinek kivonata'
  }
  if (Array.isArray(rec.eltero)) {
    return 'ez az egyeztetes-eltero lista, nem a Föld proposal tételeinek kivonata'
  }
  return null
}

/**
 * Proposal extract / tool-eredmény → ownership id halmaz (PATCH/DELETE).
 * CREATE / Partner / LandParcel tételek és a proposal `itemId` (`id`) NEM számítanak —
 * azok `extra` hamis pozitívot adnának a coverage-ben.
 *
 * Fontos: a `fold_muveletek` terv path/ownershipId mezői NEM „alkalmazott” id-k.
 * A path-ból csak DELETE/PATCH/PUT/UPDATE muvelet után olvasunk — CREATE sor
 * pathje (vagy a terv maga) korábban a filter ELŐTT bekerült, és silent false OK-ot
 * adott a coverage kapun.
 */
export function extractAppliedOwnershipIds(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    if (raw.every((x) => typeof x === 'string')) {
      return [...new Set(raw.map((x) => x.trim()).filter(Boolean))]
    }
    const ids: string[] = []
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue
      const rec = row as Record<string, unknown>
      // Terv- / egyeztető sor: `statusFromEgyeztetes` (fold_muveletek items) vagy
      // `statusz` (egyeztetes-eltero) — egyik sem alkalmazott írás.
      if (isElteroRowShape(rec)) continue

      const entityType =
        typeof rec.entityType === 'string' ? rec.entityType.toLowerCase() : null
      if (entityType && !entityType.includes('ownership')) continue

      // `action` SZÁNDÉKOSAN kimarad: az a fold_muveletek terv mezője
      // (`delete`/`patch`/`post`), nem a proposal `muvelet` / HTTP method.
      const muveletRaw =
        (typeof rec.muvelet === 'string' && rec.muvelet) ||
        (typeof rec.method === 'string' && rec.method) ||
        ''
      const muvelet = normalizeMuvelet(muveletRaw)
      // Művelet nélküli sor csak akkor számít, ha kimondottan Ownership tétel
      // (`entityType`) — a terv és az eltérés-lista sorain nincs ilyen mező, így
      // ez nem nyitja vissza a hamis „minden megvan” utat, viszont a puszta
      // id-listát tartalmazó kivonat nem esik ki némán.
      const applied = muvelet
        ? APPLIED_OWNERSHIP_WRITE_MUVELETEK.has(muvelet)
        : entityType != null
      if (!applied) continue

      const path = typeof rec.path === 'string' ? rec.path : null
      if (path) {
        const m = /\/ownerships\/([^/?#]+)/.exec(path)
        const fromPath = m?.[1]?.trim()
        if (fromPath && fromPath !== '{ownershipId}') ids.push(fromPath)
      }

      const id =
        (typeof rec.entityId === 'string' && rec.entityId) ||
        (typeof rec.ownershipId === 'string' && rec.ownershipId) ||
        (typeof rec.azonosito === 'string' && rec.azonosito) ||
        null
      if (id?.trim()) ids.push(id.trim())
    }
    return [...new Set(ids)]
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>
    if (isFoldMuveletekPlanShape(rec)) return []
    // `eltero` kimarad: az egyeztető eltérő sorai (azonosito + státusz), nem
    // proposal-alkalmazás — belőle hamis „minden id megvan” OK jönne.
    for (const key of ['items', 'applied', 'rows', 'data']) {
      if (Array.isArray(rec[key])) return extractAppliedOwnershipIds(rec[key])
    }
  }
  return []
}

/**
 * A terv PATCH/DELETE ownership id-jei ⊆ alkalmazott id-k?
 * (POST-nál nincs előzetes id — azokat a summary.post számossággal ellenőrizd külön.)
 */
export function checkFoldMuveletekCoverage(
  plan: FoldMuveletekPlan,
  appliedIds: Iterable<string>,
): FoldMuveletekCoverage {
  const applied = new Set([...appliedIds].map((id) => id.trim()).filter(Boolean))
  const expectedItems = plan.items.filter(
    (item) => (item.action === 'delete' || item.action === 'patch') && item.ownershipId,
  )
  const expectedIds = new Set(expectedItems.map((item) => item.ownershipId!))
  const missing = expectedItems
    .filter((item) => !applied.has(item.ownershipId!))
    .map((item) => ({
      ownershipId: item.ownershipId!,
      nev: item.nev,
      action: item.action,
    }))
  const extra = [...applied].filter((id) => !expectedIds.has(id))
  const ok = missing.length === 0 && extra.length === 0
  const message = ok
    ? `Lefedettség rendben: ${expectedItems.length}/${expectedItems.length} tervezett PATCH/DELETE id a proposalban.`
    : [
        missing.length
          ? `Hiányzó ${missing.length} tervezett Ownership id (nem került a csomagba).`
          : null,
        // Egy id sem jött ki: majdnem mindig rossz fájl (terv / eltérés-lista /
        // nem Ownership kivonat), nem 80 kimaradt írás. Ha ezt nem mondjuk ki,
        // az agent újraírja a már meglévő tételeket.
        missing.length && applied.size === 0
          ? 'Egyetlen alkalmazott Ownership id sem jött ki a megadott fájlból — ' +
            'ellenőrizd, hogy a coverageAppliedPath a Föld proposal tételeinek ' +
            'kivonatára mutat-e (nem a fold_muveletek tervre és nem az ' +
            'egyeztetes-eltero listára).'
          : null,
        extra.length
          ? `${extra.length} extra / ismeretlen id a csomagban (ne hagyj jóvá — lehet hallucinált).`
          : null,
      ]
        .filter(Boolean)
        .join(' ')

  return {
    ok,
    expected: expectedItems.length,
    applied: applied.size,
    missing,
    extra,
    message,
  }
}
