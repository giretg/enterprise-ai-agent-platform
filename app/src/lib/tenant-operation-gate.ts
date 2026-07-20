import type { TenantStatus } from '@prisma/client'
import { tenantStatusAllowsOperations } from '@/lib/tenant-policy'

/**
 * Tenant-státusz kapu az automata / agent API úton
 * (Feature-spec Tenant-Management §7.3 / §12).
 *
 * A kapu a MUNKA tulajdonosára kulcsol (`ticket.tenantId ?? agent.tenantId`).
 * Platform-munka (`null`) → engedélyezett. Ha van tulajdonos-tenant, de a
 * tenant-repo nincs bekötve → tiltás (fail-closed).
 */

export type TenantStatusLookup = {
  findById(id: string): Promise<{ status: TenantStatus } | null>
}

export function resolveWorkOwnerTenantId(
  ticketTenantId: string | null | undefined,
  agentTenantId: string | null | undefined,
): string | null {
  return ticketTenantId ?? agentTenantId ?? null
}

export type TenantOperationGateResult =
  | { allowed: true }
  | { allowed: false; tenantId: string; tenantStatus: string }

export async function evaluateTenantOperationGate(params: {
  tenants: TenantStatusLookup | null | undefined
  gateTenantId: string | null
}): Promise<TenantOperationGateResult> {
  const { tenants, gateTenantId } = params
  if (!gateTenantId) return { allowed: true }
  if (!tenants) {
    return { allowed: false, tenantId: gateTenantId, tenantStatus: 'repo_missing' }
  }
  const tenant = await tenants.findById(gateTenantId)
  if (!tenant || !tenantStatusAllowsOperations(tenant.status)) {
    return {
      allowed: false,
      tenantId: gateTenantId,
      tenantStatus: tenant?.status ?? 'missing',
    }
  }
  return { allowed: true }
}
