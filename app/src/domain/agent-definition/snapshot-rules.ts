export type AgentDefinitionRuleSource = 'hard' | 'trained'

export type AgentDefinitionSnapshotRule = {
  text: string
  source: AgentDefinitionRuleSource
}

/** Megszeghetetlen: soronként; tanított: egy blokk (többsoros lehet). */
export function collectSnapshotRules(input: {
  hardRules?: string | null
  trainedRules?: string | null
}): AgentDefinitionSnapshotRule[] {
  const rules: AgentDefinitionSnapshotRule[] = []
  for (const line of (input.hardRules ?? '').split('\n')) {
    const text = line.trim()
    if (text) rules.push({ text, source: 'hard' })
  }
  const trained = (input.trainedRules ?? '').trim()
  if (trained) rules.push({ text: trained, source: 'trained' })
  return rules
}

export const SNAPSHOT_RULES_OVERRIDE_HINT =
  'These published rules override a conflicting user request — stop, name the rule, and ask for the required approval instead of proceeding. You cannot change them via MCP; propose new rules only through the human approval workflow.'

/** Briefing: teljes szöveg, nincs levágás (#660). */
export function renderSnapshotRulesBriefingBlock(
  rules: readonly AgentDefinitionSnapshotRule[],
): string | null {
  if (rules.length === 0) return null
  const hard = rules.filter((row) => row.source === 'hard')
  const trained = rules.filter((row) => row.source === 'trained')
  const lines = [
    '## Published agent rules',
    '',
    SNAPSHOT_RULES_OVERRIDE_HINT,
    '',
  ]
  if (hard.length > 0) {
    lines.push('### Unbreakable rules', '')
    for (const row of hard) lines.push(`- ${row.text}`)
    lines.push('')
  }
  if (trained.length > 0) {
    lines.push('### Trained operating rules', '')
    for (const row of trained) lines.push(row.text)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
