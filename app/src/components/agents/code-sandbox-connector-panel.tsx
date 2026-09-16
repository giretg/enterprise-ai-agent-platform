'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  listCodeSandboxConnectors,
  saveCodeSandboxConnector,
  testCodeSandboxConnector,
} from '@/app/actions/code-sandbox'

type Row = {
  id: string
  name: string
  lifecycleState: string
  hasApiKey: boolean
  config: {
    provider: 'cloud_run' | 'e2b_compatible'
    region: string
    baseUrl?: string
    maxExecSec: number
    defaultAllowEgress: false
    cpuProfile: string
    memoryProfile: string
  }
  lastCall: {
    status: string
    latencyMs: number
    metrics: Record<string, unknown> | null
    createdAt: string
  } | null
}

const PRESETS = {
  'cloud-run-eu': { provider: 'cloud_run', region: 'europe-west1' },
  'lelantos-eu': { provider: 'e2b_compatible', region: 'eu-central-1' },
  e2b: { provider: 'e2b_compatible', region: 'eu-central-1' },
} as const

const INPUT =
  'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

export function CodeSandboxConnectorPanel() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState<Row[]>([])
  const [connectorId, setConnectorId] = useState('')
  const [name, setName] = useState('EU kódfuttató sandbox')
  const [preset, setPreset] = useState<keyof typeof PRESETS>('cloud-run-eu')
  const [baseUrl, setBaseUrl] = useState('')
  const [maxExecSec, setMaxExecSec] = useState(120)
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const activeRow = rows.find((row) => row.id === connectorId)
  const lastMetrics = activeRow?.lastCall?.metrics

  async function reload() {
    const result = await listCodeSandboxConnectors()
    if (result.success) setRows(result.data)
  }

  useEffect(() => {
    let cancelled = false
    void listCodeSandboxConnectors().then((result) => {
      if (!cancelled && result.success) setRows(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  function choose(id: string) {
    setConnectorId(id)
    const row = rows.find((item) => item.id === id)
    if (!row) return
    setName(row.name)
    setPreset(row.config.provider === 'cloud_run' ? 'cloud-run-eu' : 'e2b')
    setBaseUrl(row.config.baseUrl ?? '')
    setMaxExecSec(row.config.maxExecSec)
    setEnabled(row.lifecycleState === 'active')
    setApiKey('')
  }

  function save() {
    startTransition(async () => {
      setMessage(null)
      const selected = PRESETS[preset]
      const result = await saveCodeSandboxConnector({
        ...(connectorId ? { connectorId } : {}),
        name,
        provider: selected.provider,
        region: selected.region,
        baseUrl,
        maxExecSec,
        cpuProfile: '1',
        memoryProfile: '512Mi',
        enabled,
        ...(apiKey ? { apiKey } : {}),
      })
      setMessage(
        result.success ? 'A kódfuttató connector mentve.' : result.error,
      )
      if (result.success) {
        setConnectorId(result.data.connectorId)
        setApiKey('')
        await reload()
        router.refresh()
      }
    })
  }

  function test() {
    if (!connectorId) return
    startTransition(async () => {
      setMessage(null)
      const result = await testCodeSandboxConnector({ connectorId })
      setMessage(
        result.success
          ? 'A provision → exec → destroy próba sikeres.'
          : result.error,
      )
    })
  }

  return (
    <div className="rounded-xl border border-line bg-night-1 p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-ink">Kódfuttató sandbox</h3>
          <p className="text-xs text-ink-faint">
            Provider-konfiguráció és globális leállító kapcsoló. A hozzárendelés
            agentenként külön történik.
          </p>
        </div>
        <select
          value={connectorId}
          onChange={(event) => choose(event.target.value)}
          className={INPUT}
          aria-label="Meglévő sandbox connector"
        >
          <option value="">Új connector</option>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-ink-soft">Név</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Preset</span>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as keyof typeof PRESETS)}
            className={INPUT}
          >
            <option value="cloud-run-eu">Cloud Run · EU</option>
            <option value="lelantos-eu">Lelantos · EU</option>
            <option value="e2b">E2B-kompatibilis · EU végpont</option>
          </select>
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-ink-soft">Gateway URL</span>
          <input
            type="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://sandbox.example.com"
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Max. futás (másodperc)</span>
          <input
            type="number"
            min={1}
            max={900}
            value={maxExecSec}
            onChange={(e) => setMaxExecSec(Number(e.target.value))}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Megosztott token (opcionális)</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            className={INPUT}
          />
        </label>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{' '}
        Connector engedélyezve
      </label>
      {activeRow?.lastCall ? (
        <div className="mt-3 text-xs text-ink-faint">
          <p>
            Utolsó futás: {activeRow.lastCall.status} ·{' '}
            {activeRow.lastCall.latencyMs} ms ·{' '}
            {new Date(activeRow.lastCall.createdAt).toLocaleString('hu-HU')}
          </p>
          {lastMetrics ? (
            <p>
              {String(lastMetrics.provider ?? activeRow.config.provider)} ·{' '}
              {String(lastMetrics.region ?? activeRow.config.region)} ·
              provision {String(lastMetrics.provisionMs ?? '–')} ms · exec{' '}
              {String(lastMetrics.execMs ?? '–')} ms · I/O{' '}
              {String(lastMetrics.inputBytes ?? '–')}/
              {String(lastMetrics.outputBytes ?? '–')} B · exit{' '}
              {String(lastMetrics.exitStatus ?? '–')}
            </p>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p className="mt-3 text-sm text-ink-soft" aria-live="polite">
          {message}
        </p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || !name || !baseUrl}
          className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          Mentés
        </button>
        <button
          type="button"
          onClick={test}
          disabled={pending || !connectorId}
          className="rounded-full border border-line px-4 py-2 text-sm text-ink-soft disabled:opacity-50"
        >
          Kapcsolat tesztelése
        </button>
      </div>
    </div>
  )
}
