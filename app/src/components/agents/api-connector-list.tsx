'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateHttpApiConnectorForAgent } from '@/app/actions/platform'
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
  }
  accessMode: 'read' | 'write'
}

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
  const authScheme: 'header' | 'bearer' = auth.scheme === 'bearer' ? 'bearer' : 'header'
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

  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    authScheme,
    authHeader:
      authScheme === 'header' && typeof auth.header === 'string' ? auth.header : 'X-Api-Key',
    description: typeof raw.description === 'string' ? raw.description : '',
    authProfilesText: objectJson(raw.authProfiles),
    defaultAuthProfile: typeof raw.defaultAuthProfile === 'string' ? raw.defaultAuthProfile : '',
    requestHeadersText: headerJson(raw.requestHeaders),
    writeHeadersText: headerJson(raw.writeHeaders),
    restrictToEndpoints: raw.restrictToEndpoints === true,
    endpoints:
      endpoints.length > 0
        ? endpoints
        : [{ method: 'GET', path: '', description: '', idempotent: false, profile: '' }],
  }
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
  const [authScheme, setAuthScheme] = useState<'header' | 'bearer'>(initial.authScheme)
  const [authHeader, setAuthHeader] = useState(initial.authHeader)
  const [apiKey, setApiKey] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>(item.accessMode)
  const [description, setDescription] = useState(initial.description)
  const [authProfilesText, setAuthProfilesText] = useState(initial.authProfilesText)
  const [defaultAuthProfile, setDefaultAuthProfile] = useState(initial.defaultAuthProfile)
  const [requestHeadersText, setRequestHeadersText] = useState(initial.requestHeadersText)
  const [writeHeadersText, setWriteHeadersText] = useState(initial.writeHeadersText)
  const [restrictToEndpoints, setRestrictToEndpoints] = useState(initial.restrictToEndpoints)
  const [endpoints, setEndpoints] = useState<EndpointRow[]>(initial.endpoints)

  function updateEndpoint(index: number, patch: Partial<EndpointRow>) {
    setEndpoints((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function submit() {
    startTransition(async () => {
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
      try {
        authProfiles = parseAuthProfilesJson(authProfilesText)
        requestHeaders = parseHeaderJson('Minden hívás fejlécei', requestHeadersText)
        writeHeaders = parseHeaderJson('Író hívások fejlécei', writeHeadersText)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Hibás fejléc JSON.')
        return
      }

      const res = await updateHttpApiConnectorForAgent({
        agentId,
        connectorId: item.connector.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authScheme,
        ...(authScheme === 'header' ? { authHeader: authHeader.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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
        setDone(`„${res.data.name}" frissítve.`)
        setApiKey('')
        router.refresh()
        onSaved()
      } else {
        setError(res.error)
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
        <label className="block text-sm">
          <span className="text-ink-soft">Hitelesítés módja</span>
          <select
            value={authScheme}
            onChange={(e) => setAuthScheme(e.target.value as 'header' | 'bearer')}
            className={INPUT}
          >
            <option value="header">Egyedi fejléc</option>
            <option value="bearer">Bearer token</option>
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
        </label>
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

      {error && <p className="text-sm text-coral">{error}</p>}
      {done && <p className="text-sm text-sage">{done}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={pending || !name.trim() || !baseUrl.trim()}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'Frissítés'}
        </button>
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
  const [editingId, setEditingId] = useState<string | null>(null)

  if (connectors.length === 0) {
    return <p className="text-sm text-ink-faint">Nincs külső kapcsolat hozzárendelve.</p>
  }

  return (
    <ul className="space-y-2 text-sm">
      {connectors.map((item) => {
        const editable = item.connector.type === 'http_api'
        const editing = editingId === item.connector.id

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
              </div>
            </div>
            <p className="mt-1 break-all text-xs text-ink-faint">
              {item.connector.type} · {item.connector.scope}
              {item.connector.secretAlias && ` · ${item.connector.secretAlias}`}
            </p>
            {editing && (
              <EditApiConnectorForm
                agentId={agentId}
                item={item}
                onSaved={() => setEditingId(null)}
                onCancel={() => setEditingId(null)}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
