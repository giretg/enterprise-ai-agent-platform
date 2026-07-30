/**
 * Tool-eredmény kiszervezés a futó prompt-előzményből (kontextus-tömörítés).
 *
 * ÜZLETI PROBLÉMA: a tool-loop egy fordulón belül minden modellhívásnál a TELJES
 * addigi előzményt újraküldi. Minden korábbi tool-eredmény benne marad, így a
 * prompt körönként monoton nő, a forduló token-költsége pedig a tool-hívások
 * számának négyzetével arányos. Egy 24 tool-hívásos feladatnál ez mért 21k → 154k
 * token promptnövekedést és ~2,1M token összköltséget jelentett — egyetlen
 * kérdésre. Emiatt futhat ki a napi keret, és emiatt áll meg egy hosszú feladat
 * félúton, a felhasználó számára minden magyarázat nélkül.
 *
 * MEGOLDÁS: a régi tool-eredmények kikerülnek az aktív kontextusból, a helyükön
 * egy rövid tájékoztató marad, ami megmondja, hol a teljes tartalom és hogyan
 * olvasható vissza (`tool_result_read`). A tartalom NEM vész el — a hívó a
 * visszaadott bejegyzéseket beteszi a futás archívumába.
 *
 * MIÉRT CSERE ÉS NEM TÖRLÉS: az OpenAI-kompatibilis API megköveteli, hogy minden
 * `tool` üzenethez tartozzon a megelőző asszisztens-üzenet `tool_calls` bejegyzése.
 * Egy tool-üzenet eltávolítása érvénytelen kérést adna, ezért csak a TARTALMÁT
 * cseréljük — az üzenetszerkezet érintetlen marad.
 *
 * A modul I/O-mentes és determinisztikus: a hívó dönt az archiválásról.
 *
 * MIÉRT VAN A VISSZAOLVASÁSNAK KÜLÖN ÁGA: mérve (2026-07-29, Novaj-egyeztetés)
 * a kiszervezés és a visszaolvasás körforgásba került. A modell körönként
 * visszaolvasta ugyanazt a négy archívumot, a tömörítés két körrel később
 * ugyanazokat szervezte ki, és a futás 40 körön át egy helyben járt — 5,4 millió
 * token, kész eredmény nélkül. Két oka volt, és mindkettő itt látszik:
 *  1. a visszaolvasás eredménye ÚJ archívumot kapott (archívum archívuma),
 *  2. a helyére kerülő stub megint visszaolvasásra biztatott.
 * Ezért a visszaolvasott szelet kiszervezése a FORRÁS útvonalára hivatkozik (így
 * a hívó nem ír új archívumot), a stubja pedig kimondottan TILTJA az újraolvasást
 * és a munkaterületre irányít. A hívó oldali karakter-plafonok ezt egészítik ki.
 */
import type { GatewayMessage } from '@/domain/gateway/model-gateway'

/** A kiszervezett tartalom helyén álló üzenet felismerhető előtagja. */
export const EVICTED_TOOL_RESULT_MARKER = '[Kiszervezett tool-eredmény]'

/**
 * A visszaolvasó eszköz neve. Az igazság ITT él, a tool-loop innen veszi — a
 * compactornak muszáj felismernie a saját stubjai miatt keletkezett eredményeket.
 */
export const TOOL_RESULT_READ_TOOL_NAME = 'tool_result_read'

export type ContextCompactionLimits = {
  /** Ennyi legutóbbi tool-eredmény MINDIG teljes terjedelmében marad. */
  keepRecentToolResults: number
  /** A tool-eredmények együttes karakter-kerete az előzményben. */
  maxToolResultChars: number
  /** Ennél rövidebb eredményt nem érdemes kiszervezni (a helyére kerülő szöveg is helyet foglal). */
  minEvictableChars: number
}

/**
 * Alapértékek. A keret (60 000 karakter ≈ 15k token) úgy van megválasztva, hogy
 * a tipikus 3–5 lépéses eszközhasználat MEG SE ÉRINTSE — csak a tényleg hosszú,
 * sok tool-hívásos futásoknál lép működésbe.
 */
export const DEFAULT_CONTEXT_COMPACTION_LIMITS: ContextCompactionLimits = {
  keepRecentToolResults: 4,
  maxToolResultChars: 60_000,
  minEvictableChars: 1_000,
}

/**
 * Env-felülbírálás:
 * `AGENT_CONTEXT_KEEP_RECENT_TOOL_RESULTS`, `AGENT_CONTEXT_MAX_TOOL_RESULT_CHARS`,
 * `AGENT_CONTEXT_MIN_EVICTABLE_CHARS`. Érvénytelen érték → alapérték.
 */
