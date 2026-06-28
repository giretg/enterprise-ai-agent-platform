/**
 * Sensitivity-aware router (§4.7.2, Fázis 2-B)
 *
 * Pre-flight classifier that runs BEFORE the model call, entirely server-side,
 * without LLM involvement. Decision is deterministic and non-overridable by
 * agent or prompt (invariant 10).
 *
 * Sensitivity levels:
 *   clean    → allow external provider
 *   sensitive → force local provider (fallback model)
 *   forbidden → block, emit model.call.denied audit + human-in-the-loop ticket
 */

export type SensitivityLevel = 'clean' | 'sensitive' | 'forbidden'

export type SensitivityDecision = {
  level: SensitivityLevel
  /** Matched pattern category — for audit metadata, NOT logged to prompt/output. */
  matchedCategory?: string
}

// ── Pattern registry ────────────────────────────────────────────────────────

/** PAN / card number: 13-19 digit sequence, with optional separators. */
const PAN_RE =
  /\b(?:4[0-9]{12}(?:[0-9]{3,6})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|(?:3(?:0[0-5]|[68][0-9]))[0-9]{11})\b/

/** 16-19 digit sequence (broad card-like number match for unknown issuers). */
const CARD_BROAD_RE = /\b[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}[\s\-]?[0-9]{3,7}\b/

/** Hungarian TAJ szám (social security, 9 digits). */
const TAJ_RE = /\b[0-9]{3}-[0-9]{3}-[0-9]{3}\b/

/** Hungarian adószám (tax ID, 11 digits). */
const ADOSZAM_RE = /\b[0-9]{8}-[1-5]-[0-9]{2}\b/

/** IBAN — ISO 13616, basic structural match. */
const IBAN_RE = /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}(?:[A-Z0-9]{0,16})?\b/

/** Password / secret patterns (common env-var–style keys followed by a value). */
const SECRET_KEY_RE =
  /(?:password|secret|api[_-]?key|token|auth[_-]?key|private[_-]?key)\s*[:=]\s*\S+/i

/** Email address (basic RFC-5322 local@domain). */
const EMAIL_RE = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/

/** Hungarian personal name patterns: two uppercase-starting words. Very broad, used as soft signal. */
// Not used as forbidden — only contributes to "sensitive" tier.

const FORBIDDEN_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: PAN_RE, category: 'pan' },
  { re: CARD_BROAD_RE, category: 'card_broad' },
  { re: IBAN_RE, category: 'iban' },
  { re: SECRET_KEY_RE, category: 'secret_key' },
]

const SENSITIVE_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: TAJ_RE, category: 'taj' },
  { re: ADOSZAM_RE, category: 'adoszam' },
  { re: EMAIL_RE, category: 'email' },
]

// ── Classifier ───────────────────────────────────────────────────────────────

function extractText(messages: Array<{ role: string; content?: string | null }>): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => m.content ?? '')
    .join('\n')
}

export function classifyPrompt(
  messages: Array<{ role: string; content?: string | null }>,
): SensitivityDecision {
  const text = extractText(messages)

  for (const { re, category } of FORBIDDEN_PATTERNS) {
    if (re.test(text)) {
      return { level: 'forbidden', matchedCategory: category }
    }
  }

  for (const { re, category } of SENSITIVE_PATTERNS) {
    if (re.test(text)) {
      return { level: 'sensitive', matchedCategory: category }
    }
  }

  return { level: 'clean' }
}

// ── Policy enforcement ───────────────────────────────────────────────────────

export type SensitivityPolicy = {
  /** If true, sensitive prompts are forced to the local provider. */
  enforceLocalForSensitive: boolean
  /** Provider name to force for sensitive prompts (default: 'ollama'). */
  localProvider: string
  /** Model to force for sensitive prompts. */
  localModel: string
}

export const DEFAULT_SENSITIVITY_POLICY: SensitivityPolicy = {
  enforceLocalForSensitive: true,
  localProvider: 'ollama',
  localModel: 'gemma-local',
}
