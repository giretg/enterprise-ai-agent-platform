/**
 * Tenant-szintű Google-fiókkötés (Google Ads / Analytics / Search Console).
 *
 * Három szint, három tulajdonos:
 * - platform: a Google OAuth app és a Google Ads developer token (superadmin, PlatformSetting);
 * - tenant: MELYIK cégfiókot érheti el a konnektor (ez a kötés, `Connector.config.googleAccountBinding`);
 * - felhasználó: a saját Google-belépése (ConnectorGrant), amelynek joga kell legyen a kötött fiókhoz.
 *
 * A kötés futásidejű határ is: a modell csak a kötött fiók(ok)ra hívhat, mint a GitHub repo-scope-nál.
 * Kötés hiányában (régi konnektorok) a viselkedés visszafelé kompatibilisen korlátlan.
 */

export const GOOGLE_ACCOUNT_BINDING_PROVIDERS = [
  'google-ads',
  'google-analytics',
  'google-search-console',
] as const

export type GoogleAccountBindingProvider = (typeof GOOGLE_ACCOUNT_BINDING_PROVIDERS)[number]

export type GoogleAccountBinding = {
  /** Google Ads customer ID-k / GA4 property ID-k / Search Console property-k, normalizálva. */
  accountIds: string[]
  /** Csak Google Ads: MCC (manager) fiók, amelyen keresztül a kliensfiókot elérjük. */
  managerAccountId?: string
}

export const MAX_GOOGLE_BOUND_ACCOUNTS = 50

/** A GA4 közös (property-független) metadata-végpontja: properties/0/metadata. */
const GA4_UNIVERSAL_PROPERTY_ID = '0'

export class GoogleAccountBindingError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_account_id' | 'empty_binding' | 'too_many_accounts',
  ) {
    super(message)
    this.name = 'GoogleAccountBindingError'
  }
}

export function isGoogleAccountBindingProvider(
  provider: string | null | undefined,
): provider is GoogleAccountBindingProvider {
  return (GOOGLE_ACCOUNT_BINDING_PROVIDERS as readonly string[]).includes(provider ?? '')
}

/** Felhasználói/emberi címke a fiók fajtájához (UI, hibaüzenet, modell-leírás). */
export function googleAccountKindLabel(provider: GoogleAccountBindingProvider): string {
  if (provider === 'google-ads') return 'Google Ads fiók'
  if (provider === 'google-analytics') return 'Google Analytics (GA4) property'
  return 'Search Console property'
}

/** Google Ads customer ID: 123-456-7890 vagy 1234567890 → 1234567890. */
export function normalizeGoogleAdsCustomerId(raw: string): string {
  const digits = raw.trim().replace(/[\s-]/g, '')
  if (!/^\d{10}$/.test(digits)) {
    throw new GoogleAccountBindingError(
      `A Google Ads fiókazonosító 10 számjegy (pl. 123-456-7890): ${raw.trim()}`,
      'invalid_account_id',
    )
  }
  return digits
}

/** GA4 property ID: 123456789 vagy properties/123456789 → 123456789. */
export function normalizeGa4PropertyId(raw: string): string {
  const value = raw.trim().replace(/^properties\//i, '')
  if (!/^\d{1,20}$/.test(value) || value === GA4_UNIVERSAL_PROPERTY_ID) {
    throw new GoogleAccountBindingError(
      `A GA4 property ID egy szám (Admin → Property settings, pl. 123456789): ${raw.trim()}`,
      'invalid_account_id',
    )
  }
  return value
}

/**
 * Search Console property: URL-előtagos (https://www.example.com/) vagy domain-property
 * (sc-domain:example.com). Az URL-előtagos alak mindig záró perjellel tárolódik, ahogy a Google is.
 */
export function normalizeSearchConsoleSiteUrl(raw: string): string {
  const value = raw.trim()
  const domain = value.match(/^sc-domain:([a-z0-9.-]+)$/i)
  if (domain) return `sc-domain:${domain[1]!.toLowerCase()}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new GoogleAccountBindingError(
      `A Search Console property egy webcím (https://www.example.com/) vagy sc-domain:example.com: ${value}`,
      'invalid_account_id',
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GoogleAccountBindingError(
      `A Search Console property http(s) webcím vagy sc-domain: alak: ${value}`,
      'invalid_account_id',
    )
  }
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return `${url.protocol}//${url.host.toLowerCase()}${path}`
}

export function normalizeGoogleAccountId(
  provider: GoogleAccountBindingProvider,
  raw: string,
): string {
  if (provider === 'google-ads') return normalizeGoogleAdsCustomerId(raw)
  if (provider === 'google-analytics') return normalizeGa4PropertyId(raw)
  return normalizeSearchConsoleSiteUrl(raw)
}

/** Szabad szöveg (vessző / szóköz / új sor) → azonosító-lista. */
export function splitGoogleAccountIds(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function buildGoogleAccountBinding(
  provider: GoogleAccountBindingProvider,
  input: { accountIds: string[]; managerAccountId?: string | null },
): GoogleAccountBinding {
  const accountIds = [
    ...new Set(input.accountIds.map((id) => id.trim()).filter(Boolean).map((id) => normalizeGoogleAccountId(provider, id))),
  ]
  if (accountIds.length === 0) {
    throw new GoogleAccountBindingError(
      `Legalább egy ${googleAccountKindLabel(provider)} megadása kötelező.`,
      'empty_binding',
    )
  }
  if (accountIds.length > MAX_GOOGLE_BOUND_ACCOUNTS) {
    throw new GoogleAccountBindingError(
      `Legfeljebb ${MAX_GOOGLE_BOUND_ACCOUNTS} fiók köthető egy konnektorhoz.`,
      'too_many_accounts',
    )
  }
  const manager = input.managerAccountId?.trim()
  return {
    accountIds,
    ...(provider === 'google-ads' && manager
      ? { managerAccountId: normalizeGoogleAdsCustomerId(manager) }
      : {}),
  }
}

/** Tárolt (JSON) kötés olvasása; hibás tartalomnál a `null` = „nincs kötés” helyett hibát dob. */
export function parseGoogleAccountBindingConfig(
  provider: string | null | undefined,
  raw: unknown,
): GoogleAccountBinding | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isGoogleAccountBindingProvider(provider)) {
    throw new Error(`googleAccountBinding is only supported for ${GOOGLE_ACCOUNT_BINDING_PROVIDERS.join(', ')}`)
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('googleAccountBinding must be an object')
  }
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.accountIds) || value.accountIds.some((id) => typeof id !== 'string')) {
    throw new Error('googleAccountBinding.accountIds must be a string array')
  }
  const manager = value.managerAccountId
  if (manager !== undefined && typeof manager !== 'string') {
    throw new Error('googleAccountBinding.managerAccountId must be a string')
  }
  return buildGoogleAccountBinding(provider, {
    accountIds: value.accountIds as string[],
    managerAccountId: manager as string | undefined,
  })
}

