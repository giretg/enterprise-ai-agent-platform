'use client'

import { useState, useTransition } from 'react'
import {
  archiveSavedQueryAction,
  getSavedQueryVersionsAction,
  trialRunSavedQueryAction,
} from '@/app/actions/warehouse'
import type { SavedQueryView } from '@/domain/warehouse/warehouse-service'
import { Badge, Card } from '@/components/ui/shell'
import { SAVED_QUERY_STATUS, warehouseMessage } from '@/lib/warehouse-labels'

type Act = (fn: () => Promise<{ success: boolean; error?: string }>, okText?: string, after?: () => void) => void

type Trial = Extract<Awaited<ReturnType<typeof trialRunSavedQueryAction>>, { success: true }>['data']
type Versions = Extract<Awaited<ReturnType<typeof getSavedQueryVersionsAction>>, { success: true }>['data']

const TRIAL_ROWS = 20

const PARAM_HINT: Record<string, string> = {
  text: 'szöveg',
  number: 'szám',
  date: 'dátum, pl. 2026-01-31',
  boolean: 'igen / nem',
}

const RELATIVE_LABEL: Record<string, string> = {
  today: 'a mai nap',
  month_start: 'az aktuális hónap első napja',
  prev_month_start: 'az előző hónap első napja',
  prev_month_end: 'az előző hónap utolsó napja',
  year_start: 'az aktuális év első napja',
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return value.toLocaleString('hu-HU')
  if (typeof value === 'boolean') return value ? 'igen' : 'nem'
  return String(value)
}

function defaultLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'object') {
    const relative = String((value as { relative?: unknown }).relative ?? '')
    const days = /^days_ago:(\d+)$/.exec(relative)
    return days ? `${days[1]} nappal ezelőtt` : (RELATIVE_LABEL[relative] ?? relative)
  }
  if (typeof value === 'boolean') return value ? 'igen' : 'nem'
  return String(value)
}

/** #1083 §6: az AI munkatársak mentett lekérdezései, állapottal és próbafuttatással. */
export function SavedQueriesCard({
  queries,
  truncated,
  agentNames,
  datasetTitles,
  queryApps,
  canArchive,
  pending,
  act,
}: {
  queries: SavedQueryView[]
  truncated: boolean
  agentNames: Record<string, string>
  datasetTitles: Record<string, string>
  queryApps: Record<string, Array<{ appId: string; name: string }>>
  canArchive: boolean
  pending: boolean
  act: Act
}) {
  return (
    <Card title="Mentett lekérdezések">
      <p className="max-w-3xl text-sm text-ink-soft">
        Az AI munkatársak elmenthetik a jól működő lekérdezéseiket, hogy azonos kérdésnél ne kelljen újra összeállítaniuk. Ez az adatokat nem
        módosítja. A platform minden lekérdezést összevet az adatkészlet mai szerkezetével, és a jelvény szól, ha az újraellenőrzésre szorul.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Az állapotok jelentése">
        {Object.entries(SAVED_QUERY_STATUS).map(([key, status]) => (
          <li key={key}>
            <Badge tone={status.tone} title={status.hint}>{status.label}</Badge>
          </li>
        ))}
      </ul>
      {queries.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          Még nincs mentett lekérdezés. Az AI munkatársak maguk mentik el, amit érdemes újra felhasználni. Addig minden kérdésnél újra összeállítják a lekérdezést.
        </p>
      ) : (
        <ul className="mt-4 space-y-4 text-sm">
          {queries.map((query) => (
            <SavedQueryRow
              key={query.queryId}
              query={query}
              agentName={agentNames[query.ownerAgentId] ?? 'Ismeretlen munkatárs'}
              datasetTitle={datasetTitles[query.dataset] ?? query.dataset}
              apps={queryApps[query.queryId] ?? []}
              canArchive={canArchive}
              pending={pending}
              act={act}
            />
          ))}
        </ul>
      )}
      {truncated ? <p className="mt-3 text-sm text-ink-soft">Csak az utoljára használt {queries.length} lekérdezés látszik.</p> : null}
    </Card>
  )
}

