/**
 * chat-agent-turn-resilience-spec.md §7 (E7) — a tool-loop EGYETLEN, tisztán
 * tesztelhető leállási döntéshozója.
 *
 * A loop a kör elején ÉS minden tool-hívás előtt megkérdezi
 * {@link evaluateLoopContinuation}-t: folytatható-e a futás, és ha nem, miért
 * nem. A függvény szándékosan tiszta (nincs I/O, nincs `Date.now()`, nincs
 * globális állapot) — a hívó adja be az eltelt időt és a számlálókat, így a
 * feltételek determinisztikusan tesztelhetők.
 */

/** A leállás strukturált indoka (a `AgentTurn.reason` mezőre is ez kerül). */
export type LoopStopReason =
  | 'cancelled'
  | 'max_turns_exhausted'
  | 'wallclock_timeout'
  | 'tool_budget'
  | 'no_progress'

export type LoopStopDecision = { continue: true } | { continue: false; reason: LoopStopReason }

/** A négy számszerű küszöb, amit a döntéshozó vizsgál. */
export type LoopGuardLimits = {
  /** Körök maximális száma (a meglévő viselkedés — változatlan). */
  maxTurns: number
  /** Faliórai időkorlát a forduló indulásától, ezredmásodpercben. */
  maxWallClockMs: number
  /** Összesített tool-hívás-büdzsé (egy körben több tool is futhat). */
  maxToolCalls: number
  /** Hány egymást követő, előrehaladás nélküli kör után állunk le. */
  maxNoProgressTurns: number
}

/**
 * Dokumentált alapértékek (spec §7). Környezeti változóval és agent-szintű
 * `modelConfig` mezőkkel is felülírhatók — lásd {@link resolveLoopGuardLimits}.
 *
 * A chat (interaktív) szándékosan szűkebb wallclockot kap; a ticket/task futás
 * hosszabb, mert aszinkron és nagy doksi + sok tool-kör kellhet hozzá.
 *
 * A chat kerete 2026-07-31-én 180s → 360s. Indok (mért eset): egy valós CRM-
 * elemzés három egymást követő fordulón futott időkorlátra, és a felhasználónak
 * háromszor kellett „folytasd"-ot írnia ahhoz, hogy választ kapjon — 24 perc
 * faliórában. Egyetlen modellhívás önmagában 5–14 s, egy delegáció 15–50 s, így
 * 180 s alatt 10–12 lépésnyi munka fér el; ez egy több forrásból dolgozó
 * elemzéshez kevés. A felső korlát nem védelmi vonal, hanem az elszabadult futás
 * elleni végállás — a valódi féket a zsákutca- és tool-büdzsé-őr adja.
 */
export const LOOP_GUARD_DEFAULTS = {
  maxWallClockMs: 360_000,
  maxToolCalls: 60,
  maxNoProgressTurns: 3,
} as const

/** Ticket / aszinkron task futások alapértelmezett falióra-kerete (15 perc). */
export const TASK_LOOP_GUARD_DEFAULTS = {
  maxWallClockMs: 900_000,
  maxToolCalls: 120,
  maxNoProgressTurns: 4,
} as const

/** Épeszű tartományok — a konfiguráció nem tudja kikapcsolni a védelmet. */
const LIMIT_RANGES = {
  maxWallClockMs: { min: 10_000, max: 3_600_000 },
  maxToolCalls: { min: 5, max: 500 },
  maxNoProgressTurns: { min: 2, max: 20 },
} as const

export type LoopGuardMode = 'chat' | 'task'

export type LoopGuardState = {
  /** A most következő kör 0-alapú indexe. */
  turn: number
  /** A forduló indulása óta eltelt idő (ms) — a hívó méri. */
  elapsedMs: number
  /** Eddig ténylegesen végrehajtott tool-hívások száma. */
  toolCallCount: number
  /** Egymást követő, előrehaladás nélküli körök száma (lásd `trackTurnProgress`). */
  noProgressTurns: number
  /** Kooperatív megszakítás-kérés (chat Stop vagy DB-flag). */
  cancelRequested: boolean
  limits: LoopGuardLimits
}

