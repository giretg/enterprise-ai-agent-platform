/**
 * Megjelenítési feloldás (APG-06, spec §10.2).
 *
 * Web UI: teljes feloldás, vault-találaton + a fordulóban rögzített
 * megjelenítési értéken. Ismeretlen / kitalált álnév változatlanul marad,
 * audit nélkül (az unknown-audit a tool-arg úté, §10.1).
 */
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { findEmbeddedSurrogates, parseSurrogate } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type SurrogateDisplayLookup = (surrogate: string) => Promise<string | null>

export async function resolveDisplayText(
  text: string,
  lookup: SurrogateDisplayLookup,
): Promise<string> {
  if (!text) return text
  const matches = findEmbeddedSurrogates(text)
  if (matches.length === 0) return text

  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start)
    if (match.parsed) {
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
}): SurrogateDisplayLookup {
  return async (surrogate) => {
    if (!parseSurrogate(surrogate)) return null
    const cached = params.engine.peekDisplayValue(params.tenantId, params.scope, surrogate)
    if (cached) return cached
    const peeked = await params.engine.peekRef({
      tenantId: params.tenantId,
      scope: params.scope,
      surrogate,
    })
    if (!peeked.ok) return null
    return params.engine.peekDisplayValue(params.tenantId, params.scope, surrogate) ?? null
  }
}
