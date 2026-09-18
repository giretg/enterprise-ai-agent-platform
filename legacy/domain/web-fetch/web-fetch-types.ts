/**
 * Web Fetch (WS-D) — adatmodell és tool-kontraktus típusok
 * (Feature-spec — WebFetch-Egress §7). A platform egyetlen új kimenő-hálózati
 * felülete; deny-by-default, defense-in-depth.
 */

/** PlatformSetting kulcs a web_fetch globális kill-switchhez (§7.2/1, §14). */
export const WEB_FETCH_CONTROLS_KEY = 'web_fetch.controls'

/** Content-type allowlist (§7.2/8) — csak szöveges/strukturált doksi-alak. */
export const WEB_FETCH_ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/json',
  'text/plain',
  'application/xml',
  'text/xml',
  'text/markdown',
  'application/x-yaml',
  'text/yaml',
] as const

export type WebFetchLimits = {
  /** Méret-cap bájtban (§7.2/9, WEB_FETCH_MAX_BYTES). */
  maxBytes: number
  /** Fetch timeout ms-ban (§7.2/7, WEB_FETCH_TIMEOUT_MS). */
  timeoutMs: number
  /** Sanitizált tartalom-hossz/forrás (§7.2/10, WEB_DISCOVERY_MAX_CONTENT_CHARS). */
  maxContentChars: number
}

export const DEFAULT_WEB_FETCH_LIMITS: WebFetchLimits = {
  maxBytes: 1_572_864,
  timeoutMs: 8_000,
  maxContentChars: 20_000,
}

export function resolveWebFetchLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): WebFetchLimits {
  const num = (v: string | undefined, fallback: number): number => {
    const n = v ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    maxBytes: num(env.WEB_FETCH_MAX_BYTES, DEFAULT_WEB_FETCH_LIMITS.maxBytes),
    timeoutMs: num(env.WEB_FETCH_TIMEOUT_MS, DEFAULT_WEB_FETCH_LIMITS.timeoutMs),
    maxContentChars: num(env.WEB_DISCOVERY_MAX_CONTENT_CHARS, DEFAULT_WEB_FETCH_LIMITS.maxContentChars),
  }
}

/** A web-egress role forrás-osztályai. Az `unknown` a tenant-allowlistolt kereskedelmi host. */
export type WebFetchSourceType = 'official' | 'vendor_doc' | 'news' | 'blog' | 'unknown'

export const WEB_FETCH_PDF_CONTENT_TYPE = 'application/pdf'

/** Fetch-budget állapot (§7.2/11) — a számlálást a hívó végzi, a service csak kapuz. */
export type WebFetchBudget = {
  perDiscoveryUsed: number
  perDiscoveryMax: number
  perAgentDayUsed: number
  perAgentDayMax: number
}

export const DEFAULT_WEB_FETCH_BUDGET_MAX = {
  perDiscovery: 2,
  perAgentDay: 50,
} as const

export type WebFetchBlockedReason =
  | 'web_fetch_disabled'
  | 'url_not_in_conversation'
  | 'fetch_budget_exceeded'
  | 'invalid_url'
  | 'scheme_blocked'
  | 'ssrf_blocked'
  | 'egress_not_allowlisted'
  | 'redirect_blocked'
  | 'content_type_blocked'
  | 'too_large'
  | 'fetch_failed'

export type WebFetchOk = {
  ok: true
  host: string
  sourceType?: WebFetchSourceType
  contentType: string
  bytes: number
  /** A sanitizált tartalom sha256-prefixe (reprodukálhatóság, §6.1). */
  contentHash: string
  /** A fetch-elt URL sha256-prefixe — a nyers URL SOSEM kerül auditba (§7.3, §11.3). */
  urlHash: string
  /** A sanitizált, hossz-limitált szöveg — CSAK a hívónak (drafting), sosem auditba. */
  text: string
  /** Igaz, ha a nyers tartalom hosszabb volt, mint a megengedett karakter-limit. */
  truncated?: boolean
  /** HTML-lapon talált HTTPS PDF-linkek (sanitizálás előtt kinyerve, sapkázva). */
  links?: Array<{ url: string; text: string }>
  /** PDF oldalszám, ha a kinyerés ismeri. */
  pageCount?: number
  /** Üres / tört / jelszavas PDF notice — a kutatás fail-soft jelzése. */
  notice?: string
}

export type WebFetchBlocked = {
  ok: false
  reason: WebFetchBlockedReason
  detail?: string
}

export type WebFetchResult = WebFetchOk | WebFetchBlocked

/**
 * Audit-metaadat egy web_fetch hívásról (§11.1). SOSEM tartalmaz nyers URL-t vagy
 * tartalmat — csak hash-prefix + host + méret + státusz (§7.3, §11.3, WF-N10).
 */
export type WebFetchAuditMeta = {
  urlHash: string
  host: string
  sourceType?: WebFetchSourceType
  bytes: number
  contentHash?: string
  status: 'ok' | 'blocked'
  reason?: WebFetchBlockedReason
  /** `html` | `pdf` | a blokkolt válasz MIME-alapja — nyers URL/tartalom nélkül. */
  contentType?: string
  /** Igaz, ha ez a fetch egy HTML→PDF hop volt. */
  hop?: boolean
}

/** Tool Broker `web_fetch` args (§7.4) — a hívó a search-találat URL-jét adja át. */
export type WebFetchArgs = {
  url: string
  sourceType?: WebFetchSourceType
}
