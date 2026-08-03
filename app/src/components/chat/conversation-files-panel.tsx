'use client'

import { useCallback, useEffect, useImperativeHandle, useState, useTransition } from 'react'
import {
  HtmlPreviewModal,
  type HtmlPreviewTarget,
} from '@/components/workspace/html-preview-modal'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'
import {
  conversationWorkspaceFilesUrl,
  uploadConversationWorkspaceFile,
} from '@/lib/conversation-workspace-files-client'
import {
  isHtmlWorkspaceFile,
  workspaceFileLink,
  workspaceHtmlPreviewTarget,
} from '@/lib/workspace-file-visibility'

export type ConversationFilesPanelHandle = {
  refresh: () => void
}

type WorkspaceFile = { path: string }

type Props = {
  conversationId: string
  panelRef?: React.Ref<ConversationFilesPanelHandle>
  onFilesChange?: (paths: string[]) => void
}

export function ConversationFilesPanel({ conversationId, panelRef, onFilesChange }: Props) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [uploading, startUpload] = useTransition()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewTarget | null>(null)

  const listUrl = conversationWorkspaceFilesUrl(conversationId)

  const visibleFiles = files

  const loadFiles = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const res = await fetch(listUrl)
      if (!res.ok) return
      const json = (await res.json()) as { success: boolean; data?: { files: string[] } }
      const next = (json.data?.files ?? []).map((path) => ({ path }))
      setFiles(next)
      onFilesChange?.(next.map((file) => file.path))
      if (next.length > 0) setOpen(true)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [listUrl, onFilesChange])

  // Beszélgetésváltáskor a conversationId (és így listUrl/loadFiles) változik,
  // ezért a listát újra kell tölteni.
  useEffect(() => {
    const controller = new AbortController()
    void fetch(listUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null
        return (await res.json()) as { success: boolean; data?: { files: string[] } }
      })
      .then((json) => {
        if (!json || controller.signal.aborted) return
        const next = (json.data?.files ?? []).map((path) => ({ path }))
        setFiles(next)
        onFilesChange?.(next.map((file) => file.path))
        if (next.length > 0) setOpen(true)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) console.error('Failed to load conversation files', err)
      })
    return () => controller.abort()
  }, [listUrl, onFilesChange])

  useImperativeHandle(panelRef, () => ({ refresh: () => void loadFiles(true) }), [loadFiles])

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
        await uploadConversationWorkspaceFile(conversationId, file)
        await loadFiles(true)
        setOpen(true)
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Feltöltés sikertelen')
      }
    })
  }

  if (loading && files.length === 0) return null

  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium text-ink-soft hover:text-ink"
      >
        <span>
          Workspace fájlok
          {visibleFiles.length > 0 && (
            <span className="ml-1.5 rounded-full bg-sage/20 px-1.5 py-0.5 text-[10px] font-semibold text-sage-deep">
              {visibleFiles.length}
            </span>
          )}
        </span>
        <span className="text-ink-faint">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="max-h-[33vh] overflow-y-auto px-4 pb-3">
          <div className="mb-2">
            <WorkspaceFileDropzone compact uploading={uploading} onFileSelected={uploadFile} />
          </div>

          {uploadError && <p className="mb-2 text-xs text-coral">{uploadError}</p>}

          {visibleFiles.length === 0 ? (
            <p className="text-xs text-ink-faint">Nincs fájl a workspace-ben.</p>
          ) : (
            <ul className="divide-y divide-line">
              {visibleFiles.map((f) => (
                <li key={f.path} className="flex items-center justify-between py-1.5">
                  {isHtmlWorkspaceFile(f.path) ? (
                    <button
                      type="button"
                      onClick={() => handleOpen(f.path)}
                      className="truncate text-left text-xs text-ink hover:text-sky hover:underline"
                      title={f.path}
                    >
                      {f.path}
                    </button>
                  ) : (
                    <a
                      href={workspaceFileLink(listUrl, f.path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="truncate text-xs text-ink hover:text-sky hover:underline"
                      title={f.path}
                    >
                      {f.path}
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => handleOpen(f.path)}
                    className="ml-2 shrink-0 text-xs font-medium text-sky hover:underline"
                  >
                    {isHtmlWorkspaceFile(f.path) ? 'Megnyitás' : 'Letöltés'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {htmlPreview && (
        <HtmlPreviewModal target={htmlPreview} onClose={() => setHtmlPreview(null)} />
      )}
    </div>
  )
}
