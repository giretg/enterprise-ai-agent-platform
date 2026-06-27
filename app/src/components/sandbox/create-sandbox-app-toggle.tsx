'use client'

import { useState } from 'react'
import { CreateSandboxAppForm } from './create-sandbox-app-form'

export function CreateSandboxAppToggle() {
  const [open, setOpen] = useState(false)

  if (open) {
    return <CreateSandboxAppForm onCancel={() => setOpen(false)} />
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="rounded-full bg-sage/20 px-5 py-2.5 text-sm font-semibold text-sage hover:bg-sage/30"
    >
      + App létrehozása
    </button>
  )
}
