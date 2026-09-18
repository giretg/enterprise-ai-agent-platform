/**
 * Tool-szerződés keményítés — kikényszerített KIMENETI szerződés (issue #195).
 *
 * ÜZLETI PROBLÉMA: amikor az agent „nem végzi el a feladatát", az esetek nagy
 * részében nem a modell hibázott, hanem az eszköz csendben félrement — és ezt
 * sem az agent, sem a felhasználó nem tudta meg. A tünet mindig ugyanaz: a
 * rendszer sikert jelent, de a végeredmény üres, hiányos vagy rossz (üres Excel,
 * hiányzó sorok a riportban), és a felhasználó csak a fájl megnyitásakor veszi
 * észre.
 *
 * A gyökér: az eszköz-eredménynek eddig nem volt FUTÁSIDŐBEN kikényszerített
 * szerződése. A típusos union csak fordításidejű állítás volt; semmi nem
 * ellenőrizte, hogy a handler azt adta-e vissza, amit ígért, és semmi nem
 * különböztette meg a „sikeresen elkészült" és a „sikeresen semmit nem csinált"
 * esetet.
 *
 * EZ A MODUL a Tool Broker határán futó kapu (D1–D4, D6, D7):
 *   - D1: minden eredmény kap egy kötelező `ToolOutcome` kimenetel-mezőt;
 *   - D2: tool-onkénti Zod kimeneti séma, futásidőben validálva, az AUDIT ELŐTT;
 *   - D3: az ürességet a tool definiálja (`emptiness`), nem a hívó találgatja;
 *   - D4: mellékhatásos toolnál a hatás MÉRVE, nem állítva (`effect`);
 *   - D6: `modelText` méret-kapu determinisztikus, JELÖLT csonkolással;
 *   - D7: bemeneti méret-kapu — a kombinatorikus toolok azonnal `failed`-del
 *         állnak meg, nem húzzák le a workert.
 *
 * A tool-onkénti szerződések a `tool-output-contracts.ts`-ben élnek (WP-3/WP-4).
 */
import { z, type ZodType } from 'zod'

import type { TrustClass } from './tool-broker-types'
import { envelopeToolResultForModel, escapeFenceSequences } from './tool-result-envelope'

/**
 * D1 — minden tool-eredmény kimenetele. Az `empty` és a `partial` NEM hiba,
 * hanem TÉNY, amit a modellnek meg kell kapnia: a rossz viselkedés nem az, hogy
 * üres lett, hanem hogy az agent nem tudott róla.
 *   - `ok`      — elvégezte, amit ígért, nem üres eredménnyel;
 *   - `empty`   — lefutott, de nem termelt semmit (0 találat, 0 sor, 0 bájt);
 *   - `partial` — részben végzett; kötelező megmondani, mi maradt ki és miért;
 *   - `failed`  — nem végzett; kötelező hibaok (kivételként bukik ki).
 */
export type ToolOutcome = 'ok' | 'empty' | 'partial' | 'failed'

/** A sikeres végrehajtás kimenetelei (a `failed` kivételként bukik). */
export type SettledToolOutcome = Exclude<ToolOutcome, 'failed'>

/**
 * D4 — a mellékhatás MÉRT összegzése. „Sikeresen írtam" állítás önmagában nem
 * elfogadható kimenet: a broker ebből dönt az `empty`-ről, és ez kerül az
 * auditba (`ToolCall.effectSummary`) is.
 */
export type ToolEffectSummary = {
  /** A mért mennyiség (sor, cella, bájt, darab). 0 → a hatás elmaradt. */
  amount: number
  /** A mennyiség egysége, hétköznapi magyar szóval (pl. `sor`, `bájt`). */
  unit: string
  /** Az érintett cél: fájl-útvonal, ticket- vagy üzenet-azonosító, URL. */
  target: string | null
}

/**
 * Egy tool kimeneti szerződése. A `outputSchema` kivételével minden mező
 * opcionális — a hiányzó rész FAIL-SAFE alapértelmezésre esik (l. lentebb).
 */
