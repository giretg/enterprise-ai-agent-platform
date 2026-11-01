'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { updateAgentCapabilities } from '@/app/actions/platform'
import { assignConnectorToAgent, unassignConnectorFromAgent } from '@/app/actions/provisioning'
import {
  assignSkillAction,
  unassignSkillAction,
  type AgentSkillRow,
  type AssignableSkill,
} from '@/app/actions/skills'
import type { ConnectorCatalogOption } from '@/components/agents/agent-connector-binding-form'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { asTranslate } from '@/i18n/translate'
import {
  CAPABILITY_DECK,
  applyCapabilityDeckLevel,
  capabilityCategoryForConnectorType,
  capabilityDeckIsPartial,
  capabilityDeckLevel,
  capabilityDeckLevels,
  type CapabilityDeckCard,
  type CapabilityDeckLevel,
} from '@/lib/agent-capability-deck'
import { grantedToolNames } from '@/lib/create-agent-wizard'

/** Kapcsolat-típusok, amelyeket a pakli eszköz-kártyái automatikusan bekötnek. */
const AUTO_LINKED_CONNECTOR_TYPES = new Set(['gmail', 'google_drive', 'knowledge_base', 'code_sandbox', 'web_search'])

const CATEGORY_ICON: Record<CapabilityDeckCard['id'], string> = {
  mail: '✉️',
  documents: '📄',
  sheets: '📊',
  company: '🏢',
  knowledge: '📚',
  compute: '🧮',
  web: '🌐',
}

type BoundConnector = {
  connector: { id: string; name: string; type: string }
  accessMode: 'read' | 'write'
}

/**
 * „Mihez fér hozzá?” kezdő nézete (#957 WP-2): egyetlen képesség-pakli az
 * eszközökből, a céges rendszerek kapcsolataiból és a betanult módszerekből.
 * Minden kattintás azonnal ment, ugyanazokkal a szerverműveletekkel, mint az
 * adatlap (jogosultság-ellenőrzés és auditnapló ott történik).
 */