const CONTINUE: LoopStopDecision = { continue: true }

/**
 * A falióra utolsó 30%-át (legfeljebb a keret felét) a kész eredményre
 * tartjuk fenn. Így a discovery nem fogyaszthatja el a teljes futást.
 */
export function shouldEnterCompletionPhase(elapsedMs: number, maxWallClockMs: number): boolean {
  const reserveMs = Math.min(maxWallClockMs / 2, Math.max(30_000, maxWallClockMs * 0.3))
  return elapsedMs >= maxWallClockMs - reserveMs
}

/**
 * A loop folytathatóságának egyetlen döntési pontja. A sorrend szándékos: a
 * felhasználói szándék (`cancelled`) mindent megelőz, utána a meglévő
 * kör-limit, majd az új, erőforrás-alapú feltételek.
 */
export function evaluateLoopContinuation(state: LoopGuardState): LoopStopDecision {
  if (state.cancelRequested) return { continue: false, reason: 'cancelled' }
  if (state.turn >= state.limits.maxTurns) {
    return { continue: false, reason: 'max_turns_exhausted' }
  }
  if (state.elapsedMs >= state.limits.maxWallClockMs) {
    return { continue: false, reason: 'wallclock_timeout' }
  }
  if (state.toolCallCount >= state.limits.maxToolCalls) {
    return { continue: false, reason: 'tool_budget' }
  }
  if (state.noProgressTurns >= state.limits.maxNoProgressTurns) {
    return { continue: false, reason: 'no_progress' }
  }
  return CONTINUE
}

/**
 * Egy lezárt kör előrehaladás-mérlege. „Nincs előrehaladás" = nem született új
 * asszisztens-szöveg ÉS a körben futott tool-hívások mindegyike már látott
 * eredményt adott vissza. Ez a per-kör aggregált nézet kiegészíti a meglévő,
 * per-argumentum `REPEAT_LIMIT` guardot: azt a változó argumentumokkal ugyanabba
 * a zsákutcába járó modell megkerüli, ezt nem.
 */
export type TurnProgressSummary = {
  /** Volt-e a körben nem üres asszisztens-szöveg. */
  hadAssistantText: boolean
  /**
   * Hány tool-hívást ADOTT KI a modell ebben a körben (a kimaradt/elutasított
   * hívásokat is beleértve). Ez a fail-safe bemenete: ha a modell dolgozni
   * próbált, a kör NEM lehet semleges, akármelyik ág kezelte a hívást.
   */
  toolCallsIssued: number
  /** Hány tool-hívás adott vissza eredményt (sikeres vagy hibás — de lefutott). */
  toolResultCount: number
  /** Ebből hány adott a korábbiakhoz képest ÚJ eredményt. */
  newToolResultCount: number
}

/**
 * A `noProgressTurns` számláló következő értéke. Előrehaladásnak számít bármi,
 * ami új információt hozott: új szöveg vagy új tool-eredmény.
 *
 * A `toolResultCount === 0` ág FAIL-SAFE, és ez a lényege: ha a modell adott ki
 * tool-hívást, de a kör mérlegébe egyetlen eredmény sem került, az zsákutca —
 * nem semleges kör. Enélkül minden olyan végrehajtási ág, amely elfelejt a
 * mérlegbe jelezni (belső eszköz, elutasított hívás, jóváhagyásra váró lépés),
 * ÉSZREVÉTLENÜL kinyitja a zsákutca-őrt: a számláló befagy, és a futás a
 * kör-limitig pörög. Mért eset (2026-07-29): 40 kör, 2,8M token, nulla eredmény.
 * Tool-hívás nélküli kör (üres modellválasz) továbbra is semleges — arra az
 * üres-válasz ág és a kör-limit felel.
 */
export function trackTurnProgress(previousStreak: number, summary: TurnProgressSummary): number {
  if (summary.hadAssistantText) return 0
  if (summary.toolResultCount === 0) {
    return summary.toolCallsIssued > 0 ? previousStreak + 1 : previousStreak
  }
  if (summary.newToolResultCount > 0) return 0
  return previousStreak + 1
}

