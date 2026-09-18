'use client'

import { useState } from 'react'
import { AddSandboxAppVersionForm } from './add-sandbox-app-version-form'

export function AddSandboxAppVersionToggle({ appId }: { appId: string }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink-soft hover:border-sage/40 hover:text-sage"
      >
        + Új verzió kézzel
      </button>
    )
  }

  return (
    <section className="atelier-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Új verzió kézzel</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-ink-faint hover:text-ink-soft"
        >
          Bezár
        </button>
      </div>
      <AddSandboxAppVersionForm
        appId={appId}
        onSuccess={() => {
          setOpen(false)
          window.location.reload()
        }}
      />
    </section>
  )
}
