'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createHttpApiConnectorForAgent } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type EndpointRow = { method: string; path: string; description: string }

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

// Admin egy külső REST API-t köt egy agenthez: connector (http_api) létrehozása,
// a kulcs a secret-store mögé kerül (NEM a DB-be), és a két http_api capability
// engedélyezése. A megadott endpointok + leírás a modell elé kerülnek híváskor.
export function AddApiConnectorForm({ agentId }: { agentId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [authScheme, setAuthScheme] = useState<'header' | 'bearer'>('header')
  const [authHeader, setAuthHeader] = useState('X-Api-Key')
  const [apiKey, setApiKey] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('write')
  const [description, setDescription] = useState('')
  const [restrictToEndpoints, setRestrictToEndpoints] = useState(false)
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([
    { method: 'GET', path: '', description: '' },
  ])

  function updateEndpoint(index: number, patch: Partial<EndpointRow>) {
    setEndpoints((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function submit() {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const cleanedEndpoints = endpoints
        .map((e) => ({ ...e, path: e.path.trim(), description: e.description.trim() }))
        .filter((e) => e.path.length > 0)
        .map((e) => ({
          method: e.method as EndpointRow['method'],
          path: e.path,
          ...(e.description ? { description: e.description } : {}),
        }))

      const res = await createHttpApiConnectorForAgent({
        agentId,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authScheme,
        ...(authScheme === 'header' ? { authHeader: authHeader.trim() } : {}),
        apiKey: apiKey.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        accessMode,
        restrictToEndpoints,
        ...(cleanedEndpoints.length > 0 ? { endpoints: cleanedEndpoints } : {}),
      })

      if (res.success) {
        setDone(`„${res.data.name}" hozzáadva — az agent mostantól hívhatja.`)
        setName('')
        setBaseUrl('')
        setApiKey('')
        setDescription('')
        setEndpoints([{ method: 'GET', path: '', description: '' }])
        setRestrictToEndpoints(false)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <Card title="Új API-kapcsolat hozzáadása">
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
              onChange={(e) => setAuthScheme(e.target.value as 'header' | 'bearer')}
              className={INPUT}
            >
              <option value="header">Egyedi fejléc (pl. X-Api-Key)</option>
              <option value="bearer">Bearer token (Authorization)</option>
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

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-ink-soft">Endpointok (a modell ezeket látja)</span>
            <button
              type="button"
              onClick={() =>
                setEndpoints((prev) => [...prev, { method: 'GET', path: '', description: '' }])
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
                className="col-span-9 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm sm:col-span-4"
              />
              <input
                value={row.description}
                onChange={(e) => updateEndpoint(index, { description: e.target.value })}
                placeholder="Mit csinál (opcionális)"
                className="col-span-10 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm sm:col-span-5"
              />
              <button
                type="button"
                onClick={() => setEndpoints((prev) => prev.filter((_, i) => i !== index))}
                disabled={endpoints.length === 1}
                className="col-span-2 rounded-lg border border-line text-sm text-ink-faint hover:bg-night-2 disabled:opacity-40 sm:col-span-1"
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
          disabled={pending || !name.trim() || !baseUrl.trim() || !apiKey.trim()}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'API-kapcsolat hozzáadása'}
        </button>
      </form>
    </Card>
  )
}
