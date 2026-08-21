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
import {
  STREAM_BUFFER_LIMITS,
  StreamingPendingBuffer,
  drainStreamingPending,
  findOverlapFlushCut,
  type StreamDrainAction,
} from './streaming-text-buffer'

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

/**
 * 16-19 digit sequence (broad card-like number match for unknown issuers).
 * Szándékosan NEM enged `\s` (újsort): különben két egymás utáni tool-üzenet
 * szegélyén (pl. kb_search JSON vége + gmail_search eleje) hamis pozitív keletkezik.
 */
const CARD_BROAD_RE = /\b[0-9]{4}(?:[ \t\-][0-9]{4}){2}[ \t\-][0-9]{3,7}\b/

/** Hungarian TAJ szám (social security, 9 digits). */
const TAJ_RE = /\b[0-9]{3}-[0-9]{3}-[0-9]{3}\b/

/** Hungarian adószám (tax ID, 11 digits). */
const ADOSZAM_RE = /\b[0-9]{8}-[1-5]-[0-9]{2}\b/

/** IBAN — ISO 13616, basic structural match (kompakt). */
const IBAN_RE = /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}(?:[A-Z0-9]{0,16})?\b/

/** IBAN csoportok szóközzel (email aláírás, számlák): HU42 1177 3016 … */
const IBAN_SPACED_RE = /\b[A-Z]{2}[0-9]{2}(?:[ \t][A-Z0-9]{4}){2,7}(?:[ \t][A-Z0-9]{1,4})?\b/

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

/**
 * Magyar (és nemzetközi) telefonszám. Az osztályozó SZINTJÉT nem érinti — ez a
 * minta kizárólag a privacy-transzformáció (APG-12) találati halmazába kerül,
 * mert a `phone` kategória alapértelmezett akciója `tokenize`. Ha a `sensitive`
 * szintre is beszámítana, minden telefonszámot tartalmazó beszélgetés helyi
 * modellre kényszerülne — pont az a UX-csapda, amit a #272 megszüntet.
 */
const PHONE_RE =
  /(?<![0-9A-Za-z])(?:\+36|0036|06)[ \t.\-/]?(?:\(?[1-9][0-9]?\)?)[ \t.\-/]?[0-9]{3}[ \t.\-/]?[0-9]{2}[ \t.\-/]?[0-9]{2}(?![0-9])|(?<![0-9A-Za-z+])\+(?!36)[1-9][0-9]{0,2}[ \t.\-/]?(?:[0-9][ \t.\-/]?){6,12}[0-9](?![0-9])/g

/**
 * Magyar bankszámlaszám: 2×8 vagy 3×8 számjegy kötőjellel (GIRO alak).
 * Az adószám (8-1-2) és a TAJ (3-3-3) alakja ettől eltér, így nem ütközik.
 */
const ACCOUNT_RE = /\b[0-9]{8}-[0-9]{8}(?:-[0-9]{8})?\b/g

/**
 * Csak a privacy-transzformáció találatai (a redakció és az osztályozó szint
 * változatlan marad). A `phone`/`account` a surrogate-névtér tagja (§11), és a
 * kategória-policy alapból `tokenize`-t ír elő rájuk — felismerés nélkül a
 * policy üres ígéret volt: ENFORCE-ban sem cserélődött semmi.
 */
const PRIVACY_ENTITY_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: ACCOUNT_RE, category: 'account' },
  { re: PHONE_RE, category: 'phone' },
]

/** Hungarian personal name patterns: two uppercase-starting words. Very broad, used as soft signal. */
// Not used as forbidden — only contributes to "sensitive" tier.

const SENSITIVE_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: TAJ_RE, category: 'taj' },
  { re: ADOSZAM_RE, category: 'adoszam' },
  { re: EMAIL_RE, category: 'email' },
]

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * A prompt minden olyan része, ami ténylegesen kimegy a providerhez.
 *
 * A `tool` szerepű üzenetek is ide tartoznak: a gateway a teljes `messages`
 * tömböt fűzi promptba, így egy `gmail_get_message` nyers válasza épp úgy
 * elhagyja a platformot, mint a felhasználó gépelt szövege. Korábban csak a
 * `user`/`assistant` üzeneteket néztük, és a tool-eredményben érkező PAN/IBAN
 * osztályozás nélkül ment ki külső providerhez.
 *
 * A `system` üzenetek szándékosan kimaradnak: azokat a platform állítja elő
 * (tool-instrukció, skill-szöveg), nem felhasználói adatforrás. A memória-chunk
 * injektálás ezen a résen még átfér — l. a router-redesign specet.
 */
