/**
 * Budget enforcement engine (§3.3, §5 step 4 — Fázis 2-A)
 *
 * Applies model_budgets table budgets, most-specific scope first.
 * If hard_cap is true and limit is exceeded → deny (model.call.denied).
 * If soft_threshold is set and cost is near limit → warning in metadata.
 */

import type { ModelBudget } from '@prisma/client'
import type { ModelBudgetRepository, ModelCallRepository } from '@/repositories/interfaces'

export type BudgetCheckResult =
  | { allowed: true; softWarning?: string }
  | { allowed: false; reason: string; budget: ModelBudget }

export class BudgetEngine {
  constructor(
    private budgetRepo: ModelBudgetRepository,
    private modelCallRepo: ModelCallRepository,
  ) {}

  async check(ctx: {
    tenantId?: string
    agentId: string
    ticketType?: string
  }): Promise<BudgetCheckResult> {
    const budgets = await this.budgetRepo.findApplicable({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      ticketType: ctx.ticketType,
    })

    for (const budget of budgets) {
      const usage = await this.modelCallRepo.getUsageForAgent(ctx.agentId, budget.period)

      if (budget.callLimit !== null && budget.hardCap && usage.calls >= budget.callLimit) {
        return {
          allowed: false,
          reason: `Call limit exceeded: ${usage.calls}/${budget.callLimit} per ${budget.period} (scope=${budget.scope})`,
          budget,
        }
      }

      if (budget.tokenLimit !== null && budget.hardCap && usage.tokens >= budget.tokenLimit) {
        return {
          allowed: false,
          reason: `Token limit exceeded: ${usage.tokens}/${budget.tokenLimit} per ${budget.period} (scope=${budget.scope})`,
          budget,
        }
      }

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