export type ToolOutputContract = {
  /**
   * D2 — a kimenet Zod sémája. A broker VALIDÁL, de az EREDETI objektumot adja
   * tovább (nem a parse eredményét): a szerződés így nem tud csendben mezőt
   * elnyelni vagy típust konvertálni, csak elbuktatni a sértést.
   */
  readonly outputSchema: ZodType
  /**
   * D3 — üres-e az eredmény. A visszaadott szöveg az ÜRESSÉG OKA hétköznapi
   * magyarul (ez megy a modellhez és a felületre); `null` = nem üres.
   */
  readonly emptiness?: (output: unknown) => string | null
  /**
   * Részleges-e az eredmény. A visszaadott szöveg megmondja, MI MARADT KI és
   * MIÉRT (korlát, kvóta, hibás bemenet); `null` = nem részleges.
   */
  readonly partial?: (output: unknown) => string | null
  /** D4 — a mellékhatás MÉRT összegzése (mellékhatásos toolnál kötelező). */
  readonly effect?: (output: unknown) => ToolEffectSummary | null
  /** D6 — a modellnek szánt szöveg maximuma bájtban (alap: `DEFAULT_MAX_MODEL_BYTES`). */
  readonly maxModelBytes?: number
  /**
   * D7 — bemeneti méret-kapu az ARGUMENTUMOKON, a handler-hívás ELŐTT. A
   * visszaadott szöveg az elutasítás oka; `null` = a bemenet belefér.
   */
  readonly maxInputSize?: (args: Record<string, unknown>) => string | null
}

/** A szerződés-sértés tipizált osztályai — a néma továbbengedés helyett. */
export type ToolContractViolationCode =
  | 'output_schema_violation'
  | 'input_limit_exceeded'
  | 'workload_limit_exceeded'

/**
 * Szerződés-sértés: a hívás kimenetele `failed`. Kivételként bukik ki, hogy a
 * broker meglévő hiba-ága (audit + `ToolCall` status=error) rögzítse, és a
 * fogyasztó ne kaphasson csendben érvénytelen eredményt.
 */
export class ToolContractError extends Error {
  readonly outcome: ToolOutcome = 'failed'

  constructor(
    readonly code: ToolContractViolationCode,
    message: string,
    readonly tool?: string,
  ) {
    super(message)
    this.name = 'ToolContractError'
  }
}

/**
 * D6 — a csonkolás GÉPILEG FELISMERHETŐ jelölése. Szándékosan NEM `<<<…>>>`:
 * az `external_untrusted` burkolat escape-eli a három-szög szekvenciákat, így a
 * jelölés ott is olvasható maradna, ahol a payload burkolatba kerül.
 */
export const TOOL_OUTPUT_TRUNCATED_MARKER = '[[TOOL_OUTPUT_TRUNCATED]]'

/**
 * Globális alapértelmezett `modelText` méret-korlát. Szándékosan BŐ: a
 * chat-tool-loop saját, munkaterületre kitelepítő archiválása (12k karakter)
 * ennél jóval hamarabb lép, tehát ez a kapu a többi fogyasztónak
 * (agent tools API, wiki/general-task runtime) a backstop, nem az elsődleges
 * méret-szabályozó. Így a kockázati megjegyzés (túl szigorú korlát feladatot
 * tör) nem realizálódik: az agresszív csonkolást a tool-onkénti felülírás adja.
 */
export const DEFAULT_MAX_MODEL_BYTES = 200_000

// ── D3 fail-safe üresség-heurisztika ─────────────────────────────────────────

/**
 * FAIL-SAFE üresség (D3): ha a tool nem definiált `emptiness` predikátumot, a
 * validált kimenet alakja dönt — üres tömb / üres szöveg / `null` / üres objektum
 * → `empty`. Inkább egy fölösleges „nem találtam semmit", mint egy néma üres Excel.
 */
