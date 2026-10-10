/**
 * Model Gateway tartalomszűrő (#746 V1-4) — a #769 proxy `filterRequest`/`transformResponse` horgainak tartalma.
 *
 * 1. PAN → blokk: a teljes kimenő kérésen (system/user/assistant/tool üzenet, tool-argumentum), slotonként
 *    szkennelve (üzenethatáron át nincs hamis PAN-találat). Találatnál nincs provider-hívás (D15).
 * 2. E-mail + személynév → álnév, `hermes_session` hatókörben, bijektíven és stabilan (prompt-cache).
 *    Személynév csak ott ismerhető fel katalógus nélkül, ahol a forma elárulja: `Kiss János <kiss@x.hu>`;
 *    a session ezután bárhol, magyar raggal is felismeri (known-value matcher). A teljes katalógus: #747.
 * 3. Visszaállítás a válaszban: lásd response-restorer.ts.
 *
 * Fail-closed: ha a vault nem elérhető, a kérés nem megy ki (nyers e-mail nem juthat a modellhez).
 */
import { createHmac, randomUUID } from 'node:crypto'
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
import { PRIVACY_CATEGORY_ALIASES, type PrivacyPolicyCategory } from '@/domain/privacy/privacy-category-policy'
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

// ── PAN-blokk ───────────────────────────────────────────────────────────────

const PAN_CATEGORIES = new Set(['pan', 'card_broad'])

export const PAN_BLOCK_MESSAGE =
  'Ezt a kérést nem küldtem el az AI-modellnek: bankkártyaszámot találtam benne. ' +
  'Kártyaszám nem mehet külső AI-modellhez. Töröld ki a számot (vagy írd át, pl. 4111 **** **** 1111), és kérdezd újra. ' +
  'Ha a szám már korábbi üzenetben van, indíts új beszélgetést (/new), mert az előzmény minden kérésnél vele együtt megy.'

export const PRIVACY_UNAVAILABLE_MESSAGE =
  'Ezt a kérést nem küldtem el az AI-modellnek: a személyes adatok védelme most nem működik. Próbáld újra egy perc múlva; ha marad, szólj a rendszergazdának.'

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
  return collectSensitivityMatchSpans(text).some((span) => PAN_CATEGORIES.has(span.category))
}

// ── Tokenizálás ─────────────────────────────────────────────────────────────

type Candidate = { start: number; end: number; entityType: 'email' | 'person'; value: string }

