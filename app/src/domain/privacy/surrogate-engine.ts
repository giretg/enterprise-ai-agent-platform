/**
 * Surrogate Engine: allokálás és feloldás (APG-02, spec §5; APG-08 §10.5).
 *
 * `(tenantId, scope, entityRef) → surrogate` bijektív a scope-on belül.
 * A sorszámozás entitástípusonként 1-től nő. A feloldás kizárólag vault-találaton
 * múlik — a kitalált álnév `privacy.surrogate.unknown` auditot kap, és nem oldódik fel.
 *
 * A vault-lookup nem globálisan címezhető: feloldás csak azonos tenant + azonos
 * scope + jogosult résztvevő mellett. Bukás → `privacy.resolve.denied`, nem néma üres.
 */
import {
  allowAllPrivacyResolveAccess,
  type PrivacyResolveAccess,
  type PrivacyResolveRequester,
  type ResolveDenyReason,
} from '@/domain/privacy/resolve-access'
import { formatSurrogate, parseSurrogate } from '@/domain/privacy/surrogate-format'
import {
  SurrogateTakenError,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateVault,
} from '@/domain/privacy/surrogate-vault'

export type PrivacyAuditSink = {
  recordUnknownSurrogate(event: {
    action: 'privacy.surrogate.unknown'
    tenantId: string
    scope: PrivacyScope
    surrogate: string
    reason: 'unknown' | 'hmac_invalid'
  }): Promise<void>
  recordResolveDenied(event: {
    action: 'privacy.resolve.denied'
    tenantId: string
    scope: PrivacyScope
    surrogate: string
    reason: ResolveDenyReason
    requesterUserId?: string | null
  }): Promise<void>
}

export type AllocateRefInput = {
  tenantId: string
  scope: PrivacyScope
  /** Megjelenítési érték a trusted UI-hoz — a vault ref-rekord NEM tárolja (spec §6). */
  displayValue?: string
} & RefEntityRef

export type ResolveRefInput = {
  tenantId: string
  scope: PrivacyScope
  surrogate: string
  requester: PrivacyResolveRequester
}

export type ResolveRefResult =
  | { ok: true; record: RefVaultRecord }
  | { ok: false; reason: 'unknown' | 'hmac_invalid' }
  | { ok: false; reason: 'denied'; denyReason: ResolveDenyReason }

const MAX_ALLOC_ATTEMPTS = 16

export class SurrogateEngine {
  private readonly displayValues = new Map<string, string>()

  constructor(
    private readonly vault: SurrogateVault,
    private readonly audit: PrivacyAuditSink,
    private readonly access: PrivacyResolveAccess = allowAllPrivacyResolveAccess,
  ) {}

  rememberDisplayValue(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
    displayValue: string,
  ): void {
    if (!displayValue) return
    this.displayValues.set(displayKey(tenantId, scope, surrogate), displayValue)
  }

  peekDisplayValue(tenantId: string, scope: PrivacyScope, surrogate: string): string | undefined {
    return this.displayValues.get(displayKey(tenantId, scope, surrogate))
  }

  /** Vault-lookup unknown-audit nélkül — megjelenítési feloldás, ismételt history-olvasáskor. */
  async peekRef(input: ResolveRefInput): Promise<ResolveRefResult> {
    return this.lookupRef(input, { auditUnknown: false })
  }