/**
 * ── Forrás-alapú előrehaladás ────────────────────────────────────────────────
 *
 * ÜZLETI PROBLÉMA: a „új eredmény = előrehaladás" szabály a tool-eredmény
 * TARTALMÁT nézi. Egy modell viszont ugyanabból a forrásból (fájl, dokumentum,
 * archívum, oldal) más-más szeletet kérve végtelen sok „új" tartalmat tud
 * előállítani anélkül, hogy egy lépést is haladna: `offset`/`limit`
 * változtatásával a tartalmi ujjlenyomat mindig más, a munka mégis ugyanaz.
 * Mérve: 132 visszaolvasás ugyanabból a négy archívumból, 40 körön át.
 *
 * MEGOLDÁS: forrásonként számoljuk, összesen hány karaktert hoztunk be belőle. Ha
 * ez meghaladja a forrás méretéből számított keretet (nagyjából „egyszer
 * végigolvashatod"), a további behozás már NEM számít előrehaladásnak. A tartalom
 * mehet a modellnek — csak a kört nem mossa tisztára. Tool-független: ugyanígy
 * fogja a fájl-újraolvasást, a dokumentum-lapozást és az archívum-visszaolvasást.
 */
export type SourceIngestLimits = {
  /** A forrás méretének ennyiszerese hozható be, mire redundánsnak számít. */
  factor: number
  /** Kis forrásnál a faktor túl szűk lenne; ennyi mindenképp behozható. */
  minChars: number
  /** Ismeretlen méretű forrás (pl. lapozott API) kerete. */
  unknownSourceChars: number
}

export const SOURCE_INGEST_DEFAULTS: SourceIngestLimits = {
  factor: 1.5,
  minChars: 12_000,
  unknownSourceChars: 200_000,
}

/**
 * Env-felülbírálás: `AGENT_SOURCE_INGEST_FACTOR`,
 * `AGENT_SOURCE_INGEST_MIN_CHARS`, `AGENT_SOURCE_INGEST_UNKNOWN_CHARS`.
 * Érvénytelen vagy védelmet kikapcsoló érték → alapérték.
 *
 * EFF-11 (#316 / #237) — opcionális `modelConfig` overlay: precedencia
 * modelConfig → env → default, de csak SZIGORÍTANI tud (kisebb faktor / kisebb
 * minimum). A 0-s vagy lazító érték nem érvényes — a védelem nem némítható.
 * Overlay nélkül az eredmény bájtra azonos az env/defaulttel.
 */
export function resolveSourceIngestLimits(
  env: NodeJS.ProcessEnv = process.env,
  fallback: SourceIngestLimits = SOURCE_INGEST_DEFAULTS,
  modelConfig?: Record<string, unknown> | null,
): SourceIngestLimits {
  const num = (raw: string | undefined, min: number, fb: number): number => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= min ? parsed : fb
  }
  const fromEnv: SourceIngestLimits = {
    factor: num(env.AGENT_SOURCE_INGEST_FACTOR, 1, fallback.factor),
    minChars: num(env.AGENT_SOURCE_INGEST_MIN_CHARS, 1_000, fallback.minChars),
    unknownSourceChars: num(
      env.AGENT_SOURCE_INGEST_UNKNOWN_CHARS,
      10_000,
      fallback.unknownSourceChars,
    ),
  }
  const cfg = modelConfig ?? {}
  const factor =
    typeof cfg.sourceIngestFactor === 'number' && Number.isFinite(cfg.sourceIngestFactor)
      ? cfg.sourceIngestFactor
      : undefined
  const minChars =
    typeof cfg.sourceIngestMinChars === 'number' && Number.isFinite(cfg.sourceIngestMinChars)
      ? cfg.sourceIngestMinChars
      : undefined
  const unknown =
    typeof cfg.sourceIngestUnknownChars === 'number' && Number.isFinite(cfg.sourceIngestUnknownChars)
      ? cfg.sourceIngestUnknownChars
      : undefined
  return {
    factor:
      factor !== undefined && factor >= 1 && factor <= fromEnv.factor ? factor : fromEnv.factor,
    minChars:
      minChars !== undefined && minChars >= 1_000 && minChars <= fromEnv.minChars
        ? Math.round(minChars)
        : fromEnv.minChars,
    unknownSourceChars:
      unknown !== undefined && unknown >= 10_000 && unknown <= fromEnv.unknownSourceChars
        ? Math.round(unknown)
        : fromEnv.unknownSourceChars,
  }
}