export function resolveContextCompactionLimits(
  env: NodeJS.ProcessEnv = process.env,
  fallback: ContextCompactionLimits = DEFAULT_CONTEXT_COMPACTION_LIMITS,
): ContextCompactionLimits {
  const intOr = (raw: string | undefined, min: number, fb: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10)
    return Number.isFinite(parsed) && parsed >= min ? parsed : fb
  }
  return {
    keepRecentToolResults: intOr(
      env.AGENT_CONTEXT_KEEP_RECENT_TOOL_RESULTS,
      1,
      fallback.keepRecentToolResults,
    ),
    maxToolResultChars: intOr(
      env.AGENT_CONTEXT_MAX_TOOL_RESULT_CHARS,
      1_000,
      fallback.maxToolResultChars,
    ),
    minEvictableChars: intOr(
      env.AGENT_CONTEXT_MIN_EVICTABLE_CHARS,
      100,
      fallback.minEvictableChars,
    ),
  }
}

/**
 * FONTOS: az „egy forrásból ennyit hozhatsz be" keret NEM itt él, hanem a
 * `loop-stop-decision` modulban (`sourceIngestBudget`) — mert az nem a
 * tömörítés sajátja, hanem minden olvasó eszközre érvényes (fájl-újraolvasás,
 * dokumentum-lapozás, archívum-visszaolvasás). Itt csak a tömörítés kerete van.
 */

/**
 * Egy KÖRBEN összesen visszaolvasható karakterek plafonja.
 *
 * INVARIÁNS, amiért ez a fék létezik: a tömörítés a `keepRecentToolResults`
 * legutóbbi eredményt mindig védi, ezért ha egy kör annyit tud visszaszívni, hogy
 * `keepRecentToolResults × egy visszaolvasás ≫ maxToolResultChars`, akkor a védett
 * ablak maga nagyobb a keretnél — a tömörítés SOSEM ér a limit alá, és körönként
 * mindent kiszervez, amit a modell körönként visszaolvas. A mért eset: 4 × 40 000
 * = 160 000 karakter védett ablak 60 000-es keretnél. A per-kör plafon a keretre
 * szorítja a visszaolvasást, így a védett ablak sem lépheti túl.
 */
export function readBackPerTurnBudget(limits: ContextCompactionLimits): number {
  return limits.maxToolResultChars
}

/** Egy kiszervezett tool-eredmény — a hívó ezt teszi be a futás archívumába. */
export type EvictedToolResult = {
  /** Az archívum-útvonal, amit a stub és a `tool_result_read` is használ. */
  path: string
  toolName: string
  toolCallId: string
  /** A kiszervezett, TELJES tartalom (a modell felé már nem megy ki). */
  content: string
}

export type ContextCompactionResult = {
  evicted: EvictedToolResult[]
  /** Hány karakterrel lett kisebb az előzmény. */
  freedChars: number
  /** A tool-eredmények együttes mérete a tömörítés után. */
  toolResultChars: number
}

export type CompactToolResultHistoryOptions = {
  limits: ContextCompactionLimits
  /**
   * Archívum-útvonal a kiszervezett eredménynek (a hívó névkonvenciója szerint).
   * A `content` is át van adva, hogy a hívó felismerhesse a MÁR archivált (nagy)
   * eredmény előnézetét, és a meglévő útvonalat adhassa vissza új helyett.
   */
  pathFor: (input: {
    toolName: string
    toolCallId: string
    index: number
    content: string
  }) => string
  /**
   * Van-e a futásban `tool_result_read` eszköz. Ha nincs, a stub nem ígérhet
   * visszaolvasást — ilyenkor az eszköz újrafuttatását javasolja.
   */
  readableBack: boolean
  /** A `tool_result_read` egy hívásban visszaadható maximuma — a stub ezt írja ki. */
  readMaxLimit: number
}

/**
 * A tool-eredmények kiszervezése az előzményből, HELYBEN módosítva a tömböt (a
 * tool-loop ugyanezt a tömböt tölti tovább, így a másolat félrevezető lenne).
 *
 * Sosem szervezi ki:
 *  - a legutóbbi `keepRecentToolResults` eredményt (ezekre épül a modell következő lépése),
 *  - az utolsó tool-hívó asszisztens-üzenet UTÁNI eredményeket (ezeket a modell
 *    még NEM látta — a jelen kör kötegét kiszervezni azt jelentené, hogy a munka
 *    eredménye sosem jut el hozzá),
 *  - a rövid (`minEvictableChars` alatti) és a már kiszervezett eredményeket.
 */
