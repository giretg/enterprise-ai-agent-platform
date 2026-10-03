'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { asTranslate } from '@/i18n/translate'
import { useTranslations } from 'next-intl'
import { CAPABILITY_KEYS, PRESET_IDS, PRESETS, capabilityLevels, type PresetId } from '@/domain/client-policy/capabilities'

export type EditableClientPolicy = { preset: string | null; capabilities: unknown; version: number }

export function ClientPolicyForm({ scope, scopeId, policy, tenantPolicy }: {
  scope: 'tenant' | 'user' | 'agent'
  scopeId: string
  policy: EditableClientPolicy | null
  tenantPolicy: EditableClientPolicy | null
}) {
  const t = asTranslate(useTranslations('ClientPolicy'))
  const router = useRouter()
  const id = useId()
  const [preset, setPreset] = useState(policy?.preset ?? '')
  const [overrides, setOverrides] = useState<Record<string, unknown>>(
    policy?.capabilities && typeof policy.capabilities === 'object' && !Array.isArray(policy.capabilities)
      ? policy.capabilities as Record<string, unknown> : {},
  )
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [widened, setWidened] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [savedVersion, setSavedVersion] = useState(policy?.version ?? 0)
  const tenantPreset = PRESET_IDS.includes(tenantPolicy?.preset as PresetId) ? tenantPolicy!.preset as PresetId : 'bound'
  const tenantOverrides = tenantPolicy?.capabilities as Record<string, unknown> | null
  const base = preset ? PRESETS[preset as PresetId] : scope === 'agent' ? null : PRESETS[tenantPreset]
  const resetConfirmation = () => { setWidened([]); setConfirmed(false); setMessage('') }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    setMessage('')
    try {
      const response = await fetch('/api/client-policy/admin', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, scopeId, preset: preset || null, capabilities: overrides, version: savedVersion, confirmWidening: confirmed }),
      })
      const result = await response.json()
      if (response.status === 409 && result.error === 'confirmation_required') {
        setWidened(result.capabilities)
        setConfirmed(false)
      } else if (!response.ok) {
        setMessage(t(result.error === 'version_conflict' ? 'conflict' : 'saveFailed'))
      } else {
        setSavedVersion(result.policy.version)
        setWidened([])
        setConfirmed(false)
        setMessage(t('saved'))
        router.refresh()
      }
    } catch { setMessage(t('saveFailed')) }
    finally { setPending(false) }
  }

  async function downloadFloor() {
    setPending(true)
    setMessage('')
    try {
      const response = await fetch(`/api/client-policy/machine-floor?userId=${encodeURIComponent(scopeId)}`)
      if (!response.ok) throw new Error('download_failed')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `hermes-floor-${scopeId}.json`
      link.click()
      URL.revokeObjectURL(url)
    } catch { setMessage(t('downloadFailed')) }
    finally { setPending(false) }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <fieldset disabled={pending} className="space-y-4 disabled:opacity-60">
        <label className="block text-sm" htmlFor={`${id}-preset`}>
          <span className="font-semibold">{t('preset')}</span>
          <select id={`${id}-preset`} value={preset} onChange={e => { setPreset(e.target.value); resetConfirmation() }} className="mt-1 block w-full rounded-lg border border-line bg-card px-3 py-2">
            <option value="">{t(scope === 'agent' ? 'noCeiling' : scope === 'user' ? 'inheritTenant' : 'defaultPreset')}</option>
            {PRESET_IDS.map(p => <option key={p} value={p}>{t(`presets.${p}`)}</option>)}
          </select>
        </label>
        <p className="text-sm text-ink-soft">{t(scope === 'agent' ? 'agentHelp' : 'presetHelp')}</p>
        <p className="text-xs text-ink-soft">{t('filterLimits')}</p>
        <div className="grid gap-4 md:grid-cols-2">
          {CAPABILITY_KEYS.map(key => {
            const selected = typeof overrides[key] === 'string' ? overrides[key] as string : ''
            const inherited = !preset && scope === 'user' && typeof tenantOverrides?.[key] === 'string' ? tenantOverrides[key] as string : base?.[key]
            const labelKey = key.replace('.', '_')
            const displayLevel = selected || inherited
            return (
              <div key={key} className={`min-w-0 rounded-xl border p-3 ${selected ? 'border-coral/40 bg-coral/5' : 'border-line'}`}>
                <label htmlFor={`${id}-${key}`} className="block text-sm font-semibold">{t(`capabilities.${labelKey}`)}</label>
                <select id={`${id}-${key}`} value={selected} onChange={e => {
                  const next = { ...overrides }
                  if (e.target.value) next[key] = e.target.value
                  else delete next[key]
                  setOverrides(next)
                  resetConfirmation()
                }} className="mt-2 w-full rounded-lg border border-line bg-card px-2 py-2 text-sm">
                  <option value="">{t(scope === 'agent' && !preset ? 'noCeiling' : 'inherit')}{inherited ? `: ${t(`levels.${inherited}`)}` : ''}</option>
                  {capabilityLevels(key).map(level => <option key={level} value={level}>{t(`levels.${level}`)}</option>)}
                </select>
                <p className="mt-1 text-xs text-ink-faint">{t(selected ? 'custom' : scope === 'user' && !preset ? 'fromTenant' : scope === 'agent' && !preset ? 'noCeiling' : 'fromPreset')}</p>
                {displayLevel ? <p className="mt-1 text-xs text-ink-soft">{t(key === 'local_files' && displayLevel === 'none' ? 'noFileHelp' : key === 'human_approval' && displayLevel === 'none' ? 'noApprovalHelp' : `help.${displayLevel}`)}</p> : null}
              </div>
            )
          })}
        </div>
      </fieldset>
      {widened.length > 0 ? (
        <div role="alert" className="space-y-2 rounded-xl border border-coral/40 bg-coral/5 p-3 text-sm">
          <p>{t('widenWarning')}</p>
          <ul className="list-disc pl-5">{widened.map(key => <li key={key}>{t(`capabilities.${key.replace('.', '_')}`)}</li>)}</ul>
          <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e => setConfirmed(e.target.checked)} className="mt-1" />{t('confirmWidening')}</label>
        </div>
      ) : null}
      <p className="text-xs text-ink-soft">{t('effectiveNotice')}</p>
      <p role="status" aria-live="polite" className="text-sm text-coral-deep">{message}</p>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={pending || (widened.length > 0 && !confirmed)} className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">{t(pending ? 'saving' : 'save')}</button>
        {scope === 'user' ? <button type="button" onClick={downloadFloor} disabled={pending} className="rounded-full border border-line px-5 py-2 text-sm font-semibold disabled:opacity-50">{t('downloadFloor')}</button> : null}
      </div>
      {scope === 'user' ? <p className="text-xs text-ink-soft">{t('floorHelp')}</p> : null}
    </form>
  )
}
