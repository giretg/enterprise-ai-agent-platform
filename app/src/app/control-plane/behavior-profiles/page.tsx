import { listBehaviorProfiles } from '@/app/actions/platform'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'

export default async function BehaviorProfilesPage() {
  const ctx = await getAuthContext()
  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')

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

      <Card title="Profilok">
        <ul className="divide-y divide-line/70">
          {profiles.map((profile) => (
            <li key={profile.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium">{profile.name}</span>
              <span className="text-ink-soft">v{profile.currentVersion}</span>
            </li>
          ))}
        </ul>
        {profiles.length === 0 ? (
          <p className="text-sm text-ink-soft">Még nincs viselkedés-profil.</p>
        ) : null}
      </Card>
    </div>
  )
}
