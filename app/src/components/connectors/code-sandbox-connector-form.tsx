'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  listCodeSandboxConnectors,
  saveCodeSandboxConnector,
  testCodeSandboxConnector,
} from '@/app/actions/code-sandbox'

export const CODE_SANDBOX_PRESETS = {
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

export type CodeSandboxPreset = keyof typeof CODE_SANDBOX_PRESETS

export type CodeSandboxFormState = {
  connectorId: string
  name: string
  preset: CodeSandboxPreset
  baseUrl: string
  maxExecSec: number
  cpuProfile: string
  memoryProfile: string
  maxCallsPerScope: number
  maxExecSecPerScope: number
  apiKey: string
  enabled: boolean
}

export const defaultCodeSandboxFormState = (): CodeSandboxFormState => ({
  connectorId: '',
  name: 'EU kódfuttató sandbox',
  preset: 'cloud-run-eu',
  baseUrl: '',
  maxExecSec: 120,
  cpuProfile: '1',
  memoryProfile: '512Mi',
  maxCallsPerScope: 10,
  maxExecSecPerScope: 300,
  apiKey: '',
  enabled: true,
})

const INPUT =
  'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

export const CODE_SANDBOX_HELP =
  'Melyik külső dobozban fusson az agent által írt kód. A doboz nem lát platform-adatot, csak azt, amit a futtatás bemenetként kap.'

function Hint({ text }: { text: string }) {
  return (
    <span className="ml-1 cursor-help text-ink-faint" title={text}>
      ?
    </span>
  )
}

type Row = {
  id: string
  name: string
  lifecycleState: string
  config: {
    provider: 'cloud_run' | 'e2b_compatible'
    region: string
    baseUrl?: string
    maxExecSec: number
    cpuProfile: string
    memoryProfile: string
    maxCallsPerScope: number
    maxExecSecPerScope: number
  }
}

export function rowToForm(row: Row): CodeSandboxFormState {
  return {
    connectorId: row.id,
    name: row.name,
    preset:
      row.config.provider === 'cloud_run'
        ? 'cloud-run-eu'
        : row.config.region.startsWith('eu-central')
          ? 'lelantos-eu'
          : 'e2b',
    baseUrl: row.config.baseUrl ?? '',
    maxExecSec: row.config.maxExecSec,
    cpuProfile: row.config.cpuProfile,
    memoryProfile: row.config.memoryProfile,
    maxCallsPerScope: row.config.maxCallsPerScope,
    maxExecSecPerScope: row.config.maxExecSecPerScope,
    apiKey: '',
    enabled: row.lifecycleState === 'active',
  }
}

export function codeSandboxFormReady(state: CodeSandboxFormState): boolean {
  return Boolean(state.name.trim() && state.baseUrl.trim())
}

export function buildCodeSandboxSaveInput(state: CodeSandboxFormState) {
  const selected = CODE_SANDBOX_PRESETS[state.preset]
  return {
    ...(state.connectorId ? { connectorId: state.connectorId } : {}),
    name: state.name.trim(),
    provider: selected.provider,
    region: selected.region,
    baseUrl: state.baseUrl.trim(),
    maxExecSec: state.maxExecSec,
    cpuProfile: state.cpuProfile,
    memoryProfile: state.memoryProfile,
    maxCallsPerScope: state.maxCallsPerScope,
    maxExecSecPerScope: state.maxExecSecPerScope,
    enabled: state.enabled,
    ...(state.apiKey ? { apiKey: state.apiKey } : {}),
  }
}

export function CodeSandboxConnectorForm({
  value,
  onChange,
  showActions = true,
  showConnectorPicker = true,
  onSaved,
}: {
  value: CodeSandboxFormState
  onChange: (next: CodeSandboxFormState) => void
  showActions?: boolean
  showConnectorPicker?: boolean
  onSaved?: (connectorId: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState<Row[]>([])
  const [platformEnabled, setPlatformEnabled] = useState(true)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!showConnectorPicker) return
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
  }, [showConnectorPicker])

  function patch(partial: Partial<CodeSandboxFormState>) {
    onChange({ ...value, ...partial })
  }

  function choose(id: string) {
    const row = rows.find((item) => item.id === id)
    if (!row) {
      onChange(defaultCodeSandboxFormState())
      return
    }
    onChange(rowToForm(row))
  }

  function save() {
    startTransition(async () => {
      setMessage(null)
      const result = await saveCodeSandboxConnector(buildCodeSandboxSaveInput(value))
      setMessage(result.success ? 'A kódfuttató connector mentve.' : result.error)
      if (result.success) {
        patch({ connectorId: result.data.connectorId, apiKey: '' })
        if (showConnectorPicker) {
          const listed = await listCodeSandboxConnectors()
          if (listed.success) {
            setPlatformEnabled(listed.data.platformEnabled)
            setRows(listed.data.connectors)
          }
        }
        onSaved?.(result.data.connectorId)
      }
    })
  }

  function test() {
    if (!value.connectorId) return
    startTransition(async () => {
      setMessage(null)
      const result = await testCodeSandboxConnector({ connectorId: value.connectorId })
      setMessage(
        result.success
          ? 'A provision → Python → fájlhíd → destroy próba sikeres.'
          : result.error,
      )
    })
  }

  return (
    <div className="space-y-3">
      {showConnectorPicker ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs text-ink-faint">{CODE_SANDBOX_HELP}</p>
            <p className="mt-1 text-xs text-ink-faint">
              Globális leállítás: {platformEnabled ? 'üzemel' : 'CODE_SANDBOX_ENABLED=false'}
              . Connector-szintű kapcsoló lent.
            </p>
          </div>
          <select
            value={value.connectorId}
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
      ) : (
        <p className="text-xs text-ink-faint">{CODE_SANDBOX_HELP}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-ink-soft">Név</span>
          <input
            value={value.name}
            onChange={(e) => patch({ name: e.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">
            Preset
            <Hint text="Előtölti a szolgáltatót és az EU-régiót. A Gateway URL-t ettől még meg kell adni." />
          </span>
          <select
            value={value.preset}
            onChange={(e) => patch({ preset: e.target.value as CodeSandboxPreset })}
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
            value={value.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder={CODE_SANDBOX_PRESETS[value.preset].placeholder}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Max. futás (másodperc)</span>
          <input
            type="number"
            min={1}
            max={900}
            value={value.maxExecSec}
            onChange={(e) => patch({ maxExecSec: Number(e.target.value) })}
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
            value={value.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value })}
            autoComplete="off"
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">CPU profil</span>
          <input
            value={value.cpuProfile}
            onChange={(e) => patch({ cpuProfile: e.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Memória profil</span>
          <input
            value={value.memoryProfile}
            onChange={(e) => patch({ memoryProfile: e.target.value })}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Hívásplafon / beszélgetés vagy ticket</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={value.maxCallsPerScope}
            onChange={(e) => patch({ maxCallsPerScope: Number(e.target.value) })}
            className={INPUT}
          />
        </label>
        <label className="text-sm">
          <span className="text-ink-soft">Időplafon (mp) / beszélgetés vagy ticket</span>
          <input
            type="number"
            min={1}
            max={3600}
            value={value.maxExecSecPerScope}
            onChange={(e) => patch({ maxExecSecPerScope: Number(e.target.value) })}
            className={INPUT}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />{' '}
        Connector engedélyezve
      </label>
      {message ? (
        <p className="text-sm text-ink-soft" aria-live="polite">
          {message}
        </p>
      ) : null}
      {showActions ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={pending || !codeSandboxFormReady(value)}
            className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-50"
          >
            Mentés
          </button>
          <button
            type="button"
            onClick={test}
            disabled={pending || !value.connectorId}
            className="rounded-full border border-line px-4 py-2 text-sm text-ink-soft disabled:opacity-50"
          >
            Kapcsolat tesztelése
          </button>
        </div>
      ) : null}
    </div>
  )
}
