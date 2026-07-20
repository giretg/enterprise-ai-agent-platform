import { requireTenantRole } from '@/auth/tenant-context'
import type { UserRole } from '@prisma/client'

type TenantApiUser = Awaited<ReturnType<typeof requireTenantRole>>

/**
 * Közös API-auth a tenant-szintű control-plane végpontokhoz:
 * `requireTenantRole` → 401 Response, siker esetén a user.
 */
export async function requireTenantApiUser(
  minimum: UserRole | UserRole[] = 'operator',
): Promise<{ ok: true; user: TenantApiUser } | { ok: false; response: Response }> {
  try {
    const user = await requireTenantRole(minimum)
    return { ok: true, user }
  } catch {
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) }
  }
}
