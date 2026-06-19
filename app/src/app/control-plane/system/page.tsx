import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { getDatabaseMode, getDispatcherControls } from '@/app/actions/platform'
import { DatabaseControlPanel } from './database-control-panel'
import { DispatcherControlPanel } from './dispatcher-control-panel'

export default async function SystemPage() {
  const [user, controlsRes, dbModeRes] = await Promise.all([
    getCurrentUser(),
    getDispatcherControls(),
    getDatabaseMode(),
  ])
  const canEdit = user ? hasMinimumRole(user.role, 'admin') : false

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Rendszer</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Üzemeltetés</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          A háttérben futó automatizmusok és az adatbázis-környezet vezérlése. A dispatcher
          folyamatosan figyeli a ticketeket — itt állítható le, szabályozható, vagy teszt adatbázisra
          váltható.
        </p>
      </div>

      {!dbModeRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {dbModeRes.error}
        </div>
      ) : (
        <DatabaseControlPanel initial={dbModeRes.data} canEdit={canEdit} />
      )}

      {!controlsRes.success ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {controlsRes.error}
        </div>
      ) : (
        <DispatcherControlPanel initial={controlsRes.data} canEdit={canEdit} />
      )}
    </div>
  )
}
