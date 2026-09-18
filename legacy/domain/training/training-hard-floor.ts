/**
 * MemoryTraining v1.1 §8.3 / I5 / T4 — kemény padló.
 *
 * A tanítás tudáshoz és viselkedéshez nyúlhat, hatáskörhöz (capability,
 * RBAC, kulcs-scope, connector-jog) soha. Találat → azonnali reject,
 * a self-evolution profiltól függetlenül.
 */

export type HardFloorHit = {
  blocked: true
  reason: string
  matched: string
}

export type HardFloorClear = {
  blocked: false
}

export type HardFloorResult = HardFloorHit | HardFloorClear

type Pattern = { label: string; re: RegExp }

const HARD_FLOOR_PATTERNS: readonly Pattern[] = [
  { label: 'capability', re: /\b(capability|capabilities|tool[-_ ]?broker)\b/i },
  { label: 'tool_grant', re: /\b(tool[-_ ]?(grant|access|permission)|eszköz-?hozzáférés)\b/i },
  { label: 'connector_grant', re: /\bconnector[-_ ]?(grant|access|permission|scope)\b/i },
  { label: 'rbac', re: /\brbac\b|\bszerepkör(t|ét)?\s+(bővít|emel|admin)/i },
  { label: 'api_key_scope', re: /\b(api[-_ ]?key|kulcs-?scope|key[-_ ]?scope)\b/i },
  { label: 'privilege', re: /\b(privilege[-_ ]?escalat|jogosultság(ot|át)?\s+bővít)/i },
]

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function detectHardFloorViolation(proposed: unknown): HardFloorResult {
  const text = asText(proposed)
  if (!text.trim()) return { blocked: false }
  for (const pattern of HARD_FLOOR_PATTERNS) {
    if (pattern.re.test(text)) {
      return {
        blocked: true,
        reason:
          'Ez a változás jogosultságot vagy eszközhozzáférést érintene — tanítással nem engedhető meg',
        matched: pattern.label,
      }
    }
  }
  return { blocked: false }
}
