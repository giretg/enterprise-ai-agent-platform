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
import {
  FORBIDDEN_PATH_PATTERNS,
  SECRET_LIKE_PATTERNS,
} from '@/domain/net/untrusted-patterns'
import { matchForbiddenHost } from '@/domain/net/egress-guard'
import { findOverlappingHttpApiEndpoints } from '@/domain/connector/http-api-client'
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
    oauthCompleteness: CheckStatus
  }
  warnings: string[]
  errors: string[]
  /**
   * A tenant egress-allowliston MÉG NEM szereplő cél-hostok (§9). First-class kimenet,
   * hogy a felfedezés UX-e „Egress-host hozzáadása" akciót ajánlhasson (ma csak üzenetben
   * volt). Egy vadonatúj API hostja definíció szerint itt jelenik meg — ez a NORMÁL eset,
   * nem hiba: a `warned` (nem-banki) állapotot az admin explicit, auditált aktussal oldja fel.
   */
  unknownHosts: string[]
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
  for (const url of [config.auth.tokenUrl, config.auth.userInfoUrl]) {
    const host = typeof url === 'string' ? hostOf(url) : null
    if (host) declaredHosts.add(host)
  }

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
    const forbidden = matchForbiddenHost(host)
    if (forbidden) {
      forbiddenPatterns = 'failed'
      errors.push(`forbidden_host_pattern:${forbidden}`)
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

  // 4b) Átfedő végpont-sablonok: pl. `GET /{id}` minden egyszegmenses GET-et enged,
  //     a `GET /act_{id}`-t is. Futásidőben a specifikusabb nyer, de a tág sablon
  //     szélesebb allowlistet ad, mint amit az admin valószínűleg szánt — jelzés.
  for (const [a, b] of findOverlappingHttpApiEndpoints(config.proposedTools)) {
    warnings.push(`endpoint_templates_overlap: ${a} ↔ ${b}`)
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

  // 6) OAuth2-teljesség — authMode-tudatos, mert a két futásidejű út MÁS mezőket követel:
  //
  //    • service / agent_owned oauth2: a http-api-kliens client_credentials token-refresht
  //      végez az abszolút `auth.tokenUrl`-ról (nincs provider-default) → e nélkül minden
  //      hívás elhasal. A `clientId`-t az aktiválás külön kapuja kényszeríti ki (fail-fast).
  //
  //    • user_delegated oauth2: a per-user Bearer-tokent a ConnectorGrantService szerzi a
  //      consent-flow-ban (authUrl/tokenUrl/scopes). Ezek provider-névtől függetlenül
  //      explicit config-mezők: a sablon-materializer tölti őket, futásidőben nincs
  //      Google- vagy hostnév-tippelés. A `clientId` itt is aktiváláskor jön
  //      (auth.clientId / activate-param), ezért itt nem duplikáljuk. Az aktiválás a
  //      delegált draftot `auth.scheme=bearer` + `oauth` blokk runtime-alakra normalizálja.
  let oauthCompleteness: CheckStatus = 'passed'
  if (config.auth.type === 'oauth2') {
    const tokenUrl = typeof config.auth.tokenUrl === 'string' ? config.auth.tokenUrl.trim() : ''
    const tokenUrlOk = /^https?:\/\//i.test(tokenUrl)
    if (config.authMode === 'user_delegated') {
      const authUrl = typeof config.auth.authUrl === 'string' ? config.auth.authUrl.trim() : ''
      const authUrlOk = /^https?:\/\//i.test(authUrl)
      if (!authUrlOk || !tokenUrlOk) {
        oauthCompleteness = 'failed'
        errors.push('oauth2_delegated_missing_endpoints')
      }
    } else if (!tokenUrlOk) {
      oauthCompleteness = 'failed'
      errors.push('oauth2_missing_token_url')
    }
  }

  const status = worst(
    egressAllowlist,
    forbiddenPatterns,
    secretInline,
    writeToolsFlagged,
    scopeMinimization,
    oauthCompleteness,
  )

  return {
    status,
    checks: {
      egressAllowlist,
      scopeMinimization,
      forbiddenPatterns,
      secretInline,
      writeToolsFlagged,
      oauthCompleteness,
    },
    warnings,
    errors,
    unknownHosts: unknownHosts.sort(),
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
