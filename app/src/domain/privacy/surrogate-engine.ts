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
import {
  decryptSurrogateDisplayValue,
  encryptSurrogateDisplayValue,
} from '@/domain/privacy/display-value-crypto'
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

/** A betöltött megjelenítési szótár frissessége (multi-instance futás miatt). */
const DISPLAY_HYDRATION_TTL_MS = 10_000

/**
 * `observe_preview`: OBSERVE mód UI-kiemeléshez, vault nélkül. Nem kerülhet a
 * prompt known-value szótárába — különben ENFORCE-ra váltáskor a modell
 * nem-létező álneveket kapna, vagy egy későbbi valódi allokációval összekeveredne.
 */
type DisplayValueSource = 'structured_field' | 'scanner' | 'observe_preview'
type DisplayValue = { value: string; source: DisplayValueSource }

export class SurrogateEngine {
  /**
   * scope-kulcs → (álnév → megjelenítési érték). A beágyazás szándékos: a korábbi
   * lapos, összefűzött kulcsból az álnevet vissza kellett szeletelni, és a
   * kulcsformátum bármely változása némán szemetet írt volna a promptba.
   */
  private readonly displayValues = new Map<string, Map<string, DisplayValue>>()
  /** Beszélgetés-szintű entitástérkép: a history append-only, a prefix újrahasznosítható. */
  private readonly scopes = new Map<string, ScopeEntityMap>()
  /**
   * Scope-onkénti betöltés a vaultból (spec §5 R19). A találat nem cache-elhető
   * örökre: több szerverpéldánynál a másik példány fordulója új álnevet írhat,
   * és egy elavult cache-ből nyers név menne ki a modellhez.
   */
  private readonly displayHydration = new Map<string, { at: number; work: Promise<void> }>()
  /** Még nem perzisztált megjelenítési értékek scope-onként. */
  private readonly pendingDisplayWrites = new Map<string, Set<string>>()

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
    source: DisplayValueSource = 'scanner',
    /**
     * OBSERVE módban az álnév csak ELŐNÉZET (nincs mögötte vault-sor), ezért nem
     * perzisztálható: a `[[COMPANY_1]]` előnézet ütközne egy később, ENFORCE-ban
     * ténylegesen kiosztott `[[COMPANY_1]]` sorral, és rossz nevet írna rá.
     */
    opts?: { persist?: boolean },
  ): void {
    if (!displayValue) return
    const key = scopeKey(tenantId, scope)
    let byScope = this.displayValues.get(key)
    if (!byScope) {
      byScope = new Map()
      this.displayValues.set(key, byScope)
    }
    byScope.set(surrogate, { value: displayValue, source })
    if (opts?.persist === false) return
    let pending = this.pendingDisplayWrites.get(key)
    if (!pending) {
      pending = new Set()
      this.pendingDisplayWrites.set(key, pending)
    }
    pending.add(surrogate)
  }

  /**
   * A beszélgetés eltárolt megjelenítési értékei (spec §5 R19). A memóriában lévő,
   * frissebb bejegyzés győz; a vaultból csak a hiányzókat tölti be.
   */
  private async hydrateDisplayValues(
    tenantId: string,
    scope: PrivacyScope,
    opts?: { force?: boolean },
  ): Promise<void> {
    if (!this.vault.listDisplayValues) return
    const key = scopeKey(tenantId, scope)
    const running = this.displayHydration.get(key)
    if (running && !opts?.force && Date.now() - running.at < DISPLAY_HYDRATION_TTL_MS) {
      return running.work
    }
    const work = (async () => {
      const dataKey = await this.scopeDataKey(tenantId, scope, { create: false })
      if (!dataKey) return
      const rows = await this.vault.listDisplayValues!(tenantId, scope)
      let byScope = this.displayValues.get(key)
      if (!byScope) {
        byScope = new Map()
        this.displayValues.set(key, byScope)
      }
      for (const row of rows) {
        if (byScope.has(row.surrogate)) continue
        const payload = decryptSurrogateDisplayValue({
          tenantId,
          dataKey,
          scope,
          surrogate: row.surrogate,
          encrypted: row.displayValueEnc,
        })
        if (payload) byScope.set(row.surrogate, { value: payload.value, source: payload.source })
      }
    })().catch(() => {
      // Best-effort: a megjelenítési feloldás hiánya nem állíthatja meg a fordulót,
      // és a következő hívás újra próbálkozhat.
      this.displayHydration.delete(key)
    })
    this.displayHydration.set(key, { at: Date.now(), work })
    return work
  }

  /** Best-effort kiírás: a hiánya nem állítja meg a fordulót, csak a későbbi feloldást rontaná. */
  private async flushDisplayValues(tenantId: string, scope: PrivacyScope): Promise<void> {
    if (!this.vault.saveDisplayValues) return
    const key = scopeKey(tenantId, scope)
    const pending = this.pendingDisplayWrites.get(key)
    if (!pending || pending.size === 0) return
    const byScope = this.displayValues.get(key)
    if (!byScope) return
    const surrogates = [...pending]
    pending.clear()
    try {
      const dataKey = await this.scopeDataKey(tenantId, scope, { create: true })
      if (!dataKey) return
      const rows = surrogates.flatMap((surrogate) => {
        const stored = byScope.get(surrogate)
        if (!stored || stored.source === 'observe_preview') return []
        return [
          {
            surrogate,
            displayValueEnc: encryptSurrogateDisplayValue({
              tenantId,
              dataKey,
              scope,
              surrogate,
              payload: { value: stored.value, source: stored.source },
            }),
          },
        ]
      })
      await this.vault.saveDisplayValues!(tenantId, scope, rows)
    } catch {
      for (const surrogate of surrogates) pending.add(surrogate)
    }
  }

  private async scopeDataKey(
    tenantId: string,
    scope: PrivacyScope,
    opts: { create: boolean },
  ): Promise<Buffer | null> {
    const keys = this.privacyKeys
    if (!keys) return null
    if (opts.create) {
      if (keys.ensureScopeDataKey) return keys.ensureScopeDataKey(tenantId, scope.type, scope.id)
      if (scope.type !== 'conversation') return null
      return keys.ensureDataKey(tenantId, scope.id)
    }
    if (keys.getScopeDataKey) return keys.getScopeDataKey(tenantId, scope.type, scope.id)
    if (scope.type !== 'conversation') return null
    return keys.getDataKey(tenantId, scope.id)
  }

  /**
   * Val-surrogate adatkulcs. `keyConversationId` (APG-21 trace) elsőbbséget élvez;
   * egyébként a scope maga adja a kulcsot — feladat-ticket futásnál is, ahol nincs
   * `Conversation` sor (l. `ensureScopeDataKey`).
   */
  private async valDataKey(
    tenantId: string,
    scope: PrivacyScope,
    keyConversationId: string | undefined,
    opts: { create: boolean },
  ): Promise<Buffer | null> {
    if (keyConversationId) {
      return this.scopeDataKey(tenantId, { type: 'conversation', id: keyConversationId }, opts)
    }
    return this.scopeDataKey(tenantId, scope, opts)
  }

  /** Feloldás megjelenítéshez — a vaultból is betölti a scope értékeit. */
  async resolveDisplayValue(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<string | undefined> {
    const cached = this.peekDisplayValue(tenantId, scope, surrogate)
    if (cached !== undefined) return cached
    await this.hydrateDisplayValues(tenantId, scope)
    const loaded = this.peekDisplayValue(tenantId, scope, surrogate)
    if (loaded !== undefined) return loaded
    // A hívó előbb vault-találatot kapott az álnévre, tehát a sor létezik: ha a
    // megjelenítési érték hiányzik, a betöltés elavult (másik példány írta).
    await this.hydrateDisplayValues(tenantId, scope, { force: true })
    return this.peekDisplayValue(tenantId, scope, surrogate)
  }

  /** Ismert-érték szótár a scope perzisztált értékeivel együtt (APG-16). */
  async loadKnownValueReplacements(
    tenantId: string,
    scope: PrivacyScope,
    opts?: { includeObservePreviews?: boolean },
  ): Promise<Array<{ needle: string; surrogate: string; fromStructuredField: boolean }>> {
    await this.hydrateDisplayValues(tenantId, scope)
    return this.listKnownValueReplacements(tenantId, scope, opts)
  }

  peekDisplayValue(tenantId: string, scope: PrivacyScope, surrogate: string): string | undefined {
    return this.displayValues.get(scopeKey(tenantId, scope))?.get(surrogate)?.value
  }

  /**
   * A beszélgetésben már ismert nyers értékek produkciós known-value cseréi.
   *
   * Alapból kizárja az OBSERVE preview bejegyzéseket: azok vault nélkül, UI-kiemeléshez
   * készültek. Ha a prompt-transzformáció (ENFORCE) felvenné őket, a modell
   * nem-allokált `[[COMPANY_n]]` álneveket kapna — tool-arg feloldás ismeretlen
   * álnévre bukik, vagy egy későbbi valódi vault-allokációval összekeveredik.
   */
  listKnownValueReplacements(
    tenantId: string,
    scope: PrivacyScope,
    opts?: { includeObservePreviews?: boolean },
  ): Array<{ needle: string; surrogate: string; fromStructuredField: boolean }> {
    const byScope = this.displayValues.get(scopeKey(tenantId, scope))
    if (!byScope) return []
    return [...byScope]
      .filter(([, stored]) =>
        opts?.includeObservePreviews ? true : stored.source !== 'observe_preview',
      )
      .map(([surrogate, stored]) => ({
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
      // A megjelenítési érték a sorokkal együtt perzisztálódik: enélkül a
      // beszélgetés újranyitásakor az álnév feloldhatatlan maradna (spec §5 R19).
      await this.flushDisplayValues(group.tenantId, group.scope)
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
    const scoped = inputs[0]
    if (scoped) await this.flushDisplayValues(scoped.tenantId, scoped.scope)
    return results
  }

  async allocateVal(input: AllocateValInput): Promise<string> {
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

    const dataKey = await this.valDataKey(input.tenantId, input.scope, input.keyConversationId, {
      create: true,
    })
    if (!dataKey) {
      throw new Error('val-surrogate allokációhoz beszélgetés-adatkulcs szükséges')
    }
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

    if (!this.privacyKeys) return { ok: false, reason: 'shredded' }
    const dataKey = await this.valDataKey(input.tenantId, input.scope, input.keyConversationId, {
      create: false,
    })
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