function extractText(messages: Array<{ role: string; content?: string | null }>): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
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

type TextSpan = { start: number; end: number }

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

/** ISO/IEC 7812 Luhn — valódi kártyaszámokra igaz, rendelésszám/IBAN-részletekre általában nem. */
function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum % 10 === 0
}

function collectTextSpans(text: string, re: RegExp): TextSpan[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const global = new RegExp(re.source, flags)
  const spans: TextSpan[] = []
  for (const match of text.matchAll(global)) {
    if (match.index != null) {
      spans.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  return spans
}

function isWithinSpan(start: number, end: number, spans: TextSpan[]): boolean {
  return spans.some((span) => start >= span.start && end <= span.end)
}

function normalizeIbanCandidate(value: string): string {
  return value.replace(/[\s\t-]/g, '').toUpperCase()
}

/** ISO 13616 mod-97 — strukturális regex után kizárja a véletlen számsorokat. */
function passesIbanMod97(value: string): boolean {
  const compact = normalizeIbanCandidate(value)
  if (compact.length < 15 || compact.length > 34) return false
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(compact)) return false

  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const expanded = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55).toString() : ch
    for (const digit of expanded) {
      remainder = (remainder * 10 + Number(digit)) % 97
    }
  }
  return remainder === 1
}

const IBAN_PATTERNS = [IBAN_RE, IBAN_SPACED_RE] as const

function collectValidIbanSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = []
  for (const re of IBAN_PATTERNS) {
    for (const span of collectTextSpans(text, re)) {
      const candidate = text.slice(span.start, span.end)
      if (passesIbanMod97(candidate)) {
        spans.push(span)
      }
    }
  }
  return spans
}

function detectIbanFindings(text: string, ibanSpans: TextSpan[]): SensitivityFinding[] {
  const span = ibanSpans[0]
  return span ? [findingOf(text, span.start, 'forbidden', 'iban')] : []
}

function detectPaymentCardFindings(text: string, ibanSpans: TextSpan[]): SensitivityFinding[] {
  const patterns: Array<{ re: RegExp; category: 'pan' | 'card_broad' }> = [
    { re: PAN_RE, category: 'pan' },
    { re: CARD_BROAD_RE, category: 'card_broad' },
  ]

  for (const { re, category } of patterns) {
    for (const span of collectTextSpans(text, re)) {
      if (isWithinSpan(span.start, span.end, ibanSpans)) continue
      const digits = digitsOnly(text.slice(span.start, span.end))
      if (!passesLuhn(digits)) continue
      return [findingOf(text, span.start, 'forbidden', category)]
    }
  }

  return []
}

function detectForbiddenFindings(text: string): SensitivityFinding[] {
  const ibanSpans = collectValidIbanSpans(text)
  return [
    ...detectSecretKeyFindings(text),
    ...detectIbanFindings(text, ibanSpans),
    ...detectPaymentCardFindings(text, ibanSpans),
  ]
}

const FORBIDDEN_CATEGORY_LABELS: Record<string, string> = {
  pan: 'bankkártyaszám',
  card_broad: 'bankkártya-szerű szám',
  iban: 'IBAN számlaszám',
  secret_key: 'privát kulcs vagy API token',
}

/** Emberi olvasható hibaüzenet a chatben / ticketben — külön jelzi a tiltott vs érzékeny szintet. */
export function formatSensitivityBlockMessage(category?: string): string {
  const label = category ? (FORBIDDEN_CATEGORY_LABELS[category] ?? category) : 'tiltott tartalom'
  return (
    `A modellhívás tiltva: ${label} észlelhető a promptban (kategória: ${category ?? 'ismeretlen'}). ` +
    `Ez tiltott tartalom — az agent „Érzékeny tartalom külső modellnek is küldhető” kapcsolója csak email/TAJ/adószám esetén segít, ` +
    `bankkártyára, IBAN-ra és privát kulcsra nem. Ha hamis riasztásnak tűnik, nézd meg az audit log sensitivity sorát.`
  )
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
    ...detectForbiddenFindings(text),
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
  /**
   * Whether a local model is actually deployed in this environment.
   *
   * Fail-closed: alapból `false`. Managed környezetben (App Hosting) nincs
   * Ollama-sidecar, ezért a `sensitive` prompt nem irányítható sehová — ilyenkor
   * a gateway blokkol, ahelyett hogy egy nem létező localhost-ra hívna és nyers
   * `fetch failed`-del elhalna. Explicit opt-in kell hozzá.
   */
  localModelAvailable: boolean
}

