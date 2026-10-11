import { NextResponse } from 'next/server'
import { z } from 'zod'
import { machineFloorDeps } from '@/auth/machine-floor-deps'
import { buildManagedInstallerScript, MANAGED_INSTALLER_FILENAME } from '@/domain/client-policy/hermes-installer'
import { issueMachineFloor, MACHINE_PLATFORMS, modelGatewayBaseUrl } from '@/domain/client-policy/machine-floor'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { writeAudit } from '@/lib/audit/types'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  userId: z.string().uuid(),
  platform: z.enum(MACHINE_PLATFORMS).default('posix'),
  format: z.enum(['json', 'installer']).optional(),
})

/**
 * #771: admin letölti egy munkatárs gép-padlóját.
 * `format=installer`: egyfájlos Mac/Linux telepítő (padló + Guard), futtatás: sudo bash excellence-telepito.sh.
 * Windowson a JSON csomag kell (`platform=windows`), azt az install-managed.ps1 teszi fel.
 * A kiadás auditált.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const { user } = auth

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const membership = await repositories.tenantMemberships.findByTenantAndUser(user.activeTenantId, parsed.data.userId)
  if (!membership || membership.status !== 'active') {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 })
  }

  if (parsed.data.format === 'installer' && parsed.data.platform !== 'posix') {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const gatewayBaseUrl = modelGatewayBaseUrl(resolvePublicAppOrigin(request))
  const pkg = await issueMachineFloor(machineFloorDeps(), {
    tenantId: user.activeTenantId,
    userId: parsed.data.userId,
    gatewayBaseUrl,
    platform: parsed.data.platform,
  })

  await writeAudit(repositories.audit, {
    actorType: 'human',
    actorId: user.user.id,
    action: 'client_policy.machine_floor.export',
    targetType: 'user',
    targetId: parsed.data.userId,
    policyDecision: 'allowed',
    metadata: {
      installId: pkg.installId,
      platform: pkg.platform,
      managedDirHash: pkg.managedDirHash,
      disabledToolsets: pkg.disabledToolsets,
      agentCount: pkg.agentIds.length,
      format: parsed.data.format ?? 'json',
    },
    tenantId: user.activeTenantId,
  })

  if (parsed.data.format === 'installer') {
    return new Response(buildManagedInstallerScript(pkg), {
      headers: {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Content-Disposition': `attachment; filename="${MANAGED_INSTALLER_FILENAME}"`,
      },
    })
  }

  return NextResponse.json(pkg)
}