  async allocateRef(input: AllocateRefInput): Promise<string> {
    const existing = await this.vault.findByEntity(input.tenantId, input.scope, {
      entityType: input.entityType,
      connectorId: input.connectorId,
      sourceId: input.sourceId,
    })
    if (existing.status === 'hit') {
      if (input.displayValue) {
        this.rememberDisplayValue(input.tenantId, input.scope, existing.record.surrogate, input.displayValue)
      }
      return existing.record.surrogate
    }
    if (existing.status === 'tampered') {
      throw new Error('a meglévő vault-sor HMAC-je érvénytelen, új álnév nem allokálható')
    }

    let nextOrdinal = (await this.vault.maxOrdinal(input.tenantId, input.scope, input.entityType)) + 1
    for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt += 1) {
      const surrogate = formatSurrogate(input.entityType, nextOrdinal)
      try {
        const record = await this.vault.insertRef({
          tenantId: input.tenantId,
          scope: input.scope,
          entityType: input.entityType,
          connectorId: input.connectorId,
          sourceId: input.sourceId,
          surrogate,
        })
        this.rememberAllocatedDisplay(input, record.surrogate)
        return record.surrogate
      } catch (error) {
        if (error instanceof SurrogateTakenError) {
          nextOrdinal += 1
          continue
        }
        const raced = await this.vault.findByEntity(input.tenantId, input.scope, {
          entityType: input.entityType,
          connectorId: input.connectorId,
          sourceId: input.sourceId,
        })
        if (raced.status === 'hit') {
          this.rememberAllocatedDisplay(input, raced.record.surrogate)
          return raced.record.surrogate
        }
        throw error
      }
    }
    throw new Error('álnév-allokáció: a sorszámfoglalás túl sokszor ütközött')
  }

  async resolveRef(input: ResolveRefInput): Promise<ResolveRefResult> {
    return this.lookupRef(input, { auditUnknown: true })
  }

  private async lookupRef(
    input: ResolveRefInput,
    opts: { auditUnknown: boolean },
  ): Promise<ResolveRefResult> {
    const parsed = parseSurrogate(input.surrogate)
    if (!parsed) return { ok: false, reason: 'unknown' }

    const denied = await this.denyIfOutOfScope(input)
    if (denied) return denied

    const lookup = await this.vault.findBySurrogate(input.tenantId, input.scope, input.surrogate)
    if (lookup.status === 'hit') return { ok: true, record: lookup.record }

    const crossScope = await this.denyIfSurrogateLivesInOtherScope(input)
    if (crossScope) return crossScope

    const reason = lookup.status === 'tampered' ? 'hmac_invalid' : 'unknown'
    if (opts.auditUnknown) {
      await this.audit.recordUnknownSurrogate({
        action: 'privacy.surrogate.unknown',
        tenantId: input.tenantId,
        scope: input.scope,
        surrogate: input.surrogate,
        reason,
      })
    }
    return { ok: false, reason }
  }

  private async denyIfOutOfScope(input: ResolveRefInput): Promise<Extract<ResolveRefResult, { reason: 'denied' }> | null> {
    if (input.requester.tenantId !== input.tenantId) {
      return this.deny(input, 'tenant')
    }
    const access = await this.access.authorize({
      requester: input.requester,
      claimedTenantId: input.tenantId,
      scope: input.scope,
    })
    if (!access.allowed) return this.deny(input, access.reason)
    return null
  }

  private async denyIfSurrogateLivesInOtherScope(
    input: ResolveRefInput,
  ): Promise<Extract<ResolveRefResult, { reason: 'denied' }> | null> {
    const hits = await this.vault.findHitsBySurrogateInTenant(input.tenantId, input.surrogate)
    const elsewhere = hits.some(
      (record) => record.scopeType !== input.scope.type || record.scopeId !== input.scope.id,
    )
    if (!elsewhere) return null
    return this.deny(input, 'scope')
  }

  private async deny(
    input: ResolveRefInput,
    reason: ResolveDenyReason,
  ): Promise<Extract<ResolveRefResult, { reason: 'denied' }>> {
    await this.audit.recordResolveDenied({
      action: 'privacy.resolve.denied',
      tenantId: input.requester.tenantId,
      scope: input.scope,
      surrogate: input.surrogate,
      reason,
      requesterUserId: input.requester.userId ?? null,
    })
    return { ok: false, reason: 'denied', denyReason: reason }
  }

  private rememberAllocatedDisplay(input: AllocateRefInput, surrogate: string): void {
    if (input.displayValue) {
      this.rememberDisplayValue(input.tenantId, input.scope, surrogate, input.displayValue)
    }
  }
}

function displayKey(tenantId: string, scope: PrivacyScope, surrogate: string): string {
  return `${tenantId}\0${scope.type}\0${scope.id}\0${surrogate}`
}
