import type { SkillContent, SkillRequirement } from './skill-content'

/** Egyszerű YAML skalár idézőjel — csak exportra, nem teljes YAML-serializer. */
function yamlScalar(value: string): string {
  if (/[:#\n"'\\]|^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

/**
 * Kanonikus belső skill → Anthropic `SKILL.md` szöveg (import round-trip alap).
 * A törzs az instrukció-blokkok `\n\n` összefűzése — ugyanaz, amit az import
 * `splitInstructions` vissza tud bontani.
 */
export function serializeSkillMd(input: {
  name: string
  displayName?: string | null
  description: string
  license?: string | null
  content: SkillContent
  requires: SkillRequirement[]
}): string {
  const fm: string[] = ['---']
  fm.push(`name: ${yamlScalar(input.name)}`)
  const title = input.displayName?.trim()
  if (title) fm.push(`title: ${yamlScalar(title)}`)
  fm.push(`description: ${yamlScalar(input.description)}`)

  const license = input.license?.trim()
  if (license) fm.push(`license: ${yamlScalar(license)}`)

  const tools = input.requires.map((r) => r.toolName).filter(Boolean)
  if (tools.length > 0) fm.push(`allowed-tools: ${tools.join(', ')}`)

  const keywords = input.content.triggerKeywords.filter(Boolean)
  if (keywords.length > 0) fm.push(`trigger-keywords: ${keywords.map(yamlScalar).join(', ')}`)

  const hints = input.content.runtimeHints
  if (hints?.maxWallClockMs != null) fm.push(`max-wall-clock-ms: ${hints.maxWallClockMs}`)
  if (hints?.maxToolCalls != null) fm.push(`max-tool-calls: ${hints.maxToolCalls}`)
  if (hints?.preferredMode) fm.push(`preferred-mode: ${hints.preferredMode}`)
  if (hints?.allowAttachments === false) fm.push('allow-attachments: false')
  const attachmentDescription = hints?.attachmentDescription?.trim()
  if (attachmentDescription) fm.push(`attachment-description: ${yamlScalar(attachmentDescription)}`)

  fm.push('---')

  const body = input.content.instructions.join('\n\n').trimEnd()
  return body ? `${fm.join('\n')}\n${body}\n` : `${fm.join('\n')}\n`
}
