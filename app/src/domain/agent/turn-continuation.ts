/**
 * Megszakított agent-forduló utáni folytatás — általános (skill-független) prompt.
 *
 * Cél: wallclock / tool-büdzsé / no-progress leállás után a következő forduló
 * NE kezdje elölről a teljes folyamatot, hanem a workspace + előző aktivitások
 * alapján a hiányzó lépésekkel folytasson.
 */

export type ContinuationActivity = {
  kind?: string
  title?: string
  detail?: string | null
  status?: string
}

export type ContinuationTurnSnapshot = {
  status: string
  reason: string | null
  activities: ContinuationActivity[]
}

const CONTINUATION_REASONS = new Set([
  'wallclock_timeout',
  'tool_budget',
  'no_progress',
])

const MAX_ACTIVITY_LINES = 40

/** Mikor érdemes continuation-blokkot injektálni a következő fordulóba. */
export function shouldInjectTurnContinuation(turn: ContinuationTurnSnapshot): boolean {
  if (turn.status !== 'exhausted') return false
  return turn.reason != null && CONTINUATION_REASONS.has(turn.reason)
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'wallclock_timeout':
      return 'időkorlát'
    case 'tool_budget':
      return 'eszközhívási keret'
    case 'no_progress':
      return 'előrehaladás hiánya'
    default:
      return reason
  }
}

function formatActivityLine(activity: ContinuationActivity): string | null {
  if (activity.kind !== 'tool') return null
  const title = (activity.title ?? '').trim() || 'tool'
  const status = (activity.status ?? '').trim() || '?'
  const detail = (activity.detail ?? '').trim()
  return detail ? `- [${status}] ${title} — ${detail}` : `- [${status}] ${title}`
}

/**
 * System-prompt blokk a következő fordulóhoz. Üres string, ha nincs mit injektálni.
 */
export function buildTurnContinuationPrompt(
  turn: ContinuationTurnSnapshot,
  workspaceFiles: string[] = [],
): string {
  if (!shouldInjectTurnContinuation(turn) || !turn.reason) return ''

  const toolLines = turn.activities
    .map(formatActivityLine)
    .filter((line): line is string => line != null)
    .slice(0, MAX_ACTIVITY_LINES)

  const skipped = turn.activities.filter(
    (a) => a.kind === 'tool' && a.status === 'skipped',
  ).length
  const done = turn.activities.filter((a) => a.kind === 'tool' && a.status === 'done').length

  const lines = [
    '## Folytatás az előző fordulóból',
    `Az előző forduló megszakadt (${reasonLabel(turn.reason)}). A részeredmény megmaradt a munkaterületen / előzményben.`,
    '',
    'KÖTELEZŐ:',
    '- NE kezdd elölről a teljes folyamatot.',
    '- Először nézd meg a munkaterület fájljait (és ha kell, olvasd a már elkészült artefaktumokat).',
    '- NE ismételd a már sikeresen lefutott, drága lépéseket (pl. újraparse, ugyanaz az API-lekérdezés), ha a eredményük már elérhető fájlban vagy az előző aktivitásokból.',
    '- Csak a hiányzó / kimaradt lépéseket csináld meg; a „skipped / a futás leállt — kimaradt” tételek tipikusan ezek.',
    '',
    `Előző forduló eszközösszegzés: ${done} kész, ${skipped} kimaradt.`,
  ]

  if (toolLines.length > 0) {
    lines.push('', '### Előző forduló eszközaktivitásai', ...toolLines)
  }

  if (workspaceFiles.length > 0) {
    lines.push(
      '',
      '### Munkaterület (pontos nevek)',
      ...workspaceFiles.map((p) => `- ${p}`),
    )
  }

  return lines.join('\n')
}
