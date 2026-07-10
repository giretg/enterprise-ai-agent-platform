'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { Card } from '@/components/ui/shell'
import { resumeAutomationMode, setMinimalCostMode } from '@/app/actions/platform'
import type { AutomationIdleSnapshot } from '@/domain/platform-settings/platform-settings-service'
import type { DispatcherControlsView } from './dispatcher-control-panel'
import type { DispatcherRuntimeView } from '@/lib/dispatcher-runtime'
import { isAgentDispatchOn, isSafetyNetAutoOn } from './automation-status'
import type { MonitorControlsView } from './monitor-control-panel'
import type { WorkerProcessesStatus } from '@/app/actions/platform'

type RowStatus = 'on' | 'off' | 'partial' | 'unknown'

const STATUS_STYLE: Record<RowStatus, { dot: string; label: string }> = {
  on: { dot: 'bg-emerald-400', label: 'Fut / bekapcsolva' },
  off: { dot: 'bg-slate-400', label: 'Ki / szünetel' },
  partial: { dot: 'bg-amber-400', label: 'Részben aktív' },
  unknown: { dot: 'bg-amber-400', label: 'Nem ellenőrizhető' },
}

function StatusRow({
  title,
  detail,
  cost,
  status,
}: {
  title: string
  detail: string
  cost: string
  status: RowStatus
}) {
  const style = STATUS_STYLE[status]
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line/40 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="text-xs text-ink-soft">{detail}</p>
          <p className="mt-1 text-xs text-ink-soft">
            <span className="font-medium text-ink">Költség:</span> {cost}
          </p>
        </div>
      </div>
      <span className="shrink-0 text-xs text-ink-soft">{style.label}</span>
    </div>
  )
}

function FeedbackBanner({
  tone,
  children,
}: {
  tone: 'ok' | 'err' | 'info'
  children: ReactNode
}) {
  const cls =
    tone === 'ok'
      ? 'border-line bg-panel'
      : tone === 'err'
        ? 'border-red-500/50 bg-red-500/10'
        : 'border-line bg-surface/60'
  return (
    <p className={`rounded-lg border px-3 py-2 text-sm text-ink ${cls}`}>{children}</p>
  )
}

