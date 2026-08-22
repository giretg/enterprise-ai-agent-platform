/**
 * Felhasználó felé menő HTML (mini-app preview/export, workspace inline)
 * megjelenítési feloldása — ugyanaz a vault + egress-mátrix, mint a chatben.
 */
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import {
  resolveEgressTextForSurface,
  type EgressResolveAudit,
} from '@/domain/privacy/resolve-display-text'
import type { ResolvedPrivacyEgressMatrix } from '@/domain/privacy/privacy-egress-matrix'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { containsEmbeddedSurrogate } from '@/domain/privacy/surrogate-format'

export async function resolveHtmlEgressForViewer(params: {
  html: string
  engine: SurrogateEngine | null | undefined
  tenantId: string | null | undefined
  conversationId?: string | null
  ticketId?: string | null
  requesterUserId?: string | null
  /** Preview / UI megnyitás: web_ui; letöltés: export_report. */
  surface: 'web_ui' | 'export_report'
  matrix?: ResolvedPrivacyEgressMatrix
  onResolved?: EgressResolveAudit
}): Promise<string> {
  const html = params.html
  if (!html || !params.engine || !params.tenantId || !params.requesterUserId) return html
  if (!containsEmbeddedSurrogate(html)) return html

  const scope = privacyScopeForCall(params.conversationId, params.ticketId)
  if (!scope) return html

  return resolveEgressTextForSurface({
    text: html,
    surface: params.surface,
    engine: params.engine,
    tenantId: params.tenantId,
    scope,
    requesterUserId: params.requesterUserId,
    matrix: params.matrix,
    contentKind: 'html',
    onResolved: params.onResolved,
  })
}
