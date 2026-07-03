import type { OkfSourceRef } from './kb-v3'

/**
 * KB-v3 §15 eval-harness (Sprint 4).
 *
 * RAG nélkül az eval kicsi és **determinisztikus**: minden publikált artifacthoz
 * generálható egy kérdés-készlet (a forrás OKF-oldalaiból) + negatív kérdések
 * („nem tudható a dokumentumból"), és egy retrieval-függvényen lefuttatva
 * mérhetők a §15/§20 metrikák:
 *
 * - **navigációs helyesség** — a jó OKF-oldalra jutott-e (top-hit `path` a
 *   várt oldalak közt van-e);
 * - **retrieval recall** — jött-e egyáltalán találat a pozitív kérdésre (az
 *   answer-groundedness szükséges, de nem elégséges feltétele — a tényleges
 *   groundedness LLM-spot-checket kíván, lásd §15);
 * - **source-link helyesség** — a top-hit forrás-linkje a várt forrás-locusra
 *   (oldal/section/cella) mutat-e (§3.3 az egyetlen biztonsági háló, ezért ez a
 *   legfontosabb metrika);
 * - **no-answer precízió** — a negatív kérdésekre helyesen tartózkodik-e a
 *   rendszer (nincs küszöb feletti találat);
 * - **latency** és **token-költség** (utóbbi opcionális, a retrieve adja).
 *
 * A harness maga **nem hív LLM-et** — a retrieval-függvényt kívülről kapja, így
 * ugyanaz a kód futtatható a determinisztikus assembler ellen (regresszió) és
 * később egy valódi runtime-loop ellen. A körkörösség tudatos korlátja (§15):
 * ez smoke/regressziós jelzés, nem abszolút minőségmérce — emberi spot-check kell mellé.
 */

/** A retrieval-függvénynek átadott minimál találat-alak (a `KbSearchHit` részhalmaza). */
export type EvalHit = {
  path?: string
  score?: number
  source?: {
    documentId?: string
    filename?: string
    page?: number
    section?: string
    cell?: string
  }
}

export type EvalCaseKind = 'positive' | 'negative'

export type EvalCase = {
  id: string
  kind: EvalCaseKind
  /** Ember-olvasható kérdés-címke (riporthoz). */
  question: string
  /** A retrieval-függvénynek ténylegesen átadott lekérdezés. */
  query: string
  /** Pozitív esetnél a helyes OKF-oldal(ak) path-ja. Negatívnál üres. */
  expectedPaths: string[]
  /** Pozitív esetnél a várt forrás-locus (oldal/section/cella). Negatívnál undefined. */
  expectedSource?: OkfSourceRef
}

/** A retrieve-fn visszatérhet nyers hit-tömbbel vagy hit+tokenköltség objektummal. */
export type EvalRetrieveOutput = EvalHit[] | { hits: EvalHit[]; tokenCost?: number }

export type EvalRetrieve = (query: string) => EvalRetrieveOutput | Promise<EvalRetrieveOutput>

export type EvalCaseResult = {
  case: EvalCase
  hitCount: number
  topPath: string | null
  /** Pozitív: a top-hit a várt oldalra jutott-e (navigációs helyesség). */
  navigationCorrect: boolean | null
  /** Pozitív: jött-e egyáltalán találat (retrieval recall). */
  retrieved: boolean | null
  /** Pozitív: a top-hit forrás-linkje a várt locusra mutat-e. */
  sourceLinkCorrect: boolean | null
  /** Negatív: helyesen tartózkodott-e (nincs küszöb feletti találat). */
  abstainedCorrectly: boolean | null
  latencyMs: number
  tokenCost: number | null
}

export type EvalReport = {
  total: number
  positives: number
  negatives: number
  /** navigációs helyesség = jó oldalra jutott / pozitív (0..1). */
  navigationCorrectness: number
  /** retrieval recall = jött találat / pozitív (0..1). */
  retrievalRecall: number
  /**
   * source-link helyesség = helyes forrás-locus / (navigációsan helyes pozitív).
   * A nevező a navigációsan eltalált esetek — rossz oldalon a forrás-locus
   * kérdése értelmetlen. Ha nincs ilyen eset, 1 (vacuously correct).
   */
  sourceLinkCorrectness: number
  /** no-answer precízió = helyesen tartózkodott / negatív (0..1). */
  noAnswerPrecision: number
  latency: { totalMs: number; avgMs: number; maxMs: number }
  /** Összesített token-költség, ha a retrieve adott (különben null). */
  tokenCost: number | null
  results: EvalCaseResult[]
}

