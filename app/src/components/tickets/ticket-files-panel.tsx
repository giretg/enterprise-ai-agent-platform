'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { TicketWorkspaceFileDropzone } from '@/components/tickets/ticket-workspace-file-dropzone'
import { Card } from '@/components/ui/shell'
import {
  ticketWorkspaceFilesUrl,
  uploadTicketWorkspaceFile,
} from '@/lib/ticket-workspace-files-client'

type WorkspaceFile = { path: string }

type TicketFilesPanelProps = {
  ticketId: string
  ticketState: string
}

export function TicketFilesPanel({ ticketId, ticketState }: TicketFilesPanelProps) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, startUpload] = useTransition()
  const [uploadError, setUploadError] = useState<string | null>(null)

  const listUrl = ticketWorkspaceFilesUrl(ticketId)
  const isReadOnly = ['done', 'rejected', 'approved'].includes(ticketState)
  const visibleFiles = files.filter((file) => !file.path.startsWith('.tool-results/'))

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(listUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { success: boolean; data?: { files: string[] } }
      setFiles((json.data?.files ?? []).map((path) => ({ path })))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nem sikerült betölteni a fájlokat')
    } finally {
      setLoading(false)
    }
  }, [listUrl])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadFiles()
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [loadFiles])

  async function handleDownload(path: string) {
    const signedRes = await fetch(`${listUrl}?path=${encodeURIComponent(path)}&signed=1`)
    if (signedRes.ok) {
      const json = (await signedRes.json()) as {
        success: boolean
        data?: { url: string }
      }
      if (json.success && json.data?.url) {
        window.open(json.data.url, '_blank', 'noopener,noreferrer')
        return
      }
    }

    const url = `${listUrl}?path=${encodeURIComponent(path)}`
    const a = document.createElement('a')
    a.href = url
    a.download = path.split('/').pop() ?? path
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function uploadFile(file: File) {
    setUploadError(null)
    startUpload(async () => {
      try {
        await uploadTicketWorkspaceFile(ticketId, file)
        await loadFiles()
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Feltöltés sikertelen')
      }
    })
  }

  return (
    <Card title="Fájlok">
      {!isReadOnly && (
        <div className="mb-3">
          <TicketWorkspaceFileDropzone
            disabled={isReadOnly}
            uploading={uploading}
            onFileSelected={uploadFile}
          />
        </div>
      )}

      {uploadError && <p className="mb-2 text-sm text-coral">{uploadError}</p>}

      {loading ? (
        <p className="text-sm text-ink-faint">Betöltés...</p>
      ) : error ? (
        <p className="text-sm text-coral">{error}</p>
      ) : visibleFiles.length === 0 ? (
        <p className="text-sm text-ink-faint">Nincs fájl a workspace-ben.</p>
      ) : (
        <ul className="divide-y divide-line">
          {visibleFiles.map((f) => (
            <li key={f.path} className="flex items-center justify-between py-2">
              <span className="truncate text-sm text-ink" title={f.path}>
                {f.path}
              </span>
              <button
                type="button"
                onClick={() => void handleDownload(f.path)}
                className="ml-2 shrink-0 text-sm font-medium text-sky hover:underline"
              >
                Letöltés
              </button>
            </li>
          ))}
        </ul>
      )}
      {isReadOnly && visibleFiles.length > 0 && (
        <p className="mt-3 text-xs text-ink-faint">
          A ticket lezárva — a fájlok letölthetők (pre-signed URL), új feltöltés nem engedélyezett.
        </p>
      )}
    </Card>
  )
}
