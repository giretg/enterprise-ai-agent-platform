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

export type SensitivityFinding = {
  level: SensitivityLevel
  category: string
  line: number
  column: number
  snippet: string
}

export type SensitivityInspection = SensitivityDecision & {
  findings: SensitivityFinding[]
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

/** Private-key material is never safe to send to external providers. */
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i

/**
 * Password / secret assignments. Matching the key is not enough: API docs often
 * contain headers like `X-Api-Key: your_api_key_here`, which are examples rather
 * than secrets. We extract the value and assess whether it looks like real
 * material before blocking.
 */
const SECRET_ASSIGNMENT_RE =
  /(?:password|secret|api[_-]?key|token|auth[_-]?key|private[_-]?key)\s*[:=]\s*["'`]?([^\s"'`,;]+)/gi

const PLACEHOLDER_SECRET_RE =
  /^(?:<[^>]+>|\{[^}]+\}|\[[^\]]+\]|(?:your|example|sample|demo|dummy|test|fake|placeholder|replace|changeme|change_me|todo|xxx|xxxx|redacted|masked|here|api[_-]?key|token|secret|password|key|value)(?:[_-](?:your|example|sample|demo|dummy|test|fake|placeholder|replace|changeme|change_me|todo|xxx|xxxx|redacted|masked|here|api[_-]?key|token|secret|password|key|value))*)$/i

const COMMON_SECRET_VALUE_RE =
  /^(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/

/** Email address (basic RFC-5322 local@domain). */
const EMAIL_RE = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/

/** Hungarian personal name patterns: two uppercase-starting words. Very broad, used as soft signal. */
// Not used as forbidden — only contributes to "sensitive" tier.

const FORBIDDEN_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: PAN_RE, category: 'pan' },
  { re: CARD_BROAD_RE, category: 'card_broad' },
  { re: IBAN_RE, category: 'iban' },
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

function positionOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, index))
  const lines = before.split('\n')
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

function lineSnippet(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1
  const next = text.indexOf('\n', index)
  const end = next === -1 ? text.length : next
  const line = text.slice(start, end).trim()
  return maskSecretAssignments(line).slice(0, 180)
}

function maskSecretAssignments(text: string): string {
  SECRET_ASSIGNMENT_RE.lastIndex = 0
  return text.replace(SECRET_ASSIGNMENT_RE, (full, value: string) =>
    full.replace(value, maskSecretValue(value)),
  )
}

function maskSecretValue(value: string): string {
  const normalized = normalizeSecretValue(value)
  if (normalized.length <= 8) return '***'
  return `${normalized.slice(0, 3)}…${normalized.slice(-3)}`
}

function normalizeSecretValue(value: string): string {
  return value.trim().replace(/^[<[{("'`]+|[>\])}."'`,;:]+$/g, '')
}

function isPlaceholderSecretValue(value: string): boolean {
  const normalized = normalizeSecretValue(value)
  if (!normalized) return true
  if (PLACEHOLDER_SECRET_RE.test(normalized)) return true

  const lower = normalized.toLowerCase()
  return (
    lower.includes('your_') ||
    lower.includes('_here') ||
    lower.includes('example') ||
    lower.includes('placeholder') ||
    lower.includes('redacted')
  )
}

function hasHighEntropyShape(value: string): boolean {
  const normalized = normalizeSecretValue(value)
  if (COMMON_SECRET_VALUE_RE.test(normalized)) return true
  if (normalized.length < 16) return false

  const hasLower = /[a-z]/.test(normalized)
  const hasUpper = /[A-Z]/.test(normalized)
  const hasDigit = /[0-9]/.test(normalized)
  const hasSymbol = /[^A-Za-z0-9]/.test(normalized)
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length

  return classes >= 3 && !/(.)\1{5,}/.test(normalized)
}

function findingOf(
  text: string,
  index: number,
  level: SensitivityLevel,
  category: string,
): SensitivityFinding {
  return {
    level,
    category,
    ...positionOf(text, index),
    snippet: lineSnippet(text, index),
  }
}

function detectSecretKeyFindings(text: string): SensitivityFinding[] {
  SECRET_ASSIGNMENT_RE.lastIndex = 0
  const findings: SensitivityFinding[] = []

  const privateKey = PRIVATE_KEY_BLOCK_RE.exec(text)
  if (privateKey?.index != null) {
    findings.push(findingOf(text, privateKey.index, 'forbidden', 'secret_key'))
  }

  for (const match of text.matchAll(SECRET_ASSIGNMENT_RE)) {
    const value = match[1] ?? ''
    if (isPlaceholderSecretValue(value)) continue
    if (hasHighEntropyShape(value)) {
      findings.push(findingOf(text, match.index ?? 0, 'forbidden', 'secret_key'))
    }
  }

  return findings
}

function detectPatternFindings(
  text: string,
  level: SensitivityLevel,
  patterns: Array<{ re: RegExp; category: string }>,
): SensitivityFinding[] {
  const findings: SensitivityFinding[] = []
  for (const { re, category } of patterns) {
    const match = re.exec(text)
    if (match?.index != null) {
      findings.push(findingOf(text, match.index, level, category))
    }
  }
  return findings
}

function strongestLevel(findings: SensitivityFinding[]): SensitivityLevel {
  if (findings.some((f) => f.level === 'forbidden')) return 'forbidden'
  if (findings.some((f) => f.level === 'sensitive')) return 'sensitive'
  return 'clean'
}

export function inspectPromptSensitivity(
  messages: Array<{ role: string; content?: string | null }>,
): SensitivityInspection {
  const text = extractText(messages)
  const findings = [
    ...detectSecretKeyFindings(text),
    ...detectPatternFindings(text, 'forbidden', FORBIDDEN_PATTERNS),
    ...detectPatternFindings(text, 'sensitive', SENSITIVE_PATTERNS),
  ]
  const level = strongestLevel(findings)
  return {
    level,
    matchedCategory: findings.find((f) => f.level === level)?.category,
    findings,
  }
}

export function classifyPrompt(
  messages: Array<{ role: string; content?: string | null }>,
): SensitivityDecision {
  const { level, matchedCategory } = inspectPromptSensitivity(messages)
  return { level, matchedCategory }
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
