'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateHttpApiConnectorForAgent, updateAgentConnectorBinding } from '@/app/actions/platform'
import { unassignConnectorFromAgent } from '@/app/actions/provisioning'
import { startConnectorOAuth } from '@/app/actions/connector-grants'
import {
  GitHubRepositoryAccessFields,
  parseGitHubRepositoryAccess,
  readGitHubRepositoryAccess,
  type GitHubRepositoryAccess,
} from '@/components/agents/github-repository-access-fields'
import { Badge } from '@/components/ui/shell'
import { connectorAccessLabel } from '@/lib/agent-profile-labels'

type EndpointRow = { method: string; path: string; description: string; idempotent: boolean; profile: string }
type AuthProfiles = Record<
  string,
  {
    secretAlias: string
    auth?: { scheme: 'bearer' } | { scheme: 'header'; header: string }
  }
>

type ConnectorItem = {
  connector: {
    id: string
    type: string
    name: string
    scope: string
    secretAlias: string | null
    config: unknown
    authMode?: string
  }
  accessMode: 'read' | 'write'
  /** Per-agent kulcs alias (kötés-szint). Jelenléte = az agentnek saját kulcsa van. */
  agentSecretAlias?: string | null
}

const KEY_STORAGE_NOTE = 'A kulcs titkosítva tárolódik, sosem kerül az adatbázisba.'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function headerJson(value: unknown): string {
  if (!isRecord(value)) return ''
  const headers = Object.fromEntries(
    Object.entries(value).filter(([, template]) => typeof template === 'string'),
  )
  return Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : ''
}

function objectJson(value: unknown): string {
  return isRecord(value) && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : ''
}

function parseHeaderJson(label: string, value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined
  const parsed = JSON.parse(value) as unknown
  if (!isRecord(parsed)) throw new Error(`${label}: JSON objektumot adj meg.`)
  const headers: Record<string, string> = {}
  for (const [key, template] of Object.entries(parsed)) {
    if (typeof template !== 'string') throw new Error(`${label}: minden fejléc értéke szöveg legyen.`)
    headers[key] = template
  }
  return headers
}

