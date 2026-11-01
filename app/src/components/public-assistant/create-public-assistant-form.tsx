'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createPublicAssistantAction } from '@/app/actions/public-assistant'

/** #1016 D1: új nyilvános asszisztens — üresen vagy egy belső munkatárs leírásából készült vázlattal. */
export function CreatePublicAssistantForm({
  sourceAgent,
}: {
  sourceAgent: { id: string; name: string } | null
}) {
  const router = useRouter()
  const [name, setName] = useState(sourceAgent ? `${sourceAgent.name} – ügyfélszolgálat` : '')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      setError(null)
      const res = await createPublicAssistantAction({ name, fromAgentId: sourceAgent?.id })
      if (res.success) router.push(`/control-plane/agents/${res.data.agentId}`)
      else setError(res.error)
    })
  }

  return (
    <form onSubmit={submit} className="atelier-card max-w-xl space-y-4 p-5">
      <div>
        <label className="text-sm font-medium text-ink" htmlFor="pa-name">
          Hogy hívják az asszisztenst?
        </label>
        <p className="text-xs text-ink-soft">Ezt a nevet látják a látogatók a chat fejlécében.</p>
        <input
          id="pa-name"
          className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="pl. Ügyfélszolgálat"
          required
        />
      </div>
      {sourceAgent ? (
        <p className="rounded-lg border border-honey/30 bg-honey/10 px-3 py-2 text-xs text-ink">
          „{sourceAgent.name}” szerepleírásából vázlatot készítünk (témák, üdvözlés). Memóriát, eszközt és tudásbázist
          nem másolunk át — a vázlatot élesítés előtt nézd át.
        </p>
      ) : null}
      <ul className="list-disc space-y-1 pl-5 text-xs text-ink-soft">
        <li>Kap egy saját, üres nyilvános tudásbázist — ami oda kerül, azt bárki megtudhatja.</li>
        <li>Élesítésig senki nem éri el; addig a „Kipróbálás látogatóként” gombbal tesztelheted.</li>
      </ul>
      {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
      <button type="submit" disabled={pending || !name.trim()} className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {pending ? 'Létrehozás…' : 'Asszisztens létrehozása'}
      </button>
    </form>
  )
}
