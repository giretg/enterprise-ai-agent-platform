/**
 * Megjelenítési feloldás (APG-06 §10.2, APG-07 §10.3).
 *
 * Web UI: teljes feloldás a szöveg-node-okban, vault-találaton + a fordulóban
 * rögzített megjelenítési értéken. URL / markdown-link cél / HTML-attribútum /
 * kód: az álnév marad. Ismeretlen álnév változatlan, audit nélkül
 * (az unknown-audit a tool-arg úté, §10.1).
 *
 * `document` a streaminghez: a darab kontextusa a teljes, eddig látott eredeti
 * markdown — a darab önmagában szöveg-node-nak tűnhet, holott egy URL vége.
 */
import { resolvableTextRanges } from '@/domain/privacy/markdown-surrogate-context'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { findEmbeddedSurrogates, parseSurrogate } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type SurrogateDisplayLookup = (surrogate: string) => Promise<string | null>

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

export function createWebUiDisplayLookup(params: {
  engine: SurrogateEngine
  tenantId: string
  scope: PrivacyScope
  requesterUserId?: string | null
}): SurrogateDisplayLookup {
  return async (surrogate) => {
    if (!parseSurrogate(surrogate)) return null
    const peeked = await params.engine.peekRef({
      tenantId: params.tenantId,
      scope: params.scope,
      surrogate,
      requester: { tenantId: params.tenantId, userId: params.requesterUserId ?? null },
    })
    if (!peeked.ok) return null
    return params.engine.peekDisplayValue(params.tenantId, params.scope, surrogate) ?? null
  }
}
