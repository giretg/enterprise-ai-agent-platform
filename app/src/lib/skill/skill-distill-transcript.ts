import type { SkillRequirement } from '@/lib/skill/skill-content'
import type { DistillTranscriptTurn } from '@/domain/skill/skill-distiller-agent'

/** A futásidejű `load_skill` meta-tool — nem kerül a desztillált skill `requires`-ébe. */
export const DISTILL_EXCLUDED_TOOLS = new Set(['load_skill'])

function parseStoredMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    if (typeof parsed.text === 'string') return parsed.text
  } catch {
    // plain text legacy
  }
  return content
}

/**
 * Beszélgetés-üzenetek → desztilláló transzkript-fordulók. Csak user/agent szöveg,
 * törölt/üres tartalom kihagyva (D14: a beszélgetés input, de nem megbízható).
 */
export function conversationMessagesToTurns(
  messages: Array<{
    role: string
    content: string | null
    contentDeletedAt?: Date | null
  }>,
): DistillTranscriptTurn[] {
  const turns: DistillTranscriptTurn[] = []
  for (const message of messages) {
    if (message.contentDeletedAt || !message.content?.trim()) continue
    if (message.role !== 'user' && message.role !== 'agent') continue
    const text = parseStoredMessageText(message.content).trim()
    if (!text) continue
    turns.push({ role: message.role as 'user' | 'agent', text })
  }
  return turns
}

/**
 * A `requires` determinisztikus levezetése a beszélgetésben ténylegesen meghívott
 * toolokból (D14 kemény padló — NEM a modelltől jön). Csak sikeres hívások számítanak.
 */
export function deriveRequiresFromToolCalls(
  toolCalls: Array<{ toolName: string; status: string }>,
): SkillRequirement[] {
  const seen = new Set<string>()
  const requires: SkillRequirement[] = []
  for (const call of toolCalls) {
    if (call.status !== 'ok') continue
    if (DISTILL_EXCLUDED_TOOLS.has(call.toolName)) continue
    if (seen.has(call.toolName)) continue
    seen.add(call.toolName)
    requires.push({
      toolName: call.toolName,
      reason: 'A forrás-beszélgetésben ténylegesen meghívott eszköz (javasolt, nem adott).',
    })
  }
  return requires
}