/**
 * Alapértelmezett, egyértelműen tartományon kívüli negatív lekérdezések
 * („nem tudható a dokumentumból", §15). Determinisztikus és tartomány-független
 * — a hívó felülírhatja / kiegészítheti domain-specifikus negatívokkal.
 */
export const DEFAULT_NEGATIVE_QUERIES: string[] = [
  'zztop_ismeretlen_fogalom_xyzzy',
  'kvantumszíndinamika ebédmenü tervezet',
  'marslakó nyugdíjszámítás 2099',
]

/** Egy chunk-részhalmaz, amiből eval-eseteket generálunk (a published korpusz). */
export type EvalSourceChunk = {
  path: string
  title: string
  text: string
  sourceRef: OkfSourceRef | null
}

/** Az `index.md`-t (navigációs oldal) sosem tesszük eval-esetté. */
const INDEX_PATH = 'index.md'

/** A cím alfanumerikus tokenjei — ez lesz a lekérdezés (a full-text a title-t is indexeli). */
function titleQuery(title: string): string {
  const tokens = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
  return tokens.join(' ')
}

/** A várt forrás-locus (page/section/cell) kivonása a chunk sourceRef-jéből. */
function expectedSourceOf(chunk: EvalSourceChunk): OkfSourceRef | undefined {
  const ref = chunk.sourceRef
  if (!ref) return undefined
  const out: OkfSourceRef = {}
  if (typeof ref.page === 'number') out.page = ref.page
  else if (ref.cell) out.cell = ref.cell
  else if (ref.section) out.section = ref.section
  if (ref.documentId) out.documentId = ref.documentId
  if (ref.filename) out.filename = ref.filename
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * §15 — determinisztikus eval-készlet a published OKF-korpuszból. Oldalanként
 * (path) egy pozitív kérdés a cím alapján (a full-text a title-t is indexeli,
 * így a helyes oldalra kell navigálnia), plusz a negatív kérdések. Az azonos
 * path-ú chunkokat egy esetbe vonja össze (a legkisebb `chunkIndex`/első
 * előfordulás forrás-locusával).
 */
export function generateEvalCases(input: {
  chunks: EvalSourceChunk[]
  negativeQueries?: string[]
}): EvalCase[] {
  const byPath = new Map<string, EvalSourceChunk>()
  for (const chunk of input.chunks) {
    if (chunk.path === INDEX_PATH) continue
    if (!byPath.has(chunk.path)) byPath.set(chunk.path, chunk)
  }

  const positives: EvalCase[] = [...byPath.values()]
    .map((chunk, idx): EvalCase | null => {
      const query = titleQuery(chunk.title)
      if (!query) return null
      return {
        id: `pos-${String(idx + 1).padStart(2, '0')}`,
        kind: 'positive',
        question: `„${chunk.title}" — mit mond erről a tudásbázis?`,
        query,
        expectedPaths: [chunk.path],
        expectedSource: expectedSourceOf(chunk),
      }
    })
    .filter((c): c is EvalCase => c !== null)

  const negatives: EvalCase[] = (input.negativeQueries ?? DEFAULT_NEGATIVE_QUERIES).map(
    (query, idx) => ({
      id: `neg-${String(idx + 1).padStart(2, '0')}`,
      kind: 'negative' as const,
      question: `Nem-tudható kontroll: „${query}"`,
      query,
      expectedPaths: [],
    }),
  )

  return [...positives, ...negatives]
}

function normalizeOutput(out: EvalRetrieveOutput): { hits: EvalHit[]; tokenCost: number | null } {
  if (Array.isArray(out)) return { hits: out, tokenCost: null }
  return { hits: out.hits, tokenCost: typeof out.tokenCost === 'number' ? out.tokenCost : null }
}

/**
 * A top-hit forrás-locusa egyezik-e a várttal (§4.7). A dokumentum-azonosság
 * (documentId vagy filename) is számít, ha a várt oldalon van ilyen. A locus
 * prioritás: page → cell → section (formátumfüggő, D-G).
 */
function sourceMatches(expected: OkfSourceRef | undefined, hit: EvalHit): boolean {
  if (!expected) return true // nincs várt locus → nem büntetünk
  const src = hit.source
  if (!src) return false

  if (expected.documentId && src.documentId && expected.documentId !== src.documentId) return false
  if (
    !expected.documentId &&
    expected.filename &&
    src.filename &&
    expected.filename !== src.filename
  ) {
    return false
  }

  if (typeof expected.page === 'number') return src.page === expected.page
  if (expected.cell) return src.cell === expected.cell
  if (expected.section) return src.section === expected.section
  // Nincs finom locus, de a dokumentum egyezett → elég.
  return true
}

/**
 * §15 — az eval-készlet lefuttatása egy retrieval-függvényen, per-eset
 * verdikttel és aggregált metrikákkal. A `retrieve` bármi lehet (determinisztikus
 * assembler regresszióhoz vagy valódi runtime-loop) — a harness LLM-mentes.
 */
export async function evaluateRetrieval(input: {
  cases: EvalCase[]
  retrieve: EvalRetrieve
  /**
   * A „válaszolt-e" küszöb a top-hit score-jára. Score nélküli (legacy) találat
   * jelenléte önmagában „válaszolt"-nak számít. Default 0 → a puszta jelenlét válasz.
   */
  confidenceThreshold?: number
}): Promise<EvalReport> {
  const threshold = input.confidenceThreshold ?? 0
  const results: EvalCaseResult[] = []

  for (const c of input.cases) {
    const started = performance.now()
    const raw = await input.retrieve(c.query)
    const latencyMs = performance.now() - started
    const { hits, tokenCost } = normalizeOutput(raw)

    const top = hits[0] ?? null
    const topPath = top?.path ?? null
    const topScore = top?.score
    const answered = hits.length > 0 && (topScore === undefined || topScore >= threshold)

    if (c.kind === 'positive') {
      const navigationCorrect = topPath !== null && c.expectedPaths.includes(topPath)
      results.push({
        case: c,
        hitCount: hits.length,
        topPath,
        navigationCorrect,
        retrieved: hits.length > 0,
        sourceLinkCorrect: navigationCorrect ? sourceMatches(c.expectedSource, top!) : false,
        abstainedCorrectly: null,
        latencyMs,
        tokenCost,
      })
    } else {
      results.push({
        case: c,
        hitCount: hits.length,
        topPath,
        navigationCorrect: null,
        retrieved: null,
        sourceLinkCorrect: null,
        abstainedCorrectly: !answered,
        latencyMs,
        tokenCost,
      })
    }
  }

  return aggregate(results)
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1
  return Math.round((numerator / denominator) * 100) / 100
}

function aggregate(results: EvalCaseResult[]): EvalReport {
  const positives = results.filter((r) => r.case.kind === 'positive')
  const negatives = results.filter((r) => r.case.kind === 'negative')

  const navHits = positives.filter((r) => r.navigationCorrect).length
  const retrievedHits = positives.filter((r) => r.retrieved).length
  const navCorrectCases = positives.filter((r) => r.navigationCorrect)
  const sourceHits = navCorrectCases.filter((r) => r.sourceLinkCorrect).length
  const abstained = negatives.filter((r) => r.abstainedCorrectly).length

  const latencies = results.map((r) => r.latencyMs)
  const totalMs = latencies.reduce((s, v) => s + v, 0)
  const tokenCosts = results.map((r) => r.tokenCost).filter((v): v is number => v !== null)
  const tokenCost = tokenCosts.length > 0 ? tokenCosts.reduce((s, v) => s + v, 0) : null

  return {
    total: results.length,
    positives: positives.length,
    negatives: negatives.length,
    navigationCorrectness: ratio(navHits, positives.length),
    retrievalRecall: ratio(retrievedHits, positives.length),
    sourceLinkCorrectness: ratio(sourceHits, navCorrectCases.length),
    noAnswerPrecision: ratio(abstained, negatives.length),
    latency: {
      totalMs: Math.round(totalMs * 100) / 100,
      avgMs: results.length === 0 ? 0 : Math.round((totalMs / results.length) * 100) / 100,
      maxMs: latencies.length === 0 ? 0 : Math.round(Math.max(...latencies) * 100) / 100,
    },
    tokenCost,
    results,
  }
}

/** Ember-olvasható riport (console / audit-kivonat, §13). */
export function formatEvalReport(report: EvalReport): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const lines = [
    `KB-v3 eval — ${report.total} eset (${report.positives} pozitív / ${report.negatives} negatív)`,
    `  navigációs helyesség : ${pct(report.navigationCorrectness)}`,
    `  retrieval recall     : ${pct(report.retrievalRecall)}`,
    `  source-link helyesség: ${pct(report.sourceLinkCorrectness)}`,
    `  no-answer precízió   : ${pct(report.noAnswerPrecision)}`,
    `  latency              : avg ${report.latency.avgMs} ms / max ${report.latency.maxMs} ms`,
    `  token-költség        : ${report.tokenCost === null ? 'n/a' : report.tokenCost}`,
  ]
  return lines.join('\n')
}
