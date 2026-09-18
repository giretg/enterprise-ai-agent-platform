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
 *
 * Mini-app / workspace HTML: `contentKind: 'html'` — ugyanaz a szöveg-node
 * szabály, HTML parserrel (script/style/attribútum kimarad). A vaultból jövő
 * megjelenítési értéket HTML-escapelve írjuk be: CRM/név mezőkben lévő
 * `<` / `>` / `&` különben `text/html` válaszban XSS-t nyitna a bejelentkezett
 * platform-origón (sandbox preview, workspace HTML, export).
 */
import { resolvableHtmlTextRanges } from '@/domain/privacy/html-surrogate-context'
import {
  resolvableTextRanges,
  type TextRange,
} from '@/domain/privacy/markdown-surrogate-context'
import {
  allowsEgressResolve,
  type PrivacyEgressSurface,
  type ResolvedPrivacyEgressMatrix,
  resolvePrivacyEgressMatrix,
} from '@/domain/privacy/privacy-egress-matrix'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import {
  containsEmbeddedSurrogate,
  findEmbeddedSurrogates,
  parseSurrogate,
  type SurrogateEntityType,
} from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

export type SurrogateDisplayLookup = (surrogate: string) => Promise<string | null>

export type EgressContentKind = 'markdown' | 'html'

export type EgressResolveAudit = (event: {
  surface: PrivacyEgressSurface
  resolvedCount: number
  categories: string[]
}) => void | Promise<void>

/** Vault / CRM megjelenítési érték → biztonságos HTML szöveg-node tartalom. */
export function escapeHtmlTextContent(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function resolveDisplayText(
  text: string,
  lookup: SurrogateDisplayLookup,
  document?: string,
): Promise<string> {
  return resolveDisplayTextInKind(text, lookup, 'markdown', document)
}

/** Mini-app / workspace HTML megjelenítési feloldás (szöveg-node only). */
export async function resolveHtmlDisplayText(
  html: string,
  lookup: SurrogateDisplayLookup,
): Promise<string> {
  return resolveDisplayTextInKind(html, lookup, 'html')
}

async function resolveDisplayTextInKind(
  text: string,
  lookup: SurrogateDisplayLookup,
  kind: EgressContentKind,
  document?: string,
): Promise<string> {
  if (!text) return text
  const matches = findEmbeddedSurrogates(text)
  if (matches.length === 0) return text

  const source = document ?? text
  const origin = document != null && document.endsWith(text) ? document.length - text.length : 0
  const ranges = rangesForKind(source, kind)

  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start)
    const absStart = origin + match.start
    const absEnd = origin + match.end
    const inTextNode = ranges.some((range) => range.start <= absStart && absEnd <= range.end)
    if (match.parsed && inTextNode) {
      const resolved = await lookup(match.text)
      const value = resolved ?? match.text
      // HTML egress: a megjelenítési érték külső/CRM adat — escape nélkül tagot zárhat.
      out += kind === 'html' ? escapeHtmlTextContent(value) : value
    } else {
      out += match.text
    }
    cursor = match.end
  }
  out += text.slice(cursor)
  return out
}

function rangesForKind(source: string, kind: EgressContentKind): TextRange[] {
  return kind === 'html' ? resolvableHtmlTextRanges(source) : resolvableTextRanges(source)
}

export async function resolveEgressText(
  text: string,
  lookup: SurrogateDisplayLookup,
  opts?: {
    document?: string
    surface?: PrivacyEgressSurface
    onResolved?: EgressResolveAudit
    contentKind?: EgressContentKind
  },
): Promise<string> {
  const resolvedCategories: SurrogateEntityType[] = []
  const auditedLookup: SurrogateDisplayLookup = async (surrogate) => {
    const parsed = parseSurrogate(surrogate)
    const value = await lookup(surrogate)
    if (value != null && parsed) resolvedCategories.push(parsed.entityType)
    return value
  }
  const kind = opts?.contentKind ?? 'markdown'
  const resolved = await resolveDisplayTextInKind(text, auditedLookup, kind, opts?.document)
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
    if (!peeked.ok && (peeked.reason === 'denied' || peeked.reason === 'hmac_invalid')) return null
    // Ref-álnév: vault-találat. Val-álnév (feladatba írt e-mail): nincs ref-sor,
    // a scanner allokációkor perzisztált megjelenítési érték a forrás.
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
  contentKind?: EgressContentKind
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
    contentKind: params.contentKind,
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

/** Ticket-szál / trusted web UI: álnév → megjelenítési érték, ha van vault-találat. */
export async function resolveWebUiTextForViewer(params: {
  text: string
  engine: SurrogateEngine | null | undefined
  tenantId: string | null | undefined
  conversationId?: string | null
  ticketId?: string | null
  requesterUserId?: string | null
}): Promise<string> {
  const text = params.text
  if (!text || !params.engine || !params.tenantId || !params.requesterUserId) return text
  if (!containsEmbeddedSurrogate(text)) return text
  const scope = privacyScopeForCall(params.conversationId, params.ticketId)
  if (!scope) return text
  return resolveEgressTextForSurface({
    text,
    surface: 'web_ui',
    engine: params.engine,
    tenantId: params.tenantId,
    scope,
    requesterUserId: params.requesterUserId,
  })
}
