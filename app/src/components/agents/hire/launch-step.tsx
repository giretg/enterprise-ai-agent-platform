'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import {
  activateAgent,
  publishAgentDefinitionAction,
  resumeAgent,
} from '@/app/actions/platform'
import { asTranslate } from '@/i18n/translate'
import { CREATE_AGENT_WIZARD_AFTER_LAUNCH_HREFS } from '@/lib/create-agent-wizard'

type AgentStatus = 'draft' | 'active' | 'suspended' | 'retired'

/**
 * „Próbaüzem és munkába állítás” (#957 WP-6): javasolt próbakérdések, majd
 * egy gomb = élesítés + aktiválás (ugyanazok a műveletek, mint az adatlap
 * Élesítés kapcsolója). Siker után: „Írj neki most” / „Adj neki ticketet”.
 */
export function LaunchStep({
  agentId,
  name,
  status,
  hasUnpublishedChanges,
  testQuestions,
  autonomyIsTrainee,
  onLaunched,
}: {
  agentId: string
  name: string
  status: AgentStatus
  hasUnpublishedChanges: boolean
  testQuestions: string[]
  autonomyIsTrainee: boolean
  onLaunched: (status: AgentStatus) => void
}) {
  const t = asTranslate(useTranslations('AgentCreate'))
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [celebrate, setCelebrate] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const live = status === 'active'
  const retired = status === 'retired'

  function launch() {
    start(async () => {
      setError(null)
      const published = await publishAgentDefinitionAction({ agentId })
      if (!published.success) {
        setError(published.error)
        return
      }
      let nextStatus: AgentStatus = status
      if (status === 'suspended') {
        const resumed = await resumeAgent({ agentId })
        if (!resumed.success) {
          setError(resumed.error)
          return
        }
        nextStatus = resumed.data.status
      } else if (status !== 'active') {
        const activated = await activateAgent({ agentId })
        if (!activated.success) {
          setError(activated.error)
          return
        }
        nextStatus = activated.data.status
      }
      setCelebrate(true)
      onLaunched(nextStatus)
    })
  }

  async function copy(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(index)
    } catch {
      setCopied(null)
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2 rounded-xl border border-ink/12 bg-paper px-4 py-3">
        <h3 className="text-sm font-semibold">{t('launch.testTitle')}</h3>
        <p className="text-xs text-ink-soft">
          {autonomyIsTrainee ? t('launch.testSafe') : t('launch.testCareful')}
        </p>
        <ol className="space-y-1.5">
          {testQuestions.map((question, index) => (
            <li key={question} className="flex items-start justify-between gap-2 rounded-lg bg-wash/60 px-3 py-2 text-sm">
              <span>
                {index + 1}. {question}
              </span>
              <button
                type="button"
                onClick={() => void copy(index, question)}
                className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold text-ink-soft hover:text-ink"
              >
                {copied === index ? t('launch.copied') : t('launch.copy')}
              </button>
            </li>
          ))}
        </ol>
      </section>

      {retired ? (
        <p className="text-sm text-ink-soft">{t('launch.retired')}</p>
      ) : live && !hasUnpublishedChanges ? (
        <div className="relative overflow-hidden rounded-xl border border-sage/40 bg-sage/10 px-4 py-4">
          {celebrate ? (
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-2 flex justify-center gap-6 text-xl">
              <span className="animate-hire-float">🎉</span>
              <span className="animate-hire-float [animation-delay:150ms]">✨</span>
              <span className="animate-hire-float [animation-delay:300ms]">🎉</span>
            </span>
          ) : null}
          <p className="animate-hire-pop text-sm font-semibold text-sage">
            {t('launch.liveTitle', { name: name || t('card.unnamed') })}
          </p>
          <p className="mt-1 text-xs text-ink-soft">{t('launch.liveBody')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={CREATE_AGENT_WIZARD_AFTER_LAUNCH_HREFS.chat}
              className="rounded-full bg-coral px-4 py-2 text-sm font-semibold text-white"
            >
              {t('launch.chatNow')}
            </Link>
            <Link
              href={CREATE_AGENT_WIZARD_AFTER_LAUNCH_HREFS.ticket}
              className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink"
            >
              {t('launch.giveTicket')}
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-ink">
            {live ? t('launch.updateBody') : t('launch.readyBody')}
          </p>
          <button
            type="button"
            onClick={launch}
            disabled={pending}
            className="rounded-full bg-coral px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {pending ? t('launch.launching') : live ? t('launch.update') : t('launch.cta')}
          </button>
        </div>
      )}
      {error ? <p className="text-sm text-coral">{error}</p> : null}
    </div>
  )
}
