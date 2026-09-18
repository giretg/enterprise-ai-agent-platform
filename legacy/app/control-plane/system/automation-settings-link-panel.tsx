import Link from 'next/link'
import { Card } from '@/components/ui/shell'
import type { DispatcherControlsView } from './dispatcher-control-panel'
import type { DispatcherRuntimeView } from '@/lib/dispatcher-runtime'
import { isAgentDispatchOn } from './automation-status'
import type { MonitorControlsView } from './monitor-control-panel'

export function AutomationSettingsLinkPanel({
  dispatcher,
  runtime,
  monitor,
}: {
  dispatcher: DispatcherControlsView
  runtime: DispatcherRuntimeView
  monitor: MonitorControlsView
}) {
  const agentDispatchOn = isAgentDispatchOn(dispatcher, runtime)
  const monitorSweepOn = !monitor.killSwitch

  return (
    <Card title="Automatizmus és költségkontroll">
      <div className="space-y-4">
        <p className="text-xs text-ink-soft">
          Az agent-indítás, a biztonsági háló (Cloud Scheduler), a monitor-söprés és az üresjárat mód
          egy helyen, futásidő-állapottal: a <strong className="text-ink">Rendszer → Üzemeltetés</strong>{' '}
          oldalon. Itt csak pillanatkép — a kapcsolók ott szerkeszthetők.
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-line/40 px-4 py-3">
            <p className="text-xs text-ink-soft">Agent-indítás (dispatcher)</p>
            <p className="mt-1 text-sm font-medium text-ink">
              {agentDispatchOn
                ? 'Aktív — agent indulhat'
                : dispatcher.enabled
                  ? 'Be van kapcsolva, de ez a szerver nem indít'
                  : 'Szüneteltetve'}
            </p>
          </div>
          <div className="rounded-lg border border-line/40 px-4 py-3">
            <p className="text-xs text-ink-soft">Monitor-söprés</p>
            <p className="mt-1 text-sm font-medium text-ink">
              {monitorSweepOn ? 'Engedélyezve (kill-switch ki)' : 'Kill-switch be — nem söpör'}
            </p>
          </div>
        </div>

        <Link
          href="/control-plane/system"
          className="inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Üzemeltetés megnyitása →
        </Link>
      </div>
    </Card>
  )
}
