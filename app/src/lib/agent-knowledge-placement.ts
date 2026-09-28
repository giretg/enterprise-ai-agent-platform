/**
 * Issue #659: one decision table for where client AI stores agent knowledge.
 */

export type KnowledgePlacementTarget =
  | 'project_memory'
  | 'skill'
  | 'knowledge_base'
  | 'work_file'
  | 'drive'
  | 'session_log'
  | 'focus'

export const KNOWLEDGE_PLACEMENT_TABLE = `| What | Where | Tool |
|---|---|---|
| Company fact, decision, location (true now) | memory | \`platform.project_memory.write\` (replaceId when it changed) |
| Operating rule or procedure ("how we do it") | skill — propose for approval | \`platform.skills.submit\` |
| Reference document, knowledge material | knowledge base | \`kb_ingest\` |
| Work plan, notes, draft | work file | \`platform.work_file.write\` (growing log: \`platform.work_file.append\`) |
| Finished deliverable for humans | agent Drive folder | \`google_drive_upload_file\` |
| What happened today | session log | \`platform.project_memory.write\` kind \`session_log\` |
| What we are working on now | focus | \`platform.project_memory.write\` kind \`focus\` |`

export const KNOWLEDGE_PLACEMENT_TABLE_REF =
  'Use the "Where to save what" table in server instructions and the agent briefing — pick the row before any write.'

export function renderKnowledgePlacementBlock(): string {
  return [
    'WHERE TO SAVE WHAT',
    'When the user asks to remember, save, or store something, pick exactly one row — do not put operating rules in memory, plans in memory, or reference documents in memory.',
    '',
    KNOWLEDGE_PLACEMENT_TABLE,
  ].join('\n')
}

export type MisplacedMemoryWrite = {
  suggest: KnowledgePlacementTarget
  reason: 'procedure' | 'document'
}

/** Facts in memory stay short; long or procedural text belongs elsewhere (#659). */
export const MEMORY_FACT_SOFT_MAX = 1_200

const PROCEDURE_LINE =
  /^\s*(?:\d+[\.)]|[-*•])\s+(?:mindig|soha|never|always|ellenőriz|check|must|kötelező|ensure|verify)/im

function procedureScore(text: string): number {
  const lines = text.split(/\r?\n/)
  let score = 0
  for (const line of lines) {
    if (PROCEDURE_LINE.test(line)) score++
    if (/^\s*\d+[\.)]\s/.test(line)) score++
  }
  const folded = text.toLowerCase()
  if (/\b(eljárás|szabály|procedure|policy|operating rule|how we do)\b/u.test(folded)) score += 2
  if (/\b(mindig|soha|must always|never skip|kötelező)\b/u.test(folded)) score += 1
  return score
}

export function detectMisplacedMemoryWrite(input: {
  kind: string
  title: string
  body: string
}): MisplacedMemoryWrite | null {
  if (input.kind === 'focus' || input.kind === 'session_log') return null
  const text = `${input.title}\n${input.body}`.trim()
  const proc = procedureScore(text)
  if (proc >= 4) return { suggest: 'skill', reason: 'procedure' }
  if (input.body.length > MEMORY_FACT_SOFT_MAX) {
    const planLike = /\b(terv|plan|todo|feladatlista|outline|draft|jegyzet)\b/i.test(text)
    return { suggest: planLike ? 'work_file' : 'knowledge_base', reason: 'document' }
  }
  if (proc >= 2 && input.body.length > 400) return { suggest: 'skill', reason: 'procedure' }
  return null
}

export function suggestToolForPlacement(target: KnowledgePlacementTarget): string {
  switch (target) {
    case 'project_memory':
      return 'platform.project_memory.write'
    case 'skill':
      return 'platform.skills.submit'
    case 'knowledge_base':
      return 'kb_ingest'
    case 'work_file':
      return 'platform.work_file.write'
    case 'drive':
      return 'google_drive_upload_file'
    case 'session_log':
      return 'platform.project_memory.write (kind session_log)'
    case 'focus':
      return 'platform.project_memory.write (kind focus)'
  }
}
