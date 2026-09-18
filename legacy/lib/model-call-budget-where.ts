/**
 * Model-call fogyasztás where-feltételei a budget-kapuhoz.
 *
 * A kapu a work-owner `tenantId`-t kapja (ticket/conversation), ezért a
 * `scope=tenant` / `scope=ticket_type` mérésnek a megosztott (platform,
 * `agent.tenantId = null`) agentek adott szervezeten végzett munkáját is
 * tartalmaznia kell — különben a hard cap soha nem ugrik be a fő költségsávon.
 */

import type { Prisma, TicketType } from '@prisma/client'
import { budgetPeriodSince } from '@/lib/budget-period'
import type { ModelBudgetPeriod } from '@/repositories/interfaces'

/** Tenant-szintű keret: saját agentek + platform-agent work-owner hívások. */
export function modelCallWhereForTenantUsage(
  tenantId: string | null,
  period: ModelBudgetPeriod,
  now: Date = new Date(),
): Prisma.ModelCallWhereInput {
  const since = { createdAt: { gte: budgetPeriodSince(period, now) } }
  if (tenantId === null) {
    // Platform-bucket: a megosztott agentek összes hívása (külön kereten osztoznak).
    return { ...since, agent: { tenantId: null } }
  }
  return {
    ...since,
    OR: [
      { agent: { tenantId } },
      {
        AND: [
          { agent: { tenantId: null } },
          {
            OR: [{ ticket: { tenantId } }, { conversation: { tenantId } }],
          },
        ],
      },
    ],
  }
}

/** Ticket-típus keret: ugyanaz a work-owner szabály, szűkítve a típusra. */
export function modelCallWhereForTicketTypeUsage(
  tenantId: string | null,
  ticketType: TicketType,
  period: ModelBudgetPeriod,
  now: Date = new Date(),
): Prisma.ModelCallWhereInput {
  const since = { createdAt: { gte: budgetPeriodSince(period, now) } }
  if (tenantId === null) {
    return {
      ...since,
      agent: { tenantId: null },
      ticket: { type: ticketType },
    }
  }
  return {
    ...since,
    OR: [
      { agent: { tenantId }, ticket: { type: ticketType } },
      {
        agent: { tenantId: null },
        ticket: { type: ticketType, tenantId },
      },
    ],
  }
}
