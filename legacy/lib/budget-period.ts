import type { ModelBudgetPeriod } from '@prisma/client'

/**
 * A budget-periódus gördülő ablakának kezdete. Nem naptári nap/hét/hónap: a `day`
 * az elmúlt 24 órát jelenti, nem az éjfél óta eltelt időt. A `BudgetEngine`, a
 * dispatcher-kapu és a fogyasztást megjelenítő admin felület mind ezt hívja, így a
 * kiírt „elhasznált / limit" pontosan azt az ablakot mutatja, amire a kapu is néz.
 */
export function budgetPeriodSince(period: ModelBudgetPeriod, now: Date = new Date()): Date {
  const since = new Date(now)
  if (period === 'day') since.setDate(now.getDate() - 1)
  else if (period === 'week') since.setDate(now.getDate() - 7)
  else since.setMonth(now.getMonth() - 1)
  return since
}
