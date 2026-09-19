import { redirect } from 'next/navigation'
import { getAuthContext } from '@/auth/context'
import { Card } from '@/components/ui/shell'
import {
  CONTROL_PLANE_PLATFORM_HOME,
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
} from '@/lib/control-plane-entry'

/**
 * GET /me "várj a jóváhagyásra" nézet (Feature-spec IAM-RBAC §7/B, §6).
 * `pending` + `role = NULL` fiók csak ezt látja — admin-jóváhagyásig semmilyen
 * védett végponthoz nem fér (N-IAM-3).
 *
 * Aktív szerep NEM elég a visszairányításhoz: tenant-tagság nélkül a gyökér
 * újra ide küldene (loop → üres képernyő). Csak tenant- vagy platform-kontextus
 * léphet tovább.
 */
export default async function PendingApprovalPage() {
  const ctx = await getAuthContext()
  const user = ctx?.user ?? null

  if (ctx?.kind === 'tenant') {
    redirect(DEFAULT_AGENT_WORKSPACE_FALLBACK)
  }
  if (ctx?.kind === 'platform') {
    redirect(CONTROL_PLANE_PLATFORM_HOME)
  }

  const hasRole = Boolean(user?.status === 'active' && user.role)

  return (
    <div className="mx-auto max-w-xl">
      <Card title={hasRole ? 'Nincs szervezet-tagságod' : 'Admin-jóváhagyásra vár'}>
        <p className="text-sm text-ink-soft">
          {hasRole
            ? `A fiókod (${user?.email}) aktív, de még nincs szervezethez rendelve. Egy adminisztrátornak tenanthoz kell adnia, mielőtt a munkatársakat látnád.`
            : user
              ? `A fiókod (${user.email}) regisztrálva van, de még nincs hozzá szerepkör kiosztva. Egy adminisztrátornak jóvá kell hagynia a hozzáférést, mielőtt bármit láthatnál a Control Plane-en.`
              : 'A fiókod regisztrálva van, de még nincs hozzá szerepkör kiosztva. Egy adminisztrátornak jóvá kell hagynia a hozzáférést, mielőtt bármit láthatnál a Control Plane-en.'}
        </p>
        {user?.status === 'suspended' && (
          <p className="mt-3 text-sm text-coral-deep">A fiókod fel van függesztve.</p>
        )}
        <p className="mt-4 text-xs text-ink-faint">
          Ha úgy gondolod, hogy ez tévedés, keresd meg a rendszergazdát.
        </p>
      </Card>
    </div>
  )
}
