/**
 * Tool-argumentum feloldás (APG-05, spec §10.1).
 *
 * Az LLM álnevet ad vissza a tool-hívásban (`company="[[COMPANY_1]]"`). A
 * feloldott nyers érték — ref-surrogate-nál a `sourceId` — csak a connector
 * felé menő argumentumba kerül, soha a modell contextjébe. A feloldás
 * kizárólag vault-találaton múlik: kitalált álnév `privacy.surrogate.unknown`.
 *
 * Csak a teljes string-érték számít álnévnek (`parseSurrogate`); részstring
 * (pl. path-ba ágyazott álnév) M1-ben szándékosan érintetlen.
 */
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { parseSurrogate } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export class UnknownSurrogateError extends Error {
  readonly surrogate: string
  readonly reason: 'unknown' | 'hmac_invalid'

  constructor(surrogate: string, reason: 'unknown' | 'hmac_invalid' = 'unknown') {
    super(
      `Ismeretlen álnév: ${surrogate}. Csak a tool-válaszban kapott álnevet használd; kitalált álnév nem oldható fel.`,
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
}

export type ResolveToolArgsResult =
  | { ok: true; args: unknown; resolvedCount: number }
  | { ok: false; surrogate: string; reason: 'unknown' | 'hmac_invalid' }

export async function resolveToolArgs(input: ResolveToolArgsInput): Promise<ResolveToolArgsResult> {
  let copy: unknown
  try {
    copy = structuredClone(input.args)
  } catch {
    return { ok: true, args: input.args, resolvedCount: 0 }
  }

  const walked = await walk(copy, input)
  if (!walked.ok) return walked
  return { ok: true, args: copy, resolvedCount: walked.resolvedCount }
}

type WalkOk = { ok: true; resolvedCount: number }

async function walk(
  value: unknown,
  ctx: ResolveToolArgsInput,
): Promise<WalkOk | Extract<ResolveToolArgsResult, { ok: false }>> {
  if (!value || typeof value !== 'object') return { ok: true, resolvedCount: 0 }

  if (Array.isArray(value)) {
    let resolvedCount = 0
    for (let i = 0; i < value.length; i += 1) {
      const child = value[i]
      if (typeof child === 'string') {
        const replaced = await replaceIfSurrogate(child, ctx)
        if (!replaced.ok) return replaced
        if (replaced.changed) {
          value[i] = replaced.value
          resolvedCount += 1
        }
        continue
      }
      const nested = await walk(child, ctx)
      if (!nested.ok) return nested
      resolvedCount += nested.resolvedCount
    }
    return { ok: true, resolvedCount }
  }

  const record = value as Record<string, unknown>
  let resolvedCount = 0
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      const replaced = await replaceIfSurrogate(child, ctx)
      if (!replaced.ok) return replaced
      if (replaced.changed) {
        record[key] = replaced.value
        resolvedCount += 1
      }
      continue
    }
    const nested = await walk(child, ctx)
    if (!nested.ok) return nested
    resolvedCount += nested.resolvedCount
  }
  return { ok: true, resolvedCount }
}

async function replaceIfSurrogate(
  value: string,
  ctx: ResolveToolArgsInput,
): Promise<
  | { ok: true; changed: false }
  | { ok: true; changed: true; value: string }
  | Extract<ResolveToolArgsResult, { ok: false }>
> {
  if (!parseSurrogate(value)) return { ok: true, changed: false }
  const resolved = await ctx.engine.resolveRef({
    tenantId: ctx.tenantId,
    scope: ctx.scope,
    surrogate: value,
  })
  if (!resolved.ok) return { ok: false, surrogate: value, reason: resolved.reason }
  return { ok: true, changed: true, value: resolved.record.sourceId }
}
