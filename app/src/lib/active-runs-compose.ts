import { activeRunKey, type ActiveRun } from '@/lib/active-runs'

export type ComposedRun = ActiveRun & {
  /** Lefutott és a user már megnyitotta — csak a szín/jelölés változik, a sor marad. */
  seen: boolean
}

export type ComposeRunsPanelResult = {
  runs: ComposedRun[]
  /** Aktív + megnézetlen lefutott — a badge száma. */
  badgeCount: number
}

/**
 * Panel lista: minden futás időrendben (legújabb felül).
 * A megnyitott lefutottak nem esnek ki és nem csúsznak le — csak `seen` jelölést kapnak.
 */
export function composeRunsPanel(input: {
  runs: ActiveRun[]
  seenKeys: ReadonlySet<string>
}): ComposeRunsPanelResult {
  const byRecency = (a: ActiveRun, b: ActiveRun) =>
    runRecencyMs(b) - runRecencyMs(a)

  const sorted = [...input.runs].sort(byRecency)
  let badgeCount = 0
  const runs: ComposedRun[] = sorted.map((run) => {
    if (run.phase === 'active') {
      badgeCount += 1
      return { ...run, seen: false }
    }
    const seen = input.seenKeys.has(activeRunKey(run))
    if (!seen) badgeCount += 1
    return { ...run, seen }
  })

  return { runs, badgeCount }
}

function runRecencyMs(run: ActiveRun): number {
  const iso = run.finishedAt ?? run.startedAt
  return new Date(iso).getTime()
}

export type RunsSummary = {
  /** Éppen dolgozik rajta egy agent. */
  running: number
  /** Emberi döntésre vagy információra vár — ez a felhasználó teendője. */
  waiting: number
  /** Végrehajtásra vár (`ready`) — a felhasználó indíthatja. */
  ready: number
  /** Lefutott, de a felhasználó még nem nyitotta meg. */
  fresh: number
  /** Hibával vagy elutasítással zárult. */
  failed: number
}

/**
 * A lista fölé kerülő egysoros helyzetkép: mi az, ami fut, és mi az, amiben
 * a felhasználónak dolga van. A listát nem duplikálja, csak összegzi.
 */
export function summarizeRuns(runs: readonly ComposedRun[]): RunsSummary {
  const summary: RunsSummary = { running: 0, waiting: 0, ready: 0, fresh: 0, failed: 0 }
  for (const run of runs) {
    if (run.phase === 'active') {
      if (run.status === 'ready') summary.ready += 1
      else if (run.status === 'awaiting_human' || run.status === 'needs_info') summary.waiting += 1
      else summary.running += 1
      continue
    }
    if (run.status === 'failed' || run.status === 'exhausted' || run.status === 'rejected') {
      summary.failed += 1
    }
    if (!run.seen) summary.fresh += 1
  }
  return summary
}

export type RunsSummaryChip = { key: keyof RunsSummary; label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }

/** Csak a nem-nulla tételek — üres helyzetben nem szemetel a felületen. */
export function runsSummaryChips(summary: RunsSummary): RunsSummaryChip[] {
  const chips: RunsSummaryChip[] = []
  if (summary.running > 0) chips.push({ key: 'running', label: `${summary.running} fut`, tone: 'neutral' })
  if (summary.ready > 0) {
    chips.push({ key: 'ready', label: `${summary.ready} indításra vár`, tone: 'warning' })
  }
  if (summary.waiting > 0) chips.push({ key: 'waiting', label: `${summary.waiting} vár rád`, tone: 'warning' })
  if (summary.fresh > 0) chips.push({ key: 'fresh', label: `${summary.fresh} új eredmény`, tone: 'success' })
  if (summary.failed > 0) chips.push({ key: 'failed', label: `${summary.failed} sikertelen`, tone: 'danger' })
  return chips
}