export function heuristicEmptiness(output: unknown): string | null {
  if (output === null || output === undefined) return 'az eszköz nem adott vissza eredményt'
  if (typeof output === 'string') {
    return output.trim().length === 0 ? 'az eszköz üres szöveget adott vissza' : null
  }
  if (Array.isArray(output)) {
    return output.length === 0 ? 'az eszköz üres listát adott vissza' : null
  }
  if (typeof output !== 'object') return null

  const record = output as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return 'az eszköz üres eredményt adott vissza'

  // Egyetlen lista-mezős burkoló (pl. { hits: [] }, { users: [] }): a lista
  // ürességéből egyértelműen következik az eredmény üressége.
  const arrayKeys = keys.filter((key) => Array.isArray(record[key]))
  if (arrayKeys.length === 1 && (record[arrayKeys[0]] as unknown[]).length === 0) {
    return `az eszköz egyetlen elemet sem talált (${arrayKeys[0]}: 0)`
  }
  return null
}

// ── A szerződés-kapu ─────────────────────────────────────────────────────────

/** A kapu ítélete egy sikeresen lefutott hívásról. */
export type ToolOutputVerdict = {
  outcome: SettledToolOutcome
  /**
   * Miért `empty` / `partial` — hétköznapi magyarul. `ok`-nál `null`. Ez a szöveg
   * megy a modellhez ÉS a felületre, hogy a felhasználó is értse.
   */
  reason: string | null
  /** D4 — a mért mellékhatás (olvasó toolnál `null`). */
  effect: ToolEffectSummary | null
}

/**
 * A KIMENETI SZERZŐDÉS KAPUJA — a handler visszatérése után, az audit- és a
 * `ToolCall`-rögzítés ELŐTT fut.
 *
 * 1. D2 — séma-validáció. Sértés → `ToolContractError` (`failed`), nem néma
 *    továbbengedés. A validáció NEM alakítja át a kimenetet.
 * 2. D4 — mellékhatás-mérés. Mellékhatásos toolnál a mért hatás hiánya vagy a
 *    nulla mennyiség `empty`-t ad: a puszta „sikeresen írtam" állítás nem elég.
 * 3. D3 — üresség: a tool `emptiness` predikátuma, hiányában a heurisztika.
 * 4. részlegesség: a tool `partial` predikátuma.
 */
export function validateToolOutput(params: {
  tool: string
  output: unknown
  contract: ToolOutputContract | undefined
  sideEffecting: boolean
}): ToolOutputVerdict {
  const { tool, output, contract, sideEffecting } = params

  // 1. D2 — séma. Fail-safe: szerződés nélküli (jövőbeli) toolnál nincs mit
  //    sérteni, de az üresség-heurisztika és a mellékhatás-szabály attól még fut.
  const schema = contract?.outputSchema ?? z.unknown()
  const parsed = schema.safeParse(output)
  if (!parsed.success) {
    throw new ToolContractError(
      'output_schema_violation',
      `${tool}: az eszköz kimenete nem felel meg a kimeneti szerződésnek — ${formatSchemaIssues(parsed.error)}`,
      tool,
    )
  }

  // 2. D4 — a hatás MÉRVE, nem állítva.
  const effect = contract?.effect?.(output) ?? null
  if (sideEffecting) {
    if (!effect) {
      return {
        outcome: 'empty',
        reason:
          'az eszköz nem adott mért hatás-összegzést, ezért nem igazolható, hogy bármit is megváltoztatott',
        effect: null,
      }
    }
    if (effect.amount <= 0) {
      return {
        outcome: 'empty',
        reason: describeZeroEffect(effect),
        effect,
      }
    }
  }

  // 3. D3 — üresség: a tool definiálja, nem a hívó találgatja. A heurisztika CSAK
  //    a fail-safe ág: ha a mellékhatás már MÉRVE van és nem nulla, akkor az
  //    üresség kérdésére megvan a válasz — a találgatás ilyenkor csak hamis
  //    „üres" riasztást adna (pl. a részletlista mezője üres, mert nincs
  //    bizonytalan tétel, miközben 120 sor tényleg elkészült).
  const emptyReason = contract?.emptiness
    ? contract.emptiness(output)
    : effect && effect.amount > 0
      ? null
      : heuristicEmptiness(output)
  if (emptyReason) return { outcome: 'empty', reason: emptyReason, effect }

  // 4. részlegesség: mi maradt ki és miért.
  const partialReason = contract?.partial?.(output) ?? null
  if (partialReason) return { outcome: 'partial', reason: partialReason, effect }

  return { outcome: 'ok', reason: null, effect }
}

