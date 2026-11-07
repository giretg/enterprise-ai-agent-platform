import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { attachmentContentDisposition } from '@/lib/content-disposition'
import { featureGuardResponse } from '@/lib/feature-flags'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * #1139: egy tudásbázis-fájl letöltése. Aki a tudásbázist láthatja, a fájlt is letöltheti; minden
 * más esetben „nem található”, így a válasz nem árulja el, hogy a fájl létezik-e.
 */
export async function GET(_request: Request, context: { params: Promise<{ connectorId: string; documentId: string }> }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const denied = await featureGuardResponse('knowledge.file_download', { tenantId: ctx.activeTenantId })
    if (denied) return denied
    const { connectorId, documentId } = await context.params
    if (!UUID_RE.test(connectorId) || !UUID_RE.test(documentId)) return new Response('Nem található.', { status: 404 })
    const file = await services.wikiConsole.downloadFile(
      { userId: ctx.user.id, tenantId: ctx.activeTenantId, role: ctx.activeTenantRole, assumed: ctx.assumed },
      connectorId,
      documentId,
    )
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        // A feltöltött tartalom sosem nyílhat meg a platform oldalaként.
        'Content-Type': file.original ? 'application/octet-stream' : 'text/plain; charset=utf-8',
        'Content-Disposition': attachmentContentDisposition(file.filename),
        'Content-Length': String(file.bytes.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('Nem található.', { status: 404 })
  }
}