export const DEFAULT_SENSITIVITY_POLICY: SensitivityPolicy = {
  enforceLocalForSensitive: true,
  localProvider: 'ollama',
  localModel: 'gemma-local',
  localModelAvailable: false,
}

/**
 * Env-vezérelt policy. A célmodell azért állítható, mert nem minden telepítésben
 * Ollama a helyi backend; a redesign ezt majd tenant-szintű konfigba emeli.
 */
export function sensitivityPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SensitivityPolicy {
  return {
    enforceLocalForSensitive: env.SENSITIVITY_ENFORCE_LOCAL !== 'false',
    localProvider: env.SENSITIVITY_LOCAL_PROVIDER || DEFAULT_SENSITIVITY_POLICY.localProvider,
    localModel: env.SENSITIVITY_LOCAL_MODEL || DEFAULT_SENSITIVITY_POLICY.localModel,
    localModelAvailable: env.SENSITIVITY_LOCAL_MODEL_AVAILABLE === 'true',
  }
}

/**
 * Mely találatok kérnek emberi jóváhagyást provisioning / admin felületen, mielőtt
 * külső modellhez menne a prompt. A `forbidden` mindig review-köteles (kivéve agent
 * bypass); a `sensitive` csak akkor, ha nincs elérhető helyi modell a környezetben.
 */
export function reviewableSensitivityFindings(
  findings: SensitivityFinding[],
  options: {
    /** @deprecated APG-11: használd a `categoryAllowsExternal` callbackot. */
    allowSensitiveExternalModel?: boolean
    /** Kategória-policy `allow` — az adott finding nem kér review-t. */
    categoryAllowsExternal?: (category: string) => boolean
    /** Ha megvan, a hívó már jóváhagyta — nem kérünk újra review-t. */
    sensitivityReviewAccepted?: boolean
  } = {},
): SensitivityFinding[] {
  if (options.allowSensitiveExternalModel || options.sensitivityReviewAccepted) return []
  const policy = sensitivityPolicyFromEnv()
  return findings.filter((f) => {
    if (options.categoryAllowsExternal?.(f.category)) return false
    if (f.level === 'forbidden') return true
    if (f.level === 'sensitive') {
      return policy.enforceLocalForSensitive && !policy.localModelAvailable
    }
    return false
  })
}

// ── Outbound content-guard (redakció) ─────────────────────────────────────────

/**
 * Chat "thinking-trace" spec §D5/E2 — a modell gondolkodási (reasoning) szövege
 * ugyanazon a tartalom-őrön megy át, mint a normál asszisztens-válasz, MIELŐTT a
 * kliensre kerül. A reasoning gyakran több nyers kontextust (tool-eredményből
 * származó PII/titok) tartalmaz, mint a végső válasz, ezért ugyanazokat a tiltott
 * (PAN/IBAN/kártya/titok/privát kulcs) és érzékeny (TAJ/adószám/email) mintákat
 * maszkoljuk, amiket a bejövő osztályozó is felismer.
 *
 * A pre-flight osztályozóval szemben ez NEM blokkol, hanem *redaktál*: a talált
 * részt egy jelölővel cseréli, a többi szöveget változatlanul hagyja.
 */
const REDACTION_CATEGORY_LABELS: Record<string, string> = {
  pan: 'bankkártyaszám',
  card_broad: 'bankkártya-szerű szám',
  iban: 'IBAN',
  secret_key: 'titok',
  taj: 'TAJ',
  adoszam: 'adószám',
  email: 'email',
}

type RedactionSpan = TextSpan & { category: string }

/** Osztályozó-találat offsettel — a prompt-privacy transzformáció (APG-12) ebből cserél. */
export type SensitivityMatchSpan = TextSpan & { category: string; value: string }