function parseAuthProfilesJson(value: string): AuthProfiles | undefined {
  if (!value.trim()) return undefined
  const parsed = JSON.parse(value) as unknown
  if (!isRecord(parsed)) throw new Error('Auth profilok: JSON objektumot adj meg.')
  const profiles: AuthProfiles = {}
  for (const [name, rawProfile] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Auth profilok: érvénytelen profilnév: ${name}`)
    }
    if (!isRecord(rawProfile)) throw new Error(`Auth profilok: a(z) ${name} profil objektum legyen.`)
    if (typeof rawProfile.secretAlias !== 'string' || !rawProfile.secretAlias.trim()) {
      throw new Error(`Auth profilok: a(z) ${name} profilhoz secretAlias szükséges.`)
    }
    let auth: AuthProfiles[string]['auth']
    if (rawProfile.auth !== undefined) {
      if (!isRecord(rawProfile.auth)) {
        throw new Error(`Auth profilok: a(z) ${name}.auth objektum legyen.`)
      }
      if (rawProfile.auth.scheme === 'bearer') auth = { scheme: 'bearer' }
      else if (rawProfile.auth.scheme === 'header') {
        if (typeof rawProfile.auth.header !== 'string' || !rawProfile.auth.header.trim()) {
          throw new Error(`Auth profilok: a(z) ${name}.auth.header kötelező.`)
        }
        auth = { scheme: 'header', header: rawProfile.auth.header.trim() }
      } else {
        throw new Error(`Auth profilok: a(z) ${name}.auth.scheme bearer vagy header legyen.`)
      }
    }
    profiles[name] = {
      secretAlias: rawProfile.secretAlias.trim(),
      ...(auth ? { auth } : {}),
    }
  }
  return Object.keys(profiles).length > 0 ? profiles : undefined
}

function readInitialConfig(config: unknown) {
  const raw = isRecord(config) ? config : {}
  const auth = isRecord(raw.auth) ? raw.auth : {}
  const oauth = isRecord(raw.oauth) ? raw.oauth : {}
  // Auto-consent (user-delegált) connector jele: a config.oauth.authUrl.
  const isDelegated = typeof oauth.authUrl === 'string' && oauth.authUrl.trim().length > 0
  const authScheme: 'header' | 'bearer' | 'oauth2' | 'oauth2_delegated' = isDelegated
    ? 'oauth2_delegated'
    : auth.scheme === 'oauth2'
      ? 'oauth2'
      : auth.scheme === 'bearer'
        ? 'bearer'
        : 'header'
  const endpoints = Array.isArray(raw.endpoints)
    ? raw.endpoints
        .filter(isRecord)
        .map((endpoint) => ({
          method: METHODS.includes(endpoint.method as (typeof METHODS)[number])
            ? String(endpoint.method)
            : 'GET',
          path: typeof endpoint.path === 'string' ? endpoint.path : '',
          description:
            typeof endpoint.description === 'string' ? endpoint.description : '',
          idempotent: endpoint.idempotent === true,
          profile: typeof endpoint.profile === 'string' ? endpoint.profile : '',
        }))
        .filter((endpoint) => endpoint.path.trim().length > 0)
    : []
  const githubRepositoryAccess = readGitHubRepositoryAccess(raw.githubRepositoryAccess)

  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    authScheme,
    authHeader:
      authScheme === 'header' && typeof auth.header === 'string' ? auth.header : 'X-Api-Key',
    tokenUrl: isDelegated
      ? typeof oauth.tokenUrl === 'string'
        ? oauth.tokenUrl
        : ''
      : authScheme === 'oauth2' && typeof auth.tokenUrl === 'string'
        ? auth.tokenUrl
        : '',
    clientId: isDelegated
      ? typeof oauth.clientId === 'string'
        ? oauth.clientId
        : ''
      : authScheme === 'oauth2' && typeof auth.clientId === 'string'
        ? auth.clientId
        : '',
    scope: isDelegated
      ? Array.isArray(oauth.scopes)
        ? oauth.scopes.filter((s): s is string => typeof s === 'string').join(' ')
        : ''
      : authScheme === 'oauth2' && typeof auth.scope === 'string'
        ? auth.scope
        : '',
    authUrl: isDelegated && typeof oauth.authUrl === 'string' ? oauth.authUrl : '',
    userInfoUrl: isDelegated && typeof oauth.userInfoUrl === 'string' ? oauth.userInfoUrl : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    authProfilesText: objectJson(raw.authProfiles),
    defaultAuthProfile: typeof raw.defaultAuthProfile === 'string' ? raw.defaultAuthProfile : '',
    requestHeadersText: headerJson(raw.requestHeaders),
    writeHeadersText: headerJson(raw.writeHeaders),
    restrictToEndpoints: raw.restrictToEndpoints === true,
    githubRepositoryAccessMode: githubRepositoryAccess.mode,
    githubRepositoriesText: githubRepositoryAccess.repositoriesText,
    endpoints:
      endpoints.length > 0
        ? endpoints
        : [{ method: 'GET', path: '', description: '', idempotent: false, profile: '' }],
  }
}

/**
 * WP-5 (B4) — KÖTÉS-szerkesztő: az egyetlen biztonságos agent-szintű művelet. Csak a
 * hozzáférést és az opcionális per-agent kulcsot állítja (az `AgentConnector` sort), a
 * connector strukturális configját SOHA nem érinti. Így egy „csak új kulcs" mentés
 * semmi mást nem változtat, és a módosítás nem hat ki a connectort osztó többi agentre.
 */
function BindingEditor({
  agentId,
  item,
  onSaved,
}: {
  agentId: string
  item: ConnectorItem
  onSaved: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<'read' | 'write'>(item.accessMode)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const hasPerAgentKey = Boolean(item.agentSecretAlias)
  const isDelegated = item.connector.authMode === 'user_delegated'

  function submit() {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await updateAgentConnectorBinding({
        agentId,
        connectorId: item.connector.id,
        accessMode,
        ...(clearApiKey ? { clearApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      if (res.success) {
        setDone('Kötés mentve.')
        setApiKey('')
        setClearApiKey(false)
        router.refresh()
        onSaved()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <form
      className="mt-4 space-y-3 rounded-xl border border-line/80 bg-night/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Kötés — csak erre az agentre
      </p>
      <label className="block text-sm">
        <span className="text-ink-soft">Hozzáférés</span>
        <select
          value={accessMode}
          onChange={(e) => setAccessMode(e.target.value as 'read' | 'write')}
          className={INPUT}
        >
          <option value="write">Olvasás + írás</option>
          <option value="read">Csak olvasás</option>
        </select>
      </label>

      {isDelegated ? (
        <p className="rounded-lg border border-line/60 bg-night-2/60 px-3 py-2 text-xs text-ink-faint">
          Ez egy automatikus-hozzájárulású (user-delegált) kapcsolat — a hitelesítés per-felhasználó
          történik, per-agent kulcs itt nem adható meg. A fiókot az „Összekötött fiókok&rdquo; oldalon
          kösd össze.
        </p>
      ) : (
        <label className="block text-sm">
          <span className="text-ink-soft">
            Per-agent API kulcs {hasPerAgentKey ? '(be van állítva)' : '(nincs beállítva)'}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value)
              if (e.target.value) setClearApiKey(false)
            }}
            placeholder={hasPerAgentKey ? 'Üresen hagyva marad a jelenlegi' : 'Üresen hagyva a közös (tenant) kulcs marad'}
            autoComplete="off"
            disabled={clearApiKey}
            className={INPUT}
          />
          <span className="mt-1 block text-xs text-ink-faint">
            Csak ehhez az agenthez tartozó kulcs. Üresen hagyva az agent a kapcsolat közös
            (tenant-szintű) kulcsát használja. {KEY_STORAGE_NOTE}
          </span>
          {hasPerAgentKey && (
            <label className="mt-2 flex items-center gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(e) => {
                  setClearApiKey(e.target.checked)
                  if (e.target.checked) setApiKey('')
                }}
              />
              Per-agent kulcs törlése (visszaesés a közös tenant-kulcsra)
            </label>
          )}
        </label>
      )}

      {error && <p className="text-sm text-coral">{error}</p>}
      {done && <p className="text-sm text-sage">{done}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés...' : 'Kötés mentése'}
      </button>
    </form>
  )
}

function EditApiConnectorForm({
  agentId,
  item,
  onSaved,
  onCancel,
}: {
  agentId: string
  item: ConnectorItem
  onSaved: () => void
  onCancel: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const initial = readInitialConfig(item.connector.config)

  const [name, setName] = useState(item.connector.name)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [authScheme, setAuthScheme] = useState<'header' | 'bearer' | 'oauth2' | 'oauth2_delegated'>(
    initial.authScheme,
  )
  const [authHeader, setAuthHeader] = useState(initial.authHeader)
  const [apiKey, setApiKey] = useState('')
  const [tokenUrl, setTokenUrl] = useState(initial.tokenUrl)
  const [clientId, setClientId] = useState(initial.clientId)
  const [scope, setScope] = useState(initial.scope)
  const [authUrl, setAuthUrl] = useState(initial.authUrl)
  const [userInfoUrl, setUserInfoUrl] = useState(initial.userInfoUrl)
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>(item.accessMode)
  const [description, setDescription] = useState(initial.description)
  const [authProfilesText, setAuthProfilesText] = useState(initial.authProfilesText)
  const [defaultAuthProfile, setDefaultAuthProfile] = useState(initial.defaultAuthProfile)
  const [requestHeadersText, setRequestHeadersText] = useState(initial.requestHeadersText)
  const [writeHeadersText, setWriteHeadersText] = useState(initial.writeHeadersText)
  const [restrictToEndpoints, setRestrictToEndpoints] = useState(initial.restrictToEndpoints)
  const [githubRepositoryAccessMode, setGitHubRepositoryAccessMode] = useState(
    initial.githubRepositoryAccessMode,
  )
  const [githubRepositoriesText, setGitHubRepositoriesText] = useState(
    initial.githubRepositoriesText,
  )
  const [endpoints, setEndpoints] = useState<EndpointRow[]>(initial.endpoints)

  function updateEndpoint(index: number, patch: Partial<EndpointRow>) {
    setEndpoints((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  // A mentés újrahasználható: a sima „Frissítés" és az „Auto-consent kezdeményezése"
  // is ezt hívja (utóbbi mentés után indítja a consent-flow-t). Fejléc-JSON hibánál
  // null-t ad vissza (a hibát már beállította).
  async function performUpdate(): Promise<{ ok: boolean; name?: string } | null> {
    setError(null)
    setDone(null)
    const cleanedEndpoints = endpoints
      .map((endpoint) => ({
        ...endpoint,
        path: endpoint.path.trim(),
        description: endpoint.description.trim(),
        profile: endpoint.profile.trim(),
      }))
      .filter((endpoint) => endpoint.path.length > 0)
      .map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
        ...(endpoint.description ? { description: endpoint.description } : {}),
        ...(endpoint.idempotent ? { idempotent: true } : {}),
        ...(endpoint.profile ? { profile: endpoint.profile } : {}),
      }))
    let requestHeaders: Record<string, string> | undefined
    let writeHeaders: Record<string, string> | undefined
    let authProfiles: AuthProfiles | undefined
    let githubRepositoryAccess: GitHubRepositoryAccess | undefined
    try {
      authProfiles = parseAuthProfilesJson(authProfilesText)
      requestHeaders = parseHeaderJson('Minden hívás fejlécei', requestHeadersText)
      writeHeaders = parseHeaderJson('Író hívások fejlécei', writeHeadersText)
      githubRepositoryAccess = parseGitHubRepositoryAccess(
        baseUrl.trim(),
        githubRepositoryAccessMode,
        githubRepositoriesText,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hibás connector-konfiguráció.')
      return null
    }

    const res = await updateHttpApiConnectorForAgent({
      agentId,
      connectorId: item.connector.id,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      authScheme,
      ...(authScheme === 'header' ? { authHeader: authHeader.trim() } : {}),
      ...(authScheme === 'oauth2'
        ? {
            tokenUrl: tokenUrl.trim(),
            clientId: clientId.trim(),
            ...(scope.trim() ? { scope: scope.trim() } : {}),
            ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            ...(refreshToken.trim() ? { refreshToken: refreshToken.trim() } : {}),
          }
        : authScheme === 'oauth2_delegated'
          ? {
              authUrl: authUrl.trim(),
              tokenUrl: tokenUrl.trim(),
              clientId: clientId.trim(),
              scope: scope.trim(),
              ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
              ...(userInfoUrl.trim() ? { userInfoUrl: userInfoUrl.trim() } : {}),
            }
          : apiKey.trim()
            ? { apiKey: apiKey.trim() }
            : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(authProfiles ? { authProfiles } : {}),
      ...(defaultAuthProfile.trim() ? { defaultAuthProfile: defaultAuthProfile.trim() } : {}),
      ...(requestHeaders ? { requestHeaders } : {}),
      ...(writeHeaders ? { writeHeaders } : {}),
      accessMode,
      restrictToEndpoints,
      ...(githubRepositoryAccess ? { githubRepositoryAccess } : {}),
      ...(cleanedEndpoints.length > 0 ? { endpoints: cleanedEndpoints } : {}),
    })

    if (res.success) return { ok: true, name: res.data.name }
    setError(res.error)
    return { ok: false }
  }

  function submit() {
    startTransition(async () => {
      const res = await performUpdate()
      if (res?.ok) {
        setDone(`„${res.name}" frissítve.`)
        setApiKey('')
        setClientSecret('')
        setRefreshToken('')
        router.refresh()
        onSaved()
      }
    })
  }

  // Mentés → azonnal indítja az OAuth consent-flow-t. A connector a mentéssel
  // user_delegated lesz (config.oauth + plain client_secret a store-ban), így a
  // startConnectorOAuth build-eli a consent URL-t és átirányít.
  function initiateConsent() {
    startTransition(async () => {
      const saved = await performUpdate()
      if (!saved?.ok) return
      const res = await startConnectorOAuth({ connectorId: item.connector.id })
      if (!res.success) {
        setError(res.error)
        return
      }
      if ('stub' in res.data && res.data.stub) {
        setDone('Fiók összekötve (stub).')
        router.refresh()
        onSaved()
      } else {
        window.location.href = res.data.url
      }
    })
  }

  return (
    <form
      className="mt-4 space-y-4 rounded-xl border border-line/80 bg-night/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {authScheme === 'oauth2_delegated' && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          Automatikus hozzájárulás: mentés után az „Auto-consent kezdeményezése&rdquo; gombbal
          egy kattintással engedélyezhető (nincs kézi refresh token). A redirect URI a platform közös
          callbackje: <code>/api/connectors/oauth/callback</code> — ezt vedd fel az OAuth-app
          engedélyezett redirect URI-jai közé.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-ink-soft">Név</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://posnavigator.eu/api/v1"
            className={INPUT}
          />
        </label>
        <GitHubRepositoryAccessFields
          baseUrl={baseUrl}
          mode={githubRepositoryAccessMode}
          repositoriesText={githubRepositoriesText}
          onModeChange={setGitHubRepositoryAccessMode}
          onRepositoriesTextChange={setGitHubRepositoriesText}
        />
        <label className="block text-sm">
          <span className="text-ink-soft">Hitelesítés módja</span>
          <select
            value={authScheme}
            onChange={(e) =>
              setAuthScheme(e.target.value as 'header' | 'bearer' | 'oauth2' | 'oauth2_delegated')
            }
            className={INPUT}
          >
            <option value="header">Egyedi fejléc</option>
            <option value="bearer">Bearer token</option>
            <option value="oauth2">OAuth2 (kézi refresh_token grant)</option>
            <option value="oauth2_delegated">OAuth2 – automatikus hozzájárulás (user-delegált)</option>
          </select>
          <span className="mt-1 block text-xs text-ink-faint">
            {authScheme === 'bearer'
              ? 'Bearer token: csak a nyers kulcsot írd be — a rendszer az Authorization: Bearer <kulcs> fejlécet automatikusan összeállítja.'
              : authScheme === 'header'
                ? 'Egyedi fejléc: a megadott érték változtatás nélkül kerül a fejlécbe. Ha a szerver Bearer-t vár, azt neked kell beleírnod (Bearer <kulcs>).'
                : 'OAuth2: a rendszer a token-végponton szerez/frissít hozzáférési tokent.'}
          </span>
        </label>
        {authScheme === 'header' && (
          <label className="block text-sm">
            <span className="text-ink-soft">Fejléc neve</span>
            <input
              value={authHeader}
              onChange={(e) => setAuthHeader(e.target.value)}
              placeholder="X-Api-Key"
              className={INPUT}
            />
          </label>
        )}
        {authScheme !== 'oauth2' && authScheme !== 'oauth2_delegated' && (
          <label className="block text-sm">
            <span className="text-ink-soft">Új API kulcs</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Üresen hagyva marad a jelenlegi"
              autoComplete="off"
              className={INPUT}
            />
            <span className="mt-1 block text-xs text-ink-faint">
              {authScheme === 'bearer'
                ? `A külső rendszerben generált nyers kulcs. A „Bearer " előtagot ne írd bele — a rendszer hozzáadja. ${KEY_STORAGE_NOTE}`
                : `A fejlécbe kerülő teljes érték. Ha a szerver Bearer-t vár, írd bele: „Bearer <kulcs>". ${KEY_STORAGE_NOTE}`}
            </span>
          </label>
        )}
        {(authScheme === 'oauth2' || authScheme === 'oauth2_delegated') && (
          <>
            {authScheme === 'oauth2_delegated' && (
              <label className="block text-sm">
                <span className="text-ink-soft">Authorization URL (consent)</span>
                <input
                  value={authUrl}
                  onChange={(e) => setAuthUrl(e.target.value)}
                  placeholder="https://accounts.google.com/o/oauth2/v2/auth"
                  className={INPUT}
                />
              </label>
            )}
            <label className="block text-sm">
              <span className="text-ink-soft">Token URL</span>
              <input
                value={tokenUrl}
                onChange={(e) => setTokenUrl(e.target.value)}
                placeholder="https://oauth2.googleapis.com/token"
                className={INPUT}
              />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Client ID</span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={INPUT} />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">
                Scope {authScheme === 'oauth2_delegated' ? '(kötelező)' : '(opcionális)'}
              </span>
              <input value={scope} onChange={(e) => setScope(e.target.value)} className={INPUT} />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Új client secret</span>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Üresen hagyva marad a jelenlegi"
                autoComplete="off"
                className={INPUT}
              />
            </label>
            {authScheme === 'oauth2' && (
              <label className="block text-sm">
                <span className="text-ink-soft">Új refresh token</span>
                <input
                  type="password"
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                  placeholder="Üresen hagyva marad a jelenlegi"
                  autoComplete="off"
                  className={INPUT}
                />
              </label>
            )}
            {authScheme === 'oauth2_delegated' && (
              <label className="block text-sm">
                <span className="text-ink-soft">Userinfo URL (opcionális, fiók-címkéhez)</span>
                <input
                  value={userInfoUrl}
                  onChange={(e) => setUserInfoUrl(e.target.value)}
                  placeholder="https://www.googleapis.com/oauth2/v2/userinfo"
                  className={INPUT}
                />
              </label>
            )}
          </>
        )}
        <label className="block text-sm">
          <span className="text-ink-soft">Hozzáférés</span>
          <select
            value={accessMode}
            onChange={(e) => setAccessMode(e.target.value as 'read' | 'write')}
            className={INPUT}
          >
            <option value="write">Olvasás + írás</option>
            <option value="read">Csak olvasás</option>
          </select>
        </label>
      </div>

      <label className="block text-sm">
        <span className="text-ink-soft">API leírás</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className={INPUT}
        />
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-ink-soft">Auth profilok</span>
          <textarea
            value={authProfilesText}
            onChange={(e) => setAuthProfilesText(e.target.value)}
            rows={4}
            className={INPUT}
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Alap auth profil</span>
          <input
            value={defaultAuthProfile}
            onChange={(e) => setDefaultAuthProfile(e.target.value)}
            placeholder="service"
            className={INPUT}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-ink-soft">Minden hívás fejlécei</span>
          <textarea
            value={requestHeadersText}
            onChange={(e) => setRequestHeadersText(e.target.value)}
            rows={4}
            className={INPUT}
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Író hívások fejlécei</span>
          <textarea
            value={writeHeadersText}
            onChange={(e) => setWriteHeadersText(e.target.value)}
            rows={4}
            className={INPUT}
          />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink-soft">Endpointok</span>
          <button
            type="button"
            onClick={() =>
              setEndpoints((prev) => [
                ...prev,
                { method: 'GET', path: '', description: '', idempotent: false, profile: '' },
              ])
            }
            className="rounded-lg border border-line px-2 py-1 text-xs text-ink-soft hover:bg-night-2"
          >
            + Sor
          </button>
        </div>
        {endpoints.map((row, index) => (
          <div key={index} className="grid grid-cols-12 gap-2">
            <select
              value={row.method}
              onChange={(e) => updateEndpoint(index, { method: e.target.value })}
              className="col-span-3 rounded-lg border border-line bg-night-2 px-2 py-2 text-sm sm:col-span-2"
            >
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
            <input
              value={row.path}
              onChange={(e) => updateEndpoint(index, { path: e.target.value })}
              placeholder="/banks/:bankId/crm"
              className="col-span-9 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm sm:col-span-3"
            />
            <input
              value={row.description}
              onChange={(e) => updateEndpoint(index, { description: e.target.value })}
              placeholder="Mit csinál"
              className="col-span-6 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm sm:col-span-3"
            />
            <input
              value={row.profile}
              onChange={(e) => updateEndpoint(index, { profile: e.target.value })}
              placeholder="Profil"
              className="col-span-4 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm sm:col-span-2"
            />
            <label className="col-span-1 flex items-center justify-center rounded-lg border border-line bg-night-2 text-xs text-ink-soft sm:col-span-1">
              <input
                type="checkbox"
                checked={row.idempotent}
                onChange={(e) => updateEndpoint(index, { idempotent: e.target.checked })}
                aria-label="Idempotens írás"
              />
            </label>
            <button
              type="button"
              onClick={() => setEndpoints((prev) => prev.filter((_, i) => i !== index))}
              disabled={endpoints.length === 1}
              className="col-span-1 rounded-lg border border-line text-sm text-ink-faint hover:bg-night-2 disabled:opacity-40 sm:col-span-1"
              aria-label="Sor törlése"
            >
              ✕
            </button>
          </div>
        ))}
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={restrictToEndpoints}
            onChange={(e) => setRestrictToEndpoints(e.target.checked)}
          />
          Csak a fenti endpointok hívhatók
        </label>
      </div>

      {authScheme === 'header' &&
        authHeader.trim().toLowerCase() === 'authorization' &&
        apiKey.trim().length > 0 &&
        !/^bearer\s/i.test(apiKey.trim()) && (
          <p className="rounded-lg border border-honey/30 bg-honey/10 px-3 py-2 text-xs text-honey">
            Figyelem: az „Authorization&rdquo; fejléchez a legtöbb szerver „Bearer &lt;kulcs&gt;&rdquo;
            alakot vár, a beírt érték viszont nem ezzel kezdődik. Ha a szerver Bearer-t vár, írd
            elé: <code>Bearer </code>. (Ez csak figyelmeztetés — más séma is lehet.)
          </p>
        )}
      {error && <p className="text-sm text-coral">{error}</p>}
      {done && <p className="text-sm text-sage">{done}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={
            pending ||
            !name.trim() ||
            !baseUrl.trim() ||
            (authScheme === 'oauth2' && (!tokenUrl.trim() || !clientId.trim())) ||
            (authScheme === 'oauth2' &&
              Boolean(clientSecret.trim()) !== Boolean(refreshToken.trim())) ||
            (authScheme === 'oauth2_delegated' &&
              (!authUrl.trim() || !tokenUrl.trim() || !clientId.trim() || !scope.trim()))
          }
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'Frissítés'}
        </button>
        {authScheme === 'oauth2_delegated' && (
          <button
            type="button"
            onClick={initiateConsent}
            disabled={
              pending ||
              !name.trim() ||
              !baseUrl.trim() ||
              !authUrl.trim() ||
              !tokenUrl.trim() ||
              !clientId.trim() ||
              !scope.trim()
            }
            className="rounded-full bg-sage/20 px-5 py-2 text-sm font-semibold text-sage disabled:opacity-50"
          >
            {pending ? 'Folyamatban...' : 'Auto-consent kezdeményezése'}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-line px-5 py-2 text-sm font-semibold text-ink-soft hover:bg-night-2"
        >
          Mégse
        </button>
      </div>
    </form>
  )
}

export function ApiConnectorList({
  agentId,
  connectors,
}: {
  agentId: string
  connectors: ConnectorItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (connectors.length === 0) {
    return <p className="text-sm text-ink-faint">Nincs külső kapcsolat hozzárendelve.</p>
  }

  function unassign(item: ConnectorItem) {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await unassignConnectorFromAgent({
        agentId,
        connectorId: item.connector.id,
        reason: 'Agent detail admin UI',
      })
      if (res.success) {
        setDone(`„${item.connector.name}" leválasztva az agentről.`)
        setConfirmingId(null)
        setEditingId(null)
        router.refresh()
      } else {
        setError(res.error ?? 'Nem sikerült leválasztani a kapcsolatot.')
      }
    })
  }

  return (
    <ul className="space-y-2 text-sm">
      {error && <li className="text-sm text-coral">{error}</li>}
      {done && <li className="text-sm text-sage">{done}</li>}
      {connectors.map((item) => {
        const editable = item.connector.type === 'http_api'
        const editing = editingId === item.connector.id
        const confirming = confirmingId === item.connector.id

        return (
          <li key={item.connector.id} className="atelier-soft p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-medium text-ink">{item.connector.name}</span>
              <div className="flex items-center gap-2">
                <Badge tone={item.accessMode === 'write' ? 'warning' : 'neutral'}>
                  {connectorAccessLabel(item.accessMode)}
                </Badge>
                {editable && (
                  <button
                    type="button"
                    onClick={() => setEditingId(editing ? null : item.connector.id)}
                    className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-night-2"
                  >
                    {editing ? 'Bezárás' : 'Szerkesztés'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setConfirmingId(confirming ? null : item.connector.id)}
                  className="rounded-full border border-coral/40 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10"
                >
                  {confirming ? 'Mégse' : 'Leválasztás'}
                </button>
              </div>
            </div>
            <p className="mt-1 break-all text-xs text-ink-faint">
              {item.connector.type} · {item.connector.scope}
              {item.connector.secretAlias && ` · ${item.connector.secretAlias}`}
            </p>
            {confirming && (
              <div className="mt-3 rounded-lg border border-coral/30 bg-coral/10 p-3">
                <p className="text-xs text-ink-soft">
                  A kapcsolat az agentről lekerül, de maga a connector és az audit előzmény megmarad.
                </p>
                <button
                  type="button"
                  onClick={() => unassign(item)}
                  disabled={pending}
                  className="mt-3 rounded-full bg-coral/20 px-4 py-1.5 text-xs font-semibold text-coral disabled:opacity-50"
                >
                  {pending ? 'Leválasztás...' : 'Auditált leválasztás'}
                </button>
              </div>
            )}
            {editing && (
              <>
                <BindingEditor
                  agentId={agentId}
                  item={item}
                  onSaved={() => setEditingId(null)}
                />
                <details className="mt-3 rounded-xl border border-honey/30 bg-honey/5 p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-honey">
                    Connector-beállítások — az egész tenantra hat (haladó)
                  </summary>
                  <p className="mt-2 text-xs text-ink-faint">
                    Ez a beállítás a connector egészére (az egész tenantra) vonatkozik — a
                    kapcsolatot használó összes agentre. A strukturális szerkesztés (baseUrl, auth,
                    fejlécek, endpointok) helye a provisioning; itt csak akkor módosíts, ha tudatosan
                    az egész tenantra szánod.
                  </p>
                  <EditApiConnectorForm
                    agentId={agentId}
                    item={item}
                    onSaved={() => setEditingId(null)}
                    onCancel={() => setEditingId(null)}
                  />
                </details>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}
