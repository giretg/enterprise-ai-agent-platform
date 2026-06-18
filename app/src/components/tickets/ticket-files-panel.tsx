'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

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
  const fileInputRef = useRef<HTMLInputElement>(null)

  const listUrl = `/api/v1/tickets/${ticketId}/workspace/files`
  const isReadOnly = ['done', 'rejected'].includes(ticketState)

  async function loadFiles() {
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
  }

  useEffect(() => {
    void loadFiles()
  }, [ticketId])

  function handleDownload(path: string) {
    const url = `${listUrl}?path=${encodeURIComponent(path)}`
    const a = document.createElement('a')
    a.href = url
    a.download = path.split('/').pop() ?? path
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function handleUploadClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
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

  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Fájlok</h3>
        {!isReadOnly && (
          <button
            onClick={handleUploadClick}
            disabled={uploading}
            className="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {uploading ? 'Feltöltés...' : 'Feltöltés'}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
          disabled={uploading}
        />
      </div>

      {uploadError && (
        <p className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600">{uploadError}</p>
      )}

      {loading ? (
        <p className="text-xs text-gray-400">Betöltés...</p>
      ) : error ? (
        <p className="text-xs text-red-500">{error}</p>
      ) : files.length === 0 ? (
        <p className="text-xs text-gray-400">Nincs fájl a workspace-ben.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {files.map((f) => (
            <li key={f.path} className="flex items-center justify-between py-1.5">
              <span className="truncate text-xs text-gray-700" title={f.path}>
                {f.path}
              </span>
              <button
                onClick={() => handleDownload(f.path)}
                className="ml-2 shrink-0 text-xs text-indigo-600 hover:underline"
              >
                Letöltés
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
