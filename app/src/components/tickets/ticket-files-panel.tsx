'use client'

import { useState, useTransition } from 'react'
import {
  HtmlPreviewModal,
  type HtmlPreviewTarget,
} from '@/components/workspace/html-preview-modal'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'
import { Card } from '@/components/ui/shell'
import { useTicketWorkspaceFiles } from '@/components/tickets/use-ticket-workspace-files'
import { uploadTicketWorkspaceFile } from '@/lib/ticket-workspace-files-client'
import {
  isHtmlWorkspaceFile,
  workspaceFileLink,
  workspaceHtmlPreviewTarget,
} from '@/lib/workspace-file-visibility'

type TicketFilesPanelProps = {
  ticketId: string
  ticketState: string
}

export function TicketFilesPanel({ ticketId, ticketState }: TicketFilesPanelProps) {
  const { files, loading, error, reload, listUrl } = useTicketWorkspaceFiles(ticketId, ticketState)
  const [uploading, startUpload] = useTransition()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewTarget | null>(null)

  const isReadOnly = ['done', 'rejected', 'approved'].includes(ticketState)
  const visibleFiles = files

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
        await reload()
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Feltöltés sikertelen')
      }
    })
  }

  return (
    <Card title="Munkafájlok">
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
        <p className="text-sm text-ink-faint">Nincs munkafájl a workspace-ben.</p>
      ) : (
        <ul className="divide-y divide-line">
          {visibleFiles.map((path) => (
            <li key={path} className="flex items-center justify-between py-2">
              {isHtmlWorkspaceFile(path) ? (
                <button
                  type="button"
                  onClick={() => handleOpen(path)}
                  className="truncate text-left text-sm text-ink hover:text-sky hover:underline"
                  title={path}
                >
                  {path}
                </button>
              ) : (
                <a
                  href={workspaceFileLink(listUrl, path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-sm text-ink hover:text-sky hover:underline"
                  title={path}
                >
                  {path}
                </a>
              )}
              <button
                type="button"
                onClick={() => handleOpen(path)}
                className="ml-2 shrink-0 text-sm font-medium text-sky hover:underline"
              >
                {isHtmlWorkspaceFile(path) ? 'Megnyitás' : 'Letöltés'}
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
