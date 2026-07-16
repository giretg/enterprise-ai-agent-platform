import { NextResponse } from 'next/server'
import { services } from '@/domain'
import { harnessCompletionSchema } from '@/lib/validators/actions'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status })
}

function readBearerToken(header: string | null): string | null {
  const [scheme, token] = (header ?? '').split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const expectedToken = process.env.HARNESS_CALLBACK_TOKEN
  if (!expectedToken) return jsonError('Harness callback token is not configured', 503)

  const token = readBearerToken(request.headers.get('authorization'))
  if (!safeSecretEquals(token, expectedToken)) return jsonError('Unauthorized', 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  const parsed = harnessCompletionSchema.safeParse(body)
  if (!parsed.success) return jsonError(parsed.error.message, 400)

  try {
    const { id } = await params
    const result = await services.dispatcher.completeHarnessRun({
      ticketId: id,
      ...parsed.data,
    })
    return NextResponse.json({ success: true, data: result })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Harness completion failed', 500)
  }
}
