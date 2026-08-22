/**
 * Debug-trace pszeudonimizált projection (APG-21, spec §12).
 *
 * A trusted zónában nyers log marad; a debugging AI felé trace-scoped álnevekkel
 * megy ki a tartalom, hogy a modell követni tudja az eseményláncot anélkül, hogy
 * nyers entitásértéket kapna.
 */
import {
  collectSensitivityMatchSpans,
  redactionMarkerForCategory,
} from '@/domain/gateway/sensitivity-router'
import { applySurrogateReplacements } from '@/domain/privacy/apply-replacements'
import {
  actionForPrivacyCategory,
  canonicalPrivacyCategory,
  categorySupportsTokenize,
  type ResolvedPrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import { findKnownValueMatches } from '@/domain/privacy/known-value-matcher'
import {
  PROMPT_SCANNER_CONNECTOR_ID,
} from '@/domain/privacy/prompt-privacy-transform'
import { runPrivacyTransformLayer } from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { parseSurrogate, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'
import { privacyScopeForTrace } from '@/domain/privacy/privacy-scope'

export type DebugTraceRawBundle = Record<string, unknown> & {
  traceId: string
  agentTurnId: string
  conversationId: string
}

export type DebugTraceToolOutput = {
  traceId: string
  agentTurnId: string
  conversationId: string
  projection: Record<string, unknown>
}

export type DebugTraceProjectionInput = {
  trace: DebugTraceRawBundle
  tenantId: string
  traceId: string
  /** A beszélgetésben már ismert entitások forrása (known-value illesztéshez). */
  knownValueScope?: PrivacyScope | null
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy
  engine: SurrogateEngine
}

type TraceAllocation = {
  entityType: SurrogateEntityType
  /** Stabil vault-azonosító, ha van (ref-sor). `null` → titkosított val-sor. */
  sourceId: string | null
  value: string
}

/**
 * Trace-scoped álnév-allokáció (APG-21).
 *
 * Ha ismerjük az entitás stabil forrásazonosítóját, `ref`-sor születik — ez a
 * connector rekord-azonosítója, nem maga a védendő adat. Ha nem ismerjük (szabad
 * szöveges találat), `val`-sor: a nyers érték titkosítva, `source_id`-ban csak a
 * hash. A trace adatkulcsa a forduló beszélgetéséé, így a beszélgetés törlése a
 * trace-másolatot is visszafejthetetlenné teszi.
 */
async function allocateTraceSurrogates(
  input: {
    tenantId: string
    scope: PrivacyScope
    knownValueScope?: PrivacyScope | null
    engine: SurrogateEngine
  },
  slots: TraceAllocation[],
): Promise<Array<string | undefined>> {
  const keyConversationId =
    input.knownValueScope?.type === 'conversation' ? input.knownValueScope.id : undefined
  const results = new Array<string | undefined>(slots.length)

  const refSlots = slots.flatMap((slot, index) =>
    slot.sourceId ? [{ slot, index, sourceId: slot.sourceId }] : [],
  )
  if (refSlots.length > 0) {
    const refs = await input.engine.allocateRefs(
      refSlots.map(({ slot, sourceId }) => ({
        tenantId: input.tenantId,
        scope: input.scope,
        entityType: slot.entityType,
        connectorId: PROMPT_SCANNER_CONNECTOR_ID,
        sourceId,
        displayValue: slot.value,
        displayValueSource: 'structured_field' as const,
      })),
    )
    refSlots.forEach(({ index }, i) => {
      results[index] = refs[i]
    })
  }

  const valSlots = slots.flatMap((slot, index) => (slot.sourceId ? [] : [{ slot, index }]))
  if (valSlots.length > 0) {
    const vals = await input.engine.allocateVals(
      valSlots.map(({ slot }) => ({
        tenantId: input.tenantId,
        scope: input.scope,
        entityType: slot.entityType,
        plaintext: slot.value,
        keyConversationId,
      })),
    )
    valSlots.forEach(({ index }, i) => {
      results[index] = vals[i]
    })
  }

  return results
}

async function transformDebugTraceText(input: {
  text: string
  tenantId: string
  scope: PrivacyScope
  knownValueScope?: PrivacyScope | null
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy
  engine: SurrogateEngine
}): Promise<string> {
  if (!input.text) return input.text

  // A mintafelismerés az eredeti szövegen fusson le a known-value csere előtt.
  // Különben egy ismert cégnév az e-mail domainjében előbb cserélődne
  // (`ada@SPAR.hu` → `ada@[[COMPANY_1]].hu`), és az e-mail scanner már nem
  // ismerné fel a teljes PII-t.
  let text = await transformDebugTracePatterns(input)
  const knownScope = input.knownValueScope ?? input.scope
  const knownReplacements = input.engine.listKnownValueReplacements(input.tenantId, knownScope)
  if (knownReplacements.length > 0) {
    const matches = findKnownValueMatches(text, knownReplacements)
    if (matches.length > 0) {
      const pending: Array<{ start: number; end: number; entityType: SurrogateEntityType; sourceId: string | null; displayValue: string }> = []
      for (const match of matches) {
        const parsed = parseSurrogate(match.surrogate)
        if (!parsed) continue
        const resolved = await input.engine.peekRef({
          tenantId: input.tenantId,
          scope: knownScope,
          surrogate: match.surrogate,
          requester: { tenantId: input.tenantId, userId: null },
        })
        pending.push({
          start: match.start,
          end: match.end,
          entityType: parsed.entityType,
          // Vault-találat híján NINCS nyers visszaesés: a matchedText a védendő
          // érték maga, kulcsként a `source_id`-ba írva olvashatóan ottmaradna.
          sourceId: resolved.ok ? resolved.record.sourceId : null,
          displayValue: match.matchedText,
        })
      }
      if (pending.length > 0) {
        const surrogates = await runPrivacyTransformLayer({
          layer: 'vault',
          work: async () => allocateTraceSurrogates(input, pending.map((slot) => ({
            entityType: slot.entityType,
            sourceId: slot.sourceId,
            value: slot.displayValue,
          }))),
          onFailOpen: () => [],
        }).then((result) => result.value)
        text = applySurrogateReplacements(
          text,
          pending.flatMap((slot, index) => {
            const surrogate = surrogates[index]
            return surrogate ? [{ start: slot.start, end: slot.end, surrogate }] : []
          }),
        )
      }
    }
  }

  return text
}

async function transformDebugTracePatterns(input: {
  text: string
  tenantId: string
  scope: PrivacyScope
  knownValueScope?: PrivacyScope | null
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy
  engine: SurrogateEngine
}): Promise<string> {
  // A debug-trace a hibakereső (külső) modellhez megy: minden kategória, amit a
  // policy NEM `allow`-ol, védelmet kap. Amelynek van álnév-típusa, azt
  // pszeudonimizáljuk (feloldható a trusted zónában); amelynek nincs
  // (PAN/IBAN/titok/TAJ/adószám), azt visszafordíthatatlanul redaktáljuk. A
  // `block` kategória a legszigorúbb — korábban kimaradt a `tokenize`/`local_only`
  // szűrőből, és a nyers kártyaszám/IBAN/titok nyersen ment ki a modellhez.
  const pending: Array<{ start: number; end: number; entityType: SurrogateEntityType; value: string }> = []
  const redactions: Array<{ start: number; end: number; surrogate: string }> = []
  for (const span of collectSensitivityMatchSpans(input.text)) {
    const category = canonicalPrivacyCategory(span.category)
    const action = actionForPrivacyCategory(input.policy, category)
    // `allow` — az admin kifejezetten engedi a nyers külső egresst ezen a kategórián.
    if (action === 'allow') continue
    // A névtér #320 óta NYITOTT (`isSurrogateEntityType` minden érvényes slugra
    // igaz), ezért az álnév-képesség kérdését a kategória-policy dönti el: a
    // PAN/IBAN/titok/TAJ/adószám kategóriáknak nincs álnév-típusuk, azok
    // redakciót kapnak. A nyitott névtérre váltás óta ezek némán álnevet
    // kaptak — vagyis feloldható surrogate-ként mentek ki a külső hibakereső
    // modellhez, és bekerültek a vaultba.
    if (categorySupportsTokenize(category)) {
      pending.push({
        start: span.start,
        end: span.end,
        entityType: category,
        value: span.value,
      })
    } else {
      // A redakciós címke a NYERS `span.category`-ra kulcsolódik (a policy-döntés
      // a kanonikusra) — a `REDACTION_CATEGORY_LABELS` a `card_broad`/`pan` nyers
      // alakot ismeri, és a kimenő content-guard is így címkéz. A redakció
      // kategória-szintű, nem entitás-szintű: két külön PAN azonos jelölőt kap
      // (nem feloldható, nem is kell — ezek a legszigorúbb, nyersen tiltott adatok).
      redactions.push({
        start: span.start,
        end: span.end,
        surrogate: redactionMarkerForCategory(span.category),
      })
    }
  }

  if (pending.length === 0 && redactions.length === 0) return input.text

  let surrogates: Array<string | undefined> = []
  if (pending.length > 0) {
    surrogates = await runPrivacyTransformLayer({
      layer: 'vault',
      work: async () =>
        allocateTraceSurrogates(
          input,
          pending.map((slot) => ({ entityType: slot.entityType, sourceId: null, value: slot.value })),
        ),
      onFailOpen: () => [],
    }).then((result) => result.value)
  }

  const replacements = [
    ...pending.flatMap((slot, index) => {
      const surrogate = surrogates[index]
      return surrogate ? [{ start: slot.start, end: slot.end, surrogate }] : []
    }),
    ...redactions,
  ]
  return applySurrogateReplacements(input.text, replacements)
}

/**
 * MINDEN string átmegy a transzformáción — mezőnév-heurisztika nélkül.
 *
 * Korábban a nem „szöveges" nevű mezőkben csak a szóközt vagy `@`-ot tartalmazó
 * érték került átvizsgálásra. Egy `{"company":"SPAR"}` alakú mező így nyersen
 * ment ki a hibakereső AI-hoz: a mezőnév nem mond semmit arról, hogy van-e benne
 * védendő adat. Ami nem tartalmaz entitást, azon a scanner úgysem talál semmit.
 */
async function projectDebugTraceValue(
  value: unknown,
  ctx: {
    tenantId: string
    scope: PrivacyScope
    knownValueScope?: PrivacyScope | null
    mode: PrivacyGatewayMode
    policy: ResolvedPrivacyCategoryPolicy
    engine: SurrogateEngine
  },
): Promise<unknown> {
  if (typeof value === 'string') {
    if (!value) return value
    return transformDebugTraceText({
      text: value,
      tenantId: ctx.tenantId,
      scope: ctx.scope,
      knownValueScope: ctx.knownValueScope,
      mode: ctx.mode,
      policy: ctx.policy,
      engine: ctx.engine,
    })
  }

  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      out.push(await projectDebugTraceValue(item, ctx))
    }
    return out
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = await projectDebugTraceValue(child, ctx)
    }
    return out
  }

  return value
}

export async function projectDebugTraceBundle(
  input: DebugTraceProjectionInput,
): Promise<Record<string, unknown>> {
  const scope = privacyScopeForTrace(input.traceId)
  const projected = await projectDebugTraceValue(input.trace, {
    tenantId: input.tenantId,
    scope,
    knownValueScope: input.knownValueScope ?? { type: 'conversation', id: input.trace.conversationId },
    mode: input.mode,
    policy: input.policy,
    engine: input.engine,
  })
  return projected as Record<string, unknown>
}

/** A `get_debug_trace` tool LLM-bound kimenete. */
export async function projectDebugTraceToolOutput(
  input: DebugTraceProjectionInput,
): Promise<DebugTraceToolOutput> {
  const projection = await projectDebugTraceBundle(input)
  const { traceId, agentTurnId, conversationId, ...rest } = projection
  return {
    traceId: String(traceId ?? input.traceId),
    agentTurnId: String(agentTurnId ?? input.trace.agentTurnId),
    conversationId: String(conversationId ?? input.trace.conversationId),
    projection: rest,
  }
}
