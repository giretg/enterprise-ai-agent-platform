/**
 * Delegált (per-user OAuth) connectorok provider-regisztere.
 *
 * A grant-kapu — kártya + „Hozzáférés megadása" gomb + OAuth utáni folytatás —
 * NEM egy providerhez szól: minden `user_delegated` connectorra működik. Amit
 * egy provider ITT hozzátehet, az kizárólag finomítás:
 *
 *   - emberi címke a kártyán és a modellnek szánt szövegben,
 *   - tool → minimális scope leképezés (least privilege az OAuth-kérésben),
 *   - a MEGADOTT grant scope-jainak elégségesség-ellenőrzése.
 *
 * Amit egy provider nem ad meg, az generikusan dől el a connector OAuth
 * configjából (`oauth.scopes` / `auth.scope` / `scopesSuggested`). Ezért egy új
 * delegált OAuth-connector (Drive, Calendar, Slack, bármilyen `http_api`) kód
 * módosítása NÉLKÜL megkapja a gombot és a folytatást; a regiszterbe csak akkor
 * kell bejegyzés, ha scope-szintű finomhangolást is akarunk.
 */
import { GMAIL_SCOPES, gmailToolAllowedByScopes, normalizeGmailScope } from './gmail-scopes'
import type { GmailTool } from './gmail-scopes'
import {
  driveToolAllowedByScopes,
  driveToolMinimalScopes,
  normalizeDriveScope,
} from './google-drive-scopes'
import type { DriveTool } from './google-drive-scopes'
import { toolsRequiringConnector } from '@/domain/connector-grant/tool-connector-requirements'
import { connectorDisplayLabel } from '@/lib/connector-display-label'

/** Provider-független ok, ha a grant megvan, de a scope-ja kevés. */
export const GENERIC_SCOPE_DENIED_REASON = 'connector_scope_not_granted'

/** Ha a provider nem ad címkét, ez áll a kártyán a connector neve helyett. */
const GENERIC_CONNECTOR_LABEL = 'külső fiók'

export type DelegatedOAuthProvider = {
  /** `ConnectorType` érték — a regiszter kulcsa. */
  connectorType: string
  /** Emberi címke (kártya, prompt). */
  label: string
  /** A provider eszközei — ebből számoljuk a tool → connector-típus irányt. */
  tools: readonly string[]
  /** Ha a connector configja nem sorol fel scope-ot. */
  defaultScopes?: readonly string[]
  /** Alias-feloldás (pl. `gmail.readonly` → teljes URL). */
  normalizeScope?: (scope: string) => string
  /** Egy toolhoz elfogadható scope-ok — a legkisebb jogosultsággal elöl. */
  scopesForTool?: (toolName: string) => string[]
  /** Elég-e a MÁR megadott grant a toolhoz. */
  isToolAllowedByScopes?: (params: {
    toolName: string
    args?: Record<string, unknown>
    scopes: string[]
  }) => boolean
  /**
   * A scope-hiány denied oka. Provider-specifikus is lehet: a Gmail
   * `gmail_scope_not_granted` értéke auditban és tool_calls sorokban évek óta
   * rögzített, ezért nem írjuk át visszamenőleg.
   */
  scopeDeniedReason?: string
}

/** A provider eszközei a kanonikus connector-mátrixból — nincs kézi lista. */
const GMAIL_TOOL_NAMES: readonly string[] = toolsRequiringConnector('gmail')

const GMAIL_PROVIDER: DelegatedOAuthProvider = {
  connectorType: 'gmail',
  label: 'Gmail',
  tools: GMAIL_TOOL_NAMES,
  defaultScopes: [GMAIL_SCOPES.modify],
  normalizeScope: normalizeGmailScope,
  scopesForTool: (toolName) => {
    if (toolName === 'gmail_send') return [GMAIL_SCOPES.send, GMAIL_SCOPES.full]
    if (toolName === 'gmail_create_draft') {
      return [GMAIL_SCOPES.compose, GMAIL_SCOPES.modify, GMAIL_SCOPES.full]
    }
    if (toolName === 'gmail_modify_labels' || toolName === 'gmail_trash') {
      return [GMAIL_SCOPES.modify, GMAIL_SCOPES.full]
    }
    if (GMAIL_TOOL_NAMES.includes(toolName)) {
      return [GMAIL_SCOPES.readonly, GMAIL_SCOPES.modify, GMAIL_SCOPES.full]
    }
    return []
  },
  isToolAllowedByScopes: ({ toolName, args, scopes }) =>
    GMAIL_TOOL_NAMES.includes(toolName) &&
    gmailToolAllowedByScopes({ tool: toolName as GmailTool, ...(args ? { args } : {}), scopes }),
  scopeDeniedReason: 'gmail_scope_not_granted',
}

