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
    maxCallsPerScope: number
    maxExecSecPerScope: number
  }
  recentCalls: Array<{
    status: string
    latencyMs: number
    metrics: Record<string, unknown> | null
    createdAt: string
  }>
}

const PRESETS = {
  'cloud-run-eu': {
    provider: 'cloud_run' as const,
    region: 'europe-west1',
    placeholder: 'https://code-sandbox-xxxxx.run.app',
  },
  'lelantos-eu': {
    provider: 'e2b_compatible' as const,
    region: 'eu-central-1',
    placeholder: 'https://api.lelantos.eu',
  },
  e2b: {
    provider: 'e2b_compatible' as const,
    region: 'eu-west-1',
    placeholder: 'https://api.e2b.dev',
  },
} as const

const INPUT =
  'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

const HELP =
  'Melyik külső dobozban fusson az agent által írt kód. A doboz nem lát platform-adatot, csak azt, amit a futtatás bemenetként kap.'

function Hint({ text }: { text: string }) {
  return (
    <span className="ml-1 cursor-help text-ink-faint" title={text}>
      ?
    </span>
  )
}

export function CodeSandboxConnectorPanel() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState<Row[]>([])
  const [platformEnabled, setPlatformEnabled] = useState(true)
  const [connectorId, setConnectorId] = useState('')
  const [name, setName] = useState('EU kódfuttató sandbox')
  const [preset, setPreset] = useState<keyof typeof PRESETS>('cloud-run-eu')
  const [baseUrl, setBaseUrl] = useState('')
  const [maxExecSec, setMaxExecSec] = useState(120)
  const [cpuProfile, setCpuProfile] = useState('1')
  const [memoryProfile, setMemoryProfile] = useState('512Mi')
  const [maxCallsPerScope, setMaxCallsPerScope] = useState(10)
  const [maxExecSecPerScope, setMaxExecSecPerScope] = useState(300)
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const activeRow = rows.find((row) => row.id === connectorId)

  async function reload() {
    const result = await listCodeSandboxConnectors()
    if (result.success) {
      setPlatformEnabled(result.data.platformEnabled)
      setRows(result.data.connectors)
    }
  }

  useEffect(() => {
    let cancelled = false
    void listCodeSandboxConnectors().then((result) => {
      if (!cancelled && result.success) {
        setPlatformEnabled(result.data.platformEnabled)
        setRows(result.data.connectors)
      }
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
    setPreset(
      row.config.provider === 'cloud_run'
        ? 'cloud-run-eu'
        : row.config.region.startsWith('eu-central')
          ? 'lelantos-eu'
          : 'e2b',
    )
    setBaseUrl(row.config.baseUrl ?? '')
    setMaxExecSec(row.config.maxExecSec)
    setCpuProfile(row.config.cpuProfile)
    setMemoryProfile(row.config.memoryProfile)
    setMaxCallsPerScope(row.config.maxCallsPerScope)
    setMaxExecSecPerScope(row.config.maxExecSecPerScope)
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
        cpuProfile,
        memoryProfile,
        maxCallsPerScope,
        maxExecSecPerScope,
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
          ? 'A provision → Python → fájlhíd → destroy próba sikeres.'
          : result.error,
      )
    })
  }

  return (
    <div className="rounded-xl border border-line bg-night-1 p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-ink">
            Kódfuttató sandbox
            <Hint text={HELP} />
          </h3>
          <p className="text-xs text-ink-faint">{HELP}</p>
          <p className="mt-1 text-xs text-ink-faint">
            Globális leállítás: {platformEnabled ? 'üzemel' : 'CODE_SANDBOX_ENABLED=false'}
            . Connector-szintű kapcsoló lent.
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
          <span className="text-ink-soft">
            Preset
            <Hint text="Előtölti a szolgáltatót és az EU-régiót. A Gateway URL-t ettől még meg kell adni." />
          </span>
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
          <span className="text-ink-soft">
            Gateway URL
            <Hint text="A sandbox HTTP-végpontja. Cloud Runon a service URL; Lelantos/E2B-n az EU-s API base URL." />
          </span>
          <input
            type="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={PRESETS[preset].placeholder}
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
          <span className="text-ink-soft">
            Megosztott token
            <Hint text="Nem Cloud Run környezethez kötelező. Cloud Runon az IAM identity token helyettesíti." />
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">CPU profil</span>
          <input
            value={cpuProfile}
            onChange={(e) => setCpuProfile(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Memória profil</span>
          <input
            value={memoryProfile}
            onChange={(e) => setMemoryProfile(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Hívásplafon / beszélgetés vagy ticket</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxCallsPerScope}
            onChange={(e) => setMaxCallsPerScope(Number(e.target.value))}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Időplafon (mp) / beszélgetés vagy ticket</span>
          <input
            type="number"
            min={1}
            max={3600}
            value={maxExecSecPerScope}
            onChange={(e) => setMaxExecSecPerScope(Number(e.target.value))}
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
      {activeRow?.recentCalls.length ? (
        <div className="mt-3 space-y-1 text-xs text-ink-faint">
          {activeRow.recentCalls.map((call) => (
            <p key={call.createdAt}>
              {call.status} · {call.latencyMs} ms ·{' '}
              {new Date(call.createdAt).toLocaleString('hu-HU')}
              {call.metrics
                ? ` · ${String(call.metrics.provider ?? activeRow.config.provider)} · ${String(call.metrics.region ?? activeRow.config.region)} · I/O ${String(call.metrics.inputBytes ?? '–')}/${String(call.metrics.outputBytes ?? '–')} B · exit ${String(call.metrics.exitStatus ?? '–')}`
                : ''}
            </p>
          ))}
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
