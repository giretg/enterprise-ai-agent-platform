/**
 * Determinisztikus, szerveroldali policy-validátor a generált connector-draftra
 * (Feature-spec — Provisioning-Assistant §4.4, §7.2). FONTOS: ez NEM az LLM
 * önellenőrzése — sima, regex/halmaz-alapú kód. A bemenet (API-doksi → draft)
 * megbízhatatlan külső input (OWASP LLM01/LLM06), ezért a biztonsági döntés ide,
 * az LLM-en kívülre kerül.
 *
 * A `config` TARTALMÁT (host-neveket, tool-path-okat) NEM logoljuk auditba —
 * csak a validáció kimenetét (checks/warnings/errors). A nyers találati értékek
 * a `warnings`/`errors` üzenetekbe rövidített/sanitizált formában mehetnek.
 */
import { WRITE_METHODS, type ConnectorConfig, type HttpMethod } from './connector-config'

export type CheckStatus = 'passed' | 'warned' | 'failed'

export type ValidationResult = {
  status: CheckStatus
  checks: {
    egressAllowlist: CheckStatus
    scopeMinimization: CheckStatus
    forbiddenPatterns: CheckStatus
    secretInline: CheckStatus
    writeToolsFlagged: CheckStatus
  }
  warnings: string[]
  errors: string[]
}

export type ValidatorOptions = {
  /** A tenant engedélyezett egress-célhostjai (deny-by-default egress-policy, §7.2). */
  egressAllowlist: string[]
  /**
   * Banki preset: ismeretlen egress-host `failed` (allowlist-only). Alapból
   * `warned` + admin-bővítés (§14/3.).
   */
  bankPreset?: boolean
}

// Exfiltráció-szerű / gyanús minták a baseUrl-ben, host-okban és tool-path-okban.
// (§7.2 — tiltott minták.) Determinisztikus, bővíthető lista.
const FORBIDDEN_HOST_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'raw_ip_host', pattern: /^\d{1,3}(\.\d{1,3}){3}$/ },
  { name: 'localhost_host', pattern: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i },
  // Felhő-metaadat endpoint (SSRF kanári).
  { name: 'metadata_host', pattern: /(169\.254\.169\.254|metadata\.google\.internal)/i },
  { name: 'known_exfil_sink', pattern: /(webhook\.site|requestbin|ngrok\.io|burpcollaborator)/i },
]

const FORBIDDEN_PATH_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'data_uri_path', pattern: /^data:/i },
  { name: 'file_uri_path', pattern: /^file:/i },
]

// Nyers secret/token gyanús minták a config-ban (§7.2 — inline-secret tiltás).
const SECRET_LIKE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'bearer_literal', pattern: /\bbearer\s+[A-Za-z0-9._\-]{12,}/i },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'long_hex_token', pattern: /\b[0-9a-f]{40,}\b/i },
  { name: 'jwt_like', pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/ },
]

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

function worst(...statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('warned')) return 'warned'
  return 'passed'
}

/**
 * Lefuttatja a teljes determinisztikus validációt. A hívó (provisioning-service)
 * a `status === 'failed'` esetén blokkolja az aktiválást (P5, PN1).
 */
