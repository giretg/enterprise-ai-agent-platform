/**
 * Model Gateway tartalomszűrő (#746 V1-4, #747 teljes port) — a #769 proxy `filterRequest`/`transformResponse` horgai.
 *
 * Üzemmód (`content_filter.mode`, tenant → user → agent-plafon): `off` = nem nézzük át (kivéve titkos kulcs,
 * az mindig blokk); `observe` = felismer és naplóz, de semmit nem módosít és nem blokkol; `enforce` =
 * kategóriánként `block / local_only / tokenize / warn / off`.
 *
 * 1. Felismerés slotonként (system/user/assistant/tool üzenet, tool-argumentum): nincs üzenethatáron átnyúló
 *    hamis PAN-találat. Személynév katalógus nélkül ott, ahol a forma elárulja: `Kiss János <kiss@x.hu>`;
 *    a session ezután bárhol, magyar raggal is felismeri (known-value matcher).
 * 2. `tokenize` → álnév `hermes_session` hatókörben, bijektíven és stabilan; a válaszban visszaáll
 *    (response-restorer.ts). `local_only` → csak céges (saját üzemeltetésű) modell kaphatja, ha nincs: blokk.
 * 3. Inkrementális (K10): a már egyszer átengedett slot kimenete memóból jön, így a korábbi üzenetek
 *    bájtra azonosak maradnak (prompt-cache), akkor is, ha egy nevet a session csak később tanult meg.
 *    A system prompt (memória, context-fájlok) is szűrt: a bijektív álnév miatt ettől a prefix stabil marad.
 *
 * Fail-closed: ha a vault nem elérhető, a kérés nem megy ki.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { logger } from '@/lib/observability'
import { findKnownValueMatches } from '@/domain/privacy/known-value-matcher'
import { applySurrogateReplacements, type SurrogateReplacement } from '@/domain/privacy/apply-replacements'
import { sealAesGcm, openAesGcm } from '@/domain/privacy/aes-gcm-envelope'
import { collectSensitivityMatchSpans } from '@/domain/privacy/sensitivity-match-spans'
import { keyedValSurrogateFingerprint } from '@/domain/privacy/val-fingerprint'
import {
  findEmbeddedSurrogates,
  formatSurrogate,
  parseSurrogate,
  type SurrogateEntityType,
} from '@/domain/privacy/surrogate-format'
import {
  SurrogateTakenError,
  type InsertValInput,
  type PrivacyScope,
  type ValVaultRecord,
} from '@/domain/privacy/surrogate-vault'
import { resolveTenantPrivacyHmacKey } from '@/domain/privacy/tenant-hmac-key'
import type { GatewayCallContext, GatewayPipelineHooks } from '@/domain/model-gateway/proxy'
import { createRestoreTransform } from '@/domain/model-gateway/response-restorer'
import { PRIVACY_CATEGORY_ALIASES } from '@/domain/privacy/privacy-category-policy'
import { CONTENT_FILTER_CATEGORIES, CONTENT_FILTER_MODE_KEY, type ContentFilterMode } from '@/domain/client-policy/capabilities'
import { writeAudit, type AuditSink } from '@/lib/audit/types'

/** Az álnév-vault, amit a szűrő használ (Postgres-adapter: `gateway-surrogate-repository.ts`). */
export interface GatewayValVault {
  /** A hatókör hitelesített sorai. */
  list(tenantId: string, scope: PrivacyScope): Promise<ValVaultRecord[]>
  /** `SurrogateTakenError`, ha az álnév vagy az (típus, ujjlenyomat) már foglalt. */
  insert(input: InsertValInput): Promise<void>
}

const MAX_ALLOC_ATTEMPTS = 5

/** `id = <userId>:<sessionId>`. A sessionId-t a hívó adja: header, vagy header nélkül kérésenkénti UUID. */
export function hermesSessionScope(userId: string, sessionId: string): PrivacyScope {
  return { type: 'hermes_session', id: `${userId}:${sessionId}` }
}

