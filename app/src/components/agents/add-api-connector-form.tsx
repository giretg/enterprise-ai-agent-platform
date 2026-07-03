'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createHttpApiConnectorForAgent } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type EndpointRow = { method: string; path: string; description: string; idempotent: boolean; profile: string }
type AuthProfiles = Record<
  string,
  {
    secretAlias: string
    auth?: { scheme: 'bearer' } | { scheme: 'header'; header: string }
  }
>

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

function parseHeaderJson(label: string, value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: JSON objektumot adj meg.`)
  }
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Auth profilok: JSON objektumot adj meg.')
  }
  const profiles: AuthProfiles = {}
  for (const [name, rawProfile] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Auth profilok: érvénytelen profilnév: ${name}`)
    }
    if (typeof rawProfile !== 'object' || rawProfile === null || Array.isArray(rawProfile)) {
      throw new Error(`Auth profilok: a(z) ${name} profil objektum legyen.`)
    }
    const profile = rawProfile as Record<string, unknown>
    if (typeof profile.secretAlias !== 'string' || !profile.secretAlias.trim()) {
      throw new Error(`Auth profilok: a(z) ${name} profilhoz secretAlias szükséges.`)
    }
    let auth: AuthProfiles[string]['auth']
    if (profile.auth !== undefined) {
      if (typeof profile.auth !== 'object' || profile.auth === null || Array.isArray(profile.auth)) {
        throw new Error(`Auth profilok: a(z) ${name}.auth objektum legyen.`)
      }
      const authRaw = profile.auth as Record<string, unknown>
      if (authRaw.scheme === 'bearer') auth = { scheme: 'bearer' }
      else if (authRaw.scheme === 'header') {
        if (typeof authRaw.header !== 'string' || !authRaw.header.trim()) {
          throw new Error(`Auth profilok: a(z) ${name}.auth.header kötelező.`)
        }
        auth = { scheme: 'header', header: authRaw.header.trim() }
      } else {
        throw new Error(`Auth profilok: a(z) ${name}.auth.scheme bearer vagy header legyen.`)
      }
    }
    profiles[name] = {
      secretAlias: profile.secretAlias.trim(),
      ...(auth ? { auth } : {}),
    }
  }
  return Object.keys(profiles).length > 0 ? profiles : undefined
}