/**
 * Egy forrásból a futás alatt behozható karakterek kerete. `sourceChars: null` =
 * a méret nem ismert (lapozott végpont, streamelt tartalom).
 */
export function sourceIngestBudget(
  sourceChars: number | null,
  limits: SourceIngestLimits = SOURCE_INGEST_DEFAULTS,
): number {
  if (sourceChars === null) return limits.unknownSourceChars
  return Math.max(Math.ceil(sourceChars * limits.factor), limits.minChars)
}

/**
 * Ugyanabból a forrásból való ismételt behozás-e (azaz NEM előrehaladás).
 * A döntés a MOSTANI hívás előtti állapotra épül, hogy az első végigolvasás
 * mindig teljes egészében legitim maradjon.
 */
export function isRedundantSourceIngest(input: {
  ingestedCharsBefore: number
  sourceChars: number | null
  limits?: SourceIngestLimits
}): boolean {
  return input.ingestedCharsBefore >= sourceIngestBudget(input.sourceChars, input.limits)
}

/**
 * Egy eszközhívás stabil forrás-azonosítója az argumentumaiból. Szándékosan
 * SZŰK a mezőlista: csak olyan argumentum jó, amely ugyanazt a tartalmat jelöli
 * `offset`/`limit`/`page` változtatása mellett is. Ha nincs ilyen, `null` — akkor
 * a hívás a tartalom-ujjlenyomatos úton mérődik, mint eddig.
 */
export function toolCallSourceKey(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) return null
  const skillVersionId = input.skillVersionId
  const path = input.path
  if (
    toolName === 'load_skill_attachment' &&
    typeof skillVersionId === 'string' &&
    skillVersionId.trim() &&
    typeof path === 'string' &&
    path.trim()
  ) {
    return `skillVersionId:${skillVersionId.trim()}:path:${path.trim()}`
  }
  for (const field of ['path', 'documentId', 'url', 'pageId', 'skillVersionId'] as const) {
    const value = input[field]
    if (typeof value === 'string' && value.trim()) return `${field}:${value.trim()}`
  }
  const id = input.id
  if (typeof id === 'string' && id.trim()) return `${toolName}:id:${id.trim()}`
  return null
}

