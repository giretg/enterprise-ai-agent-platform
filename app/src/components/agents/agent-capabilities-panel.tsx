'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentCapabilities } from '@/app/actions/platform'
import { ToolCapabilityCheckboxGroups } from '@/components/tool-capabilities/tool-capability-checkbox-groups'
import { Card } from '@/components/ui/shell'
import { NORMAL_TOOL_CAPABILITY_GROUPS } from '@/lib/tool-capability-catalog'

export function AgentCapabilitiesPanel({
  agentId,
  currentCapabilities,
  isOrchestrator,
  bare = false,
}: {
  agentId: string
  currentCapabilities: Array<{ toolName: string; allowed: boolean }>
  isOrchestrator: boolean
  /** A hívó már adott keretet (címsor + doboz) — ne rajzoljunk másodikat. */
  bare?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const initialEnabled = new Set(
    currentCapabilities.filter((c) => c.allowed).map((c) => c.toolName),
  )
  const [enabled, setEnabled] = useState<Set<string>>(initialEnabled)

  function setEnabledAndClearDone(next: Set<string>) {
    setEnabled(next)
    setDone(null)
  }

  function save() {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await updateAgentCapabilities({
        agentId,
        enabledTools: [...enabled],
      })
      if (res.success) {
        const linked = [
          res.data.knowledgeBaseLinked ? 'Knowledge Base connector' : null,
          res.data.workspaceLinked ? 'Workspace connector' : null,
          res.data.gmailLinked ? 'Gmail connector' : null,
          res.data.httpApiLinked ? 'HTTP API connector' : null,
          res.data.webSearchLinked ? 'Web Search connector' : null,
          res.data.boardLinked ? 'Board connector' : null,
        ].filter(Boolean)
        const base = linked.length
          ? `${res.data.updatedCount} eszköz engedélyezve — ${linked.join(', ')} automatikusan linkelve.`
          : `${res.data.updatedCount} eszköz engedélyezve.`
        const msg = res.data.httpApiAssignmentRequired
          ? `${base} A HTTP API tool használatához rendelj hozzá egy kapcsolatot a „Meglévő kapcsolat hozzárendelése" résznél.`
          : base
        setDone(msg)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  const hasChanges =
    enabled.size !== initialEnabled.size ||
    [...enabled].some((t) => !initialEnabled.has(t)) ||
    [...initialEnabled].some((t) => !enabled.has(t))

  const body = (
    <>
      <p className="mb-4 text-xs text-ink-faint">
        Jelöld be az eszközöket, amelyeket az agent hívhat. A kapcsolódó platform
        connectorokat a rendszer mentéskor automatikusan linkeli, ha szükséges.
      </p>

      <ToolCapabilityCheckboxGroups
        groups={NORMAL_TOOL_CAPABILITY_GROUPS}
        enabled={enabled}
        onChange={setEnabledAndClearDone}
        isToolDisabled={(_tool, selected) => isOrchestrator && !selected.has(_tool)}
      />

      {error && <p className="mt-4 text-sm text-coral">{error}</p>}
      {done && (
        <p className="mt-4 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || !hasChanges}
          className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'Jogok mentése'}
        </button>
        {hasChanges && !pending && (
          <span className="text-xs text-ink-faint">Nem mentett változtatások</span>
        )}
      </div>
    </>
  )

  if (bare) return body
  return <Card title="Eszközjogok szerkesztése">{body}</Card>
}
