import { NextResponse } from 'next/server'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { prisma } from '@/lib/db'
import { AdminPolicyError, adminPolicySaveSchema, adminPolicyTargetSchema, adminPolicyView, saveAdminPolicy } from '@/domain/client-policy/admin-policy'
import type { PolicyRow } from '@/domain/client-policy/resolve-effective-policy'
import { clientPolicyAdminStore, clientPolicyTargetExists } from '@/repositories/postgres/client-policy-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const tenantId = auth.user.activeTenantId
  const query = Object.fromEntries(new URL(request.url).searchParams)
  const tenantRow = await prisma.clientPolicy.findUnique({ where: { tenantId_scope_scopeId: { tenantId, scope: 'tenant', scopeId: tenantId } } })
  const tenantPolicy = adminPolicyView(tenantRow as PolicyRow | null)
  if (Object.keys(query).length) {
    const parsed = adminPolicyTargetSchema.safeParse(query)
    if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
    if (!await clientPolicyTargetExists(prisma, tenantId, parsed.data)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const policy = await prisma.clientPolicy.findUnique({ where: { tenantId_scope_scopeId: { tenantId, ...parsed.data } } })
    return NextResponse.json({ policy: adminPolicyView(policy as PolicyRow | null), tenantPolicy })
  }
  const [memberships, agents, rows] = await Promise.all([
    prisma.tenantMembership.findMany({ where: { tenantId, status: 'active', user: { status: 'active' } }, include: { user: true }, orderBy: { user: { name: 'asc' } } }),
    prisma.agent.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.clientPolicy.findMany({ where: { tenantId } }),
  ])
  const policy = (scope: string, id: string) => adminPolicyView((rows.find((r) => r.scope === scope && r.scopeId === id) ?? null) as PolicyRow | null)
  return NextResponse.json({
    tenantId, tenantPolicy,
    users: memberships.map(({ user }) => ({ id: user.id, name: user.name, email: user.email, policy: policy('user', user.id) })),
    agentPolicies: agents.map((agent) => ({ ...agent, policy: policy('agent', agent.id) })),
  })
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const parsed = adminPolicySaveSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  try {
    const policy = await saveAdminPolicy(clientPolicyAdminStore, {
      tenantId: auth.user.activeTenantId, userId: auth.user.user.id, role: auth.user.activeTenantRole,
    }, parsed.data)
    return NextResponse.json({ policy })
  } catch (error) {
    if (!(error instanceof AdminPolicyError)) throw error
    const status = error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : 409
    return NextResponse.json({ error: error.code, ...(error.code === 'confirmation_required' ? { capabilities: error.capabilities } : {}) }, { status })
  }
}
