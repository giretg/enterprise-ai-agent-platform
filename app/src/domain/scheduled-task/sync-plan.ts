import { normalizeCron } from './cron'
import { expectedStubHash, scheduleHash, type ScheduledTaskClient } from './stub'

/**
 * #640 §5.2: háromutas összevetés (alap = legutóbb telepített, platform = mostani,
 * helyi = leltár). Tiszta függvény — a szinkron így tesztelhető, és nem a modell
 * ítélőképességén múlik. A harness csak leltároz és végrehajtja a lépéseket.
 */

export type PlanTaskAccess = 'ok' | 'needs_consent' | 'needs_reconsent' | 'not_allowed'

export type PlanTask = {
  taskId: string
  title: string
  kind: 'personal' | 'team' | 'shared'
  status: 'active' | 'paused' | 'archived'
  cron: string
  timezone: string
  targets: string[]
  version: number
  instruction: string
  isOwner: boolean
  ownerName: string
  /** Ki hozta létre / hívta meg (K8 kérdés szövegéhez). */
  inviterName: string | null
  access: PlanTaskAccess
  /** A feladat összes élő telepítése (K9: a kérdés megnevezi, kit érint még). */
  liveInstallations: number
  /** Aktív tagok száma a tulajdonoson kívül. */
  memberCount: number
}

export type PlanInstallation = {
  taskId: string
  externalId: string
  /** '' = ismeretlen alap (pl. futásból regisztrált telepítés). */
  installedScheduleHash: string
  locallyDisabled: boolean
}

export type InventoryEntry = {
  externalId: string
  taskId: string
  cron: string
  timezone: string
  enabled: boolean
  stubHash: string
  /** A csonkba helyben hozzáírt szöveg (L4), ha van. */
  extraText?: string
}

export type ReportAction = 'installed' | 'updated' | 'removed' | 'disabled' | 'accepted' | 'declined'

export type PlanReport = {
  taskId: string
  externalId?: string
  action: ReportAction
  scheduleHash?: string
  stubHash?: string
  locallyDisabled?: boolean
}

export type PlanStep =
  | { type: 'local'; op: 'install' | 'update' | 'disable' | 'remove'; taskId: string; externalId?: string; desired?: { cron: string; timezone: string; enabled: boolean } }
  | { type: 'platform_update'; args: { taskId: string; expectedVersion: number; cron?: string; timezone?: string; status?: 'paused'; instruction?: string } }
  | { type: 'report'; report: PlanReport }

export type PlanCode = 'P1' | 'P2' | 'P3' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'BASE' | 'CONSENT' | 'RECONSENT' | 'REVOKED'

export type PlanAction = {
  code: PlanCode
  op: 'install' | 'update' | 'disable' | 'remove' | 'report' | 'ask'
  taskId: string
  externalId?: string
  title?: string
  message: string
  steps?: PlanStep[]
  choices?: Array<{ id: string; label: string; default?: boolean; steps: PlanStep[] }>
}

export type PlanInput = {
  client: ScheduledTaskClient
  tasks: PlanTask[]
  installations: PlanInstallation[]
  inventory: InventoryEntry[]
}

function report(task: { taskId: string }, action: ReportAction, extra: Omit<PlanReport, 'taskId' | 'action'> = {}): PlanStep {
  return { type: 'report', report: { taskId: task.taskId, action, ...extra } }
}

function sameSchedule(a: { cron: string; timezone: string }, b: { cron: string; timezone: string }) {
  return normalizeCron(a.cron) === normalizeCron(b.cron) && a.timezone === b.timezone
}

