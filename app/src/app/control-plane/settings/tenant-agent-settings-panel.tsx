'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { setHireDraftDailyLimit, setTenantAutonomyCeiling } from '@/app/actions/tenant-agent-settings'
import { Card } from '@/components/ui/shell'
import { asTranslate } from '@/i18n/translate'
import { AUTONOMY_LEVELS, type AutonomyLevel } from '@/lib/agent-autonomy'
import { MAX_HIRE_DRAFT_DAILY_LIMIT } from '@/lib/agent-hire-draft'

type Message = { tone: 'ok' | 'error'; text: string } | null

function Feedback({ message }: { message: Message }) {
  if (!message) return null
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-sm ${
        message.tone === 'ok'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800'
          : 'border-coral/35 bg-coral/10 text-coral-deep'
      }`}
    >
      {message.text}
    </p>
  )
}

/** #957: az AI-munkatársak céges keretei — önállósági felső korlát (D3) és a „Mondd el” napi kerete (D1). */
export function TenantAgentSettingsPanel({
  initialCeiling,
  initialDailyLimit,
  canEdit,
}: {
  initialCeiling: AutonomyLevel
  initialDailyLimit: number
  canEdit: boolean
}) {
  const t = asTranslate(useTranslations('ControlPlane.settings'))
  const tLevels = asTranslate(useTranslations('AgentCreate.autonomy.levels'))
  const [ceiling, setCeiling] = useState<AutonomyLevel>(initialCeiling)
  const [limit, setLimit] = useState(String(initialDailyLimit))
  const [savedLimit, setSavedLimit] = useState(initialDailyLimit)
  const [pending, startTransition] = useTransition()
  const [ceilingMessage, setCeilingMessage] = useState<Message>(null)
  const [limitMessage, setLimitMessage] = useState<Message>(null)

  function chooseCeiling(next: AutonomyLevel) {
    if (next === ceiling || !canEdit || pending) return
    startTransition(async () => {
      const res = await setTenantAutonomyCeiling({ ceiling: next })
      if (res.success) {
        setCeiling(res.data.ceiling)
        setCeilingMessage({ tone: 'ok', text: t('autonomySaved', { label: tLevels(`${res.data.ceiling}.title`) }) })
      } else {
        setCeilingMessage({ tone: 'error', text: res.error })
      }
    })
  }

  function saveLimit() {
    const value = Number(limit)
    if (!Number.isInteger(value) || value < 0 || value > MAX_HIRE_DRAFT_DAILY_LIMIT) {
      setLimitMessage({ tone: 'error', text: t('hireDraftInvalid', { max: MAX_HIRE_DRAFT_DAILY_LIMIT }) })
      return
    }
    startTransition(async () => {
      const res = await setHireDraftDailyLimit({ limit: value })
      if (res.success) {
        setSavedLimit(res.data.limit)
        setLimitMessage({
          tone: 'ok',
          text: res.data.limit === 0 ? t('hireDraftSavedOff') : t('hireDraftSaved', { limit: res.data.limit }),
        })
      } else {
        setLimitMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <div className="space-y-4">
      <Card title={t('autonomyTitle')}>
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">{t('autonomyBody')}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {AUTONOMY_LEVELS.map((level) => {
              const active = ceiling === level
              return (
                <button
                  key={level}
                  type="button"
                  aria-pressed={active}
                  disabled={!canEdit || pending}
                  onClick={() => chooseCeiling(level)}
                  className={`rounded-lg px-4 py-3 text-left text-sm transition disabled:opacity-50 ${
                    active ? 'bg-coral text-white' : 'border border-line bg-panel text-ink hover:border-coral/50'
                  }`}
                >
                  <span className="block font-semibold">{tLevels(`${level}.title`)}</span>
                  <span className={`mt-1 block text-xs ${active ? 'text-white/85' : 'text-ink-soft'}`}>
                    {t(`autonomyCeiling.${level}`)}
                  </span>
                </button>
              )
            })}
          </div>
          <Feedback message={ceilingMessage} />
        </div>
      </Card>
      <Card title={t('hireDraftTitle')}>
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">{t('hireDraftBody')}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="text-ink-soft">{t('hireDraftField')}</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_HIRE_DRAFT_DAILY_LIMIT}
                step={1}
                value={limit}
                disabled={!canEdit || pending}
                onChange={(event) => setLimit(event.target.value)}
                className="mt-1 block w-32 rounded-lg border border-line bg-paper px-3 py-2 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={saveLimit}
              disabled={!canEdit || pending || limit === String(savedLimit)}
              className="rounded-lg bg-coral px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {t('hireDraftSave')}
            </button>
          </div>
          <Feedback message={limitMessage} />
        </div>
      </Card>
    </div>
  )
}
