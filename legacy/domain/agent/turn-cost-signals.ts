/**
 * issue #180 WP-4 — forrás-újraolvasási arány és forduló-szintű költségjelek.
 *
 * ÜZLETI PROBLÉMA: a mért, elszaladt futásban (2026-07-29) a forduló 40 körön át
 * gyakorlatilag csak ugyanazokat a forrásokat olvasta újra — 149 eszközhívásból
 * 132 visszaolvasás volt —, és ez 2,8M tokent égetett el. A patológia utólag is
 * csak kézzel, a beszélgetés-exportból volt kimutatható, tehát nem volt mire
 * riasztást tenni: ugyanez a hiba hat egymást követő futáson át megismétlődött,
 * mire kiderült.
 *
 * A modul EGYETLEN dolga: a kör mérlegéből eldönteni, hogy a kör körforgásnak
 * néz-e ki. Szándékosan tiszta függvény (nincs I/O, nincs óra, nincs globális
 * állapot), hogy a küszöbök determinisztikusan tesztelhetők legyenek.
 *
 * A jel TOOL-FÜGGETLEN: a `loop-stop-decision.ts` forrás-számvitele (fájl,
 * dokumentum, URL, oldal, archívum) adja a bemenetét, tehát a fájl-újraolvasásra
 * és a dokumentum-lapozásra ugyanúgy érvényes, mint az archívum-visszaolvasásra.
 */

/** Egy lezárt kör nyers mérlege. */
export type TurnCostSignalInput = {
  /** Ahány eszközhívást a modell ebben a körben kiadott (a kimaradtakat is). */
  toolCallsIssued: number
  /**
   * Ebből hány volt ISMÉTELT behozás ugyanabból a forrásból — vagyis a tartalom
   * jöhetett, de a munka nem haladt. A blokkolt (fékbe futott) újraolvasás is
   * ide számít: a modell szándéka ugyanaz volt.
   */
  sourceRereadCalls: number
  /** Az ismételt behozásokkal mozgatott karakterek száma (token-becslés alapja). */
  sourceRereadChars: number
  /** Hány kontextus-tömörítési lépés futott eddig a fordulóban. */
  compactionSteps: number
  /**
   * A kör mérlege üres volt, pedig a modell adott ki eszközhívást
   * (`agent.tool_loop.turn_balance_missing_tool_results`). Ez pontosan az a
   * hibaosztály, amitől a mért futás 40 körig pörgött.
   */
  missingToolResults: boolean
}

export type TurnCostAlertReason =
  | 'source_reread_ratio'
  | 'compaction_steps'
  | 'missing_tool_results'

export type TurnCostSignals = {
  /** Az újraolvasások aránya a kör összes kiadott eszközhívására (0..1). */
  rereadRatio: number
  /** ~4 karakter/token becslés az újraolvasásra elköltött tokenekre. */
  estimatedRereadTokens: number
  /** Kiváltott riasztási okok; üres lista = a kör rendben van. */
  reasons: TurnCostAlertReason[]
  /** Van-e riasztás (a `reasons` nem üres). */
  alert: boolean
}

export type TurnCostThresholds = {
  /** E fölött riaszt az újraolvasási arány (a mért esetben 0,89 volt). */
  rereadRatio: number
  /**
   * Ennél kevesebb eszközhívásból az arány nem jelent semmit: egy 2 hívásos
   * körben egyetlen jogos ismétlés is 50% fölé vinné. A mért patológia
   * tucatnyi hívásos körökben él, ezért a minta-küszöb nem veszít belőle.
   */
  minToolCallsForRatio: number
  /** E fölött riaszt a tömörítési lépések száma (tömörítés ↔ visszaolvasás körforgás). */
  compactionSteps: number
}

export const TURN_COST_THRESHOLDS: TurnCostThresholds = {
  rereadRatio: 0.5,
  minToolCallsForRatio: 6,
  compactionSteps: 10,
}

/**
 * Env-felülbírálás: `AGENT_TURN_REREAD_RATIO_ALERT`,
 * `AGENT_TURN_MIN_TOOL_CALLS_FOR_RATIO`, `AGENT_TURN_COMPACTION_STEPS_ALERT`.
 * Érvénytelen vagy a riasztást kikapcsoló érték → alapérték (a küszöböt lehet
 * hangolni, elnémítani nem).
 */
export function resolveTurnCostThresholds(
  env: NodeJS.ProcessEnv = process.env,
  fallback: TurnCostThresholds = TURN_COST_THRESHOLDS,
): TurnCostThresholds {
  const num = (raw: string | undefined, min: number, max: number, fb: number): number => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fb
  }
  return {
    rereadRatio: num(env.AGENT_TURN_REREAD_RATIO_ALERT, 0.1, 1, fallback.rereadRatio),
    minToolCallsForRatio: num(
      env.AGENT_TURN_MIN_TOOL_CALLS_FOR_RATIO,
      2,
      100,
      fallback.minToolCallsForRatio,
    ),
    compactionSteps: num(env.AGENT_TURN_COMPACTION_STEPS_ALERT, 1, 1000, fallback.compactionSteps),
  }
}

/**
 * A kör költségjeleinek kiértékelése. A riasztás VAGY-kapcsolat: bármelyik jel
 * elég, mert mindhárom ugyanazt a hibaosztályt (körforgás) jelzi más oldalról.
 */
export function evaluateTurnCostSignals(
  input: TurnCostSignalInput,
  thresholds: TurnCostThresholds = TURN_COST_THRESHOLDS,
): TurnCostSignals {
  const issued = Math.max(input.toolCallsIssued, 0)
  const rereads = Math.max(input.sourceRereadCalls, 0)
  const rereadRatio = issued > 0 ? Math.min(rereads / issued, 1) : 0

  const reasons: TurnCostAlertReason[] = []
  if (issued >= thresholds.minToolCallsForRatio && rereadRatio > thresholds.rereadRatio) {
    reasons.push('source_reread_ratio')
  }
  if (input.compactionSteps > thresholds.compactionSteps) {
    reasons.push('compaction_steps')
  }
  if (input.missingToolResults && issued > 0) {
    reasons.push('missing_tool_results')
  }

  return {
    rereadRatio,
    estimatedRereadTokens: Math.round(Math.max(input.sourceRereadChars, 0) / 4),
    reasons,
    alert: reasons.length > 0,
  }
}

/** Hétköznapi nyelvű indoklás a riasztási naplóhoz (üzemeltetői nézet). */
export function describeTurnCostAlert(reason: TurnCostAlertReason): string {
  switch (reason) {
    case 'source_reread_ratio':
      return 'a forduló eszközhívásainak többsége ugyanabból a forrásból olvasott újra — a futás egy helyben jár'
    case 'compaction_steps':
      return 'sok kontextus-tömörítés futott egy fordulón belül — tömörítés ↔ visszaolvasás körforgás gyanúja'
    case 'missing_tool_results':
      return 'a modell adott ki eszközhívást, de a kör mérlegébe egyetlen eredmény sem került'
  }
}