/** A nulla mennyiségű mellékhatás hétköznapi megfogalmazása. */
function describeZeroEffect(effect: ToolEffectSummary): string {
  const target = effect.target ? ` (${effect.target})` : ''
  return `az eszköz lefutott, de 0 ${effect.unit} lett az eredménye${target} — a művelet nem járt tényleges hatással`
}

/** Zod hibalista tömör, naplózható alakban (az első néhány probléma). */
function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(gyökér)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

// ── D7 bemeneti méret-kapu ───────────────────────────────────────────────────

/**
 * D7 — bemeneti méret-kapu a handler-hívás ELŐTT. A `reconcile_records`
 * O(n×m) worker-fagyása mutatta meg, hogy a szerződés nem csak a kimenetről
 * szól: a korlát fölött azonnal `failed` a válasz, nem egy megfagyott worker.
 */
export function assertToolInputWithinLimits(
  tool: string,
  args: unknown,
  contract: ToolOutputContract | undefined,
): void {
  if (!contract?.maxInputSize) return
  const record = args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
  const reason = contract.maxInputSize(record)
  if (reason) throw new ToolContractError('input_limit_exceeded', `${tool}: ${reason}`, tool)
}

/**
 * D7 — a kombinatorikus MUNKAMENNYISÉG kapuja a handleren BELÜL. Van, ahol a
 * bemenet mérete csak a fájlok beolvasása után derül ki (`reconcile_records`
 * két listája): ilyenkor a handler maga méri, és a korlát fölött azonnal
 * megáll — nem indítja el az O(n×m) párosítást.
 */
export function assertToolWorkloadWithinLimit(params: {
  tool: string
  units: number
  limit: number
  /** Mit mértünk — hétköznapi magyarul (pl. `összehasonlítás`). */
  unit: string
  /** Mit tegyen helyette a hívó (a modell ebből tud továbblépni). */
  hint: string
}): void {
  if (params.units <= params.limit) return
  throw new ToolContractError(
    'workload_limit_exceeded',
    `${params.tool}: a feladat mérete (${params.units} ${params.unit}) meghaladja a ${params.limit} ${params.unit} korlátot. ${params.hint}`,
    params.tool,
  )
}

// ── D6 méret-kapu + a modellnek szánt szöveg összeállítása ───────────────────

export type ToolModelTextResult = {
  /** A modellnek szánt, bizalmi osztály szerint BECSOMAGOLT szöveg. */
  modelText: string
  /** Csonkolt-e a hasznos tartalom (D6 → a kimenetel `partial` lesz). */
  truncated: boolean
  /** A csonkolás oka hétköznapi magyarul, ha volt csonkolás. */
  truncationReason: string | null
}

/**
 * D5 + D6 — a MODELLNEK szánt csatorna összeállítása:
 *   (a) a gépi adat JSON-alakja, méret-kapuval, determinisztikus csonkolással,
 *   (b) a bizalmi osztály szerinti becsomagolás (`envelopeToolResultForModel`),
 *   (c) a kimenetel HÉTKÖZNAPI NYELVŰ közlése a burkolaton KÍVÜL (platform-szöveg,
 *       nem külső adat) — hogy az `empty`/`partial` ne maradjon rejtve.
 *
 * A `machineData` sosem megy át ezen: az a gépi fogyasztók (munkaterület,
 * downstream tool, egyeztetés, export) csatornája, és SOHA nem burkolt.
 */
