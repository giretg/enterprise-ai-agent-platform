'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getSandboxAppPreviewUrl, listSandboxApps } from '@/app/actions/platform'
import { Badge } from '@/components/ui/shell'
import { agentWorkspacePath } from '@/lib/agent-workspace-routes'

type MiniAppSummary = {
  appId: string
  name: string
  description?: string
  status: string
  activeVersion?: number
  updatedAt: string
}

function appStatusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'blocked') return 'danger'
  if (status === 'archived') return 'neutral'
  return 'warning'
}

function appIcon(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('riport') || lower.includes('report') || lower.includes('excel')) return '📊'
  if (lower.includes('pdf') || lower.includes('dokument')) return '📄'
  if (lower.includes('levél') || lower.includes('email') || lower.includes('válasz')) return '✉️'
  return '🧩'
}

export function AgentWorkspaceApps({
  agentId,
  taskOnly = false,
}: {
  agentId: string
  taskOnly?: boolean
}) {
  const router = useRouter()
  const [apps, setApps] = useState<MiniAppSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(true)
      setError(null)
      void listSandboxApps({ createdByAgentId: agentId }).then((res) => {
        if (cancelled) return
        if (!res.success) {
          setError(res.error)
          setApps([])
          setLoading(false)
          return
        }
        setApps(res.data.apps)
        setLoading(false)
      })
    })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const handleOpen = (appId: string) => {
    setOpenError(null)
    setOpeningId(appId)
    getSandboxAppPreviewUrl({ appId })
      .then((res) => {
        if (!res.success) {
          setOpenError(res.error)
          return
        }
        window.open(res.data.previewUrl, '_blank', 'noopener,noreferrer')
      })
      .finally(() => setOpeningId(null))
  }

  const handleNewApp = () => {
    router.push(agentWorkspacePath(agentId, taskOnly ? 'task' : 'chat'))
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-ink-faint">Mini-appok betöltése…</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-[1080px]">
        {error && (
          <p className="mb-4 rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
            Nem sikerült betölteni a mini-appokat: {error}
          </p>
        )}
        {openError && (
          <p className="mb-4 rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
            {openError}
          </p>
        )}

        {apps.length === 0 && !error ? (
          <div className="atelier-card max-w-lg p-5">
            <p className="text-sm text-ink-soft">
              Még nincs mini-app ehhez a munkatárshoz. Kérd meg beszélgetésben, hogy készítsen egyet
              — vagy hozz létre kézzel a{' '}
              <Link href="/control-plane/apps" className="text-coral hover:underline">
                katalógusban
              </Link>
              .
            </p>
            <button
              type="button"
              onClick={handleNewApp}
              className="mt-4 rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink-soft hover:border-coral/40"
            >
              {taskOnly ? 'Indítás →' : 'Beszélgetés indítása →'}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
            {apps.map((app) => (
              <button
                key={app.appId}
                type="button"
                onClick={() => handleOpen(app.appId)}
                disabled={openingId === app.appId}
                className="atelier-card flex flex-col p-[14px_15px] text-left transition-colors hover:border-sage/40 disabled:opacity-60"
              >
                <div className="mb-2 grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-coral/10 text-base">
                  {appIcon(app.name)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <b className="text-sm font-semibold text-ink">{app.name}</b>
                  <Badge tone={appStatusTone(app.status)}>{app.status}</Badge>
                </div>
                {app.description ? (
                  <small className="mt-1 line-clamp-3 text-[11.5px] leading-snug text-ink-faint">
                    {app.description}
                  </small>
                ) : (
                  <small className="mt-1 text-[11.5px] text-ink-faint">
                    {openingId === app.appId ? 'Megnyitás…' : 'Megnyitás →'}
                  </small>
                )}
              </button>
            ))}
            <button
              type="button"
              onClick={handleNewApp}
              className="atelier-card flex flex-col border-dashed bg-transparent p-[14px_15px] text-left transition-colors hover:border-coral/40"
            >
              <div className="mb-2 grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-night-2 text-base">
                ＋
              </div>
              <b className="text-sm font-semibold text-ink">Új mini-app</b>
              <small className="mt-1 text-[11.5px] leading-snug text-ink-faint">
                Mondd el a munkatársnak, mire van szükséged — ő megépíti.
              </small>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
