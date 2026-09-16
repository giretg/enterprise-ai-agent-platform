/**
 * Ticketenkénti modellhívás-plafon — platform_settings + env fallback.
 * A UI: Rendszer → Model-keretek (`section=napi-keret`).
 */

export const GATEWAY_TICKET_CALL_CAP_KEY = 'gateway.ticket_call_cap'

export const DEFAULT_MAX_CALLS_PER_TICKET = 30

export const TICKET_CALL_CAP_MIN = 1
export const TICKET_CALL_CAP_MAX = 1000

/** Felhasználói navigációs hivatkozás a hibaüzenetekben. */
export const TICKET_CALL_CAP_SETTINGS_MENU = 'Rendszer → Model-keretek'
export const TICKET_CALL_CAP_SETTINGS_HREF = '/control-plane/system?section=napi-keret'

export type GatewayTicketCallCapStored = {
  maxCallsPerTicket: number
  updatedById: string | null
  updatedAt: string | null
}

export function clampTicketCallCapLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CALLS_PER_TICKET
  return Math.min(TICKET_CALL_CAP_MAX, Math.max(TICKET_CALL_CAP_MIN, Math.round(value)))
}

export function parseGatewayTicketCallCapStored(raw: unknown): GatewayTicketCallCapStored | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const maxCallsPerTicket = record.maxCallsPerTicket
  if (typeof maxCallsPerTicket !== 'number' || !Number.isFinite(maxCallsPerTicket)) return null
  const clamped = clampTicketCallCapLimit(maxCallsPerTicket)
  return {
    maxCallsPerTicket: clamped,
    updatedById: typeof record.updatedById === 'string' ? record.updatedById : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  }
}

/** Felbontás: platform_settings → GATEWAY_MAX_CALLS_PER_TICKET env → alapértelmezés. */
export function resolveMaxCallsPerTicket(input: {
  platformMax?: number | null
  env?: Record<string, string | undefined>
} = {}): number {
  if (
    input.platformMax != null &&
    Number.isFinite(input.platformMax) &&
    input.platformMax > 0
  ) {
    return clampTicketCallCapLimit(input.platformMax)
  }
  const env = input.env ?? process.env
  const raw = env.GATEWAY_MAX_CALLS_PER_TICKET?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(parsed) && parsed > 0
    ? clampTicketCallCapLimit(parsed)
    : DEFAULT_MAX_CALLS_PER_TICKET
}