export function CapabilityDeck({
  agentId,
  capabilities,
  connectors,
  assignableConnectors,
  assignedSkills,
  assignableSkills,
  onChanged,
  onOpenAccounts,
}: {
  agentId: string
  capabilities: Array<{ toolName: string; allowed: boolean }>
  connectors: BoundConnector[]
  assignableConnectors: ConnectorCatalogOption[]
  assignedSkills: AgentSkillRow[]
  assignableSkills: AssignableSkill[]
  onChanged: () => void
  onOpenAccounts: () => void
}) {
  const t = asTranslate(useTranslations('AgentCreate'))
  const [pending, start] = useTransition()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(grantedToolNames(capabilities)))

  function run(key: string, action: () => Promise<{ success: boolean; error?: string }>, rollback?: () => void) {
    setBusyKey(key)
    start(async () => {
      setError(null)
      const res = await action()
      setBusyKey(null)
      if (!res.success) {
        rollback?.()
        setError(res.error ?? t('saveFailed'))
        return
      }
      onChanged()
    })
  }

  function setCardLevel(card: CapabilityDeckCard, level: CapabilityDeckLevel) {
    const previous = enabled
    const next = applyCapabilityDeckLevel(card, level, enabled)
    setEnabled(next)
    run(
      `tool:${card.id}`,
      async () => {
        const res = await updateAgentCapabilities({ agentId, enabledTools: [...next] })
        return res.success ? { success: true } : { success: false, error: res.error }
      },
      () => setEnabled(previous),
    )
  }

  const companyBound = connectors.filter((row) => !AUTO_LINKED_CONNECTOR_TYPES.has(row.connector.type))
  const companyAvailable = assignableConnectors.filter((row) => !AUTO_LINKED_CONNECTOR_TYPES.has(row.type))

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center">
          <h3 className="text-sm font-semibold">{t('deck.toolsTitle')}</h3>
          <HelpHint>{t('deck.toolsHelp')}</HelpHint>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {CAPABILITY_DECK.map((card) => {
            const level = capabilityDeckLevel(card, enabled)
            const partial = capabilityDeckIsPartial(card, enabled)
            const levels = capabilityDeckLevels(card)
            const busy = busyKey === `tool:${card.id}`
            return (
              <li
                key={card.id}
                className={`rounded-xl border px-3 py-3 transition-colors ${
                  level === 'off' ? 'border-ink/12 bg-paper' : 'border-sage/40 bg-sage/8'
                }`}
              >
                <div className="flex items-start gap-2">
                  <span aria-hidden className="text-xl leading-none">{CATEGORY_ICON[card.id]}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{t(`deck.cards.${card.id}.title`)}</p>
                    <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                      {card.readTools.length > 0 ? <li>• {t(`deck.cards.${card.id}.read`)}</li> : null}
                      {card.writeTools.length > 0 ? <li>• {t(`deck.cards.${card.id}.write`)}</li> : null}
                    </ul>
                    {card.needsAccount ? (
                      <button
                        type="button"
                        onClick={onOpenAccounts}
                        className="mt-2 rounded-full border border-amber-600/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-ink hover:border-amber-600/70"
                      >
                        {t(`deck.needsAccount.${card.needsAccount}`)}
                      </button>
                    ) : null}
                    {partial ? <p className="mt-2 text-[11px] text-ink-faint">{t('deck.partial')}</p> : null}
                  </div>
                </div>
                <div role="radiogroup" aria-label={t(`deck.cards.${card.id}.title`)} className="mt-3 flex flex-wrap gap-1.5">
                  {levels.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={level === option}
                      disabled={pending}
                      onClick={() => level !== option && setCardLevel(card, option)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-60 ${
                        level === option
                          ? option === 'off'
                            ? 'bg-ink/80 text-white'
                            : 'bg-sage text-white'
                          : 'border border-line text-ink-soft hover:border-coral/40 hover:text-ink'
                      }`}
                    >
                      {busy && level === option ? '…' : t(`deck.levels.${option}`)}
                    </button>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex items-center">
          <h3 className="text-sm font-semibold">{t('deck.systemsTitle')}</h3>
          <HelpHint>{t('deck.systemsHelp')}</HelpHint>
        </div>
        {companyBound.length === 0 && companyAvailable.length === 0 ? (
          <p className="text-xs text-ink-faint">{t('deck.systemsEmpty')}</p>
        ) : null}
        <ul className="space-y-2">
          {companyBound.map((row) => (
            <li
              key={row.connector.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sage/40 bg-sage/8 px-3 py-2"
            >
              <span className="min-w-0 text-sm">
                <span aria-hidden className="mr-1">{CATEGORY_ICON[capabilityCategoryForConnectorType(row.connector.type)]}</span>
                <span className="font-semibold">{row.connector.name}</span>{' '}
                <span className="text-xs text-ink-soft">
                  · {row.accessMode === 'write' ? t('deck.modeWrite') : t('deck.modeRead')}
                </span>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(`conn:${row.connector.id}`, async () => {
                    const res = await unassignConnectorFromAgent({ agentId, connectorId: row.connector.id })
                    return res.success ? { success: true } : { success: false, error: res.error }
                  })
                }
                className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:text-coral disabled:opacity-50"
              >
                {busyKey === `conn:${row.connector.id}` ? '…' : t('deck.remove')}
              </button>
            </li>
          ))}
          {companyAvailable.map((option) => (
            <li
              key={option.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink/12 bg-paper px-3 py-2"
            >
              <span className="min-w-0 text-sm">
                <span aria-hidden className="mr-1">{CATEGORY_ICON[capabilityCategoryForConnectorType(option.type)]}</span>
                <span className="font-semibold">{option.name}</span>
                {option.description ? (
                  <span className="block text-xs text-ink-soft">{option.description}</span>
                ) : null}
              </span>
              <span className="flex gap-1.5">
                {(['read', 'write'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(`conn:${option.id}`, async () => {
                        const res = await assignConnectorToAgent({ agentId, connectorId: option.id, accessMode: mode })
                        return res.success ? { success: true } : { success: false, error: res.error }
                      })
                    }
                    className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:border-sage/50 hover:text-ink disabled:opacity-50"
                  >
                    {mode === 'write' ? t('deck.addWrite') : t('deck.addRead')}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex items-center">
          <h3 className="text-sm font-semibold">{t('deck.methodsTitle')}</h3>
          <HelpHint>{t('deck.methodsHelp')}</HelpHint>
        </div>
        {assignedSkills.length === 0 && assignableSkills.length === 0 ? (
          <p className="text-xs text-ink-faint">{t('deck.methodsEmpty')}</p>
        ) : null}
        <ul className="space-y-2">
          {assignedSkills.map((skill) => (
            <li
              key={skill.skillVersionId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sage/40 bg-sage/8 px-3 py-2"
            >
              <span className="min-w-0 text-sm">
                <span className="font-semibold">{skill.displayName || skill.name}</span>
                {skill.description ? <span className="block text-xs text-ink-soft">{skill.description}</span> : null}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(`skill:${skill.skillVersionId}`, async () => {
                    const res = await unassignSkillAction({ agentId, skillVersionId: skill.skillVersionId })
                    return res.success ? { success: true } : { success: false, error: res.error }
                  })
                }
                className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:text-coral disabled:opacity-50"
              >
                {busyKey === `skill:${skill.skillVersionId}` ? '…' : t('deck.forget')}
              </button>
            </li>
          ))}
          {assignableSkills.map((skill) => (
            <li
              key={skill.activeVersionId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink/12 bg-paper px-3 py-2"
            >
              <span className="min-w-0 text-sm">
                <span className="font-semibold">{skill.displayName || skill.name}</span>
                {skill.description ? <span className="block text-xs text-ink-soft">{skill.description}</span> : null}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(`skill:${skill.activeVersionId}`, async () => {
                    const res = await assignSkillAction({ agentId, skillVersionId: skill.activeVersionId })
                    return res.success ? { success: true } : { success: false, error: res.error }
                  })
                }
                className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:border-sage/50 hover:text-ink disabled:opacity-50"
              >
                {busyKey === `skill:${skill.activeVersionId}` ? '…' : t('deck.teach')}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {error ? <p className="text-sm text-coral">{error}</p> : null}
    </div>
  )
}