function clampLimit(value: number, range: { min: number; max: number }): number {
  return Math.min(Math.max(Math.round(value), range.min), range.max)
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const raw = source[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

function readEnvNumber(key: string): number | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * A küszöbök feloldása. Precedencia: agent-szintű `modelConfig` mező →
 * platform-szintű környezeti változó → mód szerinti default
 * ({@link LOOP_GUARD_DEFAULTS} chathez, {@link TASK_LOOP_GUARD_DEFAULTS} taskhoz).
 * Minden érték clamp-elve az épeszű tartományra.
 *
 * | Küszöb | modelConfig mező | Env változó | Chat alap | Task alap |
 * |---|---|---|---|---|
 * | faliórai idő | `maxToolWallClockMs` | `AGENT_LOOP_MAX_WALLCLOCK_MS` | 360s | 900s |
 * | tool-büdzsé | `maxToolCalls` | `AGENT_LOOP_MAX_TOOL_CALLS` | 60 | 120 |
 * | előrehaladás-hiány | `maxNoProgressTurns` | `AGENT_LOOP_MAX_NO_PROGRESS_TURNS` | 3 | 4 |
 */
export function resolveLoopGuardLimits(
  modelConfig: Record<string, unknown> | undefined,
  maxTurns: number,
  mode: LoopGuardMode = 'chat',
): LoopGuardLimits {
  const cfg = modelConfig ?? {}
  const defaults = mode === 'task' ? TASK_LOOP_GUARD_DEFAULTS : LOOP_GUARD_DEFAULTS
  const pick = (configKey: string, envKey: string, fallback: number) =>
    readNumber(cfg, configKey) ?? readEnvNumber(envKey) ?? fallback

  return {
    maxTurns,
    maxWallClockMs: clampLimit(
      pick('maxToolWallClockMs', 'AGENT_LOOP_MAX_WALLCLOCK_MS', defaults.maxWallClockMs),
      LIMIT_RANGES.maxWallClockMs,
    ),
    maxToolCalls: clampLimit(
      pick('maxToolCalls', 'AGENT_LOOP_MAX_TOOL_CALLS', defaults.maxToolCalls),
      LIMIT_RANGES.maxToolCalls,
    ),
    maxNoProgressTurns: clampLimit(
      pick(
        'maxNoProgressTurns',
        'AGENT_LOOP_MAX_NO_PROGRESS_TURNS',
        defaults.maxNoProgressTurns,
      ),
      LIMIT_RANGES.maxNoProgressTurns,
    ),
  }
}

/**
 * Skill `runtimeHints` alkalmazása a már feloldott guardokra.
 * Csak emelhet (max) — a skill nem szűkítheti a chat/task/env/agent keretet.
 * Clamp továbbra is érvényes.
 */
export function mergeSkillRuntimeHints(
  limits: LoopGuardLimits,
  hints:
    | {
        maxWallClockMs?: number
        maxToolCalls?: number
      }
    | null
    | undefined,
): LoopGuardLimits {
  if (!hints) return limits
  const next = { ...limits }
  if (typeof hints.maxWallClockMs === 'number' && Number.isFinite(hints.maxWallClockMs)) {
    next.maxWallClockMs = clampLimit(
      Math.max(limits.maxWallClockMs, hints.maxWallClockMs),
      LIMIT_RANGES.maxWallClockMs,
    )
  }
  if (typeof hints.maxToolCalls === 'number' && Number.isFinite(hints.maxToolCalls)) {
    next.maxToolCalls = clampLimit(
      Math.max(limits.maxToolCalls, hints.maxToolCalls),
      LIMIT_RANGES.maxToolCalls,
    )
  }
  return next
}

/**
 * Hétköznapi nyelvű, önmagyarázó jelölés a beszélgetésbe (közérthető-UI elv):
 * mi ért véget, miért, és hogy a részeredmény megmaradt. A `max_turns_exhausted`
 * szándékosan hiányzik — annak a meglévő üzenete és viselkedése változatlan.
 */
export function describeLoopStop(reason: LoopStopReason, limits: LoopGuardLimits): string | null {
  switch (reason) {
    case 'wallclock_timeout':
      return `⏱️ **Leálltam, mert elértem az időkorlátot.** Erre a fordulóra ${Math.round(limits.maxWallClockMs / 1000)} másodperc jut, és ez letelt. Amit eddig összegyűjtöttem, megmaradt — ha folytassam, írd meg, és innen viszem tovább.`
    case 'tool_budget':
      return `🧰 **Leálltam, mert elfogyott az eszközhívási keret.** Egy fordulóban legfeljebb ${limits.maxToolCalls} eszközhívást (keresés, fájlművelet, külső rendszer) használhatok, és ezt elhasználtam. A részeredmény megmaradt; ha kisebb lépésekre bontod a kérést, tovább tudok haladni.`
    case 'no_progress':
      return `🔁 **Leálltam, mert nem haladtam előre.** Az utolsó ${limits.maxNoProgressTurns} körben nem született új eredmény — ugyanazokat az információkat kaptam vissza. A részeredményt megtartottam; pontosítsd a kérést, vagy mondd meg, melyik forrásból dolgozzak.`
    default:
      return null
  }
}
