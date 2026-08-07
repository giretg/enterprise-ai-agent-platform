/**
 * Budget enforcement engine (§3.3, §5 step 4 — Fázis 2-A)
 *
 * Applies model_budgets table budgets, most-specific scope first.
 * If hard_cap is true and limit is exceeded → deny (model.call.denied).
 * If soft_threshold is set and cost is near limit → warning in metadata.
 *
 * A fogyasztást MINDIG a budget saját hatókörén méri: a `tenant` keretet a tenant saját
 * agentjeinek + a platform-agentek work-owner forgalmán, az `agent` keretet az adott
 * agentén, a `ticket_type` keretet az adott típusú ticketekre elszámolt hívásokon
 * (ugyanazzal a work-owner szabállyal). (Korábban mindhárom az agent fogyasztását nézte,
 * így egy tenant-szintű keret valójában per-agent keretként viselkedett.)
 */

import type { ModelBudget } from '@prisma/client'
import type { ModelBudgetRepository, ModelCallRepository } from '@/repositories/interfaces'
import type { Ticket } from '@prisma/client'

export type BudgetUsage = { calls: number; tokens: number }

export type BudgetCheckResult =
  | { allowed: true; softWarning?: string }
  | { allowed: false; reason: string; budget: ModelBudget; usage: BudgetUsage }

/** Egy alkalmazható keret + a hozzá tartozó, saját hatókörén mért fogyasztás (admin nézet). */
export type BudgetStatus = {
  budget: ModelBudget
  usage: BudgetUsage
  /** `true`, ha a keret jelenleg blokkolna egy új hívást. */
  exhausted: boolean
}

export type BudgetContext = {
  /** Konkrét id → tenant + platform keretek; `null` → csak platform (megosztott agent). */
  tenantId?: string | null
  agentId: string
  ticketType?: string
}

export class BudgetEngine {
  constructor(
    private budgetRepo: ModelBudgetRepository,
    private modelCallRepo: ModelCallRepository,
  ) {}

  /** Minden alkalmazható keret a saját fogyasztásával — a kapu és az admin UI közös forrása. */
  async statuses(ctx: BudgetContext): Promise<BudgetStatus[]> {
    const budgets = applyBudgetPrecedence(
      await this.budgetRepo.findApplicable({
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        ticketType: ctx.ticketType,
      }),
    )

    return Promise.all(
      budgets.map(async (budget) => {
        const usage = await usageForBudget(this.modelCallRepo, budget, ctx.agentId)
        return { budget, usage, exhausted: exceedsHardCap(budget, usage) !== null }
      }),
    )
  }

  async check(ctx: BudgetContext): Promise<BudgetCheckResult> {
    const statuses = await this.statuses(ctx)

    for (const { budget, usage } of statuses) {
      const breach = exceedsHardCap(budget, usage)
      if (breach) return { allowed: false, reason: breach, budget, usage }

      // Soft threshold: warn but don't block
      if (budget.softThreshold !== null && budget.callLimit !== null) {
        const softLimit = Number(budget.softThreshold)
        if (usage.calls >= softLimit && usage.calls < budget.callLimit) {
          return {
            allowed: true,
            softWarning: `Approaching call limit: ${usage.calls}/${budget.callLimit}`,
          }
        }
      }
    }

    return { allowed: true }
  }
}

/**
 * Nevesített keret > alapértelmezés (azonos bucket + hatókör + periódus).
 *
 * ÜZLETI PROBLÉMA: a `scope=agent` + `scopeRef=null` sor a bucket MINDEN agentjére
 * érvényes alapértelmezés. Mivel a kapu az összes alkalmazható keretet ÉS-ben
 * értékeli, egy konkrét agentre adott — akár magasabb — keret eddig nem ért
 * semmit: az alapértelmezés akkor is blokkolt. Így egyetlen, sok eszközhívást
 * igénylő agent kedvéért az EGÉSZ szervezet keretét kellett megemelni, ami
 * pontosan a költségkontrollt számolta fel.
 *
 * A precedencia ezt oldja fel: ha egy hatókör+periódus párosra van nevesített
 * (`scopeRef` kitöltött) keret, akkor az ugyanahhoz a bucket-hez tartozó
 * alapértelmezés (`scopeRef=null`) kimarad az értékelésből. A `tenantId` is
 * kulcs, hogy egy szervezeti kivétel ne kapcsolja ki a platform-szintű korlátot.
 */
export function applyBudgetPrecedence(budgets: ModelBudget[]): ModelBudget[] {
  const key = (budget: ModelBudget) =>
    `${budget.tenantId ?? 'platform'}:${budget.scope}:${budget.period}`
  const overridden = new Set(budgets.filter((b) => b.scopeRef !== null).map(key))
  return budgets.filter((b) => b.scopeRef !== null || !overridden.has(key(b)))
}

/**
 * A keret hatóköre dönti el, mit összegzünk — nem a hívás kontextusa.
 *
 * A `scope=agent` + `scopeRef=null` sor a bucket minden agentjére külön-külön érvényes
 * alapértelmezés, ezért ilyenkor a vizsgált agent (`forAgentId`) fogyasztását mérjük.
 * Konkrét `scopeRef` esetén az abban megnevezett agentét — a kettő a kapu felől ugyanaz,
 * de az admin nézet a keret sorából számol, ahol nincs „vizsgált agent".
 */
export function usageForBudget(
  repo: ModelCallRepository,
  budget: ModelBudget,
  forAgentId?: string,
): Promise<BudgetUsage> {
  if (budget.scope === 'tenant') {
    return repo.getUsageForTenant(budget.tenantId, budget.period)
  }
  if (budget.scope === 'ticket_type' && budget.scopeRef) {
    return repo.getUsageForTicketType(
      budget.tenantId,
      budget.scopeRef as Ticket['type'],
      budget.period,
    )
  }
  const agentId = budget.scopeRef ?? forAgentId
  if (!agentId) return Promise.resolve({ calls: 0, tokens: 0 })
  return repo.getUsageForAgent(agentId, budget.period)
}

/** `null`, ha a keret átengedi a hívást; egyébként az elutasítás indoklása. */
export function exceedsHardCap(budget: ModelBudget, usage: BudgetUsage): string | null {
  if (!budget.hardCap) return null
  if (budget.callLimit !== null && usage.calls >= budget.callLimit) {
    return `Call limit exceeded: ${usage.calls}/${budget.callLimit} per ${budget.period} (scope=${budget.scope})`
  }
  if (budget.tokenLimit !== null && usage.tokens >= budget.tokenLimit) {
    return `Token limit exceeded: ${usage.tokens}/${budget.tokenLimit} per ${budget.period} (scope=${budget.scope})`
  }
  return null
}