export function compactToolResultHistory(
  messages: GatewayMessage[],
  options: CompactToolResultHistoryOptions,
): ContextCompactionResult {
  const { limits } = options
  const empty: ContextCompactionResult = { evicted: [], freedChars: 0, toolResultChars: 0 }

  // A jelen kör még ki nem értékelt kötegének határa: az utolsó tool-hívó
  // asszisztens-üzenet. Az az utáni tool-eredményeket a modell még nem látta.
  let lastToolCallingAssistant = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      lastToolCallingAssistant = i
      break
    }
  }

  const toolIndexes: number[] = []
  let toolResultChars = 0
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role !== 'tool') continue
    toolIndexes.push(i)
    toolResultChars += message.content.length
  }
  if (toolIndexes.length === 0) return empty
  if (toolResultChars <= limits.maxToolResultChars) {
    return { ...empty, toolResultChars }
  }

  const protectedFromIndex = toolIndexes.length - limits.keepRecentToolResults
  const evicted: EvictedToolResult[] = []
  let freedChars = 0

  for (const [order, messageIndex] of toolIndexes.entries()) {
    if (toolResultChars <= limits.maxToolResultChars) break
    if (order >= protectedFromIndex) break
    if (messageIndex > lastToolCallingAssistant) break

    const message = messages[messageIndex]
    if (message.role !== 'tool') continue
    if (message.content.length < limits.minEvictableChars) continue
    if (message.content.startsWith(EVICTED_TOOL_RESULT_MARKER)) continue

    // Visszaolvasott szelet: a tartalom NEM új — a forrás archívumban már megvan.
    // Ezért a forrás útvonalára hivatkozunk (a hívó ott nem ír új archívumot), és
    // a stub tiltja az újraolvasást. Ha a forrás nem olvasható ki (nem várt alak),
    // fail-soft: a normál úton megy tovább.
    const readBackSource =
      message.toolName === TOOL_RESULT_READ_TOOL_NAME
        ? extractReadBackSourcePath(message.content)
        : null

    const path =
      readBackSource ??
      options.pathFor({
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        index: order,
        content: message.content,
      })
    const stub = readBackSource
      ? buildReadBackEvictionStub({ sourcePath: readBackSource, chars: message.content.length })
      : buildEvictedToolResultStub({
          toolName: message.toolName,
          path,
          chars: message.content.length,
          readableBack: options.readableBack,
          readMaxLimit: options.readMaxLimit,
        })

    evicted.push({
      path,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      content: message.content,
    })
    freedChars += message.content.length - stub.length
    toolResultChars -= message.content.length - stub.length
    messages[messageIndex] = { ...message, content: stub }
  }

  return { evicted, freedChars, toolResultChars }
}

/**
 * A kiszervezett eredmény helyén álló szöveg. Fontos, hogy a modell NE úgy
 * értelmezze, hogy az eszköz nem futott le vagy hibázott — ezért mondja ki, hogy
 * az eredmény megvan, és pontosan megadja a visszaolvasás módját.
 */
export function buildEvictedToolResultStub(input: {
  toolName: string
  path: string
  chars: number
  readableBack: boolean
  readMaxLimit: number
}): string {
  const lines = [
    `${EVICTED_TOOL_RESULT_MARKER} A(z) ${input.toolName} eredménye SIKERESEN lefutott, de a hosszú futás miatt kikerült az aktív kontextusból.`,
    `Teljes tartalom elmentve: ${input.path} (${input.chars} karakter).`,
  ]
  if (input.readableBack) {
    lines.push(
      `Ha szükséged van rá, olvasd vissza a tool_result_read eszközzel: path="${input.path}", offset=0, limit=${Math.min(input.chars, input.readMaxLimit)} — NE futtasd újra az eredeti eszközt emiatt.`,
    )
  } else {
    lines.push(
      'Visszaolvasás ebben a futásban nem elérhető — ha az adatra szükséged van, futtasd újra az eszközt.',
    )
  }
  return lines.join('\n')
}

/**
 * A visszaolvasás eredményének forrás-útvonala. A `tool_result_read` JSON-t ad
 * vissza `path` mezővel; szándékosan regexszel olvassuk (nem `JSON.parse`), mert
 * a tartalom lehet csonkolt vagy hibaszöveg, és egy dobás itt a teljes tömörítést
 * buktatná.
 */
export function extractReadBackSourcePath(content: string): string | null {
  const match = content.match(/"path"\s*:\s*"((?:[^"\\]|\\.)+)"/)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

/**
 * A már visszaolvasott szelet helyén álló szöveg. Két dolgot kell elérnie: a
 * modell NE gondolja, hogy elveszett az adat, és NE olvassa vissza újra — mert a
 * körforgás pontosan ebből lett. Ezért a kiút konkrét: írd ki, amire szükség van.
 */
export function buildReadBackEvictionStub(input: {
  sourcePath: string
  chars: number
}): string {
  return [
    `${EVICTED_TOOL_RESULT_MARKER} Ezt a szeletet (${input.chars} karakter, forrás: ${input.sourcePath}) MÁR visszaolvastad ebben a futásban, ezért kikerült az aktív kontextusból.`,
    'NE olvasd vissza újra ugyanezt — a visszaolvasás nem hoz új információt, csak a forduló keretét fogyasztja.',
    'Ha az adat kell a végeredményhez, a szükséges kivonatot írd ki a munkaterületre (file_write, xlsx_append_rows), és onnan dolgozz tovább — a részeredmény így a következő fordulóban is megvan.',
  ].join('\n')
}

/** Felhasználónak/naplónak szánt, rövid összefoglaló egy tömörítési lépésről. */
export function describeContextCompaction(result: ContextCompactionResult): string {
  const thousandChars = Math.round(result.freedChars / 1000)
  return `${result.evicted.length} korábbi eszköz-eredmény kiszervezve (~${thousandChars} ezer karakter felszabadítva)`
}