function SavedQueryRow({
  query,
  agentName,
  datasetTitle,
  apps,
  canArchive,
  pending,
  act,
}: {
  query: SavedQueryView
  agentName: string
  datasetTitle: string
  apps: Array<{ appId: string; name: string }>
  canArchive: boolean
  pending: boolean
  act: Act
}) {
  const status = SAVED_QUERY_STATUS[query.schemaStatus]!
  const [versions, setVersions] = useState<Versions | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  return (
    <li className="rounded-lg border border-ink/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          <code>{query.name}</code> <Badge tone={status.tone} title={status.hint}>{status.label}</Badge>
        </p>
        {canArchive ? (
          <button
            type="button"
            disabled={pending}
            title="A lekérdezés kikerül a munkatárs listájából, és 90 nap múlva végleg törlődik. Az adatok nem változnak."
            onClick={() => {
              if (window.confirm(`Archiválod a(z) „${query.name}” lekérdezést? 90 nap múlva végleg törlődik, a munkatárs addig is újra összeállítja vagy újra elmenti. Az adatok nem változnak.`)) {
                act(() => archiveSavedQueryAction({ queryId: query.queryId }), 'A lekérdezés archiválva.')
              }
            }}
            className="rounded-lg border border-ink/20 px-3 py-1 disabled:opacity-50"
          >
            Archiválás
          </button>
        ) : null}
      </div>
      <p className="mt-1">{query.description}</p>
      <p className="mt-1 text-ink-soft">
        {agentName} · {datasetTitle} · Mentve: {formatDate(query.savedAt)} ({query.version}. verzió)
        {query.reviewedAt ? ` · Átnézve: ${formatDate(query.reviewedAt)}` : ''} · Utolsó futás: {formatDate(query.lastRunAt)} · {query.runCount} futás
      </p>
      {apps.length > 0 ? (
        <p className="mt-1 text-ink-soft">
          Ebből dolgozik:{' '}
          {apps.map((app, index) => (
            <span key={app.appId}>
              {index > 0 ? ', ' : ''}
              <a href={`/control-plane/mini-apps/${app.appId}`} className="font-medium text-coral-deep underline">{app.name}</a>
            </span>
          ))}
          . Amíg ezek használják, a lekérdezés nem archiválható.
        </p>
      ) : null}
      <details
        className="mt-2"
        onToggle={(event) => {
          if (!event.currentTarget.open || versions) return
          void getSavedQueryVersionsAction({ queryId: query.queryId }).then((res) => {
            if (res.success) setVersions(res.data)
            else setVersionsError(res.error)
          })
        }}
      >
        <summary className="cursor-pointer">Részletek és próbafuttatás</summary>
        <div className="mt-2 space-y-3">
          <p>{query.summary}</p>
          <SchemaChanges query={query} />
          {versionsError ? <p role="alert" className="rounded-lg bg-red-50 p-2 text-red-800">{versionsError}</p> : null}
          {versions && versions.length > 1 ? (
            <div>
              <p className="font-medium">Verziók</p>
              <ul className="text-ink-soft">
                {versions.map((version) => (
                  <li key={version.version}>
                    {version.version}. verzió · {formatDate(version.createdAt)}
                    {version.changeNote ? ` · ${version.changeNote}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {query.schemaStatus === 'broken' ? null : <TrialRun query={query} />}
        </div>
      </details>
    </li>
  )
}

function SchemaChanges({ query }: { query: SavedQueryView }) {
  if (query.schemaStatus === 'broken') {
    return (
      <p role="alert" className="rounded-lg bg-red-50 p-2 text-red-800">
        {SAVED_QUERY_STATUS.broken!.hint}
      </p>
    )
  }
  if (query.schemaStatus === 'meaning_changed') {
    return (
      <p className="rounded-lg bg-honey/15 p-2">
        Megváltozott a jelentése: {query.changedFields.map((field) => field.label).join(', ')}. {warehouseMessage('saved_query_meaning_changed')}
      </p>
    )
  }
  if (query.schemaStatus === 'dataset_extended') {
    const fields = query.newFields.map((field) => field.label).join(', ')
    return <p className="rounded-lg bg-ink/5 p-2">{warehouseMessage('saved_query_dataset_extended')}{fields ? ` Új mezők: ${fields}.` : ''}</p>
  }
  return null
}

function TrialRun({ query }: { query: SavedQueryView }) {
  const [pending, startTransition] = useTransition()
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<Trial | null>(null)
  const [error, setError] = useState<string | null>(null)

  function run() {
    setError(null)
    setResult(null)
    startTransition(async () => {
      const res = await trialRunSavedQueryAction({ queryId: query.queryId, params: values })
      if (res.success) setResult(res.data)
      else setError(res.error)
    })
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        run()
      }}
    >
      <p className="font-medium">Próbafuttatás</p>
      <p className="text-ink-soft">Lefuttatja a lekérdezést a mostani adatokon, és megmutatja az első {TRIAL_ROWS} sort. Semmi nem változik.</p>
      {query.params.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {query.params.map((param) => {
            const fallback = defaultLabel(param.default)
            return (
              <label key={param.name} className="block">
                <span className="block text-ink-soft">{param.description ?? param.name} ({PARAM_HINT[param.type]})</span>
                {param.type === 'boolean' ? (
                  <select
                    value={values[param.name] ?? ''}
                    onChange={(event) => setValues({ ...values, [param.name]: event.target.value })}
                    className="mt-1 rounded-lg border border-ink/20 px-2 py-1"
                  >
                    <option value="">{fallback ? `Alapérték: ${fallback}` : 'Válassz'}</option>
                    <option value="true">igen</option>
                    <option value="false">nem</option>
                  </select>
                ) : (
                  <input
                    type={param.type === 'date' ? 'date' : param.type === 'number' ? 'number' : 'text'}
                    step={param.type === 'number' ? 'any' : undefined}
                    value={values[param.name] ?? ''}
                    required={fallback === null}
                    onChange={(event) => setValues({ ...values, [param.name]: event.target.value })}
                    className="mt-1 rounded-lg border border-ink/20 px-2 py-1"
                  />
                )}
                {fallback ? <span className="block text-xs text-ink-soft">Üresen hagyva: {fallback}</span> : null}
              </label>
            )
          })}
        </div>
      ) : null}
      <button type="submit" disabled={pending} className="rounded-lg border border-ink/20 px-3 py-1 disabled:opacity-50">
        {pending ? 'Fut…' : 'Próbafuttatás'}
      </button>
      {error ? <p role="alert" className="rounded-lg bg-red-50 p-2 text-red-800">{error}</p> : null}
      {result ? <TrialResult result={result} /> : null}
    </form>
  )
}

function TrialResult({ result }: { result: Trial }) {
  return (
    <div className="space-y-2">
      {result.warnings.map((code) => (
        <p key={code} className="rounded-lg bg-honey/15 p-2">
          {warehouseMessage(code)}
        </p>
      ))}
      <p className="text-ink-soft">Az adatok utolsó betöltése: {formatDate(result.freshness)}</p>
      {result.rows.length === 0 ? (
        <p>Nincs a feltételeknek megfelelő sor.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-ink-soft">
              <tr>{result.columns.map((column, index) => <th key={index} className="py-1 pr-4 font-medium">{column}</th>)}</tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index} className="border-t border-ink/10">
                  {row.map((value, column) => <td key={column} className="py-1 pr-4">{formatCell(value)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.hasMore ? <p className="text-ink-soft">Van több sor is, itt az első {result.rows.length} látszik.</p> : null}
    </div>
  )
}