/** Egy hatókör álnevei: memóriában (egy kérés élettartama), a vault a forrás. */
export class SurrogateSession {
  private valueBySurrogate = new Map<string, string>()
  private surrogateByKey = new Map<string, string>()
  private ordinals = new Map<string, number>()
  private tenantKey: string

  private constructor(
    private vault: GatewayValVault,
    private tenantId: string,
    private scope: PrivacyScope,
  ) {
    this.tenantKey = resolveTenantPrivacyHmacKey(tenantId)
  }

  static async load(vault: GatewayValVault, tenantId: string, scope: PrivacyScope): Promise<SurrogateSession> {
    const session = new SurrogateSession(vault, tenantId, scope)
    await session.reload()
    return session
  }

  private encryptionKey(): Buffer {
    return createHmac('sha256', this.tenantKey).update(`gateway-surrogate-enc\n${this.scope.type}\n${this.scope.id}`).digest()
  }

  private fingerprint(entityType: SurrogateEntityType, value: string): string {
    return keyedValSurrogateFingerprint(this.tenantKey, entityType, value)
  }

  private async reload(): Promise<void> {
    const key = this.encryptionKey()
    this.valueBySurrogate.clear()
    this.surrogateByKey.clear()
    this.ordinals.clear()
    for (const record of await this.vault.list(this.tenantId, this.scope)) {
      let value: string
      try {
        value = openAesGcm(key, record.encryptedValue, 'gateway surrogate').toString('utf8')
      } catch {
        continue // nem visszafejthető sor: nem használjuk
      }
      this.valueBySurrogate.set(record.surrogate, value)
      this.surrogateByKey.set(`${record.entityType}\0${record.sourceId}`, record.surrogate)
      const ordinal = parseSurrogate(record.surrogate)?.ordinal ?? 0
      this.ordinals.set(record.entityType, Math.max(this.ordinals.get(record.entityType) ?? 0, ordinal))
    }
  }

  /** Már kiosztott álnév (szinkron); null, ha az érték még nincs a vaultban. */
  peek(entityType: SurrogateEntityType, value: string): string | null {
    return this.surrogateByKey.get(`${entityType}\0${this.fingerprint(entityType, value)}`) ?? null
  }

  /** Bijektív: ugyanaz az érték mindig ugyanazt az álnevet kapja a hatókörön belül. */
  async surrogateFor(entityType: SurrogateEntityType, value: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt++) {
      const existing = this.peek(entityType, value)
      if (existing) return existing
      const fingerprint = this.fingerprint(entityType, value)
      const surrogate = formatSurrogate(entityType, (this.ordinals.get(entityType) ?? 0) + 1)
      try {
        await this.vault.insert({
          tenantId: this.tenantId,
          scope: this.scope,
          entityType,
          fingerprint,
          surrogate,
          encryptedValue: sealAesGcm(this.encryptionKey(), Buffer.from(value, 'utf8')),
        })
      } catch (error) {
        if (!(error instanceof SurrogateTakenError)) throw error
        await this.reload() // párhuzamos kérés kiosztott közben
        continue
      }
      this.valueBySurrogate.set(surrogate, value)
      this.surrogateByKey.set(`${entityType}\0${fingerprint}`, surrogate)
      this.ordinals.set(entityType, (this.ordinals.get(entityType) ?? 0) + 1)
      return surrogate
    }
    throw new Error('surrogate allocation kept conflicting')
  }

  /** A session ismert személynevei — a magyar ragozott alakok illesztéséhez. */
  personReplacements(): Array<{ needle: string; surrogate: string; fromStructuredField: boolean }> {
    return [...this.valueBySurrogate].flatMap(([surrogate, value]) =>
      parseSurrogate(surrogate)?.entityType === 'person' ? [{ needle: value, surrogate, fromStructuredField: false }] : [],
    )
  }

  /** Az ismert álneveket valódi értékre cseréli; az ismeretlen (kitalált) álnév érintetlen marad. */
  restore(text: string, jsonEscape = false): string {
    const replacements: SurrogateReplacement[] = []
    for (const found of findEmbeddedSurrogates(text)) {
      const value = this.valueBySurrogate.get(found.text)
      if (value !== undefined) {
        replacements.push({ start: found.start, end: found.end, surrogate: jsonEscape ? JSON.stringify(value).slice(1, -1) : value })
      }
    }
    return applySurrogateReplacements(text, replacements)
  }
}

