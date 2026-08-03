'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import {
  HtmlPreviewModal,
  type HtmlPreviewTarget,
} from '@/components/workspace/html-preview-modal'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'
import { Card } from '@/components/ui/shell'
import {
  ticketWorkspaceFilesUrl,
  uploadTicketWorkspaceFile,
} from '@/lib/ticket-workspace-files-client'
import {
  isHtmlWorkspaceFile,
  workspaceFileLink,
  workspaceHtmlPreviewTarget,
} from '@/lib/workspace-file-visibility'

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
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewTarget | null>(null)

  const listUrl = ticketWorkspaceFilesUrl(ticketId)
  const isReadOnly = ['done', 'rejected', 'approved'].includes(ticketState)
  const visibleFiles = files

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

  function handleOpen(path: string) {
    const preview = workspaceHtmlPreviewTarget(listUrl, path)
    if (preview) {
      setHtmlPreview(preview)
      return
    }
    window.open(workspaceFileLink(listUrl, path), '_blank', 'noopener,noreferrer')
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
          <WorkspaceFileDropzone
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
              {isHtmlWorkspaceFile(f.path) ? (
                <button
                  type="button"
                  onClick={() => handleOpen(f.path)}
                  className="truncate text-left text-sm text-ink hover:text-sky hover:underline"
                  title={f.path}
                >
                  {f.path}
                </button>
              ) : (
                <a
                  href={workspaceFileLink(listUrl, f.path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-sm text-ink hover:text-sky hover:underline"
                  title={f.path}
                >
                  {f.path}
                </a>
              )}
              <button
                type="button"
                onClick={() => handleOpen(f.path)}
                className="ml-2 shrink-0 text-sm font-medium text-sky hover:underline"
              >
                {isHtmlWorkspaceFile(f.path) ? 'Megnyitás' : 'Letöltés'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {isReadOnly && visibleFiles.length > 0 && (
        <p className="mt-3 text-xs text-ink-faint">
          A feladat lezárva — a fájlok letölthetők (pre-signed URL), új feltöltés nem engedélyezett.
        </p>
      )}
      {htmlPreview && (
        <HtmlPreviewModal target={htmlPreview} onClose={() => setHtmlPreview(null)} />
      )}
    </Card>
  )
}
