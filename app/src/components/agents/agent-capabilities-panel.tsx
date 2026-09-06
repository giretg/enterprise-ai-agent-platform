'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentCapabilities } from '@/app/actions/platform'
import { ToolCapabilityCheckboxGroups } from '@/components/tool-capabilities/tool-capability-checkbox-groups'
import { Card } from '@/components/ui/shell'
import {
  grantedToolNames,
  initialEnabledToolNames,
  toolSelectionHasChanges,
} from '@/lib/create-agent-wizard'
import {
  NORMAL_TOOL_CAPABILITY_GROUPS,
  splitToolGroupsByChatSurface,
} from '@/lib/tool-capability-catalog'

export function AgentCapabilitiesPanel({
  agentId,
  currentCapabilities,
  isOrchestrator,
  suggestedTools,
  bare = false,
}: {
  agentId: string
  currentCapabilities: Array<{ toolName: string; allowed: boolean }>
  isOrchestrator: boolean
  /** Javaslat: bejelölve, de mentésig nincs grant / connector-kötés. */
  suggestedTools?: string[]
  /** A hívó már adott keretet (címsor + doboz) — ne rajzoljunk másodikat. */
  bare?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const granted = grantedToolNames(currentCapabilities)
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(initialEnabledToolNames(currentCapabilities, suggestedTools)),
  )

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

  const { chat: chatGroups, other: otherGroups } = splitToolGroupsByChatSurface(
    NORMAL_TOOL_CAPABILITY_GROUPS,
  )
  const hasChanges = toolSelectionHasChanges(enabled, granted)
  const hasSuggestedPending =
    (suggestedTools?.length ?? 0) > 0 &&
    suggestedTools!.some((t) => enabled.has(t) && !granted.includes(t))

  const body = (
    <>
      <p className="mb-4 text-xs text-ink-faint">
        Jelöld be az eszközöket, amelyeket az agent hívhat. A kapcsolódó platform
        connectorokat a rendszer mentéskor automatikusan linkeli, ha szükséges.
      </p>
      {hasSuggestedPending ? (
        <p className="mb-4 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
          A javaslat bejelölte ezeket az eszközöket. Connector csak a „Jogok mentése”
          után kapcsolódik — vedd ki, amit nem akarsz.
        </p>
      ) : null}

      <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-soft">
        Beszélgetés-eszközök
      </p>
      <ToolCapabilityCheckboxGroups
        groups={chatGroups}
        enabled={enabled}
        onChange={setEnabledAndClearDone}
        isToolDisabled={(_tool, selected) => isOrchestrator && !selected.has(_tool)}
      />
      {otherGroups.length > 0 && (
        <div className="mt-8">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Egyéb eszközök
          </p>
          <p className="mb-4 text-xs text-ink-faint">
            Nem a beszélgetésben hívja őket — monitor, MCP vagy háttérfolyamat.
          </p>
          <ToolCapabilityCheckboxGroups
            groups={otherGroups}
            enabled={enabled}
            onChange={setEnabledAndClearDone}
            isToolDisabled={(_tool, selected) => isOrchestrator && !selected.has(_tool)}
          />
        </div>
      )}

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
