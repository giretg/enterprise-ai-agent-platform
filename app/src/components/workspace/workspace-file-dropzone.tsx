'use client'

import { useRef, useState } from 'react'

/**
 * Workspace fájlfeltöltés (húzd-ide vagy tallózás). Ticket- és beszélgetés-
 * munkaterülethez egyaránt — a hívó dönti el, hova tölt fel.
 *
 * A `compact` a chat oldalpanel sűrűbb elrendezéséhez való, ahol a teljes méretű
 * dobozdoboz kilógna a listából.
 */
type WorkspaceFileDropzoneProps = {
  disabled?: boolean
  uploading?: boolean
  compact?: boolean
  onFileSelected: (file: File) => void
}

export function WorkspaceFileDropzone({
  disabled = false,
  uploading = false,
  compact = false,
  onFileSelected,
}: WorkspaceFileDropzoneProps) {
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleUploadClick() {
    if (disabled || uploading) return
    fileInputRef.current?.click()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || disabled || uploading) return
    onFileSelected(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    if (!disabled && !uploading) setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
    if (disabled || uploading) return
    const file = e.dataTransfer.files?.[0]
    if (file) onFileSelected(file)
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`rounded-xl border border-dashed text-center transition-colors ${
        compact ? 'px-3 py-3' : 'px-4 py-6'
      } ${dragActive ? 'border-sky bg-sky/10' : 'border-line bg-card/30'} ${
        disabled ? 'opacity-60' : ''
      }`}
    >
      <p className={compact ? 'text-xs text-ink-soft' : 'text-sm text-ink-soft'}>
        Húzd ide a fájlt, vagy{' '}
        <button
          type="button"
          onClick={handleUploadClick}
          disabled={disabled || uploading}
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
        disabled={disabled || uploading}
      />
    </div>
  )
}
