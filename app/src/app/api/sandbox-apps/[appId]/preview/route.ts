import { NextResponse } from 'next/server'
import { requireRole } from '@/auth'
import { services } from '@/domain'
import { sandboxAppIdSchema } from '@/lib/validators/actions'

const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  try {
    const user = await requireRole('viewer')
    const parsed = sandboxAppIdSchema.parse(await params)
    const { version } = await services.sandboxApps.getRenderableApp(parsed.appId, {
      userId: user.id,
      tenantId: user.tenantId,
    }, 'sandbox_app.preview')

    return new NextResponse(version.htmlContent, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': HTML_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Preview failed' },
      { status: 403 },
    )
  }
}
