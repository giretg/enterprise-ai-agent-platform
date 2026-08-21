/**
 * Feloldási scope-invariáns (APG-08, spec §10.5 / R14).
 *
 * A vault-lookup nem globálisan címezhető. Feloldás csak akkor engedett, ha
 * mindhárom teljesül: azonos tenant, azonos conversation/trace scope, és a kérő
 * a beszélgetés (vagy ticket-scope esetén a ticket) jogosult résztvevője a
 * meglévő createdById-hozzáférés szerint. Nem új jogosultsági modell.
 */
import type { ConversationRepository, TicketRepository } from '@/repositories/interfaces'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type ResolveDenyReason = 'tenant' | 'scope' | 'participant'

export type PrivacyResolveRequester = {
  tenantId: string
  userId?: string | null
}

export type PrivacyResolveAccess = {
  authorize(input: {
    requester: PrivacyResolveRequester
    claimedTenantId: string
    scope: PrivacyScope
  }): Promise<{ allowed: true } | { allowed: false; reason: ResolveDenyReason }>
}

/** Unit-tesztek: a bijekció/HMAC a scope-kapu nélkül is vizsgálható. */
export const allowAllPrivacyResolveAccess: PrivacyResolveAccess = {
  async authorize() {
    return { allowed: true }
  },
}

export class ConversationPrivacyResolveAccess implements PrivacyResolveAccess {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly tickets: TicketRepository,
  ) {}

  async authorize(input: {
    requester: PrivacyResolveRequester
    claimedTenantId: string
    scope: PrivacyScope
  }): Promise<{ allowed: true } | { allowed: false; reason: ResolveDenyReason }> {
    if (input.claimedTenantId !== input.requester.tenantId) {
      return { allowed: false, reason: 'tenant' }
    }

    const conversation = await this.conversations.findById(input.scope.id)
    if (conversation) {
      return authorizeOwnedResource({
        resourceTenantId: conversation.tenantId,
        ownerId: conversation.createdById,
        requester: input.requester,
      })
    }

    const ticket = await this.tickets.findById(input.scope.id)
    if (ticket) {
      return authorizeOwnedResource({
        resourceTenantId: ticket.tenantId,
        ownerId: ticket.createdById,
        requester: input.requester,
      })
    }

    return { allowed: false, reason: 'scope' }
  }
}

function authorizeOwnedResource(input: {
  resourceTenantId: string | null
  ownerId: string
  requester: PrivacyResolveRequester
}): { allowed: true } | { allowed: false; reason: ResolveDenyReason } {
  if (input.resourceTenantId !== input.requester.tenantId) {
    return { allowed: false, reason: 'tenant' }
  }
  if (!input.requester.userId || input.requester.userId !== input.ownerId) {
    return { allowed: false, reason: 'participant' }
  }
  return { allowed: true }
}
