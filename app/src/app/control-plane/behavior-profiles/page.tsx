import { listBehaviorProfiles } from '@/app/actions/platform'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'
import { BehaviorProfileCatalog } from '@/components/agents/behavior-profile-catalog'

export default async function BehaviorProfilesPage() {
  const user = await getCurrentUser()
  const isAdmin = user ? hasMinimumRole(user.role, 'admin') : false

  if (!isAdmin) {
    return (
      <Card>
        <p className="text-sm text-ink-faint">
          A viselkedés-profilok kezeléséhez admin jogosultság szükséges.
        </p>
      </Card>
    )
  }

  const res = await listBehaviorProfiles()
  const profiles = res.success ? res.data : []

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Megosztott erőforrás</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
          Viselkedés-profilok
        </h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          A céges hangnem, nyelv és formázás újrahasznosítható, verziózott profilként él. Több agent
          is hivatkozhatja; a profil módosítása sosem frissít csendben — a hivatkozó agentek külön,
          auditált befogadással veszik át az új verziót.
        </p>
      </div>

      <BehaviorProfileCatalog profiles={profiles} />
    </div>
  )
}
