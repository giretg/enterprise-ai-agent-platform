'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import {
  activateAgent,
  publishAgentDefinitionAction,
  resumeAgent,
  suspendAgent,
} from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type AgentStatus = 'draft' | 'active' | 'suspended' | 'retired'

const MCP_OFF_REASON = 'MCP-ről levétel'

export function PublishAgentDefinitionForm({
  agentId,
  currentDefinitionId,
  status = 'draft',
  goLive = false,
  wizard = false,
  canEdit = true,
  bare = false,
  onChanged,
  hasUnpublishedChanges = false,
  publishedVersion = null,
}: {
  agentId: string
  currentDefinitionId: string | null
  status?: AgentStatus
  /** Használható kapcsoló: közzététel + aktiválás, lekapcsolva felfüggesztés. */
  goLive?: boolean
  wizard?: boolean
  canEdit?: boolean
  bare?: boolean
  onChanged?: (next: { definitionId: string | null; status: AgentStatus }) => void
  /** A vázlat eltér a közzétett verziótól — az MCP a régi verziót látja. */
  hasUnpublishedChanges?: boolean
  publishedVersion?: number | null
}) {
  const router = useRouter()
  const t = useTranslations('AgentPublish')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [definitionId, setDefinitionId] = useState(currentDefinitionId)
  const [agentStatus, setAgentStatus] = useState(status)
  const live = agentStatus === 'active'
  const retired = agentStatus === 'retired'

  function refresh(next: { definitionId: string | null; status: AgentStatus }) {
    setDefinitionId(next.definitionId)
    setAgentStatus(next.status)
    onChanged?.(next)
    router.refresh()
  }

  const staleBanner =
    hasUnpublishedChanges && definitionId ? (
      <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-ink">
        {t('stalePrefix')}
        {publishedVersion !== null ? ` (v${publishedVersion})` : ''} {t('staleSince')}{' '}
        {live ? t('staleLive') : t('staleOff')}
      </p>
    ) : null

  const switchBody = (
    <>
      {wizard ? (
        <>
          <p className="text-sm text-ink">{t('wizardSaved')}</p>
          <p className="mt-2 text-sm text-ink-soft">{t('wizardSwitch')}</p>
        </>
      ) : (
        <p className="text-sm text-ink-soft">{t('switchHelp')}</p>
      )}
      <label className="mt-4 flex items-center gap-3 rounded-lg border border-line bg-paper px-3 py-3">
        <input
          type="checkbox"
          role="switch"
          className="h-4 w-4 accent-coral"
          checked={live}
          disabled={pending || retired || !canEdit}
          onChange={(event) => {
            const on = event.target.checked
            start(async () => {
              setError(null)
              if (!on) {
                const suspended = await suspendAgent({ agentId, reason: MCP_OFF_REASON })
                if (!suspended.success) {
                  setError(suspended.error)
                  return
                }
                refresh({ definitionId, status: suspended.data.status })
                return
              }
              const published = await publishAgentDefinitionAction({ agentId })
              if (!published.success) {
                setError(published.error)
                return
              }
              const nextId = published.data.definitionId
              if (agentStatus === 'suspended') {
                const resumed = await resumeAgent({ agentId })
                if (!resumed.success) {
                  setError(resumed.error)
                  refresh({ definitionId: nextId, status: 'suspended' })
                  return
                }
                refresh({ definitionId: nextId, status: resumed.data.status })
                return
              }
              const activated = await activateAgent({ agentId })
              if (!activated.success) {
                setError(activated.error)
                refresh({ definitionId: nextId, status: 'draft' })
                return
              }
              refresh({ definitionId: nextId, status: activated.data.status })
            })
          }}
        />
        <span>
          <span className="block text-sm font-semibold">{t('mcpSwitchTitle')}</span>
          <span className="block text-xs text-ink-soft">
            {retired
              ? t('retired')
              : live
                ? t('liveHint')
                : pending
                  ? t('saving')
                  : t('offHint')}
          </span>
        </span>
      </label>
      {(live || hasUnpublishedChanges) && canEdit ? (
        <button
          type="button"
          disabled={pending}
          className="mt-3 rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft disabled:opacity-60"
          onClick={() => {
            start(async () => {
              setError(null)
              const result = await publishAgentDefinitionAction({ agentId })
              if (!result.success) {
                setError(result.error)
                return
              }
              refresh({ definitionId: result.data.definitionId, status: agentStatus })
            })
          }}
        >
          {pending ? t('publishing') : t('publishNew')}
        </button>
      ) : null}
      {staleBanner}
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </>
  )

  const publishOnlyBody = (
    <>
      <p className="text-sm text-ink-soft">{t('publishOnlyBody')}</p>
      <p className="mt-2 text-sm text-ink">
        {definitionId ? t('hasPublished') : t('noPublished')}
      </p>
      {staleBanner}
      {canEdit ? (
        <button
          type="button"
          disabled={pending}
          className="mt-3 rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          onClick={() => {
            start(async () => {
              setError(null)
              const result = await publishAgentDefinitionAction({ agentId })
              if (!result.success) {
                setError(result.error)
                return
              }
              refresh({ definitionId: result.data.definitionId, status: agentStatus })
            })
          }}
        >
          {pending ? t('publishing') : definitionId ? t('publishNew') : t('publish')}
        </button>
      ) : null}
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </>
  )

  const body = goLive ? switchBody : publishOnlyBody
  if (bare) return body
  return <Card title={goLive ? t('cardLive') : t('cardPublish')}>{body}</Card>
}