/** `Kiss János <kiss.janos@x.hu>` / `"Kiss János" <…>`: legalább két nagybetűs szó a `<cím>` előtt. */
const NAME_BEFORE_EMAIL_RE =
  /((?:^|[\n"',;:(\[]|\\")\s*)(\p{Lu}[\p{L}.'’-]*(?: \p{Lu}[\p{L}.'’-]*){1,3})(?:\\?"|')?\s*<[^<>\s]+@[^<>\s]+>/gu

function findCandidates(text: string): Candidate[] {
  const found: Candidate[] = collectSensitivityMatchSpans(text)
    .filter((span) => span.category === 'email')
    .map((span) => ({ start: span.start, end: span.end, entityType: 'email' as const, value: span.value }))
  for (const match of text.matchAll(NAME_BEFORE_EMAIL_RE)) {
    const start = match.index + match[1].length
    found.push({ start, end: start + match[2].length, entityType: 'person', value: match[2] })
  }
  return found.sort((a, b) => a.start - b.start)
}

/** Kétlépéses, hogy az eredmény ne függjön az üzenetek sorrendjétől (a név a fejlécben későn is jöhet). */
async function tokenizeSlots(slots: Slot[], session: SurrogateSession, types: Set<string>): Promise<void> {
  for (const slot of slots) {
    for (const candidate of findCandidates(slot.text).filter((c) => types.has(c.entityType))) await session.surrogateFor(candidate.entityType, candidate.value)
  }
  const known = types.has('person') ? session.personReplacements() : []
  for (const slot of slots) {
    const candidates = findCandidates(slot.text)
    const own = candidates.filter((c) => types.has(c.entityType))
    const spans: SurrogateReplacement[] = own.map((c) => ({ start: c.start, end: c.end, surrogate: session.peek(c.entityType, c.value)! }))
    const bareNames = findKnownValueMatches(slot.text, known).filter(
      (m) => !candidates.some((c) => m.start < c.end && m.end > c.start),
    )
    const replaced = applySurrogateReplacements(slot.text, [...spans, ...bareNames])
    if (replaced !== slot.text) (slot.owner as Record<string | number, unknown>)[slot.key] = replaced
  }
}

// ── Horgok ──────────────────────────────────────────────────────────────────

export function createContentFilterHooks(deps: {
  vault: GatewayValVault
  getCapabilities?: (ctx: GatewayCallContext) => Promise<Record<string, string>>
  audit?: AuditSink
}): Required<Pick<GatewayPipelineHooks, 'filterRequest' | 'transformResponse'>> {
  // A kérés session-je a szűrőtől a válasz-visszaállításig ugyanaz az objektum (a ctx azonos).
  const sessions = new WeakMap<GatewayCallContext, Promise<SurrogateSession>>()
  const sessionFor = (ctx: GatewayCallContext) => {
    let session = sessions.get(ctx)
    if (!session) {
      // Header nélkül ne essünk userenkénti „default” vaultba: a sessionök HMAC-tartománya maradjon külön.
      const sessionId = ctx.sessionId?.trim() || randomUUID()
      session = SurrogateSession.load(deps.vault, ctx.tenantId, hermesSessionScope(ctx.userId, sessionId))
      sessions.set(ctx, session)
    }
    return session
  }

  return {
    async filterRequest(ctx, body) {
      const messages = structuredClone(body.messages)
      const slots = collectSlots(messages)
      try {
        const capabilities = await deps.getCapabilities?.(ctx)
        // Without a policy loader retain the original V1 filter contract for standalone callers.
        const level = (category: string) => capabilities
          ? capabilities[`content_filter.${category}` as `content_filter.${PrivacyPolicyCategory}`] ?? 'block'
          : category === 'pan' ? 'block' : ['email', 'person'].includes(category) ? 'tokenize' : 'off'
        const categories = new Set<string>()
        for (const slot of slots) {
          for (const span of collectSensitivityMatchSpans(slot.text)) categories.add(PRIVACY_CATEGORY_ALIASES[span.category] ?? span.category)
          for (const candidate of findCandidates(slot.text)) categories.add(candidate.entityType)
        }
        const blocked = () => [...categories].find((category) => level(category) === 'block'
          // V1 only has reversible email/person aliases; unsupported tokenization must never leak raw values.
          || (level(category) === 'tokenize' && !['email', 'person'].includes(category)))
        const block = (category: string) => ({
          block: category === 'pan' ? PAN_BLOCK_MESSAGE : 'Ezt a kérést nem küldtem el az AI-modellnek: a céges adatvédelmi beállítás tiltja a benne felismert adat továbbítását. Töröld vagy takard ki az érintett adatot, majd próbáld újra.',
          reason: category === 'pan' ? 'pan_detected' : `content_filter_block:${category}`,
        })
        const firstBlocked = blocked()
        if (firstBlocked) return block(firstBlocked)
        const types = new Set(['email', 'person'].filter((category) => level(category) === 'tokenize'))
        // Known names from earlier messages remain governed even when they occur without an email header.
        const session = types.size || level('person') !== 'off' ? await sessionFor(ctx) : null
        if (session && level('person') !== 'off' && slots.some((slot) =>
          findKnownValueMatches(slot.text, session.personReplacements()).some((match) => !findCandidates(slot.text).some((candidate) =>
            candidate.entityType === 'email' && match.start < candidate.end && match.end > candidate.start)))) categories.add('person')
        const knownBlocked = blocked()
        if (knownBlocked) return block(knownBlocked)
        const warned = [...categories].filter((category) => level(category) === 'warn')
        if (warned.length) {
          await writeAudit(deps.audit, {
            actorType: 'human', actorId: ctx.userId, tenantId: ctx.tenantId,
            action: 'client_policy.content_warning', targetType: 'agent', targetId: ctx.agentId,
            policyDecision: 'flagged', metadata: { categories: warned },
          })
        }
        if (session && types.size) await tokenizeSlots(slots, session, types)
      } catch (error) {
        // Fail-closed, és a hibában sem szerepelhet érték (csak az üzenet).
        logger.error({ event: 'model_gateway.tokenize_failed', error: String(error) }, 'Gateway tokenization failed')
        return { block: PRIVACY_UNAVAILABLE_MESSAGE, reason: 'privacy_unavailable' }
      }
      return { body: { ...body, messages } }
    },

    transformResponse: (ctx) => sessions.has(ctx)
      ? createRestoreTransform({ stream: ctx.stream, session: () => sessionFor(ctx) })
      : new TransformStream<Uint8Array, Uint8Array>(),
  }
}