/** Ember- és modell-barát megjelenítés: Google Ads ID-t kötőjelezve mutatjuk. */
export function formatGoogleAccountId(provider: GoogleAccountBindingProvider, id: string): string {
  if (provider === 'google-ads' && /^\d{10}$/.test(id)) {
    return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`
  }
  return id
}

/**
 * A hívás melyik fiókot célozza? `null` = fiók-független hívás (pl. elérhető fiókok listája),
 * amelyet a kötés nem korlátoz.
 */
export function googleAccountTargetOf(
  provider: GoogleAccountBindingProvider,
  pathname: string,
  body?: unknown,
): string | null {
  if (provider === 'google-ads') {
    const match = pathname.match(/^\/v\d+\/customers\/([^/:]+)(?:[/:]|$)/)
    return match ? decodeSegment(match[1]!) : null
  }
  if (provider === 'google-analytics') {
    const match = pathname.match(/^\/v1(?:beta|alpha)?\/properties\/([^/:]+)(?:[/:]|$)/)
    return match ? decodeSegment(match[1]!) : null
  }
  const site = pathname.match(/^\/webmasters\/v3\/sites\/([^/]+)(?:\/|$)/)
  if (site) return decodeSegment(site[1]!)
  if (/^\/v1\/urlInspection\//.test(pathname)) {
    const siteUrl = body && typeof body === 'object' ? (body as { siteUrl?: unknown }).siteUrl : undefined
    return typeof siteUrl === 'string' ? siteUrl : ''
  }
  return null
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export type GoogleAccountCheck =
  | { allowed: true }
  | { allowed: false; target: string; boundAccounts: string[] }

/** A hívás célfiókja benne van-e a tenant által kötött fiókok között? */
export function checkGoogleAccountAllowed(
  provider: GoogleAccountBindingProvider,
  binding: GoogleAccountBinding | undefined,
  pathname: string,
  body?: unknown,
): GoogleAccountCheck {
  if (!binding) return { allowed: true }
  const target = googleAccountTargetOf(provider, pathname, body)
  if (target === null) return { allowed: true }
  if (provider === 'google-analytics' && target === GA4_UNIVERSAL_PROPERTY_ID) return { allowed: true }
  let normalized: string
  try {
    normalized = normalizeGoogleAccountId(provider, target)
  } catch {
    return { allowed: false, target, boundAccounts: binding.accountIds }
  }
  return binding.accountIds.includes(normalized)
    ? { allowed: true }
    : { allowed: false, target, boundAccounts: binding.accountIds }
}

/** A modell elé kerülő mondat: melyik fiókkal dolgozzon, ne találgasson. */
export function describeGoogleAccountBinding(
  provider: GoogleAccountBindingProvider,
  binding: GoogleAccountBinding | undefined,
): string | null {
  if (!binding) return null
  const ids = binding.accountIds.map((id) => formatGoogleAccountId(provider, id)).join(', ')
  const pathHint =
    provider === 'google-ads'
      ? ' A path customerId-ja kötőjel nélkül megy.'
      : provider === 'google-search-console'
        ? ' A siteUrl path-paramétert URL-kódolni kell.'
        : ''
  return `A cég által kötött ${googleAccountKindLabel(provider)}: ${ids}. Csak ezekre hívj.${pathHint}`
}

/**
 * A tárolt connector-config kötésének cseréje (tenant-admin művelet). A régi, tenant-configba
 * írt `login-customer-id` fejlécet eldobjuk, hogy az MCC egyetlen forrása a kötés legyen.
 */
export function withGoogleAccountBinding(
  config: Record<string, unknown>,
  binding: GoogleAccountBinding,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config, googleAccountBinding: binding }
  const headers = config.requestHeaders
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const kept = Object.entries(headers as Record<string, unknown>).filter(
      ([name]) => name.toLowerCase() !== 'login-customer-id',
    )
    if (kept.length > 0) next.requestHeaders = Object.fromEntries(kept)
    else delete next.requestHeaders
  }
  return next
}
