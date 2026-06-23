import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { listAgents } from '@/app/actions/platform'
import { MonitorEditorForm } from '@/components/monitors/monitor-editor-form'
import { redirect } from 'next/navigation'

export default async function NewMonitorPage() {
  const user = await getCurrentUser()
  if (!user || !hasMinimumRole(user.role, 'admin')) {
    redirect('/control-plane/monitors')
  }

  const agentsRes = await listAgents()
  const agents = agentsRes.success
    ? agentsRes.data.map((a) => ({ id: a.id, name: a.name }))
    : []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Monitorok</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Új monitor</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Meghatározza, mit figyel a söprés-motor, milyen küszöbbel, milyen frekvenciával, és
          mit tesz találatkor.
        </p>
      </div>

      <div className="max-w-3xl">
        <MonitorEditorForm agents={agents} />
      </div>
    </div>
  )
}
