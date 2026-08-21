/**
 * Megjelenítési feloldás (APG-06 §10.2, APG-07 §10.3, APG-19 egress-mátrix).
 *
 * Web UI: teljes feloldás a szöveg-node-okban, vault-találaton + a fordulóban
 * rögzített megjelenítési értéken. URL / markdown-link cél / HTML-attribútum /
 * kód: az álnév marad. Ismeretlen álnév változatlan, audit nélkül
 * (az unknown-audit a tool-arg úté, §10.1).
 *
 * Minden egress-útvonal ugyanazt a `resolveEgressText` + `createEgressDisplayLookup`
 * párost használja — a csatorna a mátrix szerint korlátozza az entitástípusokat.
 *
 * `document` a streaminghez: a darab kontextusa a teljes, eddig látott eredeti
 * markdown — a darab önmagában szöveg-node-nak tűnhet, holott egy URL vége.
 */
import { resolvableTextRanges } from '@/domain/privacy/markdown-surrogate-context'
import {
  allowsEgressResolve,
  type PrivacyEgressSurface,
  type ResolvedPrivacyEgressMatrix,
  resolvePrivacyEgressMatrix,
} from '@/domain/privacy/privacy-egress-matrix'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { findEmbeddedSurrogates, parseSurrogate, type SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type SurrogateDisplayLookup = (surrogate: string) => Promise<string | null>

export type EgressResolveAudit = (event: {
  surface: PrivacyEgressSurface
  resolvedCount: number
  categories: string[]
}) => void | Promise<void>

export async function resolveDisplayText(
  text: string,
  lookup: SurrogateDisplayLookup,
  document?: string,
): Promise<string> {
  if (!text) return text
  const matches = findEmbeddedSurrogates(text)
  if (matches.length === 0) return text

  const source = document ?? text
  const origin = document != null && document.endsWith(text) ? document.length - text.length : 0
  const ranges = resolvableTextRanges(source)

  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start)
    const absStart = origin + match.start
    const absEnd = origin + match.end
    const inTextNode = ranges.some((range) => range.start <= absStart && absEnd <= range.end)
    if (match.parsed && inTextNode) {
      const resolved = await lookup(match.text)
      out += resolved ?? match.text
    } else {
      out += match.text
    }
    cursor = match.end
  }
  out += text.slice(cursor)
  return out
}

export async function resolveEgressText(
  text: string,
  lookup: SurrogateDisplayLookup,
  opts?: {
    document?: string
    surface?: PrivacyEgressSurface
    onResolved?: EgressResolveAudit
  },
): Promise<string> {
  const resolvedCategories: SurrogateEntityType[] = []
  const auditedLookup: SurrogateDisplayLookup = async (surrogate) => {
    const parsed = parseSurrogate(surrogate)
    const value = await lookup(surrogate)
    if (value != null && parsed) resolvedCategories.push(parsed.entityType)
    return value
  }
  const resolved = await resolveDisplayText(text, auditedLookup, opts?.document)
  if (opts?.onResolved && opts.surface && resolvedCategories.length > 0) {
    await opts.onResolved({
      surface: opts.surface,
      resolvedCount: resolvedCategories.length,
      categories: [...new Set(resolvedCategories)],
    })
  }
  return resolved
}

export function createEgressDisplayLookup(params: {
  surface: PrivacyEgressSurface
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  requesterUserId?: string | null
  matrix?: ResolvedPrivacyEgressMatrix
}): SurrogateDisplayLookup {
  const matrix = params.matrix ?? resolvePrivacyEgressMatrix()
  return async (surrogate) => {
    const parsed = parseSurrogate(surrogate)
    if (!parsed) return null
    if (!allowsEgressResolve(matrix, params.surface, parsed.entityType)) return null
    const peeked = await params.engine.peekRef({
      tenantId: params.tenantId,
      scope: params.scope,
      surrogate,
      requester: { tenantId: params.tenantId, userId: params.requesterUserId ?? null },
    })
    if (!peeked.ok) return null
    // A megjelenítési érték a vaultból is betöltődik (spec §5 R19): újraindítás vagy
    // másik szerverpéldány után is a valódi nevet látja a felhasználó, nem az álnevet.
    return (await params.engine.resolveDisplayValue(params.tenantId, params.scope, surrogate)) ?? null
  }
}

export function createWebUiDisplayLookup(params: {
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  requesterUserId?: string | null
  matrix?: ResolvedPrivacyEgressMatrix
}): SurrogateDisplayLookup {
  return createEgressDisplayLookup({ ...params, surface: 'web_ui' })
}

type EgressTextParams = {
  text: string
  surface: PrivacyEgressSurface
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  requesterUserId?: string | null
  matrix?: ResolvedPrivacyEgressMatrix
  document?: string
  onResolved?: EgressResolveAudit
}

/** Közös belépési pont minden egress-útvonalhoz (APG-19 DoD). */
export async function resolveEgressTextForSurface(params: EgressTextParams): Promise<string> {
  const matrix = params.matrix ?? resolvePrivacyEgressMatrix()
  const lookup = createEgressDisplayLookup({
    surface: params.surface,
    engine: params.engine,
    tenantId: params.tenantId,
    scope: params.scope,
    requesterUserId: params.requesterUserId,
    matrix,
  })
  return resolveEgressText(params.text, lookup, {
    document: params.document,
    surface: params.surface,
    onResolved: params.onResolved,
  })
}

export async function resolveChannelOutboundText(params: {
  text: string
  engine: SurrogateEngine
  tenantId: string
  conversationId: string
  userId: string
  matrix?: ResolvedPrivacyEgressMatrix
}): Promise<string> {
  return resolveEgressTextForSurface({
    text: params.text,
    surface: 'external_channel',
    engine: params.engine,
    tenantId: params.tenantId,
    scope: { type: 'conversation', id: params.conversationId },
    requesterUserId: params.userId,
    matrix: params.matrix,
  })
}
