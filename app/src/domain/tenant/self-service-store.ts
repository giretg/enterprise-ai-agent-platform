import type { Tenant, TenantMembership, UserRole, UserStatus } from '@prisma/client'
import type { AuditAppendInput } from '@/lib/audit/types'

/**
 * Self-service cégindítás (#830) tranzakciós tárolója.
 *
 * A cap-számlálás, a slug-választás és az írások (tenant + admin membership +
 * user-aktiválás + audit) EGY tranzakcióban futnak, sorosítva — így két párhuzamos
 * submit nem lépheti át az 5-ös limitet, és nem foghatja ugyanazt a slugot.
 * A Postgres-megvalósítás: `repositories/postgres/self-service-tenant-store.ts`.
 */
export type SelfServiceTenantTx = {
  findUser(userId: string): Promise<{ id: string; status: UserStatus; role: UserRole | null } | null>
  /** A user által self-service indított, NEM archivált cégek száma. */
  countSelfServiceTenants(userId: string): Promise<number>
  slugExists(slug: string): Promise<boolean>
  createTenant(data: {
    slug: string
    displayName: string
    legalName: string | null
    taxId: string | null
    createdById: string
  }): Promise<Tenant>
  /** A user minden más membershipjéről leveszi az `isDefault` jelölést. */
  clearDefaultMemberships(userId: string): Promise<void>
  createAdminMembership(data: { tenantId: string; userId: string }): Promise<TenantMembership>
  activateUser(userId: string, role: UserRole): Promise<void>
  audit(event: AuditAppendInput): Promise<unknown>
}

export type SelfServiceTenantStore = {
  transaction<T>(run: (tx: SelfServiceTenantTx) => Promise<T>): Promise<T>
}