export function buildToolModelText(params: {
  tool: string
  trust: TrustClass
  outcome: SettledToolOutcome
  reason: string | null
  effect: ToolEffectSummary | null
  /** A gépi adat — ennek a JSON-alakja kerül a burkolatba. */
  machineData: unknown
  maxModelBytes?: number
  /** Hol érhető el a teljes tartalom csonkolás esetén (munkaterületi útvonal). */
  fullDataRef?: string | null
}): ToolModelTextResult {
  const body = safeJsonStringify(params.machineData)
  const limit = params.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES
  const gated = truncateToBytes(body, limit)

  const notices: string[] = []
  const outcomeNotice = describeOutcomeForModel(params.outcome, params.reason, params.effect)
  if (outcomeNotice) notices.push(outcomeNotice)

  let truncationReason: string | null = null
  if (gated.truncated) {
    // A hivatkozás is a burkolaton KÍVÜLRE kerül, ezért ugyanúgy semlegesítendő.
    const fullRef = params.fullDataRef ? sanitizeOutcomeNotice(params.fullDataRef) : null
    truncationReason = fullRef
      ? `az eredmény ${gated.originalBytes} bájt volt, a modellbe csak ${limit} bájt fér — a teljes tartalom itt érhető el: ${fullRef}`
      : `az eredmény ${gated.originalBytes} bájt volt, a modellbe csak ${limit} bájt fér — a lenti tartalom csonkolt`
    notices.push(
      `${TOOL_OUTPUT_TRUNCATED_MARKER} bytes=${gated.originalBytes} limit=${limit} full=${fullRef ?? 'n/a'} — ` +
        `Az eszköz eredménye nem fért be egészben. ${
          fullRef
            ? `A teljes tartalom a munkaterületen van: ${fullRef} — onnan dolgozz tovább, NE olvasd vissza darabokban.`
            : 'A hiányzó rész NEM látszik lentebb — ne következtess a teljes adatra ebből a részletből.'
        }`,
    )
  }

  const enveloped = envelopeToolResultForModel(params.trust, gated.text)
  const modelText = notices.length > 0 ? `${notices.join('\n')}\n${enveloped}` : enveloped
  return { modelText, truncated: gated.truncated, truncationReason }
}

/**
 * A SIKERES hívás két csatornája egy lépésben: szerződés-validáció (D1–D4) +
 * a modell-szöveg összeállítása méret-kapuval (D6). Egyetlen hívási pont, hogy
 * a broker és minden dublőr/teszt UGYANAZT az alakot állítsa elő — egy külön
 * összeszerelt eredmény könnyen kihagyna egy szabályt.
 */
export type ToolOutcomeChannels = {
  outcome: SettledToolOutcome
  outcomeReason: string | null
  effect: ToolEffectSummary | null
  /** D5 — becsomagolt, méret-kapuzott szöveg a MODELLNEK. */
  modelText: string
  /** D5 — nyers, SOSEM burkolt adat a GÉPI fogyasztóknak. */
  machineData: unknown
}

export function buildToolOutcomeChannels(params: {
  tool: string
  trust: TrustClass
  /** A handler nyers kimenete. Ez lesz a `machineData` — változatlanul. */
  output: unknown
  /**
   * APG-04 — a modellnek szánt JSON törzs. Ha meg van adva, a `modelText` ebből
   * készül; a szerződés-validáció és a `machineData` továbbra is a nyers `output`.
   */
  modelOutput?: unknown
  contract: ToolOutputContract | undefined
  sideEffecting: boolean
  fullDataRef?: string | null
  /** Már lefuttatott nyers-output verdict; privacy után így nincs második validáció. */
  validatedVerdict?: ToolOutputVerdict
}): ToolOutcomeChannels {
  const verdict =
    params.validatedVerdict ??
    validateToolOutput({
      tool: params.tool,
      output: params.output,
      contract: params.contract,
      sideEffecting: params.sideEffecting,
    })
  const modelChannel = buildToolModelText({
    tool: params.tool,
    trust: params.trust,
    outcome: verdict.outcome,
    reason: verdict.reason,
    effect: verdict.effect,
    machineData: params.modelOutput ?? params.output,
    maxModelBytes: params.contract?.maxModelBytes,
    fullDataRef: params.fullDataRef,
  })
  // D6 — a csonkolt eredmény kimenetele `partial`: a modell a jelölésből tudja,
  // hogy a látott adat nem a teljes. Egy már `empty`/`partial` ítéletet nem ír felül.
  const promoted = modelChannel.truncated && verdict.outcome === 'ok'
  return {
    outcome: promoted ? 'partial' : verdict.outcome,
    outcomeReason: promoted ? modelChannel.truncationReason : verdict.reason,
    effect: verdict.effect,
    modelText: modelChannel.modelText,
    machineData: params.output,
  }
}