const GOOGLE_DRIVE_TOOL_NAMES: readonly string[] = toolsRequiringConnector('google_drive')

const GOOGLE_DRIVE_PROVIDER: DelegatedOAuthProvider = {
  connectorType: 'google_drive',
  label: 'Google Drive',
  tools: GOOGLE_DRIVE_TOOL_NAMES,
  defaultScopes: [
    'https://www.googleapis.com/auth/drive.readonly',
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  normalizeScope: normalizeDriveScope,
  scopesForTool: (toolName) => driveToolMinimalScopes(toolName),
  isToolAllowedByScopes: ({ toolName, scopes }) =>
    GOOGLE_DRIVE_TOOL_NAMES.includes(toolName) &&
    driveToolAllowedByScopes({ tool: toolName as DriveTool, scopes }),
  scopeDeniedReason: 'google_drive_scope_not_granted',
}

const PROVIDERS: readonly DelegatedOAuthProvider[] = [GMAIL_PROVIDER, GOOGLE_DRIVE_PROVIDER]

export function delegatedOAuthProvider(
  connectorType: string | null | undefined,
): DelegatedOAuthProvider | null {
  if (!connectorType) return null
  return PROVIDERS.find((provider) => provider.connectorType === connectorType) ?? null
}

/** Kártya/prompt címke: provider-címke, különben a connector saját neve. */
export function delegatedConnectorLabel(
  connectorType: string | null | undefined,
  connectorName?: string | null,
): string {
  const provider = delegatedOAuthProvider(connectorType)
  if (provider) return provider.label
  const name = connectorName?.trim()
  if (name) return connectorDisplayLabel(connectorType ?? '', name)
  return GENERIC_CONNECTOR_LABEL
}

/** Melyik delegált connector-típushoz tartozik az eszköz (ha ismert provider). */
export function delegatedConnectorTypeForTool(toolName: string): string | null {
  const provider = PROVIDERS.find((p) => (p.tools as readonly string[]).includes(toolName))
  return provider?.connectorType ?? null
}

/**
 * Fejlesztői/teszt stub: valódi OAuth-kör nélkül ad grantet.
 *
 * A `GMAIL_OAUTH_STUB` a történeti név (meglévő környezetek használják), a
 * `CONNECTOR_OAUTH_STUB` a provider-független alak — bármelyik bekapcsolja.
 */
export function isDelegatedOAuthStubEnabled(): boolean {
  return (
    process.env.CONNECTOR_OAUTH_STUB === 'true' || process.env.GMAIL_OAUTH_STUB === 'true'
  )
}

/** A grant tárolt scope-listája (JSON) → string tömb. */
export function parseDelegatedGrantScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return []
  return (scopes as unknown[]).filter((scope): scope is string => typeof scope === 'string')
}

export function normalizeDelegatedScope(connectorType: string | null | undefined, scope: string): string {
  const provider = delegatedOAuthProvider(connectorType)
  return provider?.normalizeScope ? provider.normalizeScope(scope) : scope.trim()
}

/**
 * A connector configjában konfigurált OAuth-scope-ok — provider-független.
 *
 * Ez a forrás-igazság: a szerver az OAuth-kérésnél amúgy is a confighoz validál,
 * tehát a configon kívüli scope-ot kérni hiba. A provider `defaultScopes` csak
 * akkor lép be, ha a config egyáltalán nem sorol fel scope-ot.
 */
