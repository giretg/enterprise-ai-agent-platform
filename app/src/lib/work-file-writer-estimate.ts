/**
 * A rögzítés előtti munkafájlok írójának becslése az audit-sorok időzítéséből (#1113 §5.7).
 * Az MCP-audit régi sorai nem tartalmazzák az útvonalat, ezért a találat csak valószínűség.
 */

export type WriterEvent =
  | { kind: 'agent'; at: Date; actorId: string; agentId: string }
  | { kind: 'human'; at: Date; actorId: string; path: string }

export type WriterEstimate =
  | { kind: 'agent'; agentId: string }
  | { kind: 'human' }
  | { kind: 'ambiguous' }
  | { kind: 'none' }

/** Az audit-sor a mentés után készül, de az órák és a tranzakció miatt kis eltérést megengedünk. */
export const WRITER_ESTIMATE_BEFORE_MS = 1_000
export const WRITER_ESTIMATE_AFTER_MS = 15_000

export function estimateWorkFileWriter(
  file: { path: string; updatedAt: Date; lastWriterUserId: string },
  events: readonly WriterEvent[],
): WriterEstimate {
  const from = file.updatedAt.getTime() - WRITER_ESTIMATE_BEFORE_MS
  const to = file.updatedAt.getTime() + WRITER_ESTIMATE_AFTER_MS
  const agents = new Set<string>()
  let human = false
  for (const event of events) {
    const at = event.at.getTime()
    if (event.actorId !== file.lastWriterUserId || at < from || at > to) continue
    if (event.kind === 'agent') agents.add(event.agentId)
    else if (event.path === file.path) human = true
  }
  if (agents.size + (human ? 1 : 0) > 1) return { kind: 'ambiguous' }
  if (human) return { kind: 'human' }
  const [agentId] = agents
  return agentId ? { kind: 'agent', agentId } : { kind: 'none' }
}
