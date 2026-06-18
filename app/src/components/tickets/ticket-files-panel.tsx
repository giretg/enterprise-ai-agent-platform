'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'

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
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const listUrl = `/api/v1/tickets/${ticketId}/workspace/files`
  const isReadOnly = ['done', 'rejected', 'approved'].includes(ticketState)

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
      const form = new FormData()
      form.append('file', file)
      try {
        const res = await fetch(listUrl, { method: 'POST', body: form })
        const json = (await res.json()) as { success: boolean; error?: string }
        if (!json.success) throw new Error(json.error ?? 'Feltöltés sikertelen')
        await loadFiles()
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Feltöltés sikertelen')
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    })
  }

  function handleUploadClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    uploadFile(file)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    if (!isReadOnly) setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
    if (isReadOnly) return
    const file = e.dataTransfer.files?.[0]
    if (file) uploadFile(file)
  }

  return (
    <Card title="Fájlok">
      {!isReadOnly && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`mb-3 rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
            dragActive ? 'border-sky bg-sky/10' : 'border-line bg-card/30'
          }`}
        >
          <p className="text-sm text-ink-soft">
            Húzd ide a fájlt, vagy{' '}
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={uploading}
              className="font-semibold text-sky hover:underline disabled:opacity-50"
            >
              {uploading ? 'Feltöltés...' : 'válassz fájlt'}
            </button>
          </p>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
            disabled={uploading}
          />
        </div>
      )}

      {uploadError && <p className="mb-2 text-sm text-coral">{uploadError}</p>}

      {loading ? (
        <p className="text-sm text-ink-faint">Betöltés...</p>
      ) : error ? (
        <p className="text-sm text-coral">{error}</p>
      ) : files.length === 0 ? (
        <p className="text-sm text-ink-faint">Nincs fájl a workspace-ben.</p>
      ) : (
        <ul className="divide-y divide-line">
          {files.map((f) => (
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
      {isReadOnly && files.length > 0 && (
        <p className="mt-3 text-xs text-ink-faint">
          A ticket lezárva — a fájlok letölthetők (pre-signed URL), új feltöltés nem engedélyezett.
        </p>
      )}
    </Card>
  )
}
