import { guardrailFromEnv } from '@/domain/gateway/model-gateway'

/** Payload `error.code` / audit reason — ticketenkénti modellhívás-plafon. */
export const TICKET_CALL_CAP_ERROR_CODE = 'TICKET_CALL_CAP'

/** `DispatchOutcome.reason` prefix a ticket call-cap ághoz. */
export const TICKET_CALL_CAP_REASON_PREFIX = 'ticket_call_cap:'

export function ticketCallCapReason(calls: number, maxCalls: number): string {
  return `${TICKET_CALL_CAP_REASON_PREFIX}${calls}/${maxCalls}`
}

export function isTicketCallCapReason(reason: string | undefined | null): boolean {
  return typeof reason === 'string' && reason.startsWith(TICKET_CALL_CAP_REASON_PREFIX)
}

/**
 * Felhasználói üzenet: a ticket call-cap élettartam-limit (nem napi),
 * holnapi várakozás nem segít.
 */
export function formatTicketCallCapUserMessage(input: {
  calls: number
  maxCalls: number
}): string {
  return (
    `Keret kimerült — ez a ticket nem indítható újra (${input.calls}/${input.maxCalls} modellhívás). ` +
    `Ez a plafon ticketenként érvényes, és NEM áll vissza holnap. ` +
    `Mit tehetsz: (1) nyiss új ticketet a folytatáshoz, vagy (2) szólj az adminnak, hogy emelje a GATEWAY_MAX_CALLS_PER_TICKET környezeti változót, majd próbáld újra.`
  )
}

export function readTicketCallCapMessageFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const error = (payload as Record<string, unknown>).error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  const record = error as Record<string, unknown>
  if (record.code !== TICKET_CALL_CAP_ERROR_CODE) return null
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  return null
}

export function isTicketCallCapErrorMessage(error: string | undefined | null): boolean {
  if (!error) return false
  return (
    /gateway guardrail/i.test(error) ||
    /reached \d+ model calls/i.test(error) ||
    /max_calls_per_ticket/i.test(error)
  )
}

export function currentTicketCallCapLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  return guardrailFromEnv(env).maxCallsPerTicket
}

/** Ha a ticket túllépte a plafont, user-facing üzenet; különben `null`. */
export function ticketCallCapExceededMessage(
  usage: { calls: number },
  env: Record<string, string | undefined> = process.env,
): string | null {
  const maxCalls = currentTicketCallCapLimit(env)
  if (usage.calls < maxCalls) return null
  return formatTicketCallCapUserMessage({ calls: usage.calls, maxCalls })
}
