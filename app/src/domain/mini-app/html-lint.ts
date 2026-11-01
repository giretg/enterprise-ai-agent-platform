/**
 * Mini app HTML-kapu (#967 §5.2) — a legacy `html-validator.ts` átemelve.
 * Determinisztikus, regex-alapú statikus lint: a hard-fail szabályok elutasítanak,
 * a figyelmeztetések a verzió mellé kerülnek. A védelem a CSP (§5.3), ez csak jelzés.
 * A HTML-t SOHA nem logoljuk — csak a találatok kódját.
 */
import { createHash } from 'node:crypto'

export const MINI_APP_DEFAULT_MAX_BYTES = 1024 * 1024

type Rule = { code: string; pattern: RegExp }

const HARD_FAIL_RULES: Rule[] = [
  { code: 'iframe_tag', pattern: /<iframe[\s>]/i },
  { code: 'object_tag', pattern: /<object[\s>]/i },
  { code: 'embed_tag', pattern: /<embed[\s>]/i },
  { code: 'form_tag', pattern: /<form[\s>]/i },
]

const WARNING_RULES: Rule[] = [
  { code: 'external_script', pattern: /<script[^>]*\ssrc\s*=/i },
  { code: 'external_stylesheet', pattern: /<link[^>]*\shref\s*=\s*["']?https?:/i },
  { code: 'fetch_call', pattern: /\bfetch\s*\(/ },
  { code: 'xhr', pattern: /\bXMLHttpRequest\b/ },
  { code: 'websocket', pattern: /\bWebSocket\b/ },
  { code: 'event_source', pattern: /\bEventSource\b/ },
  { code: 'document_cookie', pattern: /document\s*\.\s*cookie/ },
  { code: 'local_storage', pattern: /\blocalStorage\b/ },
  { code: 'session_storage', pattern: /\bsessionStorage\b/ },
  { code: 'window_top', pattern: /window\s*\.\s*top\b/ },
  { code: 'parent_post_message', pattern: /parent\s*\.\s*postMessage/ },
]

export type MiniAppLintResult = { errors: string[]; warnings: string[] }

export function lintMiniAppHtml(html: string): MiniAppLintResult {
  return {
    errors: HARD_FAIL_RULES.filter((rule) => rule.pattern.test(html)).map((rule) => rule.code),
    warnings: WARNING_RULES.filter((rule) => rule.pattern.test(html)).map((rule) => rule.code),
  }
}

/**
 * Az útmutató-szöveg ütközései a platform-szabályokkal (§3.7 `conflicts`):
 * ugyanazok a kódok, amelyeket a lint egy ilyen HTML-re adna.
 */
export function guideConflicts(guide: string): string[] {
  const { errors, warnings } = lintMiniAppHtml(guide)
  const conflicts = [...errors, ...warnings]
  // Külső betűtípus/CDN-hivatkozás szövegesen is (pl. "Google Fonts-ról töltsd be").
  if (/https?:\/\/\S+\.(css|js|woff2?|ttf)\b|fonts\.googleapis|cdn\.jsdelivr|unpkg\.com/i.test(guide)) {
    conflicts.push('external_resource')
  }
  return [...new Set(conflicts)]
}

export function miniAppByteSize(html: string): number {
  return Buffer.byteLength(html, 'utf8')
}

/** sha256 hex CRLF→LF normalizálás után (§4), hogy a sorvég-eltérés ne adjon új verziót. */
export function miniAppContentHash(html: string): string {
  return createHash('sha256').update(html.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}