export function scopesFromConnectorConfig(
  config: unknown,
  connectorType?: string | null,
): string[] {
  const cfg = (config ?? {}) as {
    oauth?: { scopes?: unknown }
    auth?: { scope?: unknown }
    scopesSuggested?: unknown
  }
  const fromOauth = Array.isArray(cfg.oauth?.scopes) ? cfg.oauth?.scopes : null
  const fromAuth =
    typeof cfg.auth?.scope === 'string' ? cfg.auth.scope.split(/[\s,]+/) : null
  const fromSuggested = Array.isArray(cfg.scopesSuggested) ? cfg.scopesSuggested : null
  const raw = fromOauth ?? fromAuth ?? fromSuggested ?? []
  const scopes = raw
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => normalizeDelegatedScope(connectorType, scope))
    .filter(Boolean)
  if (scopes.length > 0) return [...new Set(scopes)]
  const provider = delegatedOAuthProvider(connectorType)
  return provider?.defaultScopes ? [...provider.defaultScopes] : []
}

/**
 * Az OAuth-kérés scope-jai: a connector configja a keret, a tool igénye a szűrő.
 *
 * A kliens NEM dönt scope-ról (jogosultság-emelés lenne). Ha a tool igénye és a
 * config metszete nem üres, azt kérjük (least privilege); különben a config
 * teljes listáját — ismeretlen providernél ez az egyetlen értelmes választás.
 */
export function resolveGrantOAuthScopes(params: {
  connectorType: string | null | undefined
  config: unknown
  toolName?: string | null
}): string[] {
  const configured = scopesFromConnectorConfig(params.config, params.connectorType)
  if (configured.length === 0) return []
  const provider = delegatedOAuthProvider(params.connectorType)
  if (!params.toolName || !provider?.scopesForTool) return configured
  const wanted = provider
    .scopesForTool(params.toolName)
    .map((scope) => normalizeDelegatedScope(params.connectorType, scope))
  if (wanted.length === 0) return configured
  const allowed = new Set(configured)
  const narrowed = wanted.filter((scope) => allowed.has(scope))
  return narrowed.length > 0 ? narrowed : configured
}

/**
 * Elég-e a megadott grant a toolhoz.
 *
 * Provider-ellenőrző hiányában generikus: ha a toolhoz nem ismerünk scope-igényt,
 * a grant létezését elégnek tekintjük — a hívás valódi bírája ilyenkor a külső
 * szolgáltató (`provider_auth_error`), nem egy találgatás a mi oldalunkon.
 */
export function isDelegatedToolAllowedByScopes(params: {
  connectorType: string | null | undefined
  toolName: string
  args?: Record<string, unknown>
  scopes: string[]
}): boolean {
  const provider = delegatedOAuthProvider(params.connectorType)
  if (provider?.isToolAllowedByScopes) {
    return provider.isToolAllowedByScopes({
      toolName: params.toolName,
      ...(params.args ? { args: params.args } : {}),
      scopes: params.scopes,
    })
  }
  const wanted = provider?.scopesForTool?.(params.toolName) ?? []
  if (wanted.length === 0) return true
  const granted = new Set(params.scopes.map((scope) => normalizeDelegatedScope(params.connectorType, scope)))
  return wanted.some((scope) => granted.has(normalizeDelegatedScope(params.connectorType, scope)))
}

/** Van-e egyáltalán scope-szintű ellenőrzés ehhez a típushoz. */
export function hasDelegatedScopeCheck(connectorType: string | null | undefined): boolean {
  const provider = delegatedOAuthProvider(connectorType)
  return Boolean(provider?.isToolAllowedByScopes || provider?.scopesForTool)
}

export function delegatedScopeDeniedReason(connectorType: string | null | undefined): string {
  return delegatedOAuthProvider(connectorType)?.scopeDeniedReason ?? GENERIC_SCOPE_DENIED_REASON
}

/** A regiszterben scope-finomítással szereplő provider-típusok (drift-teszthez). */
export function registeredDelegatedProviderTypes(): string[] {
  return PROVIDERS.map((provider) => provider.connectorType)
}

export function registeredDelegatedProviderTools(connectorType: string): string[] {
  return [...(delegatedOAuthProvider(connectorType)?.tools ?? [])]
}
