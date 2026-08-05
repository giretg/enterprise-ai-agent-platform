/**
 * Keretszabály-kihasználtság a felülethez — tiszta függvények, DB nélkül.
 *
 * A „mennyit fogyasztottunk ebből a keretből" a felületen ugyanazt a szabályt kell
 * kövesse, mint a kapu döntése (`budget-engine.ts`), különben a felhasználó egy
 * félig telt sávot lát, miközben a feladatai állnak.
 */

export type BudgetLimitSpec = {
  callLimit: number | null
  tokenLimit: number | null
  hardCap: boolean
}

export type AgentUsage = { agentId: string; calls: number; tokens: number }

/**
 * A „minden munkatársra külön-külön" keretnél nincs egyetlen fogyasztás: a korlátot
 * az éri el először, aki a legtöbbet fogyasztotta — ő a szűk keresztmetszet.
 * A rangsor ahhoz a dimenzióhoz igazodik, amire tényleg van korlát; ha mindkettőre
 * van, a token a szigorúbb (abból fogy gyorsabban a keret).
 */
export function pickPeakAgent(
  byAgent: AgentUsage[],
  limits: Pick<BudgetLimitSpec, 'callLimit' | 'tokenLimit'>,
): AgentUsage | null {
  const byTokens = limits.tokenLimit !== null || limits.callLimit === null
  return byAgent.reduce<AgentUsage | null>((best, current) => {
    if (!best) return current
    return byTokens
      ? current.tokens > best.tokens
        ? current
        : best
      : current.calls > best.calls
        ? current
        : best
  }, null)
}

/**
 * Blokkolna-e most ez a keret. Csak a kemény korlát (`hardCap`) állít meg munkát;
 * a puha keret figyelmeztet, de átengedi a hívást.
 */
export function isRuleExhausted(
  spec: BudgetLimitSpec,
  usage: { calls: number; tokens: number },
): boolean {
  if (!spec.hardCap) return false
  if (spec.callLimit !== null && usage.calls >= spec.callLimit) return true
  if (spec.tokenLimit !== null && usage.tokens >= spec.tokenLimit) return true
  return false
}
