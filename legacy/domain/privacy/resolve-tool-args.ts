/**
 * Tool-argumentum feloldás (APG-05, spec §10.1).
 *
 * Az LLM álnevet ad vissza a tool-hívásban (`company="[[COMPANY_1]]"`,
 * `to="[[EMAIL_1]]"`). Ref-álnévnél a `sourceId`, val-álnévnél (szabad
 * szöveges e-mail/telefon) a plaintext megy a connector argumentumba, soha
 * a modell contextjébe. A feloldás kizárólag vault-találaton múlik:
 * kitalált álnév `privacy.surrogate.unknown`.
 *
 * Csak a teljes string-érték számít álnévnek (`parseSurrogate`); részstring
 * M1-ben szándékosan érintetlen — KIVÉVE a `path` kulcs: fájlnévbe ágyazott
 * álnév (`riport-[[COMPANY_1]].html`) sem feloldva, sem nyersen nem jó (a
 * chat-ben megjelenített név sosem egyezne a valódi fájllal), ezért a hívás
 * tippel elutasítva: legyen semleges a fájlnév.
 */
import { addSpanCategory, mergePrivacySpanCategories } from '@/domain/privacy/privacy-mode'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import {
  containsEmbeddedSurrogate,
  parseSurrogate,
  type SurrogateEntityType,
} from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type SurrogateResolveFailure = 'unknown' | 'hmac_invalid' | 'denied' | 'embedded_in_path'

export class UnknownSurrogateError extends Error {
  readonly surrogate: string
  readonly reason: SurrogateResolveFailure

  constructor(surrogate: string, reason: SurrogateResolveFailure = 'unknown') {
    super(
      reason === 'denied'
        ? `Az álnév ebben a beszélgetésben nem oldható fel: ${surrogate}.`
        : reason === 'embedded_in_path'
          ? `Fájlnévbe/útvonalba nem ágyazható álnév: ${surrogate}. Adj semleges fájlnevet (pl. targyalasi-felkeszito-2026-09-15.html); az álnév a tartalomban maradhat.`
          : `Ismeretlen álnév: ${surrogate}. Csak a feladatban vagy tool-válaszban kapott álnevet használd; kitalált álnév nem oldható fel.`,
    )
    this.name = 'UnknownSurrogateError'
    this.surrogate = surrogate
    this.reason = reason
  }
}

export type ResolveToolArgsInput = {
  args: unknown
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  requesterUserId?: string | null
}

export type ResolveToolArgsResult =
  | {
      ok: true
      args: unknown
      resolvedCount: number
      byCategory: Partial<Record<SurrogateEntityType, number>>
    }
  | { ok: false; surrogate: string; reason: SurrogateResolveFailure }

export async function resolveToolArgs(input: ResolveToolArgsInput): Promise<ResolveToolArgsResult> {
  let copy: unknown
  try {
    copy = structuredClone(input.args)
  } catch {
    return { ok: true, args: input.args, resolvedCount: 0, byCategory: {} }
  }

  const walked = await walk(copy, input)
  if (!walked.ok) return walked
  return {
    ok: true,
    args: copy,
    resolvedCount: walked.resolvedCount,
    byCategory: walked.byCategory,
  }
}

type WalkOk = {
  ok: true
  resolvedCount: number
  byCategory: Partial<Record<SurrogateEntityType, number>>
}

async function walk(
  value: unknown,
  ctx: ResolveToolArgsInput,
): Promise<WalkOk | Extract<ResolveToolArgsResult, { ok: false }>> {
  if (!value || typeof value !== 'object') return { ok: true, resolvedCount: 0, byCategory: {} }

  if (Array.isArray(value)) {
    let resolvedCount = 0
    let byCategory: Partial<Record<SurrogateEntityType, number>> = {}
    for (let i = 0; i < value.length; i += 1) {
      const child = value[i]
      if (typeof child === 'string') {
        const replaced = await replaceIfSurrogate(child, ctx)
        if (!replaced.ok) return replaced
        if (replaced.changed) {
          value[i] = replaced.value
          resolvedCount += 1
          byCategory = addSpanCategory(byCategory, replaced.entityType)
        }
        continue
      }
      const nested = await walk(child, ctx)
      if (!nested.ok) return nested
      resolvedCount += nested.resolvedCount
      byCategory = mergePrivacySpanCategories(byCategory, nested.byCategory)
    }
    return { ok: true, resolvedCount, byCategory }
  }

  const record = value as Record<string, unknown>
  let resolvedCount = 0
  let byCategory: Partial<Record<SurrogateEntityType, number>> = {}
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      if (key === 'path' && !parseSurrogate(child) && containsEmbeddedSurrogate(child)) {
        return { ok: false, surrogate: child.match(/\[\[[^\]]+\]\]/)?.[0] ?? child, reason: 'embedded_in_path' }
      }
      const replaced = await replaceIfSurrogate(child, ctx)
      if (!replaced.ok) return replaced
      if (replaced.changed) {
        record[key] = replaced.value
        resolvedCount += 1
        byCategory = addSpanCategory(byCategory, replaced.entityType)
      }
      continue
    }
    const nested = await walk(child, ctx)
    if (!nested.ok) return nested
    resolvedCount += nested.resolvedCount
    byCategory = mergePrivacySpanCategories(byCategory, nested.byCategory)
  }
  return { ok: true, resolvedCount, byCategory }
}

async function replaceIfSurrogate(
  value: string,
  ctx: ResolveToolArgsInput,
): Promise<
  | { ok: true; changed: false }
  | { ok: true; changed: true; value: string; entityType: SurrogateEntityType }
  | Extract<ResolveToolArgsResult, { ok: false }>
> {
  const parsed = parseSurrogate(value)
  if (!parsed) return { ok: true, changed: false }
  const requester = { tenantId: ctx.tenantId, userId: ctx.requesterUserId ?? null }
  const lookup = {
    tenantId: ctx.tenantId,
    scope: ctx.scope,
    surrogate: value,
    requester,
  }
  const ref = await ctx.engine.peekRef(lookup)
  if (ref.ok) return { ok: true, changed: true, value: ref.record.sourceId, entityType: parsed.entityType }
  if (ref.reason === 'denied' || ref.reason === 'hmac_invalid') {
    return { ok: false, surrogate: value, reason: ref.reason }
  }

  const val = await ctx.engine.resolveVal(lookup)
  if (val.ok) return { ok: true, changed: true, value: val.value, entityType: parsed.entityType }
  if (val.reason === 'denied' || val.reason === 'hmac_invalid') {
    return { ok: false, surrogate: value, reason: val.reason }
  }
  return { ok: false, surrogate: value, reason: 'unknown' }
}