/**
 * A kimenetel-közlésbe kerülő DINAMIKUS szövegtöredék semlegesítése.
 *
 * A közlés a burkolaton KÍVÜL, platform-szövegként megy a modellhez — a
 * `reason` és az `effect` mezői viszont a tool KIMENETÉBŐL származnak, tehát
 * lehetnek külső, támadó által írt adatok (feltöltött dokumentum fájlneve, egy
 * connector hibaüzenete, munkalap-név, találati figyelmeztetés). Enélkül a
 * burkolat (issue #97) megkerülhető lenne: elég egy sortörésekkel és
 * `<<<END_EXTERNAL_UNTRUSTED_DATA>>>`-szerű szekvenciával megtűzdelt fájlnév.
 *
 * Ezért: a határoló-szekvenciák escape-elve, a szöveg EGY sorba fogva (a
 * beékelt „új utasítás-blokk" így nem tud önálló sornak látszani), és
 * hosszban korlátozva.
 */
const NOTICE_FRAGMENT_MAX_CHARS = 500

export function sanitizeOutcomeNotice(text: string): string {
  const singleLine = escapeFenceSequences(text)
    // Sortörés és egyéb vezérlőkarakter → szóköz: a közlés egyetlen sor marad.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return singleLine.length > NOTICE_FRAGMENT_MAX_CHARS
    ? `${singleLine.slice(0, NOTICE_FRAGMENT_MAX_CHARS)}…`
    : singleLine
}

/**
 * WP-6 — a kimenetel HÉTKÖZNAPI NYELVEN. Nem `outcome: empty`, hanem
 * „Az eszköz lefutott, de egyetlen sort sem talált" — a modellnek is, a
 * felületnek is ez a mondat megy.
 */
export function describeOutcomeForModel(
  outcome: SettledToolOutcome,
  reason: string | null,
  effect: ToolEffectSummary | null,
): string | null {
  if (outcome === 'ok') return null
  if (outcome === 'empty') {
    return (
      `FIGYELEM — AZ ESZKÖZ NEM TERMELT EREDMÉNYT: ${sanitizeOutcomeNotice(reason ?? 'az eszköz lefutott, de nem született eredmény')}. ` +
      'Ez NEM sikeres elvégzés: ne állítsd a felhasználónak, hogy kész van. ' +
      'Vagy próbáld más bemenettel/eszközzel, vagy mondd el neki érthetően, hogy nem született eredmény és miért.'
    )
  }
  const measured = effect
    ? ` Eddig mért hatás: ${effect.amount} ${sanitizeOutcomeNotice(effect.unit)}${
        effect.target ? ` (${sanitizeOutcomeNotice(effect.target)})` : ''
      }.`
    : ''
  return (
    `FIGYELEM — AZ ESZKÖZ CSAK RÉSZBEN VÉGZETT: ${sanitizeOutcomeNotice(reason ?? 'a művelet egy része kimaradt')}.${measured} ` +
    'Ne kezeld teljesnek: vagy pótold a hiányzó részt, vagy mondd el a felhasználónak, mi maradt ki.'
  )
}

/** A kimenetel rövid, felületre való mondata (activity/UI detail). */
export function describeOutcomeForUi(
  outcome: SettledToolOutcome,
  reason: string | null,
): string | null {
  if (outcome === 'ok') return null
  const detail = sanitizeOutcomeNotice(reason ?? '')
  if (outcome === 'empty') {
    return `nem született eredmény — ${detail || 'az eszköz üres eredményt adott'}`
  }
  return `csak részben készült el — ${detail || 'a művelet egy része kimaradt'}`
}

/**
 * Determinisztikus, bájt-alapú csonkolás. UTF-8 bájthatáron vág, a keletkező
 * csonka többbájtos szekvenciát (U+FFFD) levágja, hogy a szöveg érvényes
 * maradjon. Ugyanaz a bemenet mindig ugyanazt a kimenetet adja.
 */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes }
  const sliced = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  return { text: sliced.replace(/�+$/, ''), truncated: true, originalBytes }
}

/** Ciklus-biztos JSON — a szerződés-kapu sosem bukhat el a naplózáson. */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return String(value)
  }
}