export function AutomationCostOverview({
  dispatcher,
  runtime,
  workerStatus,
  monitor,
  idleSnapshot,
  canEdit,
  onApplied,
}: {
  dispatcher: DispatcherControlsView
  runtime: DispatcherRuntimeView
  workerStatus: WorkerProcessesStatus
  monitor: MonitorControlsView
  idleSnapshot: AutomationIdleSnapshot | null
  canEdit: boolean
  onApplied?: () => void | Promise<void>
}) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const agentDispatchOn = isAgentDispatchOn(dispatcher, runtime)

  const scheduler = workerStatus.scheduler
  const local = workerStatus.local
  const schedulerOn =
    scheduler.available && scheduler.state === 'ENABLED'
  const schedulerUnknown = !scheduler.available
  const schedulerPaused = scheduler.available && scheduler.state === 'PAUSED'
  const localWorkerOn = local.available && local.running

  const safetyNetAutoOn = isSafetyNetAutoOn(scheduler, local)
  const safetyNetStatus: RowStatus = schedulerUnknown
    ? localWorkerOn
      ? 'partial'
      : 'unknown'
    : safetyNetAutoOn
      ? 'on'
      : 'off'

  const monitorEnabled = !monitor.killSwitch
  const monitorEffectiveOn = monitorEnabled && safetyNetAutoOn
  const monitorStatus: RowStatus = !monitorEnabled
    ? 'off'
    : monitorEffectiveOn
      ? 'on'
      : 'partial'

  const neonWakeRisk: RowStatus =
    localWorkerOn || schedulerOn ? 'on' : schedulerUnknown ? 'unknown' : 'off'

  const idleModeActive = idleSnapshot !== null

  const looksLikeIdle =
    !agentDispatchOn &&
    !monitorEnabled &&
    !safetyNetAutoOn &&
    !localWorkerOn

  const showResume = idleModeActive || looksLikeIdle

  function runAction(
    action: () => Promise<{ success: true; data: { warnings: string[] } } | { success: false; error: string }>,
    okPrefix: string,
  ) {
    setMessage(null)
    startTransition(async () => {
      const res = await action()
      if (res.success) {
        const notes = res.data.warnings.length > 0 ? ` ${res.data.warnings.join('; ')}` : ''
        setMessage({ tone: 'ok', text: `${okPrefix}${notes}` })
        await onApplied?.()
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <Card title="Költségkontroll — mi fut most?">
      <div className="space-y-4">
        <p className="text-xs text-ink-soft">
          Ez az összefoglaló azt mutatja, <strong className="text-ink">mi terhelheti a Cloud Run-t, az LLM-et és a Neon
          adatbázist</strong>. A panelek alatt részletesen állíthatod. A ticketek többsége keletkezéskor
          azonnal indul — a dispatcher kapcsoló csak az <em>agent</em>-indítást állítja meg, a biztonsági
          háló kör viszont továbbra is futhat (és ébreszti az adatbázist), amíg a Scheduler vagy a lokális
          worker aktív.
        </p>

        <div className="space-y-2">
          <StatusRow
            title="Agent-indítás (dispatcher)"
            detail={
              agentDispatchOn
                ? 'Ready ticketeknél agent indul — LLM-token és esetleg Cloud Run Job.'
                : dispatcher.enabled && !agentDispatchOn
                  ? 'A főkapcsoló be van kapcsolva, de ez a szerver futtató-környezete tiltva van.'
                  : 'Nincs automatikus agent-indítás. A ticketek a boardon maradnak.'
            }
            cost={
              agentDispatchOn
                ? 'Magas — futásidő + modellhívások.'
                : 'Alacsony — csak a ticket tárolás.'
            }
            status={agentDispatchOn ? 'on' : dispatcher.enabled ? 'partial' : 'off'}
          />

          <StatusRow
            title="Biztonsági háló (automatikus kör)"
            detail={
              schedulerUnknown
                ? `A Cloud Scheduler állapota nem lekérdezhető innen${scheduler.error ? `: ${scheduler.error}` : ''}. A GCP-ben a job ettől még futhat — ellenőrizd a konzolon, vagy szüneteltesd ott is.`
                : localWorkerOn
                  ? 'Lokális worker fut — folyamatos adatbázis-kapcsolat (Neon nem alszik).'
                  : schedulerOn
                    ? `Cloud Scheduler aktív${scheduler.schedule ? ` (${scheduler.schedule})` : ''} — N percenként felébreszti a webappot és lefuttat egy kört.`
                    : schedulerPaused
                      ? 'Cloud Scheduler szünetel — automatikus kör nem indul.'
                      : 'Nincs automatikus kör (Scheduler ki, lokális worker sem fut).'
            }
            cost={
              localWorkerOn
                ? 'Magas — állandó DB-kapcsolat.'
                : schedulerOn
                  ? 'Közepes — rövid ébredések + DB-lekérdezések üresjáratban is.'
                  : schedulerUnknown
                    ? 'Ismeretlen — ha a Scheduler fut a háttérben, üresjáratban is ébreszt.'
                    : 'Alacsony — nincs ütemezett ébresztés.'
            }
            status={safetyNetStatus}
          />

          <StatusRow
            title="Monitor-söprés (proaktív figyelés)"
            detail={
              !monitorEnabled
                ? 'Kill-switch be — nem gyűjt jeleket, nem nyit magától ticketet.'
                : !safetyNetAutoOn
                  ? 'Engedélyezve a panelen, de a biztonsági háló nem fut automatikusan — így most nem söpör.'
                  : 'A biztonsági háló körében fut; esedékes monitorok jeleket gyűjtenek, küszöbön túl ticketet nyithatnak.'
            }
            cost={
              monitorEffectiveOn
                ? 'Közepes — DB-lekérdezések; eszkaláció esetén további agent-költség.'
                : 'Alacsony — jelenleg nem söpör.'
            }
            status={monitorStatus}
          />

          <StatusRow
            title="Neon compute ébresztés"
            detail={
              localWorkerOn
                ? 'A lokális worker nyitva tartja a kapcsolatot.'
                : schedulerOn
                  ? 'A Scheduler periodikusan felébreszti az appot (és így az adatbázist is).'
                  : schedulerUnknown
                    ? 'Nem látszik innen — ha Scheduler vagy worker fut, a Neon ébredhet.'
                    : 'Nincs ismert automatikus ébresztő.'
            }
            cost={
              localWorkerOn ? 'Magas' : schedulerOn ? 'Közepes (ütem szerint)' : 'Alacsony'
            }
            status={neonWakeRisk}
          />
        </div>

        {showResume ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Üresjárat mód aktív</p>
              <p className="mt-1 text-sm text-ink-soft">
                Agent-indítás, monitor-söprés és Scheduler (ha elérhető volt) ki van kapcsolva. A Neon csak
                felület/API-használatkor ébred.
                {idleSnapshot
                  ? ` Mentve: ${new Date(idleSnapshot.savedAt).toLocaleString('hu-HU')}.`
                  : ' (Nincs mentett pillanatkép — a visszaállítás az alapértelmezett normál módot kapcsolja be.)'}
              </p>
            </div>
            <button
              type="button"
              disabled={!canEdit || pending}
              onClick={() => runAction(resumeAutomationMode, 'Normál mód visszaállítva.')}
              className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Normál mód vissza
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface/60 px-4 py-3">
            <p className="min-w-0 text-sm text-ink">
              Teszteléshez / üresjárathoz: egy gombnyomásra leállítja az agent-indítást, szünetelteti a
              Cloud Schedulert (ha elérhető), és bekapcsolja a monitor kill-switch-et. A korábbi
              állapotot elmenti — később visszaállítható.
            </p>
            <button
              type="button"
              disabled={!canEdit || pending}
              onClick={() => runAction(setMinimalCostMode, 'Üresjárat mód bekapcsolva.')}
              className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-40"
            >
              Üresjárat mód
            </button>
          </div>
        )}

        {message ? <FeedbackBanner tone={message.tone}>{message.text}</FeedbackBanner> : null}

        {!canEdit ? (
          <p className="text-xs text-ink-soft">A módosításhoz superadmin jogosultság kell.</p>
        ) : null}
      </div>
    </Card>
  )
}
