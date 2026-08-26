'use client'

import { useEffect, useState } from 'react'
import { getConversationMemoryStrip } from '@/app/actions/platform'
import { compactTicketStateLabel, MEMORY_TYPE_LABELS, type MemoryStripView } from '@/lib/work-traceability'

export function MemoryStrip({
  conversationId,
  agentId,
  workspaceFiles,
}: {
  conversationId: string | null
  agentId: string
  workspaceFiles: string[]
}) {
  const [view, setView] = useState<MemoryStripView | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    void getConversationMemoryStrip({ conversationId, agentId }).then((res) => {
      if (cancelled || !res.success) return
      setView(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [agentId, conversationId])

  if (!conversationId || !view) return null

  return (
    <div className="mt-2 px-1">
      <p className="text-[11px] leading-snug text-ink-faint">
        <span aria-hidden>🧠 </span>
        {view.summaryLine}{' '}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="font-semibold text-coral hover:underline"
        >
          {open ? 'Bezár' : 'Mit tud pontosan?'}
        </button>
      </p>
      {open ? (
        <div className="mt-2 space-y-2.5 rounded-xl border border-line bg-card px-3 py-2.5 text-[12px] text-ink-soft">
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Beszélgetés
            </h3>
            <p className="mt-0.5">
              {view.details.conversation.includedCount} üzenet kerül a promptba
              {view.details.conversation.droppedCount > 0
                ? ` — ${view.details.conversation.droppedCount} korábbi üzenet kiesett a 16-os ablak miatt.`
                : '.'}
            </p>
          </section>
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Projekt-memória
            </h3>
            {view.details.projectMemory.length === 0 ? (
              <p className="mt-0.5 text-ink-faint">Most nincs betöltött projekt-memória.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {view.details.projectMemory.map((item, index) => (
                  <li key={`${item.type}-${index}`}>
                    <span className="font-semibold text-ink">
                      {MEMORY_TYPE_LABELS[item.type] ?? item.type}:
                    </span>{' '}
                    {item.title}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Nyitott feladatok
            </h3>
            {view.details.openTasks.length === 0 ? (
              <p className="mt-0.5 text-ink-faint">Nincs nyitott feladat ebből a beszélgetésből.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {view.details.openTasks.map((task) => (
                  <li key={task.id}>
                    {task.title}{' '}
                    <span className="text-ink-faint">({compactTicketStateLabel(task.state)})</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Munkaterület fájljai
            </h3>
            {workspaceFiles.length === 0 ? (
              <p className="mt-0.5 text-ink-faint">Nincs fájl a munkaterületen.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {workspaceFiles.slice(0, 12).map((path) => (
                  <li key={path} className="font-mono text-[11px]">
                    {path}
                  </li>
                ))}
                {workspaceFiles.length > 12 ? (
                  <li className="text-ink-faint">+{workspaceFiles.length - 12} további</li>
                ) : null}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
