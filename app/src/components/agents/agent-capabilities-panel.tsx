'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentCapabilities } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type ToolGroup = {
  label: string
  tools: string[]
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'Fájlkezelés (Workspace)',
    tools: [
      'file_read', 'file_write', 'file_edit', 'file_list',
      'file_glob', 'file_search', 'file_delete',
    ],
  },
  {
    label: 'Excel (XLSX)',
    tools: [
      'xlsx_read_sheet', 'xlsx_write_cells', 'xlsx_append_rows',
      'xlsx_create', 'xlsx_format_range', 'xlsx_layout',
    ],
  },
  {
    label: 'Dokumentumok',
    tools: ['docx_read', 'pdf_read', 'pdf_create'],
  },
  {
    label: 'Email (Gmail)',
    tools: ['gmail_search', 'gmail_get_message', 'gmail_create_draft', 'gmail_send'],
  },
  {
    label: 'Agent együttműködés',
    tools: ['agent_catalog', 'agent_resolve', 'agent_ask', 'ticket_create'],
  },
  {
    label: 'HTTP API',
    tools: ['http_api_get', 'http_api_request'],
  },
  {
    label: 'Webes kutatás',
    tools: ['web_search'],
  },
]

export function AgentCapabilitiesPanel({
  agentId,
  currentCapabilities,
  isOrchestrator,
}: {
  agentId: string
  currentCapabilities: Array<{ toolName: string; allowed: boolean }>
  isOrchestrator: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const initialEnabled = new Set(
    currentCapabilities.filter((c) => c.allowed).map((c) => c.toolName),
  )
  const [enabled, setEnabled] = useState<Set<string>>(initialEnabled)

  function toggle(tool: string) {
    if (isOrchestrator && tool === 'web_search' && !enabled.has(tool)) return
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(tool)) next.delete(tool)
      else next.add(tool)
      return next
    })
    setDone(null)
  }

  function toggleGroup(tools: string[], allOn: boolean) {
    const selectableTools = tools.filter(
      (tool) => !(isOrchestrator && tool === 'web_search' && !enabled.has(tool)),
    )
    setEnabled((prev) => {
      const next = new Set(prev)
      for (const t of selectableTools) {
        if (allOn) next.delete(t)
        else next.add(t)
      }
      return next
    })
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
          res.data.workspaceLinked ? 'Workspace connector' : null,
          res.data.webSearchLinked ? 'Web Search connector' : null,
        ].filter(Boolean)
        const msg = linked.length
          ? `${res.data.updatedCount} eszköz engedélyezve — ${linked.join(', ')} automatikusan linkelve.`
          : `${res.data.updatedCount} eszköz engedélyezve.`
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

  return (
    <Card title="Eszközjogok szerkesztése">
      <p className="mb-4 text-xs text-ink-faint">
        Jelöld be az eszközöket, amelyeket az agent hívhat. A Workspace/XLSX eszközök
        automatikusan linkelik az Agent Workspace connectort.
      </p>

      <div className="space-y-5">
        {TOOL_GROUPS.map((group) => {
          const allOn = group.tools.every((t) => enabled.has(t))
          const someOn = !allOn && group.tools.some((t) => enabled.has(t))
          return (
            <div key={group.label}>
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.tools, allOn)}
                  className={`h-4 w-4 rounded border text-xs ${
                    allOn
                      ? 'border-sage bg-sage text-white'
                      : someOn
                        ? 'border-sky bg-sky/40'
                        : 'border-line bg-night-2'
                  }`}
                  aria-label={`${group.label} csoport ${allOn ? 'kikapcsolása' : 'bekapcsolása'}`}
                />
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  {group.label}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1 pl-6 sm:grid-cols-3">
                {group.tools.map((tool) => (
                  <label
                    key={tool}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                      isOrchestrator && tool === 'web_search' && !enabled.has(tool)
                        ? 'cursor-not-allowed opacity-50'
                        : 'cursor-pointer hover:bg-night-2'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={enabled.has(tool)}
                      onChange={() => toggle(tool)}
                      disabled={isOrchestrator && tool === 'web_search' && !enabled.has(tool)}
                      className="accent-sage"
                    />
                    <span className="font-mono text-xs text-ink-soft">{tool}</span>
                  </label>
                ))}
              </div>
            </div>
          )
        })}
      </div>

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
    </Card>
  )
}
