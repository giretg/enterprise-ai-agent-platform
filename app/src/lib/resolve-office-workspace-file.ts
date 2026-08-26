/**
 * Workspace Office-fájl letöltés: álnév-feloldás a bejelentkezett nézőnek.
 * A tárban a fájl tokenizált marad; csak a kimenő bájtok oldódnak.
 */
import { services } from '@/domain'
import { resolveOfficeFileEgressForViewer } from '@/domain/privacy/resolve-office-egress'

export async function resolveOfficeWorkspaceFile(params: {
  buffer: Buffer
  tenantId: string
  conversationId?: string | null
  ticketId?: string | null
  requesterUserId: string
  surface?: 'web_ui' | 'export_report'
}): Promise<Buffer> {
  return resolveOfficeFileEgressForViewer({
    buffer: params.buffer,
    engine: services.surrogateEngine,
    tenantId: params.tenantId,
    conversationId: params.conversationId,
    ticketId: params.ticketId,
    requesterUserId: params.requesterUserId,
    surface: params.surface ?? 'export_report',
  })
}
