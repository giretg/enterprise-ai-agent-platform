import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { getDispatcherControls } from '@/app/actions/platform'
import { DispatcherControlPanel } from './dispatcher-control-panel'

export default async function SystemPage() {
  const [user, controlsRes] = await Promise.all([getCurrentUser(), getDispatcherControls()])
  const canEdit = user ? hasMinimumRole(user.role, 'admin') : false

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Rendszer</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Üzemeltetés</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          A háttérben futó automatizmusok vezérlése. A dispatcher folyamatosan figyeli a ticketeket
          és automatikusan elindítja az agenteket — itt állítható le vagy szabályozható.
        </p>
      </div>

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
