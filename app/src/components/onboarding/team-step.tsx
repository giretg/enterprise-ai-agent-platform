'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { inviteUser } from '@/app/actions/platform'
import {
  ErrorNotice,
  HelpHint,
  OnboardingCard,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './onboarding-ui'

const INVITE_ROLES = ['operator', 'approver', 'viewer', 'admin'] as const
type InviteRole = (typeof INVITE_ROLES)[number]

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 3. lépés: munkatárs-meghívó, átugorható. A meglévő `inviteUser` actiont hívja
 * (Clerk-levél az aktív, frissen indított cégbe). Alap szerep: operátor — az
 * alapító marad az egyetlen admin, amíg szándékosan mást nem hív meg (#830 §7).
 */
export function TeamStep({ companyName }: { companyName: string }) {
  const t = useTranslations('Onboarding')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('operator')
  const [sent, setSent] = useState<{ email: string; mailed: boolean }[]>([])
  const [error, setError] = useState<string | null>(null)

  const finish = () => {
    // A gyökér dönt: első belépésnél a meglévő „kezdd el" (MCP) oldalra visz.
    router.replace('/control-plane')
    router.refresh()
  }

  const send = () => {
    const target = email.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(target)) {
      setError(t('errors.invalid_email'))
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await inviteUser({ email: target, role })
      if (!res.success) {
        setError(t('errors.generic'))
        return
      }
      setSent((rows) => [...rows, { email: target, mailed: res.data.clerkInvited }])
      setEmail('')
    })
  }

  return (
    <OnboardingCard eyebrow={t('teamEyebrow')} title={t('teamTitle')} body={t('teamBody', { company: companyName })}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="block text-sm font-medium text-ink-soft">
            {t('inviteEmail')}
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('inviteEmailPlaceholder')}
              className={inputClass}
            />
          </label>
          <div className="text-sm font-medium text-ink-soft">
            <label htmlFor="onboarding-invite-role">{t('inviteRoleLabel')}</label>
            <HelpHint>{t('inviteRoleHelp')}</HelpHint>
            <select
              id="onboarding-invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as InviteRole)}
              className={inputClass}
            >
              {INVITE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {t(`roles.${value}`)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <ErrorNotice message={error} />

        <button type="submit" disabled={pending || !email.trim()} className={secondaryButtonClass}>
          {pending ? t('sending') : t('sendInvite')}
        </button>
      </form>

      {sent.length > 0 && (
        <ul className="mt-5 space-y-1.5 rounded-xl border border-sage/30 bg-sage/10 p-3 text-sm text-sage">
          {sent.map((row) => (
            <li key={row.email}>
              ✓ {row.mailed ? t('inviteSent', { email: row.email }) : t('inviteCreated', { email: row.email })}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line/60 pt-5">
        <button type="button" disabled={pending} className={primaryButtonClass} onClick={finish}>
          {sent.length > 0 ? t('continue') : t('skip')}
        </button>
      </div>
    </OnboardingCard>
  )
}
