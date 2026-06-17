import type { TicketSource } from '@prisma/client'

export const PLATFORM_TICKET_SOURCE_ENV = 'PLATFORM_TICKET_SOURCE'

/** Teszt futás közben (acceptance, harness) automatikusan test forrás. */
export function resolveTicketSource(explicit?: TicketSource): TicketSource {
  if (explicit) return explicit
  if (process.env[PLATFORM_TICKET_SOURCE_ENV] === 'test') return 'test'
  return 'user'
}

/** Régi teszt ticketek cím mintái — egyszeri cleanup-hoz, source mező bevezetése előtt. */
export const LEGACY_TEST_TICKET_TITLE_PATTERNS: RegExp[] = [
  /^Acceptance:/,
  /^Wiki jóváhagyás:/,
  /^Delegálás:/,
  /^Playbook gate probe$/,
  /harness smoke$/i,
  /^Tanítás: (Wiki Agent|HAL|Könyvelő Agent)$/,
]

export function isLegacyTestTicketTitle(title: string): boolean {
  return LEGACY_TEST_TICKET_TITLE_PATTERNS.some((re) => re.test(title))
}

export function isBoardVisibleSource(source: TicketSource): boolean {
  return source !== 'test'
}