export function validateDraftConfig(
  config: ConnectorConfig,
  opts: ValidatorOptions,
): ValidationResult {
  const warnings: string[] = []
  const errors: string[] = []

  const allowlist = new Set(opts.egressAllowlist.map((h) => h.toLowerCase()))

  // 1) Egress-allowlist: minden egressHost + a baseUrl host-ja az allowliston?
  const declaredHosts = new Set<string>(config.egressHosts.map((h) => h.toLowerCase()))
  const baseHost = hostOf(config.baseUrl)
  if (baseHost) declaredHosts.add(baseHost)

  const unknownHosts: string[] = []
  for (const host of declaredHosts) {
    if (!allowlist.has(host)) unknownHosts.push(host)
  }
  let egressAllowlist: CheckStatus = 'passed'
  if (unknownHosts.length > 0) {
    if (opts.bankPreset) {
      egressAllowlist = 'failed'
      errors.push(`egress_host_not_allowlisted: ${unknownHosts.join(', ')}`)
    } else {
      egressAllowlist = 'warned'
      warnings.push(`egress_host_not_allowlisted (admin-bővítés szükséges): ${unknownHosts.join(', ')}`)
    }
  }

  // 2) Tiltott minták: gyanús host / path (exfil-szerű). Mindig `failed`.
  let forbiddenPatterns: CheckStatus = 'passed'
  for (const host of declaredHosts) {
    for (const rule of FORBIDDEN_HOST_PATTERNS) {
      if (rule.pattern.test(host)) {
        forbiddenPatterns = 'failed'
        errors.push(`forbidden_host_pattern:${rule.name}`)
      }
    }
  }
  for (const tool of config.proposedTools) {
    for (const rule of FORBIDDEN_PATH_PATTERNS) {
      if (rule.pattern.test(tool.path)) {
        forbiddenPatterns = 'failed'
        errors.push(`forbidden_path_pattern:${rule.name}`)
      }
    }
  }

  // 3) Inline-secret tiltás: nyers token/secret a config-ban → `failed` (§7.2).
  let secretInline: CheckStatus = 'passed'
  const haystack = serializeForSecretScan(config)
  for (const rule of SECRET_LIKE_PATTERNS) {
    if (rule.pattern.test(haystack)) {
      secretInline = 'failed'
      errors.push(`inline_secret_detected:${rule.name}`)
    }
  }

  // 4) Write-tool flag: van-e mutáló tool → admin figyelmét igényli (§4.3).
  const writeTools = config.proposedTools.filter(
    (t) => t.access === 'write' || WRITE_METHODS.has(t.method as HttpMethod),
  )
  let writeToolsFlagged: CheckStatus = 'passed'
  if (writeTools.length > 0) {
    writeToolsFlagged = 'warned'
    warnings.push(`write_tools_present: ${writeTools.map((t) => t.name).join(', ')}`)
  }

  // 5) Scope-minimalizálás: minden kért scope indokolt-e a proposedTools-hoz?
  //    Heurisztika: csak olvasó toolokhoz tartozik write-scope → tág scope.
  let scopeMinimization: CheckStatus = 'passed'
  const hasWriteTool = writeTools.length > 0
  const writeScopes = config.scopesSuggested.filter((s) => /\b(write|admin|delete|manage|all|\*)\b/i.test(s))
  if (writeScopes.length > 0 && !hasWriteTool) {
    scopeMinimization = 'warned'
    warnings.push(`broad_scope_without_write_tool: ${writeScopes.join(', ')}`)
  }
  if (config.scopesSuggested.length === 0 && config.proposedTools.length > 0) {
    // Nincs megadott scope, de van tool — nem hibás, csak jelzés.
    scopeMinimization = worst(scopeMinimization, 'warned')
    warnings.push('no_scopes_declared_for_tools')
  }

  const status = worst(
    egressAllowlist,
    forbiddenPatterns,
    secretInline,
    writeToolsFlagged,
    scopeMinimization,
  )

  return {
    status,
    checks: { egressAllowlist, scopeMinimization, forbiddenPatterns, secretInline, writeToolsFlagged },
    warnings,
    errors,
  }
}

/**
 * A secret-szkenneléshez a config releváns string-mezőit fűzzük össze. A
 * `secretAliasSuggested` SZÁNDÉKOSAN kimarad — az csak egy alias-NÉV, nem secret.
 */
function serializeForSecretScan(config: ConnectorConfig): string {
  const parts: string[] = [config.provider, config.baseUrl, ...config.egressHosts]
  if (config.auth.headerName) parts.push(config.auth.headerName)
  parts.push(...config.scopesSuggested)
  for (const t of config.proposedTools) {
    parts.push(t.name, t.path)
    if (t.description) parts.push(t.description)
  }
  return parts.join('\n')
}
