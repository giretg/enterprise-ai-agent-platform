'use client'

import { useRouter } from 'next/navigation'
import { AutomationCostOverview } from './automation-cost-overview'
import { DispatcherControlPanel, type DispatcherControlsView } from './dispatcher-control-panel'
import type { DispatcherRuntimeView } from '@/lib/dispatcher-runtime'
import { WorkerProcessesPanel } from './worker-processes-panel'
import { MonitorControlPanel, type MonitorControlsView } from './monitor-control-panel'
import type { AutomationIdleSnapshot } from '@/domain/platform-settings/platform-settings-service'
import type { WorkerProcessesStatus } from '@/app/actions/platform'

export function AutomationControlSection({
  dispatcher,
  runtime,
  workerStatus,
  monitor,
  idleSnapshot,
  canEdit,
  settingsKey,
}: {
  dispatcher: DispatcherControlsView
  runtime: DispatcherRuntimeView
  workerStatus: WorkerProcessesStatus
  monitor: MonitorControlsView
  idleSnapshot: AutomationIdleSnapshot | null
  canEdit: boolean
  /** Újrarendereli a paneleket, ha a szerverről friss adat érkezik. */
  settingsKey: string
}) {
  const router = useRouter()

  return (
    <div className="space-y-6">
      <AutomationCostOverview
        dispatcher={dispatcher}
        runtime={runtime}
        workerStatus={workerStatus}
        monitor={monitor}
        idleSnapshot={idleSnapshot}
        canEdit={canEdit}
        onApplied={async () => router.refresh()}
      />

      <DispatcherControlPanel
        key={`dispatcher-${settingsKey}`}
        initial={dispatcher}
        runtime={runtime}
        canEdit={canEdit}
      />

      <WorkerProcessesPanel
        key={`worker-${settingsKey}`}
        initial={workerStatus}
        monitor={monitor}
        canEdit={canEdit}
      />

      <MonitorControlPanel
        key={`monitor-${settingsKey}`}
        initial={monitor}
        workerStatus={workerStatus}
        canEdit={canEdit}
      />
    </div>
  )
}
