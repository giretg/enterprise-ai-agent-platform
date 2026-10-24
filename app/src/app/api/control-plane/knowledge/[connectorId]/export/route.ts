import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { WikiConsoleError } from '@/domain/knowledge-base/wiki-console-service'

export const runtime = 'nodejs'

/** #946: a wiki letöltése ZIP-ben (Obsidian-kompatibilis markdown + nyers források szövege). */
export async function GET(_request: Request, context: { params: Promise<{ connectorId: string }> }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { connectorId } = await context.params
    if (!/^[0-9a-f-]{36}$/i.test(connectorId)) return new Response('Nem található.', { status: 404 })
    const { filename, bytes } = await services.wikiConsole.exportZip(
      { userId: ctx.user.id, tenantId: ctx.activeTenantId, role: ctx.activeTenantRole, assumed: ctx.assumed },
      connectorId,
    )
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="wiki.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    // Privát KB-nál a tiltás is „nem található” — nem áruljuk el, hogy létezik.
    if (error instanceof WikiConsoleError && error.code === 'forbidden') {
      return new Response('Nincs jogosultság a letöltéshez.', { status: 403 })
    }
    return new Response('Nem található.', { status: 404 })
  }
}
