/**
 * Eszközjog-nézet: mit hívhat az agent, és mit nem (issue #194).
 */
import { ExpandableContent } from '@/components/ui/expandable-content'
import { Badge } from '@/components/ui/shell'
import { NORMAL_TOOL_CAPABILITY_NAMES } from '@/lib/tool-capability-catalog'
import { getToolUiLabel } from '@/lib/tool-ui-labels'

function ToolPillList({
  items,
  muted = false,
}: {
  items: Array<{ key: string; label: string }>
  muted?: boolean
}) {
  if (items.length === 0) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {items.map((item) => (
        <li
          key={item.key}
          className={
            muted
              ? 'rounded-full border border-line px-2.5 py-1 text-xs text-ink-faint'
              : 'atelier-soft px-2.5 py-1 text-xs text-ink'
          }
        >
          {item.label}
        </li>
      ))}
    </ul>
  )
}

function ToolSection({
  title,
  badge,
  count,
  hint,
  items,
  muted = false,
}: {
  title: string
  badge?: { label: string; tone: 'success' | 'danger' | 'neutral' }
  count: number
  hint?: string
  items: Array<{ key: string; label: string }>
  muted?: boolean
}) {
  if (count === 0) return null
  return (
    <div className={muted ? 'border-t border-line pt-3' : undefined}>
      <div className="flex items-center gap-2">
        {badge ? (
          <Badge tone={badge.tone}>{badge.label}</Badge>
        ) : (
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{title}</p>
        )}
        <span className="text-xs text-ink-faint">{count} eszköz</span>
      </div>
      {hint && <p className="mt-2 text-xs text-ink-faint">{hint}</p>}
      <ToolPillList items={items} muted={muted} />
    </div>
  )
}

export function AgentToolsOverview({
  capabilities,
  canEdit = false,
}: {
  capabilities: Array<{ toolName: string; allowed: boolean }>
  canEdit?: boolean
}) {
  const granted = new Set(capabilities.filter((c) => c.allowed).map((c) => c.toolName))
  const names = [...new Set([...NORMAL_TOOL_CAPABILITY_NAMES, ...capabilities.map((c) => c.toolName)])]
  const available = names
    .filter((name) => granted.has(name))
    .map((name) => ({ key: name, label: getToolUiLabel(name).label }))
  const unavailable = names
    .filter((name) => !granted.has(name))
    .map((name) => ({ key: name, label: getToolUiLabel(name).label }))

  if (available.length === 0 && unavailable.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        Még nincs beállítva egyetlen eszközjog sem — az agent csak beszélgetni tud.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink">
        <strong>{available.length}</strong> eszköz elérhető az agent számára
        {unavailable.length > 0 && (
          <span className="text-ink-faint"> — {unavailable.length} nem elérhető</span>
        )}
        .
      </p>

      <ExpandableContent>
        <div className="space-y-4">
          <ToolSection
            title="Elérhető"
            badge={{ label: 'Elérhető', tone: 'success' }}
            count={available.length}
            items={available}
          />

          <ToolSection
            title="Nem elérhető"
            count={unavailable.length}
            hint={
              canEdit
                ? 'Ha kellenek, pipáld be őket a Szerkesztés gombbal.'
                : undefined
            }
            items={unavailable}
            muted
          />
        </div>
      </ExpandableContent>
    </div>
  )
}
