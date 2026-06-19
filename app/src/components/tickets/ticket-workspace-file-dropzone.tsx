'use client'

import { useRef, useState } from 'react'

type TicketWorkspaceFileDropzoneProps = {
  disabled?: boolean
  uploading?: boolean
  onFileSelected: (file: File) => void
}

export function TicketWorkspaceFileDropzone({
  disabled = false,
  uploading = false,
  onFileSelected,
}: TicketWorkspaceFileDropzoneProps) {
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
      className={`rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
        dragActive ? 'border-sky bg-sky/10' : 'border-line bg-card/30'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <p className="text-sm text-ink-soft">
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
