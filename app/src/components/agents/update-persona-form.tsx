'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentPersona } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

// Admin szerkesztheti az agent emberi arcát: a megjelenített nevet, az üdvözlő
// mondatot és a jellemvonást. Ha a mezőt üresen hagyja, a névből számított meleg
// alapértelmezésre esik vissza (lásd agent-persona.ts).
export function UpdatePersonaForm({
  agentId,
  storedNickname,
  storedGreeting,
  storedTrait,
  defaultNickname,
  defaultGreeting,
  defaultTrait,
}: {
  agentId: string
  storedNickname: string | null
  storedGreeting: string | null
  storedTrait: string | null
  defaultNickname: string
  defaultGreeting: string
  defaultTrait: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  return (
    <Card title="Bemutatkozás szerkesztése">
      <p className="mb-4 text-xs text-ink-faint">
        A megjelenített név, az üdvözlő mondat és a jellemvonás jelenik meg az agent
        kártyáin és a chat bevezetőjében. Hagyd üresen valamelyiket, hogy visszaálljon
        az alapértelmezett szöveg.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          const nextNickname = String(fd.get('personaNickname') ?? '')
          const nextGreeting = String(fd.get('personaGreeting') ?? '')
          const nextTrait = String(fd.get('personaTrait') ?? '')
          startTransition(async () => {
            setError(null)
            setDone(false)
            const res = await updateAgentPersona({
              agentId,
              personaNickname: nextNickname,
              personaGreeting: nextGreeting,
              personaTrait: nextTrait,
            })
            if (res.success) {
              setDone(true)
              router.refresh()
            } else {
              setError(res.error)
            }
          })
        }}
      >
        <label className="block text-sm">
          <span className="text-ink-soft">Megjelenített név</span>
          <input
            type="text"
            name="personaNickname"
            defaultValue={storedNickname ?? ''}
            placeholder={defaultNickname}
            maxLength={80}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Üdvözlő mondat</span>
          <textarea
            name="personaGreeting"
            defaultValue={storedGreeting ?? ''}
            placeholder={defaultGreeting}
            rows={2}
            maxLength={280}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Jellemvonás</span>
          <textarea
            name="personaTrait"
            defaultValue={storedTrait ?? ''}
            placeholder={defaultTrait}
            rows={2}
            maxLength={280}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
        </label>
        {error && <p className="text-sm text-coral">{error}</p>}
        {done && (
          <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
            Bemutatkozás mentve.
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'Mentés'}
        </button>
      </form>
    </Card>
  )
}
