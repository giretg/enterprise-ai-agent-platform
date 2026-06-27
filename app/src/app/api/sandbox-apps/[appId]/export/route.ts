import { NextResponse } from 'next/server'
import { requireRole } from '@/auth'
import { services } from '@/domain'
import { sandboxAppIdSchema } from '@/lib/validators/actions'

function safeDownloadName(name: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sandbox-report'}.html`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  try {
    const user = await requireRole('viewer')
    const parsed = sandboxAppIdSchema.parse(await params)
    const versionParam = new URL(request.url).searchParams.get('version')
    const versionNumber = versionParam ? parseInt(versionParam, 10) : undefined
    const { app, version } = await services.sandboxApps.getRenderableApp(
      parsed.appId,
      { userId: user.id, tenantId: user.tenantId },
      'sandbox_app.export',
      Number.isFinite(versionNumber) ? versionNumber : undefined,
    )

    return new NextResponse(version.htmlContent, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeDownloadName(app.name)}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Sandbox-App-Hash': version.htmlHash,
      },
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Export failed' },
      { status: 403 },
    )
  }
}
