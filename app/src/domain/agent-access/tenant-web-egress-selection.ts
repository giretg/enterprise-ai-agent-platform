/**
 * Tenant Web-Egress kiválasztási policy (#142).
 *
 * A Web-Egress a tenant saját search connectorát és egress-házirendjét használja.
 * Ezért egy tenant felfedezési útja csak a SAJÁT aktív példányát választhatja ki:
 * egy platform- vagy más tenant példánya nem "jó elég" visszaesés. Ha a saját
 * példány nem állítható elő, a hívónak fail-closed módon le kell állnia.
 */
export type TenantWebEgressCandidate = {
  tenantId: string | null
  status: string
  systemRole: string | null
}

export function selectActiveTenantWebEgress<T extends TenantWebEgressCandidate>(
  tenantId: string | null,
  candidates: readonly T[],
): T | null {
  if (!tenantId) return null
  return (
    candidates.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.status === 'active' &&
        candidate.systemRole === 'web_egress',
    ) ?? null
  )
}