export function planScheduledTaskSync(input: PlanInput): PlanAction[] {
  const { client } = input
  const actions: PlanAction[] = []
  const known = new Set(input.tasks.map((task) => task.taskId))

  // L6: ismeretlen vagy nem a user feladata → eltávolítás, adat nem szivárog.
  for (const entry of input.inventory) {
    if (known.has(entry.taskId)) continue
    actions.push({
      code: 'L6', op: 'remove', taskId: entry.taskId, externalId: entry.externalId,
      message: 'This scheduled task no longer exists on the platform (or is not yours). Remove it from this client.',
      steps: [{ type: 'local', op: 'remove', taskId: entry.taskId, externalId: entry.externalId }],
    })
  }

  for (const task of input.tasks) {
    const entries = input.inventory.filter((entry) => entry.taskId === task.taskId)
    const installs = input.installations.filter((row) => row.taskId === task.taskId)
    const base = { taskId: task.taskId, title: task.title }
    const stub = expectedStubHash(task.taskId, client)

    // P2 (archivált) és jog-elvétel: minden helyi példány megy.
    if (task.status === 'archived' || task.access === 'not_allowed') {
      const code: PlanCode = task.status === 'archived' ? 'P2' : 'REVOKED'
      for (const entry of entries) {
        actions.push({
          ...base, code, op: 'remove', externalId: entry.externalId,
          message: task.status === 'archived' ? `"${task.title}" was archived on the platform. Remove it from this client.` : `You can no longer run "${task.title}". Remove it from this client.`,
          steps: [{ type: 'local', op: 'remove', taskId: task.taskId, externalId: entry.externalId }, report(task, 'removed', { externalId: entry.externalId })],
        })
      }
      for (const row of installs.filter((row) => !entries.some((entry) => entry.externalId === row.externalId))) {
        actions.push({ ...base, code, op: 'report', externalId: row.externalId, message: 'Already gone from this client; record it as removed.', steps: [report(task, 'removed', { externalId: row.externalId })] })
      }
      continue
    }

    // L7: ugyanaz a feladat kétszer ezen a kliensen → a második megy.
    const primary = entries.find((entry) => installs.some((row) => row.externalId === entry.externalId)) ?? entries[0]
    for (const extra of entries.filter((entry) => entry !== primary)) {
      actions.push({
        ...base, code: 'L7', op: 'remove', externalId: extra.externalId,
        message: `"${task.title}" is installed twice on this client. Remove the duplicate.`,
        steps: [{ type: 'local', op: 'remove', taskId: task.taskId, externalId: extra.externalId }, report(task, 'removed', { externalId: extra.externalId })],
      })
    }
    const install = primary ? installs.find((row) => row.externalId === primary.externalId) : undefined
    const runnable = task.status === 'active' && task.access !== 'needs_consent'
    const desiredEnabled = runnable && !install?.locallyDisabled
    const desired = { cron: normalizeCron(task.cron), timezone: task.timezone, enabled: desiredEnabled }
    const desiredHash = scheduleHash(desired)
    const installSteps = (op: 'install' | 'update', externalId?: string): PlanStep[] => [
      { type: 'local', op, taskId: task.taskId, ...(externalId ? { externalId } : {}), desired },
      report(task, op === 'install' ? 'installed' : 'updated', { ...(externalId ? { externalId } : {}), scheduleHash: desiredHash, stubHash: stub }),
    ]

    if (!primary) {
      const missing = installs.find((row) => row.installedScheduleHash !== '')
      if (missing) {
        // L5: helyben törölték.
        const pauseOrLeave: PlanStep[] = task.isOwner
          ? [{ type: 'platform_update', args: { taskId: task.taskId, expectedVersion: task.version, status: 'paused' } }, report(task, 'removed', { externalId: missing.externalId })]
          : [report(task, 'declined')]
        actions.push({
          ...base, code: 'L5', op: 'ask', externalId: missing.externalId,
          message: task.isOwner
            ? `"${task.title}" was deleted from this client. Should I pause the task, or install it again?`
            : `"${task.title}" was deleted from this client. Should I leave this shared task, or install it again?`,
          choices: [
            { id: task.isOwner ? 'pause' : 'leave', label: task.isOwner ? 'Pause the task' : 'Leave the task', steps: pauseOrLeave },
            { id: 'reinstall', label: 'Install it again', default: true, steps: [report(task, 'removed', { externalId: missing.externalId }), ...installSteps('install')] },
          ],
        })
        continue
      }
      if (task.status !== 'active' || !task.targets.includes(client.clientType)) continue
      if (task.access === 'needs_consent' || task.access === 'needs_reconsent') {
        actions.push({
          ...base, code: 'CONSENT', op: 'ask',
          message: `${task.inviterName ?? task.ownerName} set up a scheduled task for you: "${task.title}" — ${task.instruction.slice(0, 300)}. Should I install it?`,
          choices: [
            { id: 'accept', label: 'Install it', default: true, steps: [...installSteps('install'), ...(task.access === 'needs_reconsent' ? [report(task, 'accepted')] : [])] },
            { id: 'decline', label: 'No, thanks', steps: [report(task, 'declined')] },
          ],
        })
        continue
      }
      actions.push({ ...base, code: 'P3', op: 'install', message: `Install "${task.title}" on this client.`, steps: installSteps('install') })
      continue
    }

    const externalId = primary.externalId
    if (task.access === 'needs_reconsent') {
      actions.push({
        ...base, code: 'RECONSENT', op: 'ask', externalId,
        message: `${task.ownerName} changed "${task.title}": ${task.instruction.slice(0, 300)}. Do you accept the new version?`,
        choices: [
          { id: 'accept', label: 'Accept', default: true, steps: [report(task, 'accepted')] },
          { id: 'decline', label: 'Leave the task', steps: [{ type: 'local', op: 'remove', taskId: task.taskId, externalId }, report(task, 'removed', { externalId }), report(task, 'declined')] },
        ],
      })
    }

    const stubOk = primary.stubHash === stub
    const local = scheduleHash(primary)
    const baseHash = install && install.installedScheduleHash !== '' ? install.installedScheduleHash : null

    if (!stubOk) {
      // L4: a csonk szövegét átírták — visszaállítjuk; a hozzáírt utasítás csak kérdésre megy át.
      const restore = installSteps('update', externalId)
      if (primary.extraText && task.isOwner) {
        actions.push({
          ...base, code: 'L4', op: 'ask', externalId,
          message: `The prompt of "${task.title}" was edited on this client ("${primary.extraText.slice(0, 200)}"). Should I move that text into the task's instruction on the platform?`,
          choices: [
            { id: 'move', label: 'Move it into the instruction', steps: [{ type: 'platform_update', args: { taskId: task.taskId, expectedVersion: task.version, instruction: `${task.instruction}\n\n${primary.extraText}`.slice(0, 8000) } }, ...restore] },
            { id: 'discard', label: 'Discard the edit', default: true, steps: restore },
          ],
        })
      } else {
        actions.push({ ...base, code: 'L4', op: 'update', externalId, message: `Restore the platform prompt of "${task.title}" on this client.`, steps: restore })
      }
      continue
    }

    if (local === desiredHash) {
      if (baseHash !== local) actions.push({ ...base, code: 'BASE', op: 'report', externalId, message: 'Already up to date; record the installed state.', steps: [report(task, 'updated', { externalId, scheduleHash: local, stubHash: stub })] })
      continue
    }
    // Helyben visszakapcsolta, amit csak ezen a gépen kapcsolt ki: az ő gépe, kérdés nélkül.
    if (install?.locallyDisabled && primary.enabled && runnable && sameSchedule(primary, task)) {
      actions.push({ ...base, code: 'BASE', op: 'report', externalId, message: 'Re-enabled on this client.', steps: [report(task, 'updated', { externalId, scheduleHash: local, stubHash: stub, locallyDisabled: false })] })
      continue
    }
    if (baseHash === null || local === baseHash) {
      if (!desiredEnabled) {
        actions.push({
          ...base, code: 'P2', op: 'disable', externalId,
          message: `"${task.title}" is paused on the platform. Turn it off on this client.`,
          steps: [{ type: 'local', op: 'disable', taskId: task.taskId, externalId, desired }, report(task, 'disabled', { externalId, scheduleHash: desiredHash, stubHash: stub })],
        })
      } else {
        actions.push({ ...base, code: 'P1', op: 'update', externalId, message: `"${task.title}" changed on the platform. Update it on this client.`, steps: installSteps('update', externalId) })
      }
      continue
    }

    // Helyben változott (local ≠ alap).
    const onlyDisabled = !primary.enabled && sameSchedule(primary, task) && scheduleHash({ ...primary, enabled: true }) === baseHash
    if (onlyDisabled && runnable) {
      const choices: NonNullable<PlanAction['choices']> = [
        { id: 'this_client', label: 'Only on this client', default: true, steps: [report(task, 'disabled', { externalId, scheduleHash: local, stubHash: stub, locallyDisabled: true })] },
        task.isOwner
          ? { id: 'pause', label: 'Pause the task everywhere', steps: [{ type: 'platform_update', args: { taskId: task.taskId, expectedVersion: task.version, status: 'paused' } }, report(task, 'disabled', { externalId, scheduleHash: local, stubHash: stub })] }
          : { id: 'restore', label: 'Turn it back on', steps: installSteps('update', externalId) },
      ]
      actions.push({ ...base, code: 'L3', op: 'ask', externalId, message: `"${task.title}" was turned off on this client. Turn it off only here, or ${task.isOwner ? 'pause the task' : 'turn it back on'}?`, choices })
      continue
    }
    const code: PlanCode = baseHash === desiredHash ? 'L1' : 'L2'
    if (!task.isOwner) {
      // K9: közös feladat nem-tulajdonos helyi módosítása nem vezethető át.
      actions.push({
        ...base, code, op: 'update', externalId,
        message: `"${task.title}" is a shared task managed by ${task.ownerName}. I am restoring the local change. If you need a different time, ask ${task.ownerName}.`,
        steps: installSteps('update', externalId),
      })
      continue
    }
    const others = Math.max(0, task.liveInstallations - installs.length)
    const affected = task.kind === 'personal'
      ? others > 0 ? ` This also changes ${others} other installation(s).` : ''
      : ` This affects ${task.memberCount} other member(s).`
    actions.push({
      ...base, code, op: 'ask', externalId,
      message: code === 'L1'
        ? `"${task.title}" was rescheduled on this client (${normalizeCron(primary.cron)} ${primary.timezone} instead of ${desired.cron} ${desired.timezone}). Apply this to the platform, or restore it?${affected}`
        : `"${task.title}" changed both on this client and on the platform. Keep the platform version, or apply the local one?${affected}`,
      choices: [
        {
          id: 'apply', label: 'Apply to the platform',
          steps: [
            { type: 'platform_update', args: { taskId: task.taskId, expectedVersion: task.version, cron: normalizeCron(primary.cron), timezone: primary.timezone, ...(primary.enabled ? {} : { status: 'paused' as const }) } },
            report(task, 'updated', { externalId, scheduleHash: local, stubHash: stub }),
          ],
        },
        { id: 'restore', label: 'Restore the platform version', default: true, steps: installSteps('update', externalId) },
      ],
    })
  }
  return actions
}

export function summarizePlan(actions: PlanAction[]): string {
  if (actions.length === 0) return 'Everything is in sync.'
  const count = (predicate: (action: PlanAction) => boolean) => actions.filter(predicate).length
  const parts = [
    [count((a) => a.op === 'install'), 'to install'],
    [count((a) => a.op === 'update' || a.op === 'disable'), 'to update'],
    [count((a) => a.op === 'remove'), 'to remove'],
    [count((a) => a.op === 'ask'), 'question(s) for the user'],
  ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}`)
  return parts.length ? `${parts.join(', ')}.` : 'Only bookkeeping: report the installed state.'
}
