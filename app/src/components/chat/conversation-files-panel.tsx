'use client'

import { useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { conversationWorkspaceFilesUrl } from '@/lib/conversation-workspace-files-client'

export type ConversationFilesPanelHandle = {
  refresh: () => void
}

type WorkspaceFile = { path: string }

type Props = {
  conversationId: string
  panelRef?: React.Ref<ConversationFilesPanelHandle>
}

export function ConversationFilesPanel({ conversationId, panelRef }: Props) {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const listUrl = conversationWorkspaceFilesUrl(conversationId)

  const loadFiles = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const res = await fetch(listUrl)
      if (!res.ok) return
      const json = (await res.json()) as { success: boolean; data?: { files: string[] } }
      const next = (json.data?.files ?? []).map((path) => ({ path }))
      setFiles(next)
      if (next.length > 0) setOpen(true)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [listUrl])

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
        if (next.length > 0) setOpen(true)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) console.error('Failed to load conversation files', err)
      })
    return () => controller.abort()
  }, [listUrl])

  useImperativeHandle(panelRef, () => ({ refresh: () => void loadFiles(true) }), [loadFiles])

  async function handleDownload(path: string) {
    const signedRes = await fetch(`${listUrl}?path=${encodeURIComponent(path)}&signed=1`)
    if (signedRes.ok) {
      const json = (await signedRes.json()) as { success: boolean; data?: { url: string } }
      if (json.success && json.data?.url) {
        window.open(json.data.url, '_blank', 'noopener,noreferrer')
        return
      }
    }
    const a = document.createElement('a')
    a.href = `${listUrl}?path=${encodeURIComponent(path)}`
    a.download = path.split('/').pop() ?? path
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
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
          {files.length > 0 && (
            <span className="ml-1.5 rounded-full bg-sage/20 px-1.5 py-0.5 text-[10px] font-semibold text-sage-deep">
              {files.length}
            </span>
          )}
        </span>
        <span className="text-ink-faint">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-3">
          {files.length === 0 ? (
            <p className="text-xs text-ink-faint">Nincs fájl a workspace-ben.</p>
          ) : (
            <ul className="divide-y divide-line">
              {files.map((f) => (
                <li key={f.path} className="flex items-center justify-between py-1.5">
                  <span className="truncate text-xs text-ink" title={f.path}>
                    {f.path}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleDownload(f.path)}
                    className="ml-2 shrink-0 text-xs font-medium text-sky hover:underline"
                  >
                    Letöltés
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
