import { isAgentActivelyWorking, type ActiveRun } from '@/lib/active-runs'
import { formatRunElapsed, statusLabel } from '@/lib/active-runs-labels'

/**
 * Egy agent „mai napja” a bejelentkezett felhasználó szemszögéből.
 *
 * A forrás a saját futások listája (`loadActiveRuns`), ezért minden szám a
 * KETTŐJÜK közös munkájáról szól — sosem a tenant egészéről. A kártya emiatt
 * fogalmaz „neked” birtokviszonnyal.
 */
export type AgentActivity = {
  /** Van legalább egy futása, amin épp számol (nem emberi válaszra vár). */
  working: boolean
  /** A legfrissebb aktív futás — ezt mutatja a kártya „épp ezen dolgozik” sávja. */
  current: {
    title: string
    href: string
    /** „Fut” / „Döntésre vár” — a futás-listákkal azonos szótár. */
    label: string
    /** Előre formázott kor („12 perce”), hogy a kliens ne számoljon újra. */
    elapsed: string
    /** Emberi döntésre/válaszra vár, tehát a felhasználón a sor. */
    needsYou: boolean
  } | null
  /** Emberi válaszra váró aktív futások száma. */
  awaitingHuman: number
  /**
   * A legfrissebb jóváhagyásra/válaszra váró futás linkje (ticket vagy beszélgetés).
   * A sáv-kártya „Jóváhagyásra vár” pillje ide navigál.
   */
  attentionHref: string | null
  /** Ma lezárult futások száma (kész, elutasított, leállított egyaránt). */
  completedToday: number
}

const WAITING_STATES = new Set(['awaiting_human', 'needs_info'])

function emptyActivity(): AgentActivity {
  return { working: false, current: null, awaitingHuman: 0, attentionHref: null, completedToday: 0 }
}

/** „Ma nem dolgoztatok együtt” — az összegzésből kimaradt agentek alapértelmezése. */
export const EMPTY_AGENT_ACTIVITY: AgentActivity = Object.freeze(emptyActivity())

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** A dolgozó futás előbbre való a várakozónál; egyenlőségnél a frissebb nyer. */
function isBetterCurrent(candidate: ActiveRun, best: ActiveRun): boolean {
  const candidateWorking = isAgentActivelyWorking(candidate)
  const bestWorking = isAgentActivelyWorking(best)
  if (candidateWorking !== bestWorking) return candidateWorking
  return new Date(candidate.startedAt).getTime() > new Date(best.startedAt).getTime()
}

/**
 * Agentenként összegzi a futásokat, hogy a kártya azt mondhassa: „most ezen
 * dolgozik”, „rád vár”, „ma ennyit zárt le” — a puszta „aktív/pihen” helyett.
 *
 * A relatív időt szándékosan itt (szerveren) formázzuk: a kártya így kész
 * szöveget kap, és nincs szerver/kliens eltérés a hidratálásnál.
 */
/** A frissebb várakozó futás nyer — a pill a legutóbbi döntésre váró ügyre visz. */
function isBetterAttention(candidate: ActiveRun, best: ActiveRun): boolean {
  return new Date(candidate.startedAt).getTime() > new Date(best.startedAt).getTime()
}

export function summarizeAgentActivity(
  runs: readonly ActiveRun[],
  now: Date = new Date(),
): Map<string, AgentActivity> {
  const byAgent = new Map<string, AgentActivity>()
  const currentRun = new Map<string, ActiveRun>()
  const attentionRun = new Map<string, ActiveRun>()

  for (const run of runs) {
    const agentId = run.agentId
    if (!agentId) continue
    const entry = byAgent.get(agentId) ?? emptyActivity()

    if (run.phase === 'active') {
      if (isAgentActivelyWorking(run)) entry.working = true
      if (WAITING_STATES.has(run.status)) {
        entry.awaitingHuman += 1
        const bestAttention = attentionRun.get(agentId)
        if (!bestAttention || isBetterAttention(run, bestAttention)) {
          attentionRun.set(agentId, run)
        }
      }
      const best = currentRun.get(agentId)
      if (!best || isBetterCurrent(run, best)) currentRun.set(agentId, run)
    } else if (isSameDay(new Date(run.finishedAt ?? run.startedAt), now)) {
      entry.completedToday += 1
    }

    byAgent.set(agentId, entry)
  }

  for (const [agentId, run] of currentRun) {
    const entry = byAgent.get(agentId)
    if (!entry) continue
    entry.current = {
      title: run.title,
      href: run.href,
      label: statusLabel(run) ?? 'Folyamatban',
      elapsed: formatRunElapsed(run.startedAt, now),
      needsYou: WAITING_STATES.has(run.status),
    }
  }

  for (const [agentId, run] of attentionRun) {
    const entry = byAgent.get(agentId)
    if (!entry) continue
    entry.attentionHref = run.href
  }

  return byAgent
}
