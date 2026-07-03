'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { startProcess } from '@/app/actions/process'

export type StartablePlaybook = {
  playbookId: string
  name: string
  processType: string
  publishedVersionId: string
  version: number | null
}

export type StartableProcessDefinition = {
  id: string
  name: string
  description: string | null
  playbookVersionId: string
  triggers: { id: string; type: string; enabled: boolean }[]
}

export function StartProcessForm({
  definitions,
  playbooks = [],
}: {
  definitions: StartableProcessDefinition[]
  playbooks?: StartablePlaybook[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selectedDefinitionId, setSelectedDefinitionId] = useState(definitions[0]?.id ?? '')
  const [selectedLegacyVersionId, setSelectedLegacyVersionId] = useState(playbooks[0]?.publishedVersionId ?? '')
  const [inputJson, setInputJson] = useState('{}')
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const hasDefinitions = definitions.length > 0

  function submit() {
    setMessage(null)
    const def = definitions.find((d) => d.id === selectedDefinitionId)
    const pb = playbooks.find((p) => p.publishedVersionId === selectedLegacyVersionId)
    if (!def && !pb) {
      setMessage({ tone: 'err', text: 'Válassz egy aktív Folyamatot.' })
      return
    }
    let payload: Record<string, unknown> = {}
    if (inputJson.trim()) {
      try {
        payload = JSON.parse(inputJson)
      } catch {
        setMessage({ tone: 'err', text: 'A bemenet nem érvényes JSON.' })
        return
      }
    }
    startTransition(async () => {
      const res = def
        ? await startProcess({
            processDefinitionId: def.id,
            triggerType: 'manual',
            inputPayload: payload,
          })
        : await startProcess({
            processType: pb!.processType,
            playbookVersionId: pb!.publishedVersionId,
            inputPayload: payload,
          })
      if (res.success) {
        router.push(`/control-plane/processes/${res.data.id}`)
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  if (!hasDefinitions && playbooks.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        Nincs aktív Folyamat. Hozz létre egy Folyamat-draftot publikált Playbook-verzióból,
        kösd hozzá az agenteket, majd aktiváld.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-ink-soft">
          {hasDefinitions ? 'Aktív Folyamat' : 'Legacy Playbook-indítás'}
        </span>
        <select
          value={hasDefinitions ? selectedDefinitionId : selectedLegacyVersionId}
          onChange={(e) =>
            hasDefinitions
              ? setSelectedDefinitionId(e.target.value)
              : setSelectedLegacyVersionId(e.target.value)
          }
          className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
        >
          {hasDefinitions
            ? definitions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))
            : playbooks.map((p) => (
                <option key={p.publishedVersionId} value={p.publishedVersionId}>
                  {p.name} - {p.processType}
                  {p.version != null ? ` @v${p.version}` : ''}
                </option>
              ))}
        </select>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-ink-soft">Bemeneti payload (JSON)</span>
        <textarea
          value={inputJson}
          onChange={(e) => setInputJson(e.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 font-mono text-xs"
        />
      </label>

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
      )}

      <button
        onClick={submit}
        disabled={pending}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Indítás...' : 'Futás indítása'}
      </button>
    </div>
  )
}
