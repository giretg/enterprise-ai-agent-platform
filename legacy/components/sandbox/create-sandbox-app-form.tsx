'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createSandboxApp } from '@/app/actions/platform'

export function CreateSandboxAppForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [criticality, setCriticality] = useState<'L0' | 'L1'>('L1')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await createSandboxApp({ name, description: description || undefined, criticality })
      if (!res.success) {
        setError(res.error)
        return
      }
      router.push(`/control-plane/apps/${res.data.appId}`)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-line bg-night-1/30 p-5 space-y-4">
      <h2 className="font-display text-lg font-semibold">Új mini-app létrehozása</h2>

      {error && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          {error}
        </p>
      )}

      <div className="space-y-3">
        <div>
          <label htmlFor="app-name" className="block text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1">
            Név <span className="text-coral">*</span>
          </label>
          <input
            id="app-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={3}
            maxLength={80}
            placeholder="pl. Wiki pilot riport"
            className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-sage/50 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="app-desc" className="block text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1">
            Leírás
          </label>
          <textarea
            id="app-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Opcionális rövid leírás"
            className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-sage/50 focus:outline-none resize-none"
          />
        </div>

        <div>
          <span className="block text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
            Kritikussági szint
          </span>
          <div className="flex gap-3">
            {(['L0', 'L1'] as const).map((level) => (
              <label
                key={level}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  criticality === level
                    ? 'border-sage/50 bg-sage/10 text-ink'
                    : 'border-line text-ink-soft hover:border-line/80'
                }`}
              >
                <input
                  type="radio"
                  name="criticality"
                  value={level}
                  checked={criticality === level}
                  onChange={() => setCriticality(level)}
                  className="sr-only"
                />
                <span className="font-mono font-bold">{level}</span>
                <span className="text-ink-faint text-xs">
                  {level === 'L0' ? 'belső kísérlet' : 'demo / pilot'}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-ink-faint">
        A0 · single_html · hálózat nélkül · platform session nélkül. Verzió a mini-app megnyitása után adható hozzá.
      </p>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || name.trim().length < 3}
          className="rounded-full bg-sage/20 px-5 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
        >
          {pending ? 'Létrehozás…' : 'Mini-app létrehozása'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-line px-5 py-2 text-sm font-semibold text-ink-faint hover:text-ink-soft"
        >
          Mégse
        </button>
      </div>
    </form>
  )
}
