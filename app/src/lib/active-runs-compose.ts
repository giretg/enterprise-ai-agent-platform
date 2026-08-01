import { activeRunKey, type ActiveRun } from '@/lib/active-runs'

export const SEEN_COMPLETED_LIMIT = 5

export type ComposedRun = ActiveRun & {
  /** Lefutott és a user már megnyitotta — a lista alján jelenik meg. */
  seen: boolean
}

export type ComposeRunsPanelResult = {
  runs: ComposedRun[]
  /** Aktív + megnézetlen lefutott — a badge száma. */
  badgeCount: number
}

/**
 * Panel lista: aktív + megnézetlen lefutott (időrend, legújabb felül),
 * alul az utolsó N megnézett lefutott (köztük is legújabb felül).
 */
export function composeRunsPanel(input: {
  runs: ActiveRun[]
  seenKeys: ReadonlySet<string>
  seenLimit?: number
}): ComposeRunsPanelResult {
  const seenLimit = input.seenLimit ?? SEEN_COMPLETED_LIMIT
  const byRecency = (a: ActiveRun, b: ActiveRun) =>
    runRecencyMs(b) - runRecencyMs(a)

  const active: ActiveRun[] = []
  const unseenCompleted: ActiveRun[] = []
  const seenCompleted: ActiveRun[] = []

  for (const run of input.runs) {
    if (run.phase === 'active') {
      active.push(run)
      continue
    }
    if (input.seenKeys.has(activeRunKey(run))) {
      seenCompleted.push(run)
    } else {
      unseenCompleted.push(run)
    }
  }

  active.sort(byRecency)
  unseenCompleted.sort(byRecency)
  seenCompleted.sort(byRecency)

  const primary = [...active, ...unseenCompleted].sort(byRecency)
  const seenTail = seenCompleted.slice(0, seenLimit)

  return {
    runs: [
      ...primary.map((run) => ({ ...run, seen: false })),
      ...seenTail.map((run) => ({ ...run, seen: true })),
    ],
    badgeCount: primary.length,
  }
}

function runRecencyMs(run: ActiveRun): number {
  const iso = run.finishedAt ?? run.startedAt
  return new Date(iso).getTime()
}
