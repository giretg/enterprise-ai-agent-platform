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
import type { ConversationPrivacyKeyRepository } from '@/repositories/interfaces'
import { formatSurrogate, parseSurrogate } from '@/domain/privacy/surrogate-format'
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import {
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  SurrogateTakenError,
  type SurrogateVault,
} from '@/domain/privacy/surrogate-vault'
import { encryptValSurrogateValue, decryptValSurrogateValue } from '@/domain/privacy/val-surrogate-crypto'
import { valSurrogateFingerprint } from '@/domain/privacy/val-fingerprint'

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
  /** A known-value fail-policyhoz: csak explicit strukturált mező kap hard forrásjelölést. */
  displayValueSource?: 'structured_field' | 'scanner'
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

export type ResolveValResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'unknown' | 'hmac_invalid' | 'shredded' }
  | { ok: false; reason: 'denied'; denyReason: ResolveDenyReason }

export type AllocateValInput = {
  tenantId: string
  scope: PrivacyScope
  entityType: SurrogateEntityType
  plaintext: string
  /**
   * Az az `conversation`, amelynek adatkulcsa titkosítja az értéket. Alapból a
   * scope maga; `trace` scope-nál (APG-21 debug-trace) a forduló beszélgetése —
   * így a beszélgetés törlése a trace-hez tartozó másolatot is leshreddeli.
   */
  keyConversationId?: string
}

export type ResolveValInput = {
  tenantId: string
  scope: PrivacyScope
  surrogate: string
  requester: PrivacyResolveRequester
  /** L. `AllocateValInput.keyConversationId` — ugyanaz a kulcs kell a feloldáshoz. */
  keyConversationId?: string
}

const MAX_ALLOC_ATTEMPTS = 16

type DisplayValue = { value: string; source: 'structured_field' | 'scanner' }

export class SurrogateEngine {
  /**
   * scope-kulcs → (álnév → megjelenítési érték). A beágyazás szándékos: a korábbi
   * lapos, összefűzött kulcsból az álnevet vissza kellett szeletelni, és a
   * kulcsformátum bármely változása némán szemetet írt volna a promptba.
   */
  private readonly displayValues = new Map<string, Map<string, DisplayValue>>()
  /** Beszélgetés-szintű entitástérkép: a history append-only, a prefix újrahasznosítható. */
  private readonly scopes = new Map<string, ScopeEntityMap>()

  constructor(
    private readonly vault: SurrogateVault,
    private readonly audit: PrivacyAuditSink,
    private readonly access: PrivacyResolveAccess = allowAllPrivacyResolveAccess,
    private readonly privacyKeys?: ConversationPrivacyKeyRepository,
  ) {}

  rememberDisplayValue(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
    displayValue: string,
    source: 'structured_field' | 'scanner' = 'scanner',
  ): void {
    if (!displayValue) return
    const key = scopeKey(tenantId, scope)
    let byScope = this.displayValues.get(key)
    if (!byScope) {
      byScope = new Map()
      this.displayValues.set(key, byScope)
    }
    byScope.set(surrogate, { value: displayValue, source })
  }

  peekDisplayValue(tenantId: string, scope: PrivacyScope, surrogate: string): string | undefined {
    return this.displayValues.get(scopeKey(tenantId, scope))?.get(surrogate)?.value
  }

