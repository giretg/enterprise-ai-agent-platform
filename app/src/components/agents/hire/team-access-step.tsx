'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setAgentUserAccess } from '@/app/actions/platform'
import { AgentAccessPanel, type AgentAccessUser } from '@/components/agents/agent-access-panel'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { asTranslate } from '@/i18n/translate'
import {
  hireSharedWithOthers,
  hireTeamChoice,
  isTeamMemberNeedingGrant,
  usersToGrantForWholeTeam,
  type HireTeamChoice,
} from '@/lib/agent-hire'

/**
 * „Ki dolgozik vele?” (#957): alapból csak a létrehozó (és az adminok, akik
 * mindig látják); egy kattintással az egész csapat, vagy személyenként — az
 * adatlap ugyanazon `setAgentUserAccess` műveletével, auditnaplóval.
 */
export function TeamAccessStep({
  agentId,
  users,
  onChanged,
}: {
  agentId: string
  users: AgentAccessUser[]
  onChanged: () => void
}) {
  const t = asTranslate(useTranslations('AgentCreate'))
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const choice: HireTeamChoice = picking ? 'selected' : hireTeamChoice(users)
  const members = users.filter(isTeamMemberNeedingGrant)
  const shared = hireSharedWithOthers(users)

  function applyAll(userIds: string[], accessLevel: 'operate' | 'none') {
    start(async () => {
      setError(null)
      for (const userId of userIds) {
        const res = await setAgentUserAccess({ agentId, userId, accessLevel })
        if (!res.success) {
          setError(res.error)
          break
        }
      }
      onChanged()
    })
  }

  async function chooseMe() {
    setPicking(false)
    const granted = members.filter((user) => user.accessLevel).map((user) => user.id)
    if (granted.length === 0) return
    const ok = await confirmDialog({
      title: t('team.revokeTitle'),
      description: t('team.revokeBody', { count: granted.length }),
      confirmLabel: t('team.revokeConfirm'),
    })
    if (ok) applyAll(granted, 'none')
  }

  const options: Array<{ id: HireTeamChoice; onPick: () => void }> = [
    { id: 'me', onPick: () => void chooseMe() },
    {
      id: 'team',
      onPick: () => {
        setPicking(false)
        applyAll(usersToGrantForWholeTeam(users), 'operate')
      },
    },
    { id: 'selected', onPick: () => setPicking(true) },
  ]

  return (
    <div className="space-y-4">
      <ul className="grid gap-3 sm:grid-cols-3">
        {options.map((option) => {
          const active = choice === option.id
          return (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={active}
                disabled={pending || (option.id !== 'me' && members.length === 0)}
                onClick={option.onPick}
                className={`h-full w-full rounded-xl border px-3 py-3 text-left transition-colors disabled:opacity-60 ${
                  active ? 'border-coral/50 bg-coral/8' : 'border-ink/12 bg-paper hover:border-coral/30'
                }`}
              >
                <span className="block text-sm font-semibold">{t(`team.options.${option.id}.title`)}</span>
                <span className="mt-1 block text-xs text-ink-soft">
                  {t(`team.options.${option.id}.body`, { count: members.length })}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {!shared ? (
        <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-ink">
          {members.length === 0 ? t('team.nobodyElse') : t('team.onlyYou')}
        </p>
      ) : null}
      {choice === 'selected' && members.length > 0 ? (
        <AgentAccessPanel agentId={agentId} users={members} />
      ) : null}
      {pending ? <p className="text-xs text-ink-soft">{t('saving')}</p> : null}
      {error ? <p className="text-sm text-coral">{error}</p> : null}
    </div>
  )
}