export function collectSensitivityMatchSpans(text: string): SensitivityMatchSpan[] {
  if (!text) return []
  const spans = collectRedactionSpans(text)
  // A privacy-entitások (telefon, bankszámla) csak akkor kerülnek be, ha nem
  // lógnak bele egy erősebb találatba (IBAN, PAN, titok) — átfedő spanoknál a
  // csere offsetjei csúsznának el, és maszkolatlan részlet menne ki.
  for (const { re, category } of PRIVACY_ENTITY_PATTERNS) {
    for (const span of collectTextSpans(text, re)) {
      if (isWithinSpan(span.start, span.end, spans)) continue
      if (spans.some((other) => span.start < other.end && span.end > other.start)) continue
      spans.push({ ...span, category })
    }
  }
  return spans.map((span) => ({
    ...span,
    value: text.slice(span.start, span.end),
  }))
}

function collectRedactionSpans(text: string): RedactionSpan[] {
  const spans: RedactionSpan[] = []

  // Privát kulcs blokk: a fejléctől a záró sorig (vagy a szöveg végéig) — a
  // base64 törzs önmagában is titok, ezért az egész blokkot redaktáljuk.
  const pkStart = text.search(PRIVATE_KEY_BLOCK_RE)
  if (pkStart >= 0) {
    const endMatch = /-----END [A-Z ]*PRIVATE KEY-----/i.exec(text.slice(pkStart))
    const end = endMatch ? pkStart + endMatch.index + endMatch[0].length : text.length
    spans.push({ start: pkStart, end, category: 'secret_key' })
  }

  // Titok-hozzárendelések: csak a valódi (nem placeholder, magas-entrópiájú)
  // ÉRTÉK részt maszkoljuk, a kulcsot (pl. `api_key:`) meghagyjuk kontextusnak.
  SECRET_ASSIGNMENT_RE.lastIndex = 0
  for (const match of text.matchAll(SECRET_ASSIGNMENT_RE)) {
    const value = match[1] ?? ''
    if (!value || isPlaceholderSecretValue(value) || !hasHighEntropyShape(value)) continue
    const base = match.index ?? 0
    const rel = match[0].lastIndexOf(value)
    const start = base + (rel >= 0 ? rel : 0)
    spans.push({ start, end: start + value.length, category: 'secret_key' })
  }

  const ibanSpans = collectValidIbanSpans(text)
  for (const span of ibanSpans) spans.push({ ...span, category: 'iban' })

  for (const { re, category } of [
    { re: PAN_RE, category: 'pan' },
    { re: CARD_BROAD_RE, category: 'card_broad' },
  ] as const) {
    for (const span of collectTextSpans(text, re)) {
      if (isWithinSpan(span.start, span.end, ibanSpans)) continue
      if (!passesLuhn(digitsOnly(text.slice(span.start, span.end)))) continue
      spans.push({ ...span, category })
    }
  }

  for (const { re, category } of SENSITIVE_PATTERNS) {
    for (const span of collectTextSpans(text, re)) spans.push({ ...span, category })
  }

  return spans
}

export function redactSensitiveText(text: string): { text: string; redactedCount: number } {
  if (!text) return { text, redactedCount: 0 }

  const spans = collectRedactionSpans(text).sort((a, b) => a.start - b.start || b.end - a.end)

  // Átfedő találatok összevonása (pl. IBAN a titok-értéken belül) — az első
  // kategória marad, a hosszabb vég nyer.
  const merged: RedactionSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start < last.end) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ ...span })
  }

  if (merged.length === 0) return { text, redactedCount: 0 }

  let out = ''
  let cursor = 0
  for (const span of merged) {
    out += text.slice(cursor, span.start)
    out += `«redaktált:${REDACTION_CATEGORY_LABELS[span.category] ?? span.category}»`
    cursor = span.end
  }
  out += text.slice(cursor)
  return { text: out, redactedCount: merged.length }
}

/**
 * Stateful outbound guard reasoning-summary streamekhez.
 *
 * A guard csak teljes sorokat ad tovább, ezért a delta-határon szétszakadó
 * PAN/IBAN/email/titok tokeneket mindig egyben látja. A PEM privátkulcs-blokkot
 * a BEGIN sortól az END sorig visszatartja, mert annak base64 törzse önmagában
 * már nem ismerhető fel biztonságosan. A `finish()` a turn végén a maradékot is
 * redaktálva üríti.
 */
export class StreamingSensitiveTextRedactor {
  private static readonly PRIVATE_KEY_END_TAIL_CHARS = 96
  private readonly buffer = new StreamingPendingBuffer()
  private suppressingOpaqueToken = false
  private insidePrivateKey = false
  private privateKeyTail = ''