// ── Üzenetek ────────────────────────────────────────────────────────────────

/** Hétköznapi név a blokk-üzenetekhez (tárgyeset). */
const CATEGORY_LABELS: Record<string, string> = {
  person: 'személynevet', email: 'e-mail-címet', phone: 'telefonszámot', account: 'bankszámlaszámot',
  taj: 'TAJ-számot', adoszam: 'adószámot', pan: 'bankkártyaszámot', iban: 'IBAN-számlaszámot',
  secret_key: 'titkos kulcsot vagy jelszót',
}

const HISTORY_HINT =
  'Ha az adat már korábbi üzenetben van, indíts új beszélgetést (/new), mert az előzmény minden kérésnél vele együtt megy.'

export const PAN_BLOCK_MESSAGE =
  'Ezt a kérést nem küldtem el az AI-modellnek: bankkártyaszámot találtam benne. ' +
  'Kártyaszám nem mehet külső AI-modellhez. Töröld ki a számot (vagy írd át, pl. 4111 **** **** 1111), és kérdezd újra. ' +
  HISTORY_HINT

export const PRIVACY_UNAVAILABLE_MESSAGE =
  'Ezt a kérést nem küldtem el az AI-modellnek: a személyes adatok védelme most nem működik. Próbáld újra egy perc múlva; ha marad, szólj a rendszergazdának.'

const labelsOf = (categories: string[]) => categories.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')

export function blockMessage(category: string): string {
  if (category === 'pan') return PAN_BLOCK_MESSAGE
  return `Ezt a kérést nem küldtem el az AI-modellnek: ${labelsOf([category])} találtam benne, és a céges adatvédelmi beállítás ezt nem engedi továbbítani. Töröld vagy írd át az adatot, és kérdezd újra. ${HISTORY_HINT}`
}

export function privateOnlyMessage(categories: string[]): string {
  return `Ezt a kérést nem küldtem el: ${labelsOf(categories)} találtam benne, amit a céges beállítás szerint csak a cég saját AI-modellje dolgozhat fel, de ilyen modell most nincs beállítva. Töröld vagy írd át az adatot, vagy kérd meg a rendszergazdát, hogy állítson be céges modellt. ${HISTORY_HINT}`
}

// ── Szöveg-slotok ───────────────────────────────────────────────────────────

type Slot = { owner: Record<string, unknown> | unknown[]; key: string | number; text: string }

const SKIP_KEYS = new Set(['role', 'type', 'id', 'tool_call_id'])

/** Minden string a `messages`-ben (content, content-részek, tool_calls argumentumok, reasoning…). */
function collectSlots(value: unknown, out: Slot[] = []): Slot[] {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    const owner = value as Record<string, unknown> | unknown[]
    for (const [key, child] of Object.entries(owner)) {
      if (typeof child === 'string') {
        if (!SKIP_KEYS.has(key) && !child.startsWith('data:')) out.push({ owner, key: Array.isArray(owner) ? Number(key) : key, text: child })
      } else collectSlots(child, out)
    }
  }
  return out
}

export function containsPan(text: string): boolean {
  return collectSensitivityMatchSpans(text).some((span) => (PRIVACY_CATEGORY_ALIASES[span.category] ?? span.category) === 'pan')
}

// ── Felismerés ──────────────────────────────────────────────────────────────

type Candidate = { start: number; end: number; category: string; value: string }

