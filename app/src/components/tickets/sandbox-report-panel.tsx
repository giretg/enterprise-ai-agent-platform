'use client'

import { useEffect, useState, useTransition } from 'react'
import { createSandboxReport, getSandboxAppPreviewUrl } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

type SandboxReport = {
  id: string
  name: string
  version: number
  htmlHash: string
  sourceTicketId: string
  createdAt: Date | string
}

export function SandboxReportPanel({
  ticketId,
  initialReport,
}: {
  ticketId: string
  initialReport: SandboxReport | null
}) {
  const [report, setReport] = useState<SandboxReport | null>(initialReport)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Rövid életű, aláírt preview URL-t kérünk (cookieless, izolált origin — §6.1).
  useEffect(() => {
    if (!report) return
    let cancelled = false
    const appId = report.id
    void (async () => {
      const res = await getSandboxAppPreviewUrl({ appId })
      if (cancelled) return
      if (res.success) setPreviewUrl(res.data.previewUrl)
      else setError(res.error)
    })()
    return () => {
      cancelled = true
    }
  }, [report])

  const createReport = () => {
    setError(null)
    startTransition(async () => {
      const res = await createSandboxReport({ ticketId })
      if (!res.success) {
        setError(res.error)
        return
      }
      setReport(res.data)
    })
  }

  return (
    <Card title="A0 sandbox riport">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-ink-soft">
            Single-file HTML preview és export a wiki-válaszból.
          </p>
          {report && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="success">v{report.version}</Badge>
              <Badge tone="neutral">sha256 {report.htmlHash.slice(0, 12)}</Badge>
              <Badge tone="neutral">sandbox preview · nincs hálózat / nincs platform API</Badge>
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={createReport}
          className="rounded-full bg-honey/20 px-5 py-2.5 text-sm font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
        >
          {pending ? 'Generálás…' : report ? 'Új verzió' : 'Riport létrehozása'}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-coral">{error}</p>}

      {report && (
        <div className="mt-4 space-y-3">
          <div className="overflow-hidden rounded-lg border border-line bg-white">
            {previewUrl ? (
              <iframe
                title={report.name}
                src={previewUrl}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="h-[420px] w-full bg-white"
              />
            ) : (
              <div className="flex h-[420px] w-full items-center justify-center text-sm text-ink-soft">
                Preview betöltése…
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={previewUrl ?? '#'}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!previewUrl}
              className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft hover:border-coral/45 hover:text-coral"
            >
              Preview megnyitása
            </a>
            <a
              href={`/api/sandbox-apps/${report.id}/export`}
              className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage hover:bg-sage/30"
            >
              .html export
            </a>
          </div>
        </div>
      )}
    </Card>
  )
}
