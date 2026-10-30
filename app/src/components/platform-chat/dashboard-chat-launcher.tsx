'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { platformChatHref } from '@/lib/platform-chat-href'
import { stashPendingPrompt } from './pending-prompt'

export type LauncherAgent = { id: string; name: string; description: string | null }

/**
 * Áttekintés oldal: Grok-szerű kérdezőmező. Beírod a kérdést, kiválasztod a munkatársat, Enter —
 * és a chat már ezzel az üzenettel indul.
 */
export function DashboardChatLauncher({ agents }: { agents: LauncherAgent[] }) {
  const t = useTranslations('ControlPlane.dashboard.chat')
  const router = useRouter()
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [text, setText] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [going, setGoing] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const agent = agents.find((a) => a.id === agentId) ?? agents[0]

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  if (!agent) return null

  function go(prompt = text) {
    const content = prompt.trim()
    if (!content || going) return
    setGoing(true)
    stashPendingPrompt({ agentId: agent.id, text: content })
    router.push('/control-plane/chat')
  }

  const examples = [t('example1'), t('example2'), t('example3')]

  return (
    <section aria-labelledby="dashboard-chat-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="dashboard-chat-title" className="font-display text-xl font-semibold">
          {t('title')}
        </h2>
        <Link href="/control-plane/chat" className="text-sm text-coral-deep hover:underline">
          {t('history')}
        </Link>
      </div>
      <div className="rounded-[1.75rem] border border-line bg-card shadow-[0_4px_24px_-12px_rgba(0,0,0,0.18)] transition focus-within:border-coral/50">
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              go()
            }
          }}
          rows={2}
          aria-label={t('inputLabel')}
          placeholder={t('placeholder', { name: agent.name })}
          className="block max-h-[200px] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-base leading-6 text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="flex items-center gap-2 px-3 pb-3 pt-1">
          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              title={t('pickerHint')}
              className="flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 text-sm text-ink transition hover:bg-ink/5"
            >
              <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-coral/15 text-[10px] font-semibold text-coral-deep">
                {agent.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate">{agent.name}</span>
              <svg aria-hidden viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9.5 6 6 6-6" />
              </svg>
            </button>
            {pickerOpen ? (
              <>
                <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={() => setPickerOpen(false)} />
                <ul role="listbox" aria-label={t('pickerHint')} className="absolute left-0 top-full z-40 mt-2 max-h-72 w-[min(20rem,calc(100vw-3rem))] overflow-y-auto rounded-2xl border border-line bg-card p-1.5 shadow-xl">
                  {agents.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={a.id === agent.id}
                        onClick={() => {
                          setAgentId(a.id)
                          setPickerOpen(false)
                          area.current?.focus()
                        }}
                        className={`flex w-full flex-col rounded-xl px-2.5 py-2 text-left transition ${a.id === agent.id ? 'bg-coral/10' : 'hover:bg-ink/5'}`}
                      >
                        <span className="truncate text-sm font-medium text-ink">{a.name}</span>
                        {a.description ? <span className="line-clamp-2 text-xs text-ink-soft">{a.description}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <span className="flex-1" />
          <Link href={platformChatHref(agent.id)} className="hidden text-sm text-ink-soft hover:text-ink sm:inline">
            {t('openChat')}
          </Link>
          <button
            type="button"
            onClick={() => go()}
            disabled={!text.trim() || going}
            aria-label={t('send')}
            title={t('send')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-coral text-white transition hover:bg-coral-deep disabled:bg-ink/10 disabled:text-ink-faint"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
            </svg>
          </button>
        </div>
      </div>
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => go(example)}
            className="shrink-0 rounded-full border border-line bg-card px-3.5 py-2 text-sm text-ink-soft transition hover:border-coral/50 hover:text-ink"
          >
            {example}
          </button>
        ))}
      </div>
    </section>
  )
}
