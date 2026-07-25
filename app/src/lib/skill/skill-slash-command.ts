import type { AssignedSkillEntry } from '@/lib/skill/skill-context'

/** Skill-névből slash-token: `/kb-answer-helper` (kisbetű, szóköz/underscore → kötőjel). */
export function skillNameToSlashToken(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

export interface ParsedSkillSlashCommands {
  /** A modell felé menő szöveg — a felismert `/token` részek eltávolítva. */
  modelFacingText: string
  /** Egyedi skillVersionId-k a szövegben kért skillekből (sorrend megőrizve). */
  skillVersionIds: string[]
}

const SLASH_TOKEN_PATTERN = /(?:^|\s)\/([a-zA-Z0-9_-]+)/g

/**
 * Felismeri a `/skill-token` mintákat és csak a ténylegesen hozzárendelt
 * skillek tokenjeit oldja fel skillVersionId-re (fail-closed).
 */
export function parseSkillSlashCommands(
  text: string,
  entries: AssignedSkillEntry[],
): ParsedSkillSlashCommands {
  const byToken = new Map<string, string>()
  for (const entry of entries) {
    byToken.set(skillNameToSlashToken(entry.name), entry.skillVersionId)
  }

  const skillVersionIds: string[] = []
  const seen = new Set<string>()

  const modelFacingText = text
    .replace(SLASH_TOKEN_PATTERN, (match, token: string) => {
      const versionId = byToken.get(token.toLowerCase())
      if (!versionId) return match
      if (!seen.has(versionId)) {
        seen.add(versionId)
        skillVersionIds.push(versionId)
      }
      return match.startsWith(' ') ? ' ' : ''
    })
    .replace(/\s{2,}/g, ' ')
    .trim()

  return { modelFacingText, skillVersionIds }
}

/** Aktív slash-autocomplete kontextus a kurzor pozíciója alapján (üres query = `/` után). */
export function getActiveSlashQuery(
  text: string,
  cursorPos: number,
): { start: number; query: string } | null {
  const before = text.slice(0, cursorPos)
  const slashIdx = before.lastIndexOf('/')
  if (slashIdx < 0) return null
  if (slashIdx > 0 && !/\s/.test(before[slashIdx - 1]!)) return null
  const query = before.slice(slashIdx + 1)
  if (/\s/.test(query)) return null
  return { start: slashIdx, query }
}

export function insertSkillSlashToken(input: {
  text: string
  cursorPos: number
  slashStart: number
  token: string
}): { text: string; cursorPos: number } {
  const before = input.text.slice(0, input.slashStart)
  const after = input.text.slice(input.cursorPos)
  const insertion = `/${input.token}`
  const needsSpace = after.length > 0 && !/^\s/.test(after)
  const text = before + insertion + (needsSpace ? ' ' : '') + after
  const cursorPos = before.length + insertion.length + (needsSpace ? 1 : 0)
  return { text, cursorPos }
}

/** Skill választóból: `/token` beszúrása a kurzorhoz (mintha a user begépelte volna). */
export function appendSkillSlashToken(input: {
  text: string
  cursorPos: number
  token: string
}): { text: string; cursorPos: number } {
  const before = input.text.slice(0, input.cursorPos)
  const after = input.text.slice(input.cursorPos)
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
  const insertion = `${needsLeadingSpace ? ' ' : ''}/${input.token}`
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
  const text = before + insertion + (needsTrailingSpace ? ' ' : '') + after
  const cursorPos = before.length + insertion.length + (needsTrailingSpace ? 1 : 0)
  return { text, cursorPos }
}

export function filterSkillsForSlashQuery<
  T extends { name: string; description?: string },
>(skills: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return skills.slice(0, 8)
  return skills
    .filter(
      (skill) =>
        skillNameToSlashToken(skill.name).includes(q) ||
        skill.name.toLowerCase().includes(q) ||
        (skill.description?.toLowerCase().includes(q) ?? false),
    )
    .slice(0, 8)
}
