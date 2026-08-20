/**
 * Tool-broker hívás → vault-scope (APG-04/APG-05, spec §5).
 *
 * Conversation-scoped álnév, ha van beszélgetés; különben a ticket id-ja
 * ugyanazt a `conversation` scope-tölti (a tool-output allokáció és a
 * tool-arg feloldás ugyanazt a kulcsot használja).
 */
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export function privacyScopeForCall(
  conversationId: string | null | undefined,
  ticketId: string | null | undefined,
): PrivacyScope | null {
  if (conversationId) return { type: 'conversation', id: conversationId }
  if (ticketId) return { type: 'conversation', id: ticketId }
  return null
}

/** Debug-trace projection (APG-21): trace-scoped álnév a debugging AI felé. */
export function privacyScopeForTrace(traceId: string): PrivacyScope {
  return { type: 'trace', id: traceId }
}
