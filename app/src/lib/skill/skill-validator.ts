import type { SkillRiskTier } from '@prisma/client'
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  type SkillContent,
  type SkillRequirement,
} from './skill-content'

/**
 * Hardcoded skill-validátor (spec §D5, WP-3). Ez — nem az LLM-review — a
 * TEHERHORDÓ kapu: determinista séma-, méret-, injection- és kód-jelenlét
 * ellenőrzés. Fázis 1 kizárólag T0/T1 (instrukció-only); bármilyen kód-jelenlét
 * (T2/T3) → ELUTASÍTÁS. A validátor sosem fail-open: kétség esetén elutasít.
 */

export interface SkillValidationInput {
  name: string
  description: string
  content: SkillContent
  requires: SkillRequirement[]
}

export interface SkillValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** Levezetett kockázati tier — csak akkor értelmezett, ha ok === true. */
  riskTier: SkillRiskTier
}

// Prompt-injection minták (spec §5). A skill támadó-kontrollált szöveg lehet, ami
// megpróbálhatja átvenni az irányítást vagy a review-agentet manipulálni.
const INJECTION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?)/i, label: 'ignore-previous' },
  { re: /disregard\s+(all\s+)?(previous|prior|above|the)\s+/i, label: 'disregard' },
  { re: /you\s+are\s+now\s+(a|an|the)\s+/i, label: 'role-override' },
  { re: /(reveal|print|show|leak|expose)\s+(your\s+)?(system\s+prompt|instructions|api[\s_-]?key|secret|token|password|credential)/i, label: 'secret-exfil' },
  { re: /(mark|report|classify)\s+(this|it|the)(\s+\w+){0,2}\s+as\s+(safe|harmless|approved|benign)/i, label: 'review-manipulation' },
  { re: /exfiltrat|data\s*exfil/i, label: 'exfiltration' },
  { re: /base64\s*[,:]?\s*[A-Za-z0-9+/]{80,}={0,2}/i, label: 'suspicious-blob' },
]

// Kód-jelenlét: futtatható nyelvi fence-ek. A T0/T1 skill instrukció-only.
const CODE_FENCE_RE = /```+\s*(python|py|bash|sh|shell|zsh|js|javascript|ts|typescript|ruby|rb|php|go|golang|rust|rs|java|c|cpp|c\+\+|perl|powershell|ps1)\b/i
const SHEBANG_RE = /(^|\n)\s*#!\s*\/(usr\/)?bin\//

/**
 * Injection-minta kereső NEM-SKILL szövegen (Level-2 mellékletek). Ugyanaz a
 * mintakészlet, mint a skill-törzsé: a melléklet is támadó-kontrollált bájt, és a
 * `load_skill_attachment` ugyanúgy a modell kontextusába teszi. A hívó dönt a
 * következményről — a csomag-import a MELLÉKLETET hagyja ki, nem az egész skillt.
 */
export function findInjectionPatterns(text: string): string[] {
  return INJECTION_PATTERNS.filter(({ re }) => re.test(text)).map(({ label }) => label)
}

export function validateSkill(input: SkillValidationInput): SkillValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // ── Séma / méret ──────────────────────────────────────────────────────────
  const name = input.name?.trim() ?? ''
  if (name.length === 0) errors.push('A skill neve kötelező.')
  if (name.length > SKILL_NAME_MAX) errors.push(`A név túl hosszú (max ${SKILL_NAME_MAX}).`)

  const description = input.description?.trim() ?? ''
  if (description.length === 0) errors.push('A leírás (Level-0 index) kötelező.')
  if (description.length > SKILL_DESCRIPTION_MAX) {
    errors.push(`A leírás túl hosszú (max ${SKILL_DESCRIPTION_MAX}).`)
  }

  const instructionsText = input.content.instructions.join('\n\n')
  if (instructionsText.trim().length === 0) {
    errors.push('Legalább egy instrukció-blokk kötelező.')
  }
  if (instructionsText.length > SKILL_INSTRUCTIONS_MAX) {
    errors.push(`Az instrukció-törzs túl hosszú (max ${SKILL_INSTRUCTIONS_MAX}).`)
  }

  // ── Kód-jelenlét → T2/T3 → Fázis 1-ben elutasít ───────────────────────────
  const haystack = [description, instructionsText].join('\n\n')
  if (CODE_FENCE_RE.test(haystack) || SHEBANG_RE.test(haystack)) {
    errors.push(
      'Kód-hordozó skill (futtatható kód-blokk) — ez T2/T3, ami Fázis 1-ben nem importálható.',
    )
  }

  // ── Injection-minták ──────────────────────────────────────────────────────
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(haystack)) {
      errors.push(`Prompt-injection gyanús minta: ${label}.`)
    }
  }

  // ── requires alaki ellenőrzés ─────────────────────────────────────────────
  for (const req of input.requires) {
    if (!req.toolName || req.toolName.trim().length === 0) {
      errors.push('Üres toolName a requires listában.')
    }
  }

  // ── Tier-levezetés (csak ha érvényes) ─────────────────────────────────────
  const riskTier: SkillRiskTier = input.requires.length > 0 ? 't1' : 't0'

  return { ok: errors.length === 0, errors, warnings, riskTier }
}
