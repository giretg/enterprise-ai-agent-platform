'use client'

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { personaFor } from '@/lib/agent-persona'

export type AgentAssigneeOption = {
  id: string
  name: string
  personaNickname?: string | null
  personaTrait?: string | null
  avatarUrl?: string | null
  status?: string
}

function AgentAssigneeOptionContent({ agent }: { agent: AgentAssigneeOption }) {
  const persona = personaFor(agent.name, {
    personaNickname: agent.personaNickname,
    personaTrait: agent.personaTrait,
  })

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <AgentAvatar
        name={agent.name}
        status={agent.status ?? 'active'}
        size="sm"
        avatarUrl={agent.avatarUrl}
        personaNickname={agent.personaNickname}
      />
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium text-ink">{persona.nickname}</p>
        <p className="line-clamp-2 text-xs text-ink-faint">{persona.trait}</p>
      </div>
    </div>
  )
}

export function AgentAssigneeSelect({
  agents,
  value,
  onChange,
  disabled,
  id,
}: {
  agents: AgentAssigneeOption[]
  value: string
  onChange: (agentId: string) => void
  disabled?: boolean
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listId = useId()

  const selected = agents.find((agent) => agent.id === value) ?? null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  const openAt = (index: number) => {
    if (agents.length === 0) return
    setActiveIndex(Math.max(0, Math.min(index, agents.length - 1)))
    setOpen(true)
  }

  const closeAndRestoreFocus = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const selectAgent = (agentId: string) => {
    onChange(agentId)
    closeAndRestoreFocus()
  }

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const selectedIndex = agents.findIndex((agent) => agent.id === value)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openAt(selectedIndex >= 0 ? selectedIndex : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(selectedIndex >= 0 ? selectedIndex : agents.length - 1)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      closeAndRestoreFocus()
    }
  }

  const handleOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index + 1) % agents.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index - 1 + agents.length) % agents.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(agents.length - 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeAndRestoreFocus()
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          const selectedIndex = agents.findIndex((agent) => agent.id === value)
          openAt(selectedIndex >= 0 ? selectedIndex : 0)
        }}
        onKeyDown={handleTriggerKeyDown}
        className="mt-1 flex w-full items-center gap-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-left text-sm text-ink transition hover:border-sky/30 disabled:opacity-50"
      >
        {selected ? (
          <AgentAssigneeOptionContent agent={selected} />
        ) : (
          <span className="flex-1 text-ink-faint">Válassz…</span>
        )}
        <span className="shrink-0 text-ink-faint" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="AI munkatárs választása"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-line bg-card py-1 shadow-lg"
        >
          {agents.map((agent, index) => {
            const isSelected = agent.id === value
            return (
              <li key={agent.id} role="presentation">
                <button
                  ref={(node) => {
                    optionRefs.current[index] = node
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(index)}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                  onClick={() => {
                    selectAgent(agent.id)
                  }}
                  className={`w-full px-3 py-2 transition hover:bg-night-2 ${
                    isSelected ? 'bg-sky/10' : ''
                  }`}
                >
                  <AgentAssigneeOptionContent agent={agent} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
