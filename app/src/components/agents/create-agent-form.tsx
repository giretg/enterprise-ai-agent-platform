'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createAgent } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

const DEFAULT_MODEL = {
  provider: 'gemini',
  model: 'gemini-2.5-flash-lite',
  temperature: 0.2,
  maxTokens: 4096,
}

export function CreateAgentForm() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null)

  return (
    <Card title="Új agent">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          startTransition(async () => {
            setError(null)
            const res = await createAgent({
              name: String(fd.get('name')),
              roleDescription: String(fd.get('roleDescription')),
              systemPrompt: String(fd.get('systemPrompt')),
              modelConfig: {
                ...DEFAULT_MODEL,
                temperature: Number(fd.get('temperature') ?? DEFAULT_MODEL.temperature),
              },
            })
            if (res.success) {
              setApiKey(res.data.apiKey)
              setCreatedAgentId(res.data.agent.id)
              router.refresh()
            } else {
              setError(res.error)
            }
          })
        }}
      >
        <label className="block text-sm">
          <span className="text-ink-soft">Név</span>
          <input
            name="name"
            required
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            placeholder="Könyvelő agent"
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Szerepkör leírás</span>
          <input
            name="roleDescription"
            required
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            placeholder="Számlák feldolgozása és javaslatok"
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">System prompt</span>
          <textarea
            name="systemPrompt"
            required
            rows={6}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
            placeholder="Te egy könyvelő asszisztens vagy..."
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink-soft">Temperature</span>
          <input
            name="temperature"
            type="number"
            step="0.1"
            min={0}
            max={2}
            defaultValue={DEFAULT_MODEL.temperature}
            className="mt-1 w-32 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
        </label>
        {error && <p className="text-sm text-coral">{error}</p>}
        {apiKey && (
          <div className="space-y-2 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
            <p>API kulcs (egyszer látható): {apiKey}</p>
            {createdAgentId && (
              <button
                type="button"
                onClick={() => router.push(`/control-plane/agents/${createdAgentId}`)}
                className="rounded-full bg-sage/30 px-3 py-1 font-semibold"
              >
                Agent megnyitása →
              </button>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Létrehozás...' : 'Agent létrehozása'}
        </button>
      </form>
    </Card>
  )
}
