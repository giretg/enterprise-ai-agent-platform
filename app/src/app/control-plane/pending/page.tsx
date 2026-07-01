import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/auth'
import { Card } from '@/components/ui/shell'

/**
 * GET /me "várj a jóváhagyásra" nézet (Feature-spec IAM-RBAC §7/B, §6).
 * `pending` + `role = NULL` fiók csak ezt látja — admin-jóváhagyásig semmilyen
 * védett végponthoz nem fér (N-IAM-3).
 */
export default async function PendingApprovalPage() {
  const user = await getCurrentUser()

  if (user && user.status === 'active' && user.role) {
    redirect('/control-plane')
  }

  return (
    <div className="mx-auto max-w-xl">
      <Card title="Admin-jóváhagyásra vár">
        <p className="text-sm text-ink-soft">
          {user
            ? `A fiókod (${user.email}) regisztrálva van, de még nincs hozzá szerepkör kiosztva.`
            : 'A fiókod regisztrálva van, de még nincs hozzá szerepkör kiosztva.'}{' '}
          Egy adminisztrátornak jóvá kell hagynia a hozzáférést, mielőtt bármit
          láthatnál a Control Plane-en.
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
