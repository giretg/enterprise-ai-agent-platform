'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createSandboxProject } from '@/app/actions/sandbox-versioning'

export function CreateSandboxProjectToggle() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-sage/20 px-5 py-2.5 text-sm font-semibold text-sage hover:bg-sage/30"
      >
        + Projekt létrehozása
      </button>
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await createSandboxProject({ name, description: description || undefined })
      if (!res.success) {
        setError(res.error)
        return
      }
      router.push(`/control-plane/sandbox-versions/${res.data.projectId}`)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-md rounded-xl border border-line bg-night-1/30 p-5 space-y-4">
      <h2 className="font-display text-lg font-semibold">Új sandbox projekt</h2>
      {error && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">{error}</p>
      )}
      <div>
        <label htmlFor="proj-name" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Név <span className="text-coral">*</span>
        </label>
        <input
          id="proj-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={3}
          maxLength={120}
          placeholder="pl. CRM modul"
          className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-sage/50 focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor="proj-desc" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Leírás
        </label>
        <textarea
          id="proj-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={2000}
          className="w-full resize-none rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-sage/50 focus:outline-none"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
        >
          {pending ? 'Létrehozás…' : 'Létrehozás'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full px-4 py-2 text-sm text-ink-soft hover:text-ink"
        >
          Mégse
        </button>
      </div>
    </form>
  )
}
