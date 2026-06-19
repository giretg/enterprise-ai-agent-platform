'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setDatabaseMode, syncTestDatabaseFromProduction } from '@/app/actions/platform'

export type DatabaseSyncStatusView = {
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  method: 'neon_restore' | 'pg_copy' | null
  startedAt: string | null
  completedAt: string | null
  startedById: string | null
  error: string | null
  tableCount: number | null
  rowCount: number | null
  durationMs: number | null
}

export type DatabaseModeView = {
  mode: 'production' | 'test'
  testConfigured: boolean
  activeUrlHost: string | null
  updatedById: string | null
  updatedAt: string | null
  syncStatus: DatabaseSyncStatusView
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function syncMethodLabel(method: DatabaseSyncStatusView['method']): string {
  if (method === 'neon_restore') return 'Neon branch restore'
  if (method === 'pg_copy') return 'PostgreSQL másolás'
  return '—'
}

export function DatabaseControlPanel({
  initial,
  canEdit,
}: {
  initial: DatabaseModeView
  canEdit: boolean
}) {
  const [info, setInfo] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [syncPending, startSyncTransition] = useTransition()
  const [confirmSync, setConfirmSync] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const busy = pending || syncPending
  const syncStatus = info.syncStatus
  const syncRunning = syncStatus.status === 'running'

  function switchMode(mode: 'production' | 'test') {
    if (mode === info.mode) return
    setMessage(null)
    startTransition(async () => {
      const res = await setDatabaseMode({ mode })
      if (res.success) {
        setInfo((prev) => ({ ...prev, ...res.data }))
        setMessage({
          tone: 'ok',
          text:
            mode === 'test'
              ? 'Teszt adatbázis aktív. A következő kérések már a teszt branch-en futnak.'
              : 'Éles adatbázis aktív.',
        })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function runSync() {
    setMessage(null)
    startSyncTransition(async () => {
      const res = await syncTestDatabaseFromProduction({ confirm: true })
      setConfirmSync(false)
      if (res.success) {
        setInfo((prev) => ({ ...prev, syncStatus: res.data.syncStatus }))
        const { result } = res.data
        setMessage({
          tone: 'ok',
          text:
            result.method === 'neon_restore'
              ? `Teszt branch frissítve az éles állapotra (${formatDuration(result.durationMs)}).`
              : `Teszt adatbázis másolva: ${result.tableCount} tábla, ${result.rowCount} sor (${formatDuration(result.durationMs)}).`,
        })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  const isTest = info.mode === 'test'

  return (
    <Card title="Adatbázis környezet (Neon)">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${
                isTest ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
            />
            <div>
              <p className="text-sm font-semibold">
                {isTest ? 'Teszt adatbázis' : 'Éles adatbázis'}
                {info.activeUrlHost ? (
                  <span className="ml-2 font-normal text-ink-soft">({info.activeUrlHost})</span>
                ) : null}
              </p>
              <p className="text-xs text-ink-soft">
                {isTest
                  ? 'A ticketek, agentek és audit adatok a Neon teszt branch-en vannak — az éles adatok érintetlenek.'
                  : 'A platform az éles Neon branch-et használja (alapértelmezett).'}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canEdit || busy || info.mode === 'production'}
              onClick={() => switchMode('production')}
              className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium disabled:opacity-50 data-[active=true]:border-emerald-500/50 data-[active=true]:bg-emerald-500/10"
              data-active={info.mode === 'production'}
            >
              Éles
            </button>
            <button
              type="button"
              disabled={!canEdit || busy || !info.testConfigured || info.mode === 'test'}
              onClick={() => switchMode('test')}
              className="rounded-lg border border-line bg-panel px-4 py-2 text-sm font-medium disabled:opacity-50 data-[active=true]:border-amber-500/50 data-[active=true]:bg-amber-500/10"
              data-active={info.mode === 'test'}
            >
              Teszt
            </button>
          </div>
        </div>

        <div className="border-t border-line/40 pt-4">
          <p className="text-sm font-medium">Teszt frissítése élesből</p>
          <p className="mt-1 text-xs text-ink-soft">
            Felülírja a teszt adatbázis teljes tartalmát az éles branch aktuális állapotával. Az éles
            adat érintetlen marad. Neon API esetén branch restore (~1 mp), egyébként PostgreSQL
            tábla-másolás.
          </p>

          {syncRunning ? (
            <p className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-200">
              Szinkron folyamatban…
            </p>
          ) : null}

          {syncStatus.status === 'succeeded' && syncStatus.completedAt ? (
            <p className="mt-3 text-xs text-ink-soft">
              Utolsó sikeres frissítés: {new Date(syncStatus.completedAt).toLocaleString('hu-HU')}
              {' · '}
              {syncMethodLabel(syncStatus.method)}
              {syncStatus.rowCount !== null && syncStatus.rowCount > 0
                ? ` · ${syncStatus.rowCount} sor`
                : ''}
              {' · '}
              {formatDuration(syncStatus.durationMs)}
            </p>
          ) : null}

          {syncStatus.status === 'failed' && syncStatus.error ? (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              Utolsó szinkron sikertelen: {syncStatus.error}
            </p>
          ) : null}

          {!confirmSync ? (
            <button
              type="button"
              disabled={!canEdit || busy || !info.testConfigured || syncRunning}
              onClick={() => setConfirmSync(true)}
              className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Teszt frissítése éles adatokkal
            </button>
          ) : (
            <div className="mt-3 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-sm text-amber-100">
                Biztosan felülírod a teszt adatbázist? A teszt branch-en lévő összes adat elvész.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={runSync}
                  className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                >
                  Igen, frissítés
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmSync(false)}
                  className="rounded-lg border border-line bg-panel px-4 py-2 text-sm disabled:opacity-50"
                >
                  Mégse
                </button>
              </div>
            </div>
          )}
        </div>

        {!info.testConfigured ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            A teszt adatbázis nincs konfigurálva. Állítsd be a{' '}
            <code className="text-xs">DATABASE_URL_TEST</code> és{' '}
            <code className="text-xs">DIRECT_URL_TEST</code> env változókat (Neon branch
            connection string).
          </p>
        ) : null}

        {isTest ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            Figyelem: teszt módban vagy. A dispatcher worker és más háttérfolyamatok is a teszt
            adatbázist használják (max. ~15 mp késleltetéssel más instance-oknál).
          </p>
        ) : null}

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </p>
        ) : null}

        {!canEdit ? (
          <p className="text-xs text-ink-soft">Módosításhoz admin jogosultság szükséges.</p>
        ) : null}

        <p className="text-xs text-ink-soft">
          Utoljára módosítva:{' '}
          {info.updatedAt ? new Date(info.updatedAt).toLocaleString('hu-HU') : '— (alapértelmezett: éles)'}
          {' · '}A beállítás az éles Neon branch platform_settings táblájában tárolódik.
        </p>
      </div>
    </Card>
  )
}
