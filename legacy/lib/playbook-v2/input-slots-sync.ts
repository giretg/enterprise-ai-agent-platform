/**
 * instructionTemplate ↔ inputSlots szinkron (Folyamat-spec §4.7).
 * A {{token}} placeholder-ek és a lépés inputSlots tömbje együtt mozog.
 */
import type { PlaybookInputSlot } from '@/lib/playbook-v2/spec'

export const SLOT_TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

/** Sablonban szereplő token-nevek megőrzött sorrendben (duplikátum nélkül). */
export function extractTemplateTokensInOrder(template: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(SLOT_TOKEN_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      tokens.push(name)
    }
  }
  return tokens
}

const DEFAULT_NEW_SLOT: Pick<PlaybookInputSlot, 'type' | 'required' | 'source'> = {
  type: 'string',
  required: true,
  source: 'trigger',
}

/**
 * inputSlots frissítése az instructionTemplate tokenjei alapján:
 * - új token → új slot (meglévő metaadat megmarad, ha a név ismerős)
 * - eltűnt token → slot törlése
 */
export function syncInputSlotsWithTemplate(
  template: string | undefined,
  existingSlots: PlaybookInputSlot[] | undefined,
): PlaybookInputSlot[] | undefined {
  const tokenNames = extractTemplateTokensInOrder(template ?? '')
  if (tokenNames.length === 0) return undefined

  const existingByName = new Map((existingSlots ?? []).map((s) => [s.name, s]))

  return tokenNames.map((name) => {
    const existing = existingByName.get(name)
    if (existing) return existing
    return { name, ...DEFAULT_NEW_SLOT }
  })
}
