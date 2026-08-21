/**
 * Workspace HTML megnyitás: álnév-feloldás a bejelentkezett néző számára.
 * Az artifact a tárban tokenizált marad; csak az egress (inline válasz) oldódik.
 */
import { services } from '@/domain'
import { resolveHtmlEgressForViewer } from '@/domain/privacy/resolve-html-egress'
import { containsEmbeddedSurrogate } from '@/domain/privacy/surrogate-format'

export async function resolveInlineWorkspaceHtml(params: {
  html: string
  tenantId: string
  conversationId?: string | null
  ticketId?: string | null
  requesterUserId: string
}): Promise<string> {
  if (!containsEmbeddedSurrogate(params.html)) return params.html
  return resolveHtmlEgressForViewer({
    html: params.html,
    engine: services.surrogateEngine,
    tenantId: params.tenantId,
    conversationId: params.conversationId,
    ticketId: params.ticketId,
    requesterUserId: params.requesterUserId,
    surface: 'web_ui',
  })
}
