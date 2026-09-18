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
import { missingDeclaredOutputs } from '@/lib/declared-workspace-outputs'
import {
  isHtmlWorkspaceFile,
  workspaceFileLink,
  workspaceHtmlPreviewTarget,
} from '@/lib/workspace-file-visibility'

type TicketFilesPanelProps = {
  ticketId: string
  ticketState: string
  /** Amit a futás előállítottként rögzített (mért mellékhatás) — ellenőrzéshez. */
  declaredOutputs?: string[]
}

export function TicketFilesPanel({
  ticketId,
  ticketState,
  declaredOutputs = [],
}: TicketFilesPanelProps) {
  const { files, loading, error, reload, listUrl } = useTicketWorkspaceFiles(ticketId, ticketState)
  const [uploading, startUpload] = useTransition()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewTarget | null>(null)

  const isReadOnly = ['done', 'rejected', 'approved'].includes(ticketState)
  const visibleFiles = files
  // Csak akkor állítunk hiányról, ha a lista tényleg megérkezett (nem betöltés/hiba).
  const missingOutputs =
    loading || error ? [] : missingDeclaredOutputs(declaredOutputs, visibleFiles)

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

      {missingOutputs.length > 0 && (
        <div className="mb-3 rounded-lg border border-honey/30 bg-honey/[0.07] p-3 text-sm">
          <p className="font-semibold text-honey">
            <span aria-hidden>⚠ </span>
            {missingOutputs.length === 1
              ? 'Egy fájl hiányzik a munkaterületről'
              : `${missingOutputs.length} fájl hiányzik a munkaterületről`}
          </p>
          <p className="mt-1 text-ink-soft">
            A futás naplója szerint ez elkészült, de most nincs meg. Ha kell, indítsd újra a
            feladatot — a válaszban szereplő hivatkozás önmagában nem bizonyítja, hogy a fájl
            megvan.
          </p>
          <ul className="mt-2 space-y-0.5">
            {missingOutputs.map((path) => (
              <li key={path} className="truncate font-mono text-xs text-ink" title={path}>
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}

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
