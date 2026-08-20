/**
 * Surrogate Engine: allokálás és feloldás (APG-02, spec §5; APG-08 §10.5; APG-10 batch).
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
  /** Beszélgetés-szintű entitástérkép: a history append-only, a prefix újrahasznosítható. */
  private readonly scopes = new Map<string, ScopeEntityMap>()

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
    const assigned = await this.allocateRefs([input])
    const surrogate = assigned[0]
    if (!surrogate) throw new Error('álnév-allokáció üres eredménnyel tért vissza')
    return surrogate
  }

  /**
   * Fordulónkénti batchelt allokáció (APG-10): a beszélgetés entitástérképe
   * memóriában marad, az új entitások egy vault-tranzakcióban íródnak.
   */
  async allocateRefs(inputs: AllocateRefInput[]): Promise<string[]> {
    if (inputs.length === 0) return []
    const results = new Array<string>(inputs.length)
    for (const group of groupAllocationsByScope(inputs)) {
      await this.allocateRefsInScope(group, results)
    }
    return results
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

  private async allocateRefsInScope(
    group: AllocationScopeGroup,
    results: string[],
  ): Promise<void> {
    const cache = await this.hydrate(group.tenantId, group.scope)
    const uniquePending: AllocateRefInput[] = []
    const keyToIndexes = new Map<string, number[]>()

    for (const item of group.items) {
      const key = entityKey(item.input)
      const cached = cache.byEntity.get(key)
      if (cached) {
        this.rememberAllocatedDisplay(item.input, cached.surrogate)
        results[item.index] = cached.surrogate
        continue
      }
      const indexes = keyToIndexes.get(key)
      if (indexes) {
        indexes.push(item.index)
        continue
      }
      keyToIndexes.set(key, [item.index])
      uniquePending.push(item.input)
    }

    if (uniquePending.length === 0) return

    const placed = await this.insertNew(cache, group.tenantId, group.scope, uniquePending)
    for (const input of uniquePending) {
      const key = entityKey(input)
      const record = placed.get(key)
      if (!record) throw new Error('álnév-allokáció: a batchelt írás nem adott rekordot')
      for (const index of keyToIndexes.get(key) ?? []) {
        const original = group.items.find((item) => item.index === index)
        if (original) this.rememberAllocatedDisplay(original.input, record.surrogate)
        results[index] = record.surrogate
      }
    }
  }

  private async hydrate(tenantId: string, scope: PrivacyScope): Promise<ScopeEntityMap> {
    const key = scopeKey(tenantId, scope)
    const existing = this.scopes.get(key)
    if (existing) return existing

    const cache: ScopeEntityMap = { byEntity: new Map(), maxOrdinal: new Map() }
    const records = await this.vault.listByScope(tenantId, scope)
    for (const record of records) {
      cache.byEntity.set(entityKey(record), record)
      const parsed = parseSurrogate(record.surrogate)
      if (parsed) {
        const prev = cache.maxOrdinal.get(parsed.entityType) ?? 0
        if (parsed.ordinal > prev) cache.maxOrdinal.set(parsed.entityType, parsed.ordinal)
      }
    }
    this.scopes.set(key, cache)
    return cache
  }

  private async insertNew(
    cache: ScopeEntityMap,
    tenantId: string,
    scope: PrivacyScope,
    inputs: AllocateRefInput[],
  ): Promise<Map<string, RefVaultRecord>> {
    const placed = new Map<string, RefVaultRecord>()
    let remaining = [...inputs]
    for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS && remaining.length > 0; attempt += 1) {
      const batch: Array<{
        tenantId: string
        scope: PrivacyScope
        entityType: string
        connectorId: string
        sourceId: string
        surrogate: string
      }> = remaining.map((input) => {
        const next = (cache.maxOrdinal.get(input.entityType) ?? 0) + 1
        cache.maxOrdinal.set(input.entityType, next)
        return {
          tenantId,
          scope,
          entityType: input.entityType,
          connectorId: input.connectorId,
          sourceId: input.sourceId,
          surrogate: formatSurrogate(input.entityType, next),
        }
      })
      const records = await this.vault.insertRefs(batch)
      const foundKeys = new Set<string>()
      for (const record of records) {
        const key = entityKey(record)
        cache.byEntity.set(key, record)
        placed.set(key, record)
        foundKeys.add(key)
        const parsed = parseSurrogate(record.surrogate)
        if (parsed) {
          const max = cache.maxOrdinal.get(parsed.entityType) ?? 0
          if (parsed.ordinal > max) cache.maxOrdinal.set(parsed.entityType, parsed.ordinal)
        }
      }
      remaining = remaining.filter((input) => !foundKeys.has(entityKey(input)))
    }
    if (remaining.length > 0) {
      throw new Error('álnév-allokáció: a sorszámfoglalás túl sokszor ütközött')
    }
    return placed
  }
}

type ScopeEntityMap = {
  byEntity: Map<string, RefVaultRecord>
  maxOrdinal: Map<string, number>
}

type AllocationScopeGroup = {
  tenantId: string
  scope: PrivacyScope
  items: Array<{ input: AllocateRefInput; index: number }>
}

function groupAllocationsByScope(inputs: AllocateRefInput[]): AllocationScopeGroup[] {
  const groups = new Map<string, AllocationScopeGroup>()
  inputs.forEach((input, index) => {
    const key = scopeKey(input.tenantId, input.scope)
    let group = groups.get(key)
    if (!group) {
      group = { tenantId: input.tenantId, scope: input.scope, items: [] }
      groups.set(key, group)
    }
    group.items.push({ input, index })
  })
  return [...groups.values()]
}

function entityKey(entity: RefEntityRef): string {
  return `${entity.entityType}\0${entity.connectorId}\0${entity.sourceId}`
}

function scopeKey(tenantId: string, scope: PrivacyScope): string {
  return `${tenantId}\0${scope.type}\0${scope.id}`
}

function displayKey(tenantId: string, scope: PrivacyScope, surrogate: string): string {
  return `${tenantId}\0${scope.type}\0${scope.id}\0${surrogate}`
}
