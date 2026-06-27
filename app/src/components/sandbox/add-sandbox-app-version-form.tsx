'use client'

import { useState, useTransition } from 'react'
import { upsertSandboxAppVersion } from '@/app/actions/platform'

export function AddSandboxAppVersionForm({
  appId,
  onSuccess,
}: {
  appId: string
  onSuccess: () => void
}) {
  const [html, setHtml] = useState('')
  const [changeSummary, setChangeSummary] = useState('')
  const [activate, setActivate] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await upsertSandboxAppVersion({ appId, html, changeSummary, activate })
      if (!res.success) {
        setError(res.error)
        return
      }
      setHtml('')
      setChangeSummary('')
      onSuccess()
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="av-summary"
          className="block text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1"
        >
          Változtatás leírása <span className="text-coral">*</span>
        </label>
        <input
          id="av-summary"
          type="text"
          value={changeSummary}
          onChange={(e) => setChangeSummary(e.target.value)}
          required
          minLength={1}
          maxLength={1000}
          placeholder="pl. Első önálló riportnézet"
          className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-sage/50 focus:outline-none"
        />
      </div>

      <div>
        <label
          htmlFor="av-html"
          className="block text-xs font-semibold uppercase tracking-wide text-ink-faint mb-1"
        >
          HTML tartalom <span className="text-coral">*</span>
        </label>
        <textarea
          id="av-html"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          required
          rows={10}
          placeholder="<!doctype html>&#10;<html>...</html>"
          className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-sage/50 focus:outline-none resize-y"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-ink-faint">
          A0 · 1 MB limit · <code className="font-mono">&lt;iframe&gt;</code>,{' '}
          <code className="font-mono">&lt;form&gt;</code>,{' '}
          <code className="font-mono">&lt;object&gt;</code> tilos
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={activate}
          onChange={(e) => setActivate(e.target.checked)}
          className="h-4 w-4 rounded border-line accent-sage"
        />
        Azonnal aktiválás mentés után
      </label>

      {error && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !html.trim() || !changeSummary.trim()}
          className="rounded-full bg-sage/20 px-5 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
        >
          {pending ? 'Mentés…' : 'Verzió mentése'}
        </button>
      </div>
    </form>
  )
}
