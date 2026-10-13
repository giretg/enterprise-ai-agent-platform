import { NextResponse } from 'next/server'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { AdminPolicyError, classifyTenantTool, toolClassifySchema } from '@/domain/client-policy/admin-policy'
import { clientPolicyAdminStore } from '@/repositories/postgres/client-policy-admin'

export const dynamic = 'force-dynamic'

/** #872: egy besorolatlan eszköz tengelyre sorolása vagy végleges tiltása (tenant-szint). */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const parsed = toolClassifySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  try {
    const policy = await classifyTenantTool(clientPolicyAdminStore, {
      tenantId: auth.user.activeTenantId, userId: auth.user.user.id, role: auth.user.activeTenantRole,
    }, parsed.data)
    return NextResponse.json({ policy })
  } catch (error) {
    if (!(error instanceof AdminPolicyError)) throw error
    return NextResponse.json({ error: error.code }, { status: error.code === 'forbidden' ? 403 : 409 })
  }
}
