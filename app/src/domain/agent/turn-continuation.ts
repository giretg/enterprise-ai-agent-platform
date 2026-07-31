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
    '- Először listázd / nézd meg a munkaterület fájljait (progress JSON, kivonatok, Excel).',
    '- NE ismételd a már sikeresen lefutott, drága lépéseket (újraparse, ugyanaz az API-lekérdezés / http_api_get_all, ugyanazok a JSON-ok chunkolt file_read-del), ha az eredményük már fájlban van.',
    '- Nagy listák egyeztetéséhez: tool_result_extract (archívum VAGY workspace JSON) → reconcile_records / tulajdoni_lap_egyeztetes — NE párosíts a modellben.',
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

/**
 * Időközben megérkezett delegált válasz (C1 — „behúzás a következő fordulóban").
 *
 * Ha a szinkron várás határidőre futott, vagy a delegációt a diszpécser
 * futtatta le, a válasz egy lezárt ticketben landol, és ma SEMMI nem viszi
 * vissza a beszélgetésbe: a felhasználó kérdésére csend a válasz. Ez a blokk a
 * következő forduló promptjába emeli be, hogy az agent ne kérdezze meg
 * ugyanazt még egyszer.
 */
export type ReturnedDelegation = {
  /** A megkérdezett agent megjelenítendő neve (vagy az azonosítója, ha nincs). */
  answeredBy: string
  question: string
  answer: string
  confidence?: string | null
}

const MAX_DELEGATION_ANSWER_CHARS = 4_000

/** System-prompt blokk a megérkezett delegált válaszokból. Üres, ha nincs egy sem. */
export function buildReturnedDelegationPrompt(entries: readonly ReturnedDelegation[]): string {
  const usable = entries.filter((entry) => entry.answer.trim().length > 0)
  if (usable.length === 0) return ''

  const lines = [
    '## Időközben megérkezett válaszok',
    'Ezeket egy korábbi fordulóban te kérdezted meg másik agenttől; a válasz akkor még nem ért vissza, most itt van.',
    '',
    'KÖTELEZŐ:',
    '- NE kérdezd meg ugyanazt még egyszer — a válasz alább olvasható.',
    '- Használd fel a válaszban, és ha ettől már meg tudod adni a végeredményt, add meg.',
  ]

  for (const entry of usable) {
    const answer = entry.answer.trim()
    const truncated =
      answer.length > MAX_DELEGATION_ANSWER_CHARS
        ? `${answer.slice(0, MAX_DELEGATION_ANSWER_CHARS)}\n[…a válasz többi része levágva]`
        : answer
    const confidence = entry.confidence ? ` (magabiztosság: ${entry.confidence})` : ''
    lines.push(
      '',
      `### ${entry.answeredBy}${confidence}`,
      `Kérdés: ${entry.question.trim()}`,
      'Válasz:',
      truncated,
    )
  }

  return lines.join('\n')
}