  constructor(private readonly emit: (text: string) => void) {}

  push(delta: string): void {
    if (!delta) return
    let next = delta
    if (this.insidePrivateKey) {
      const keyStream = this.privateKeyTail + next
      const privateKeyEnd = /-----END [A-Z ]*PRIVATE KEY-----/i.exec(keyStream)
      if (!privateKeyEnd) {
        this.privateKeyTail = keyStream.slice(
          -StreamingSensitiveTextRedactor.PRIVATE_KEY_END_TAIL_CHARS,
        )
        return
      }
      this.insidePrivateKey = false
      this.privateKeyTail = ''
      next = keyStream.slice(privateKeyEnd.index + privateKeyEnd[0].length)
      if (!next) return
    }
    if (this.suppressingOpaqueToken) {
      const tokenEnd = next.search(/[\s,;]/)
      if (tokenEnd < 0) return
      this.suppressingOpaqueToken = false
      next = next.slice(tokenEnd + 1)
      if (!next) return
    }
    this.buffer.append(next)
    this.drain(false)
  }

  finish(): void {
    this.drain(true)
    this.suppressingOpaqueToken = false
    this.insidePrivateKey = false
    this.privateKeyTail = ''
  }

  private emitRedacted(chunk: string): void {
    if (!chunk) return
    const { text } = redactSensitiveText(chunk)
    if (text) this.emit(text)
  }

  private drain(final: boolean): void {
    drainStreamingPending(
      this.buffer,
      final,
      (pending, isFinal) => this.decide(pending, isFinal),
      (chunk) => this.emitRedacted(chunk),
    )
  }

  private decide(pending: string, final: boolean): StreamDrainAction {
    const privateKeyStart = pending.search(PRIVATE_KEY_BLOCK_RE)
    if (privateKeyStart >= 0) {
      if (privateKeyStart > 0) return { type: 'emit', count: privateKeyStart }

      const privateKeyEnd = /-----END [A-Z ]*PRIVATE KEY-----/i.exec(pending)
      if (!privateKeyEnd) {
        if (final) return { type: 'emit', count: pending.length }
        this.insidePrivateKey = true
        this.privateKeyTail = pending.slice(-StreamingSensitiveTextRedactor.PRIVATE_KEY_END_TAIL_CHARS)
        return { type: 'replace', consume: pending.length, emit: '«redaktált:titok»' }
      }
      return { type: 'emit', count: privateKeyEnd.index + privateKeyEnd[0].length }
    }

    const newline = pending.indexOf('\n')
    if (newline >= 0) return { type: 'emit', count: newline + 1 }

    const safeCut = this.findSafeProseCut(pending)
    if (safeCut > 0) return { type: 'emit', count: safeCut }

    if (!final && pending.length > STREAM_BUFFER_LIMITS.HARD_BUFFER_CHARS) {
      // Határoló nélküli, túl hosszú tokennél nem tudjuk bizonyítani, hogy nem
      // titok/email. Fail-closed: a teljes tokent elnyomjuk a következő valódi
      // tokenhatárig, így a memória korlátos és nyers részlet sem szivárog ki.
      this.suppressingOpaqueToken = true
      return {
        type: 'replace',
        consume: pending.length,
        emit: '«redaktált:hosszú, nem ellenőrizhető reasoning-token»',
      }
    }
    return { type: 'hold' }
  }

  private findSafeProseCut(pending: string): number {
    return findOverlapFlushCut(pending, (index) => {
      if (!/[ \t]/.test(pending[index] ?? '')) return false
      const previous = pending[index - 1] ?? ''
      const next = pending[index + 1] ?? ''
      // Számformátumon belül (PAN/IBAN/TAJ/adószám) soha ne vágjunk.
      if (/\d/.test(previous) || /\d/.test(next)) return false
      const lineStart = pending.lastIndexOf('\n', index - 1) + 1
      const beforeBoundary = pending.slice(lineStart, index + 1)
      // `api_key: <érték>` esetén a kulcs és az érték közti whitespace nem
      // biztonságos határ: a következő chunk elveszítené a hozzárendelés kontextusát.
      if (
        /(?:password|secret|api[_-]?key|token|auth[_-]?key|private[_-]?key)\s*[:=]\s*$/i.test(
          beforeBoundary,
        )
      ) {
        return false
      }
      return true
    })
  }
}