// Admin egy külső REST API-t köt egy agenthez: connector (http_api) létrehozása,
// a kulcs a secret-store mögé kerül (NEM a DB-be), és a két http_api capability
// engedélyezése. A megadott endpointok + leírás a modell elé kerülnek híváskor.
export function AddApiConnectorForm({ agentId, bare = false }: { agentId: string; bare?: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [authScheme, setAuthScheme] = useState<'header' | 'bearer' | 'oauth2' | 'oauth2_delegated'>(
    'header',
  )
  const [authHeader, setAuthHeader] = useState('X-Api-Key')
  const [apiKey, setApiKey] = useState('')
  const [tokenUrl, setTokenUrl] = useState('')
  const [clientId, setClientId] = useState('')
  const [scope, setScope] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [userInfoUrl, setUserInfoUrl] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('write')
  const [description, setDescription] = useState('')
  const [authProfilesText, setAuthProfilesText] = useState('')
  const [defaultAuthProfile, setDefaultAuthProfile] = useState('')
  const [requestHeadersText, setRequestHeadersText] = useState('')
  const [writeHeadersText, setWriteHeadersText] = useState('')
  const [restrictToEndpoints, setRestrictToEndpoints] = useState(false)
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([
    { method: 'GET', path: '', description: '', idempotent: false, profile: '' },
  ])

  function updateEndpoint(index: number, patch: Partial<EndpointRow>) {
    setEndpoints((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function submit() {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const cleanedEndpoints = endpoints
        .map((e) => ({
          ...e,
          path: e.path.trim(),
          description: e.description.trim(),
          profile: e.profile.trim(),
        }))
        .filter((e) => e.path.length > 0)
        .map((e) => ({
          method: e.method as EndpointRow['method'],
          path: e.path,
          ...(e.description ? { description: e.description } : {}),
          ...(e.idempotent ? { idempotent: true } : {}),
          ...(e.profile ? { profile: e.profile } : {}),
        }))
      let requestHeaders: Record<string, string> | undefined
      let writeHeaders: Record<string, string> | undefined
      let authProfiles: AuthProfiles | undefined
      try {
        authProfiles = parseAuthProfilesJson(authProfilesText)
        requestHeaders = parseHeaderJson('Minden hívás fejlécei', requestHeadersText)
        writeHeaders = parseHeaderJson('Író hívások fejlécei', writeHeadersText)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Hibás fejléc JSON.')
        return
      }

      const res = await createHttpApiConnectorForAgent({
        agentId,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authScheme,
        ...(authScheme === 'header' ? { authHeader: authHeader.trim() } : {}),
        ...(authScheme === 'oauth2'
          ? {
              tokenUrl: tokenUrl.trim(),
              clientId: clientId.trim(),
              ...(scope.trim() ? { scope: scope.trim() } : {}),
              clientSecret: clientSecret.trim(),
              refreshToken: refreshToken.trim(),
            }
          : authScheme === 'oauth2_delegated'
            ? {
                authUrl: authUrl.trim(),
                tokenUrl: tokenUrl.trim(),
                clientId: clientId.trim(),
                scope: scope.trim(),
                clientSecret: clientSecret.trim(),
                ...(userInfoUrl.trim() ? { userInfoUrl: userInfoUrl.trim() } : {}),
              }
            : { apiKey: apiKey.trim() }),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(authProfiles ? { authProfiles } : {}),
        ...(defaultAuthProfile.trim() ? { defaultAuthProfile: defaultAuthProfile.trim() } : {}),
        ...(requestHeaders ? { requestHeaders } : {}),
        ...(writeHeaders ? { writeHeaders } : {}),
        accessMode,
        restrictToEndpoints,
        ...(cleanedEndpoints.length > 0 ? { endpoints: cleanedEndpoints } : {}),
      })

      if (res.success) {
        setDone(`„${res.data.name}" hozzáadva — az agent mostantól hívhatja.`)
        setName('')
        setBaseUrl('')
        setApiKey('')
        setTokenUrl('')
        setClientId('')
        setScope('')
        setAuthUrl('')
        setUserInfoUrl('')
        setClientSecret('')
        setRefreshToken('')
        setDescription('')
        setAuthProfilesText('')
        setDefaultAuthProfile('')
        setRequestHeadersText('')
        setWriteHeadersText('')
        setEndpoints([{ method: 'GET', path: '', description: '', idempotent: false, profile: '' }])
        setRestrictToEndpoints(false)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  const form = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
        <p className="text-xs text-ink-faint">
          Egy külső REST API bekötése. Az API-kulcs titkosítva, a control plane secret-tárolójában
          tárolódik — soha nem kerül az adatbázisba, promptba vagy logba.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-ink-soft">Név</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Provider CRM (POSnavigator)"
              className={INPUT}
            />
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
          <label className="block text-sm">
            <span className="text-ink-soft">Hitelesítés módja</span>
            <select
              value={authScheme}
              onChange={(e) =>
                setAuthScheme(e.target.value as 'header' | 'bearer' | 'oauth2' | 'oauth2_delegated')
              }
              className={INPUT}
            >
              <option value="header">Egyedi fejléc (pl. X-Api-Key)</option>
              <option value="bearer">Bearer token (Authorization)</option>
              <option value="oauth2">OAuth2 (kézi refresh_token grant)</option>
              <option value="oauth2_delegated">OAuth2 – automatikus hozzájárulás (user-delegált)</option>
            </select>
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
              <span className="text-ink-soft">API kulcs</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="pn_..."
                autoComplete="off"
                className={INPUT}
              />
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
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className={INPUT}
                />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">
                  Scope {authScheme === 'oauth2_delegated' ? '(kötelező)' : '(opcionális)'}
                </span>
                <input
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="https://www.googleapis.com/auth/webmasters.readonly"
                  className={INPUT}
                />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Client secret</span>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                  className={INPUT}
                />
              </label>
              {authScheme === 'oauth2' && (
                <label className="block text-sm">
                  <span className="text-ink-soft">Refresh token</span>
                  <input
                    type="password"
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
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
              <option value="write">Olvasás + írás (GET, POST, PATCH, DELETE)</option>
              <option value="read">Csak olvasás (GET)</option>
            </select>
          </label>
        </div>

        {authScheme === 'oauth2_delegated' && (
          <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
            Automatikus hozzájárulás: a felhasználók az „Összekötött fiókok&rdquo; oldalon egy kattintással
            adnak engedélyt (authorization-code consent) — nincs kézi OAuth Playground, nem kell
            refresh tokent beilleszteni. A redirect URI a platform közös callbackje:{' '}
            <code>/api/connectors/oauth/callback</code> — ezt vedd fel az OAuth-app engedélyezett
            redirect URI-jai közé.
          </p>
        )}

        <label className="block text-sm">
          <span className="text-ink-soft">API leírás (a modell elé kerül)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Pl. fizetési szolgáltató mini-CRM. A :bankId 24 hex karakteres ObjectId. CRM státuszok: NEW, CONTACTED, …"
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
              placeholder={'{"delegated":{"secretAlias":"env:CRM_DELEGATED_API_KEY"}}'}
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
              placeholder={'{"X-Agent-Id":"{{agent.id}}","X-Acting-User":"{{actingUser.email}}","X-Connector-Call-Id":"{{call.id}}"}'}
              className={INPUT}
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Író hívások fejlécei</span>
            <textarea
              value={writeHeadersText}
              onChange={(e) => setWriteHeadersText(e.target.value)}
              rows={4}
              placeholder={'{"Idempotency-Key":"{{call.idempotencyKey}}"}'}
              className={INPUT}
            />
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-ink-soft">Endpointok (a modell ezeket látja)</span>
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
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
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
                placeholder="Mit csinál (opcionális)"
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
            Csak a fenti endpointok hívhatók (deny-by-default a többire)
          </label>
        </div>

        {error && <p className="text-sm text-coral">{error}</p>}
        {done && (
          <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
            {done}
          </p>
        )}

        <button
          type="submit"
          disabled={
            pending ||
            !name.trim() ||
            !baseUrl.trim() ||
            (authScheme === 'oauth2'
              ? !tokenUrl.trim() || !clientId.trim() || !clientSecret.trim() || !refreshToken.trim()
              : authScheme === 'oauth2_delegated'
                ? !authUrl.trim() ||
                  !tokenUrl.trim() ||
                  !clientId.trim() ||
                  !scope.trim() ||
                  !clientSecret.trim()
                : !apiKey.trim())
          }
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'API-kapcsolat hozzáadása'}
        </button>
      </form>
  )

  if (bare) return form
  return <Card title="Új API-kapcsolat hozzáadása">{form}</Card>
}