  /** A beszélgetésben már ismert nyers értékek produkciós known-value cseréi. */
  listKnownValueReplacements(
    tenantId: string,
    scope: PrivacyScope,
  ): Array<{ needle: string; surrogate: string; fromStructuredField: boolean }> {
    const byScope = this.displayValues.get(scopeKey(tenantId, scope))
    if (!byScope) return []
    return [...byScope].map(([surrogate, stored]) => ({
      needle: stored.value,
      surrogate,
      fromStructuredField: stored.source === 'structured_field',
    }))
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

  /**
   * Szabad szöveges / user-input találatok batch-allokációja (spec §6, D2).
   *
   * Fingerprinten dedupál, így ugyanaz az érték egy fordulón belül egyetlen
   * vault-írást okoz. A nyers érték KIZÁRÓLAG titkosítva kerül a vaultba —
   * a `source_id` a hash, nem az adat.
   */
  async allocateVals(inputs: AllocateValInput[]): Promise<string[]> {
    if (inputs.length === 0) return []
    const results = new Array<string>(inputs.length)
    const byFingerprint = new Map<string, number[]>()
    inputs.forEach((input, index) => {
      const key = [
        input.tenantId,
        input.scope.type,
        input.scope.id,
        input.entityType,
        valSurrogateFingerprint(input.plaintext),
      ].join('\0')
      const indexes = byFingerprint.get(key)
      if (indexes) indexes.push(index)
      else byFingerprint.set(key, [index])
    })

    for (const indexes of byFingerprint.values()) {
      const first = indexes[0]
      if (first === undefined) continue
      const input = inputs[first]
      if (!input) continue
      const surrogate = await this.allocateVal(input)
      for (const index of indexes) results[index] = surrogate
    }
    return results
  }

  async allocateVal(input: AllocateValInput): Promise<string> {
    const keyConversationId =
      input.keyConversationId ?? (input.scope.type === 'conversation' ? input.scope.id : null)
    if (!keyConversationId) {
      throw new Error('val-surrogate allokációhoz beszélgetés-adatkulcs szükséges')
    }
    if (!this.privacyKeys) {
      throw new Error('val-surrogate allokációhoz privacy key repository szükséges')
    }
    const fingerprint = valSurrogateFingerprint(input.plaintext)
    const existing = await this.vault.findValByFingerprint(
      input.tenantId,
      input.scope,
      input.entityType,
      fingerprint,
    )
    if (existing.status === 'hit') {
      this.rememberDisplayValue(
        input.tenantId,
        input.scope,
        existing.record.surrogate,
        input.plaintext,
        'scanner',
      )
      return existing.record.surrogate
    }

    const dataKey = await this.privacyKeys.ensureDataKey(input.tenantId, keyConversationId)
    const cache = await this.hydrateValOrdinals(input.tenantId, input.scope, input.entityType)
    let surrogate = ''
    for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt += 1) {
      const next = cache.maxOrdinal + 1
      cache.maxOrdinal = next
      surrogate = formatSurrogate(input.entityType, next)
      try {
        const encryptedValue = encryptValSurrogateValue(input.tenantId, dataKey, input.plaintext)
        await this.vault.insertVal({
          tenantId: input.tenantId,
          scope: input.scope,
          entityType: input.entityType,
          fingerprint,
          surrogate,
          encryptedValue,
        })
        this.rememberDisplayValue(
          input.tenantId,
          input.scope,
          surrogate,
          input.plaintext,
          'scanner',
        )
        return surrogate
      } catch (error) {
        const retry = await this.vault.findValByFingerprint(
          input.tenantId,
          input.scope,
          input.entityType,
          fingerprint,
        )
        if (retry.status === 'hit') {
          this.rememberDisplayValue(
            input.tenantId,
            input.scope,
            retry.record.surrogate,
            input.plaintext,
            'scanner',
          )
          return retry.record.surrogate
        }
        if (!(error instanceof SurrogateTakenError)) throw error
      }
    }
    throw new Error('val-surrogate allokáció: a sorszámfoglalás túl sokszor ütközött')
  }

  async resolveVal(input: ResolveValInput): Promise<ResolveValResult> {
    const parsed = parseSurrogate(input.surrogate)
    if (!parsed) return { ok: false, reason: 'unknown' }

    const denied = await this.denyIfOutOfScope(input)
    if (denied) return denied

    const lookup = await this.vault.findValBySurrogate(input.tenantId, input.scope, input.surrogate)
    if (lookup.status === 'tampered') return { ok: false, reason: 'hmac_invalid' }
    if (lookup.status === 'miss') {
      await this.audit.recordUnknownSurrogate({
        action: 'privacy.surrogate.unknown',
        tenantId: input.tenantId,
        scope: input.scope,
        surrogate: input.surrogate,
        reason: 'unknown',
      })
      return { ok: false, reason: 'unknown' }
    }

    const keyConversationId =
      input.keyConversationId ?? (input.scope.type === 'conversation' ? input.scope.id : null)
    if (!keyConversationId || !this.privacyKeys) {
      return { ok: false, reason: 'shredded' }
    }
    const dataKey = await this.privacyKeys.getDataKey(input.tenantId, keyConversationId)
    if (!dataKey) return { ok: false, reason: 'shredded' }

    try {
      const value = decryptValSurrogateValue(
        input.tenantId,
        dataKey,
        lookup.record.encryptedValue,
      )
      return { ok: true, value }
    } catch {
      return { ok: false, reason: 'shredded' }
    }
  }

  private valOrdinalCache = new Map<string, { maxOrdinal: number }>()

  private async hydrateValOrdinals(
    tenantId: string,
    scope: PrivacyScope,
    entityType: SurrogateEntityType,
  ): Promise<{ maxOrdinal: number }> {
    const key = `${tenantId}\0${scope.type}\0${scope.id}\0${entityType}\0val`
    const cached = this.valOrdinalCache.get(key)
    if (cached) return cached
    const maxOrdinal = await this.vault.maxOrdinal(tenantId, scope, entityType)
    const next = { maxOrdinal }
    this.valOrdinalCache.set(key, next)
    return next
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

  private async denyIfOutOfScope(
    input: ResolveRefInput | ResolveValInput,
  ): Promise<Extract<ResolveRefResult, { reason: 'denied' }> | null> {
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
    input: ResolveRefInput | ResolveValInput,
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
      this.rememberDisplayValue(
        input.tenantId,
        input.scope,
        surrogate,
        input.displayValue,
        input.displayValueSource,
      )
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
        entityType: SurrogateEntityType
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
