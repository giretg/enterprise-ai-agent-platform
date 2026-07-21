'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentOperatorVisibility } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

// Tenant admin elrejtheti az agentet az operátorok elől. A futás/dispatch
// nem függ ettől — csak a listázás és a detail hozzáférés.
export function OperatorVisibilityForm({
  agentId,
  hiddenFromOperators,
}: {
  agentId: string
  hiddenFromOperators: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(hiddenFromOperators)

  const submit = (next: boolean) => {
    startTransition(async () => {
      setError(null)
      const res = await updateAgentOperatorVisibility({
        agentId,
        hiddenFromOperators: next,
      })
      if (res.success) {
        setHidden(next)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <Card title="Operátor-láthatóság">
      <p className="mb-4 text-xs text-ink-faint">
        Az agent továbbra is futhat és ticketeket vehet fel. Ez a beállítás csak azt
        szabályozza, hogy az operátorok (és a többi nem-admin szerep) látják-e a
        munkatársak listájában és a részletező oldalon.
      </p>

      <label className="flex items-start gap-3 rounded-lg border border-line bg-night-2 px-3 py-3 text-sm">
        <input
          type="checkbox"
          checked={hidden}
          disabled={pending}
          onChange={(e) => submit(e.currentTarget.checked)}
          className="mt-1"
        />
        <span>
          <span className="text-ink-soft">Elrejtve az operátorok elől</span>
          <span className="mt-1 block text-xs text-ink-faint">
            Bekapcsolva csak a tenant adminok látják ezt az agentet. A futás és a
            dispatch változatlan marad.
          </span>
        </span>
      </label>

      {error && <p className="mt-3 text-sm text-coral">{error}</p>}
      {pending && <p className="mt-3 text-xs text-ink-faint">Mentés...</p>}
    </Card>
  )
}
