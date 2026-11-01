import { requireTenantRole } from '@/auth/tenant-context'
import { decideExportDownload } from '@/domain/document-export/document-export-store'
import { writeAudit } from '@/lib/audit/types'
import { readPlatformChatSettings } from '@/lib/platform-chat-settings'
import { repositories } from '@/repositories/postgres'
import { PostgresDocumentExportRepository } from '@/repositories/postgres/document-export-repository'

export const runtime = 'nodejs'

const store = new PostgresDocumentExportRepository()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const EXPIRED_PAGE = `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A fájl lejárt</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222">
<h1 style="font-size:1.25rem">A fájl lejárt</h1>
<p>A munkatárs által készített fájlok 7 napig tölthetők le. Kérd meg a munkatársat, hogy készítse el újra.</p>
</body></html>`

/** Fájlnév a fejlécben: ASCII tartalék + UTF-8 (RFC 6266/5987), hogy az ékezet is megmaradjon. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'dokumentum'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/**
 * #1024: a munkatárs által készített fájl letöltése. Csak a kérő (és admin-betekintésnél a tenant
 * admin) töltheti le; más usernek 404. Minden sikeres letöltés auditált.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  let ctx
  try {
    ctx = await requireTenantRole('viewer')
  } catch {
    return new Response('Nem található.', { status: 404 })
  }
  const { id } = await context.params
  const exp = UUID_RE.test(id) ? await store.find(id) : null
  const tenant = exp ? await repositories.tenants.findById(exp.tenantId) : null
  const decision = decideExportDownload(
    exp,
    {
      userId: ctx.user.id,
      activeTenantId: ctx.activeTenantId,
      role: ctx.activeTenantRole,
      adminInsight: readPlatformChatSettings(tenant?.settings).adminInsight,
    },
    new Date(),
  )
  if (!decision.ok) {
    return decision.reason === 'expired'
      ? new Response(EXPIRED_PAGE, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
      : new Response('Nem található.', { status: 404 })
  }
  const data = await store.readData(exp!.id)
  if (!data) return new Response('Nem található.', { status: 404 })
  await writeAudit(repositories.audit, {
    actorType: 'human',
    actorId: ctx.user.id,
    action: 'document_export.downloaded',
    targetType: 'document_export',
    targetId: exp!.id,
    policyDecision: 'allowed',
    metadata: { format: exp!.format, byteSize: exp!.byteSize, agentId: exp!.agentId, asAdmin: decision.asAdmin },
    tenantId: exp!.tenantId,
  })
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': exp!.mimeType,
      'Content-Disposition': contentDisposition(exp!.fileName),
      'Content-Length': String(data.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
