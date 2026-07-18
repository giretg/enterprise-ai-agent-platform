'use client'

import type { ToolCapabilityGroup } from '@/lib/tool-capability-catalog'
import { getToolUiLabel } from '@/lib/tool-ui-labels'

export function ToolCapabilityCheckboxGroups({
  groups,
  enabled,
  onChange,
  isToolDisabled,
}: {
  groups: readonly ToolCapabilityGroup[]
  enabled: Set<string>
  onChange: (next: Set<string>) => void
  isToolDisabled?: (tool: string, enabled: Set<string>) => boolean
}) {
  function disabled(tool: string) {
    return isToolDisabled?.(tool, enabled) ?? false
  }

  function toggle(tool: string) {
    if (disabled(tool)) return
    const next = new Set(enabled)
    if (next.has(tool)) next.delete(tool)
    else next.add(tool)
    onChange(next)
  }

  function toggleGroup(tools: readonly string[], allOn: boolean) {
    const selectableTools = tools.filter((tool) => !disabled(tool))
    const next = new Set(enabled)
    for (const tool of selectableTools) {
      if (allOn) next.delete(tool)
      else next.add(tool)
    }
    onChange(next)
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const allOn = group.tools.every((tool) => enabled.has(tool))
        const someOn = !allOn && group.tools.some((tool) => enabled.has(tool))
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
            <div className="grid grid-cols-1 gap-1 pl-6 md:grid-cols-2 xl:grid-cols-3">
              {group.tools.map((tool) => {
                const isDisabled = disabled(tool)
                const { label, description } = getToolUiLabel(tool)
                const hasCustomLabel = label !== tool
                return (
                  <label
                    key={tool}
                    title={description || undefined}
                    className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 ${
                      isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-night-2'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={enabled.has(tool)}
                      onChange={() => toggle(tool)}
                      disabled={isDisabled}
                      className="shrink-0 accent-sage"
                    />
                    <span className="min-w-0 break-words text-xs text-ink-soft [overflow-wrap:anywhere]">
                      {hasCustomLabel ? (
                        <>
                          {label}{' '}
                          <span className="font-mono text-ink-faint">({tool})</span>
                        </>
                      ) : (
                        <span className="font-mono">{tool}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
