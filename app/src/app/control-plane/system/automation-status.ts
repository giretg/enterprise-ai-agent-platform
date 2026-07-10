import type { LocalWorkerStatus, SchedulerWorkerStatus } from '@/app/actions/platform'
import type { DispatcherControlsView } from './dispatcher-control-panel'
import type { DispatcherRuntimeView } from '@/lib/dispatcher-runtime'

/**
 * A biztonsági háló akkor jár körbe magától, ha vagy a Cloud Scheduler job fut, vagy a
 * lokális worker-folyamat él. A `available: false` mindkét oldalon azt jelenti, hogy nem
 * tudtuk lekérdezni — az nem „ki”, ezt a hívónak külön kell kezelnie.
 */
export function isSafetyNetAutoOn(
  scheduler: SchedulerWorkerStatus,
  local: LocalWorkerStatus,
): boolean {
  const schedulerOn = scheduler.available && scheduler.state === 'ENABLED'
  const localWorkerOn = local.available && local.running
  return schedulerOn || localWorkerOn
}

/**
 * Az agent-indítás csak akkor hat, ha a dispatcher be van kapcsolva ÉS ennek a
 * szerverfolyamatnak a futtató-módja szerepel az engedélyezett módok között.
 */
export function isAgentDispatchOn(
  dispatcher: DispatcherControlsView,
  runtime: DispatcherRuntimeView,
): boolean {
  const runtimeModeAllowed = runtime.mode !== null && dispatcher.allowedModes.includes(runtime.mode)
  return dispatcher.enabled && runtimeModeAllowed
}