/** `Kiss János <kiss.janos@x.hu>` / `"Kiss János" <…>`: legalább két nagybetűs szó a `<cím>` előtt. */
const NAME_BEFORE_EMAIL_RE =
  /((?:^|[\n"',;:(\[]|\\")\s*)(\p{Lu}[\p{L}.'’-]*(?: \p{Lu}[\p{L}.'’-]*){1,3})(?:\\?"|')?\s*<[^<>\s]+@[^<>\s]+>/gu

function findCandidates(text: string): Candidate[] {
  const found: Candidate[] = collectSensitivityMatchSpans(text).map((span) => ({
    start: span.start, end: span.end, category: PRIVACY_CATEGORY_ALIASES[span.category] ?? span.category, value: span.value,
  }))
  for (const match of text.matchAll(NAME_BEFORE_EMAIL_RE)) {
    const start = match.index + match[1].length
    found.push({ start, end: start + match[2].length, category: 'person', value: match[2] })
  }
  return found.sort((a, b) => a.start - b.start)
}

/** A session már ismert nevei a szövegben, ahol nem fednek egy másik találatot (pl. az e-mail-címen belül). */
function knownNames(text: string, session: SurrogateSession | null, candidates: Candidate[]) {
  if (!session) return []
  return findKnownValueMatches(text, session.personReplacements()).filter(
    (m) => !candidates.some((c) => m.start < c.end && m.end > c.start),
  )
}

// ── Inkrementális memó ──────────────────────────────────────────────────────

type MemoEntry = { out: string; categories: string[] }

/**
 * Slot → szűrt kimenet, (hatókör, policy, szöveg) kulcson. Csak átengedett kérés slotja kerül be.
 * ponytail: folyamaton belüli, karakterszámra korlátos LRU; több példánynál egy-egy cache-miss lehet
 * (a másik példány újraszámol). Tartós memó (DB), ha a mért cache-találati arány ezt indokolja.
 */
export class SlotMemo {
  private map = new Map<string, MemoEntry>()
  private chars = 0
  constructor(private maxChars = 16_000_000) {}

  get(key: string): MemoEntry | undefined {
    const entry = this.map.get(key)
    if (entry) {
      this.map.delete(key)
      this.map.set(key, entry)
    }
    return entry
  }

  set(key: string, entry: MemoEntry): void {
    if (this.map.has(key)) return
    this.map.set(key, entry)
    this.chars += entry.out.length
    while (this.chars > this.maxChars && this.map.size > 1) {
      const [oldest, value] = this.map.entries().next().value!
      this.map.delete(oldest)
      this.chars -= value.out.length
    }
  }
}

// ── A szűrő magja (a horgok és a dry-run közös útja) ────────────────────────

export type FilterPolicy = { mode: ContentFilterMode; level: (category: string) => string }

/** A V1 szerződés getCapabilities nélkül: PAN és titkos kulcs blokk, e-mail/név álnév, más nem. */
const STANDALONE_POLICY: FilterPolicy = {
  mode: 'enforce',
  level: (c) => (c === 'pan' || c === 'secret_key' ? 'block' : c === 'email' || c === 'person' ? 'tokenize' : 'off'),
}

export function filterPolicyFrom(capabilities: Record<string, string> | undefined): FilterPolicy {
  if (!capabilities) return STANDALONE_POLICY
  const mode = capabilities[CONTENT_FILTER_MODE_KEY]
  return {
    mode: mode === 'off' || mode === 'observe' ? mode : 'enforce',
    // Ismeretlen kategória a legszigorúbb. Titkos kulcs mentett warn/off értéke is block (§7.1/5).
    level: (c) => (c === 'secret_key' ? 'block' : capabilities[`content_filter.${c}`] ?? 'block'),
  }
}

const NOT_TOKENIZABLE = new Set(['pan', 'secret_key'])

export type FilterResult =
  | { kind: 'block'; category: string; message: string; reason: string }
  | {
      kind: 'send'
      messages: unknown
      /** A kérés (memóval együtt) összes felismert kategóriája. */
      categories: string[]
      /** Csak az új (nem memóból jött) slotok kategóriái, darabszámmal — a napló ezekről szól. */
      fresh: Record<string, number>
      /** Ezek miatt csak céges modell kaphatja; üres = bármely engedett modell. */
      privateOnly: string[]
    }

export async function filterMessages(input: {
  messages: unknown
  policy: FilterPolicy
  /** Lustán: csak ha tényleg kell álnév (a vault-hívás drága és fail-closed). */
  session: () => Promise<SurrogateSession>
  memo?: { store: SlotMemo; scopeKey: string }
}): Promise<FilterResult> {
  const { policy } = input
  const messages = structuredClone(input.messages)
  if (policy.mode === 'off') {
    for (const slot of collectSlots(messages)) {
      if (findCandidates(slot.text).some((c) => c.category === 'secret_key')) {
        return { kind: 'block', category: 'secret_key', message: blockMessage('secret_key'), reason: 'content_filter_block:secret_key' }
      }
    }
    return { kind: 'send', messages, categories: [], fresh: {}, privateOnly: [] }
  }

  const signature = `${policy.mode}|${CONTENT_FILTER_CATEGORIES.map(policy.level).join(',')}`
  const memoKey = (text: string) => input.memo && createHash('sha256').update(`${input.memo.scopeKey}\0${signature}\0${text}`).digest('base64url')
  const slots = collectSlots(messages)
  const fresh: Array<{ slot: Slot; key: string | undefined; candidates: Candidate[] }> = []
  const all = new Set<string>()
  const counts: Record<string, number> = {}
  for (const slot of slots) {
    const key = memoKey(slot.text)
    const hit = key ? input.memo!.store.get(key) : undefined
    if (hit) {
      hit.categories.forEach((c) => all.add(c))
      if (hit.out !== slot.text) (slot.owner as Record<string | number, unknown>)[slot.key] = hit.out
      continue
    }
    const candidates = findCandidates(slot.text)
    fresh.push({ slot, key, candidates })
  }

  const enforce = policy.mode === 'enforce'
  const tokenized = (c: string) => enforce && policy.level(c) === 'tokenize' && !NOT_TOKENIZABLE.has(c)
  const anyTokenize = fresh.some((f) => f.candidates.some((c) => tokenized(c.category)))
  // A korábban tanult név fejléc nélkül is felismerendő, ha a név-szűrő aktív.
  const needSession = anyTokenize || (enforce && policy.level('person') !== 'off' && fresh.length > 0)
  const session = needSession ? await input.session() : null

  const slotCategories = new Map<Slot, Set<string>>()
  for (const f of fresh) {
    const own = new Set(f.candidates.map((c) => c.category))
    if (knownNames(f.slot.text, session, f.candidates).length) own.add('person')
    slotCategories.set(f.slot, own)
    for (const c of own) {
      all.add(c)
      counts[c] = (counts[c] ?? 0) + Math.max(1, f.candidates.filter((x) => x.category === c).length)
    }
  }

  if (enforce) {
    for (const c of all) {
      const level = policy.level(c)
      // Nem álnevezhető kategóriára a `tokenize` sosem engedheti át a nyers értéket.
      if (level === 'block' || (level === 'tokenize' && NOT_TOKENIZABLE.has(c))) {
        return { kind: 'block', category: c, message: blockMessage(c), reason: c === 'pan' ? 'pan_detected' : `content_filter_block:${c}` }
      }
    }
    if (session) {
      // Kétlépéses, hogy az eredmény ne függjön az üzenetek sorrendjétől (a név a fejlécben későn is jöhet).
      for (const f of fresh) for (const c of f.candidates) if (tokenized(c.category)) await session.surrogateFor(c.category, c.value)
      for (const f of fresh) {
        const spans: SurrogateReplacement[] = f.candidates
          .filter((c) => tokenized(c.category))
          .map((c) => ({ start: c.start, end: c.end, surrogate: session.peek(c.category, c.value)! }))
        const names = tokenized('person') ? knownNames(f.slot.text, session, f.candidates) : []
        const replaced = applySurrogateReplacements(f.slot.text, [...spans, ...names])
        if (replaced !== f.slot.text) (f.slot.owner as Record<string | number, unknown>)[f.slot.key] = replaced
      }
    }
  }

  for (const f of fresh) {
    const out = (f.slot.owner as Record<string | number, unknown>)[f.slot.key] as string
    if (f.key) input.memo!.store.set(f.key, { out, categories: [...slotCategories.get(f.slot)!] })
  }
  const categories = [...all]
  return {
    kind: 'send',
    messages,
    categories,
    fresh: counts,
    privateOnly: enforce ? categories.filter((c) => policy.level(c) === 'local_only') : [],
  }
}

// ── Horgok ──────────────────────────────────────────────────────────────────

/** A kérésben kimenő nyers kártyaszám/IBAN mindig naplózandó (PR #342). */
const RAW_EGRESS_AUDITED = new Set(['pan', 'iban'])

export function createContentFilterHooks(deps: {
  vault: GatewayValVault
  getCapabilities?: (ctx: GatewayCallContext) => Promise<Record<string, string>>
  audit?: AuditSink
  memo?: SlotMemo
}): Required<Pick<GatewayPipelineHooks, 'filterRequest' | 'transformResponse'>> {
  const memo = deps.memo ?? new SlotMemo()
  // A kérés session-je a szűrőtől a válasz-visszaállításig ugyanaz az objektum (a ctx azonos).
  const sessions = new WeakMap<GatewayCallContext, Promise<SurrogateSession>>()
  const sessionIds = new WeakMap<GatewayCallContext, string>()
  // Header nélkül ne essünk userenkénti „default” vaultba: a sessionök HMAC-tartománya maradjon külön.
  const sessionIdFor = (ctx: GatewayCallContext) => {
    let id = sessionIds.get(ctx)
    if (!id) sessionIds.set(ctx, (id = ctx.sessionId?.trim() || randomUUID()))
    return id
  }
  const sessionFor = (ctx: GatewayCallContext) => {
    let session = sessions.get(ctx)
    if (!session) {
      session = SurrogateSession.load(deps.vault, ctx.tenantId, hermesSessionScope(ctx.userId, sessionIdFor(ctx)))
      sessions.set(ctx, session)
    }
    return session
  }
  const audit = (ctx: GatewayCallContext, action: string, metadata: Record<string, unknown>) =>
    writeAudit(deps.audit, {
      actorType: 'human', actorId: ctx.userId, tenantId: ctx.tenantId,
      action, targetType: 'agent', targetId: ctx.agentId, policyDecision: 'flagged', metadata,
    })

  return {
    async filterRequest(ctx, body) {
      try {
        const policy = filterPolicyFrom(await deps.getCapabilities?.(ctx))
        const result = await filterMessages({
          messages: body.messages,
          policy,
          session: () => sessionFor(ctx),
          memo: { store: memo, scopeKey: `${ctx.tenantId}\0${ctx.userId}\0${sessionIdFor(ctx)}` },
        })
        if (result.kind === 'block') return { block: result.message, reason: result.reason }
        const freshCategories = Object.keys(result.fresh)
        try {
          if (policy.mode === 'observe' && freshCategories.length) {
            // Csak jelez: a kérés változatlanul megy ki. Érték nem kerül a naplóba, csak a fajta és a darabszám.
            await audit(ctx, 'client_policy.content_observed', {
              categories: result.fresh,
              wouldBlock: freshCategories.filter((c) => policy.level(c) === 'block' || (policy.level(c) === 'tokenize' && NOT_TOKENIZABLE.has(c))),
            })
          }
          const warned = policy.mode === 'enforce'
            ? freshCategories.filter((c) => policy.level(c) === 'warn' || (policy.level(c) === 'off' && RAW_EGRESS_AUDITED.has(c)))
            : []
          if (warned.length) await audit(ctx, 'client_policy.content_warning', { categories: warned })
        } catch (error) {
          // A naplóhiba a már átengedett kérést nem blokkolhatja (observe soha nem blokkol).
          logger.error({ event: 'model_gateway.content_audit_failed', error: String(error) }, 'Content-filter audit failed')
        }
        return {
          body: { ...body, messages: result.messages },
          ...(result.privateOnly.length
            ? { requirePrivate: { block: privateOnlyMessage(result.privateOnly), reason: `content_filter_private_only:${result.privateOnly.join(',')}` } }
            : {}),
        }
      } catch (error) {
        // Fail-closed, és a hibában sem szerepelhet érték (csak az üzenet).
        logger.error({ event: 'model_gateway.tokenize_failed', error: String(error) }, 'Gateway tokenization failed')
        return { block: PRIVACY_UNAVAILABLE_MESSAGE, reason: 'privacy_unavailable' }
      }
    },

    transformResponse: (ctx) => sessions.has(ctx)
      ? createRestoreTransform({ stream: ctx.stream, session: () => sessionFor(ctx) })
      : new TransformStream<Uint8Array, Uint8Array>(),
  }
}

// ── Dry-run (admin felület) ─────────────────────────────────────────────────

/** Memória-vault: a próbaszöveg álnevei sehol nem tárolódnak. */
function ephemeralVault(): GatewayValVault {
  const rows: ValVaultRecord[] = []
  return {
    async list() { return rows },
    async insert(input) {
      rows.push({
        id: String(rows.length), tenantId: input.tenantId, scopeType: input.scope.type, scopeId: input.scope.id,
        entityType: input.entityType, surrogate: input.surrogate, class: 'val', connectorId: '', sourceId: input.fingerprint,
        hmac: '', encryptedValue: input.encryptedValue,
      })
    },
  }
}

export type DryRunResult = {
  outcome: 'off' | 'observed' | 'sent' | 'private_only' | 'blocked'
  /** Amit a munkatárs látna (blokk vagy „csak céges modell”). */
  message: string | null
  findings: Array<{ category: string; count: number; level: string }>
  /** Ezt kapná a modell. */
  modelText: string
}

/** Egy próbaszöveg útja a szűrőn — ugyanaz a kód, mint élesben, de tárolás és napló nélkül. */
export async function dryRunContentFilter(tenantId: string, text: string, capabilities: Record<string, string>): Promise<DryRunResult> {
  const policy = filterPolicyFrom(capabilities)
  const vault = ephemeralVault()
  const result = await filterMessages({
    messages: [{ role: 'user', content: text }],
    policy,
    session: () => SurrogateSession.load(vault, tenantId, { type: 'hermes_session', id: `dry-run:${randomUUID()}` }),
  })
  if (result.kind === 'block') {
    const found = findCandidates(text)
    return { outcome: 'blocked', message: result.message, findings: summarize(found.map((c) => c.category), policy), modelText: '' }
  }
  const modelText = (result.messages as Array<{ content: string }>)[0].content
  const findings = summarize(Object.entries(result.fresh).flatMap(([c, n]) => Array(n).fill(c)), policy)
  if (policy.mode === 'off') return { outcome: 'off', message: null, findings: [], modelText }
  if (policy.mode === 'observe') return { outcome: 'observed', message: null, findings, modelText }
  if (result.privateOnly.length) return { outcome: 'private_only', message: privateOnlyMessage(result.privateOnly), findings, modelText }
  return { outcome: 'sent', message: null, findings, modelText }
}

function summarize(categories: string[], policy: FilterPolicy): DryRunResult['findings'] {
  const counts = new Map<string, number>()
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts].map(([category, count]) => ({ category, count, level: policy.level(category) }))
}
