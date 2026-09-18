/**
 * Szerveroldali HTML security-lint az A0 single-file apphoz
 * (Feature-spec — App Registry §6.4). Determinisztikus, regex-alapú statikus
 * ellenőrzés; nem helyettesíti a futásidejű CSP-t (§6.3), csak review-jelzést és
 * hard-fail kaput ad. A HTML-t SOHA nem logoljuk — csak a találatok kódját.
 */
import { SandboxAppError } from './errors'

export const DEFAULT_MAX_ARTIFACT_SIZE_BYTES = 1024 * 1024 // 1 MB (§3.4)

export type ValidationResult = {
  status: 'passed' | 'failed'
  warnings: string[]
  errors: string[]
}

type Rule = { name: string; pattern: RegExp }

// Hard fail: aktív beágyazás / form (§6.4). A preview iframe / CSP úgyis tiltaná,
// de a registrybe be sem engedjük.
const HARD_FAIL_RULES: Rule[] = [
  { name: 'iframe_tag', pattern: /<iframe[\s>]/i },
  { name: 'object_tag', pattern: /<object[\s>]/i },
  { name: 'embed_tag', pattern: /<embed[\s>]/i },
  { name: 'form_tag', pattern: /<form[\s>]/i },
]

// Warning: hálózat / tárolás / kitörés. CSP blokkolja, de review-hoz jelezzük (§6.4).
const WARNING_RULES: Rule[] = [
  { name: 'external_script', pattern: /<script[^>]*\ssrc\s*=/i },
  { name: 'fetch_call', pattern: /\bfetch\s*\(/ },
  { name: 'xhr', pattern: /\bXMLHttpRequest\b/ },
  { name: 'websocket', pattern: /\bWebSocket\b/ },
  { name: 'event_source', pattern: /\bEventSource\b/ },
  { name: 'document_cookie', pattern: /document\s*\.\s*cookie/ },
  { name: 'local_storage', pattern: /\blocalStorage\b/ },
  { name: 'session_storage', pattern: /\bsessionStorage\b/ },
  { name: 'window_top', pattern: /window\s*\.\s*top\b/ },
  { name: 'parent_post_message', pattern: /parent\s*\.\s*postMessage/ },
]

/**
 * Méret-ellenőrzés UTF-8 byte alapján. Túllépésnél hard hiba (§4.2/2., N2).
 */
export function assertArtifactSize(html: string, maxBytes: number): number {
  const sizeBytes = Buffer.byteLength(html, 'utf8')
  if (sizeBytes > maxBytes) {
    throw new SandboxAppError(
      'APP_ARTIFACT_TOO_LARGE',
      `Artifact ${sizeBytes} bytes exceeds limit ${maxBytes} bytes`,
      { sizeBytes, maxBytes },
    )
  }
  return sizeBytes
}

/**
 * Lefuttatja a statikus lintet. A hard-fail szabályok `status: 'failed'`-et
 * adnak (a hívó ekkor SandboxAppError-t dob és `sandbox_app.validation_failed`-et
 * auditál); a warningok nem blokkolnak, de eltárolódnak a verzió mellé.
 */
export function lintHtml(html: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  for (const rule of HARD_FAIL_RULES) {
    if (rule.pattern.test(html)) errors.push(rule.name)
  }
  for (const rule of WARNING_RULES) {
    if (rule.pattern.test(html)) warnings.push(rule.name)
  }

  return { status: errors.length > 0 ? 'failed' : 'passed', warnings, errors }
}
