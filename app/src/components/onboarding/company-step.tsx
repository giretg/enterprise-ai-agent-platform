'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { acceptOnboardingInvitation, createSelfServiceTenant } from '@/app/actions/onboarding'
import { onboardingErrorKey } from '@/lib/onboarding-errors'
import {
  ErrorNotice,
  HelpHint,
  OnboardingCard,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './onboarding-ui'

export type PendingInvitationView = {
  id: string
  companyName: string
  role: 'admin' | 'approver' | 'operator' | 'viewer'
}

const linkClass = 'font-semibold text-coral-deep underline-offset-2 hover:underline'

/**
 * 2. lépés: cégadatok + ÁSZF. Ha a user e-mailjére függő meghívó van (#830 D8),
 * előbb a csatlakozást ajánljuk fel; a saját cég a másodlagos választás.
 */
export function CompanyStep({
  email,
  hasWorkspace,
  invitations,
  cap,
  canCreate,
}: {
  email: string
  /** Van már legalább egy cége (a váltóból „Új cég" érkezett). */
  hasWorkspace: boolean
  invitations: PendingInvitationView[]
  cap: number
  canCreate: boolean
}) {
  const t = useTranslations('Onboarding')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<'choose' | 'company'>(invitations.length > 0 ? 'choose' : 'company')
  const [displayName, setDisplayName] = useState('')
  const [legalName, setLegalName] = useState('')
  const [taxId, setTaxId] = useState('')
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joiningId, setJoiningId] = useState<string | null>(null)

  const showError = (raw: string) => setError(t(`errors.${onboardingErrorKey(raw)}`, { cap }))

  if (mode === 'choose') {
    const single = invitations.length === 1 ? invitations[0] : null
    return (
      <OnboardingCard
        eyebrow={t('inviteChoiceEyebrow')}
        title={single ? t('inviteChoiceTitle', { company: single.companyName }) : t('inviteChoiceTitleMany')}
        body={t('inviteChoiceBody', { email })}
      >
        <div className="space-y-3">
          {invitations.map((invitation) => (
            <div
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-night-2 p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{invitation.companyName}</p>
                <p className="text-xs text-ink-faint">
                  {t('inviteRole', { role: t(`roles.${invitation.role}`) })}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                className={primaryButtonClass}
                onClick={() => {
                  setError(null)
                  setJoiningId(invitation.id)
                  startTransition(async () => {
                    const res = await acceptOnboardingInvitation({ invitationId: invitation.id })
                    if (!res.success) return showError(res.error)
                    router.replace('/control-plane')
                    router.refresh()
                  })
                }}
              >
                {pending && joiningId === invitation.id ? t('joining') : t('joinCompany')}
              </button>
            </div>
          ))}
          <ErrorNotice message={error} />
          {canCreate && (
            <button
              type="button"
              disabled={pending}
              className={secondaryButtonClass}
              onClick={() => {
                setError(null)
                setMode('company')
              }}
            >
              {t('startOwnInstead')}
            </button>
          )}
        </div>
      </OnboardingCard>
    )
  }

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const res = await createSelfServiceTenant({
        displayName,
        legalName: legalName || undefined,
        taxId: taxId || undefined,
        termsAccepted,
      })
      if (!res.success) return showError(res.error)
      router.replace(`/onboarding?step=team&tenant=${res.data.tenantId}`)
      router.refresh()
    })
  }

  return (
    <OnboardingCard
      eyebrow={t('companyEyebrow')}
      title={hasWorkspace ? t('companyTitleAnother') : t('companyTitle')}
      body={t('companyBody')}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="block text-sm font-medium text-ink-soft">
          {t('displayName')}
          <input
            required
            autoFocus
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={t('displayNamePlaceholder')}
            className={inputClass}
          />
          <span className="mt-1 block text-xs font-normal text-ink-faint">{t('displayNameHint')}</span>
        </label>

        <label className="block text-sm font-medium text-ink-soft">
          {t('legalName')} <span className="font-normal text-ink-faint">({t('optional')})</span>
          <input
            maxLength={240}
            value={legalName}
            onChange={(event) => setLegalName(event.target.value)}
            placeholder={t('legalNamePlaceholder')}
            className={inputClass}
          />
        </label>

        <div className="text-sm font-medium text-ink-soft">
          <label htmlFor="onboarding-tax-id">
            {t('taxId')} <span className="font-normal text-ink-faint">({t('optional')})</span>
          </label>
          <HelpHint>{t('taxIdHelp')}</HelpHint>
          <input
            id="onboarding-tax-id"
            maxLength={32}
            value={taxId}
            onChange={(event) => setTaxId(event.target.value)}
            placeholder={t('taxIdPlaceholder')}
            className={inputClass}
          />
        </div>

        <label className="flex items-start gap-2.5 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={termsAccepted}
            onChange={(event) => setTermsAccepted(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-coral"
          />
          <span>
            {t.rich('terms', {
              gtc: (chunks) => (
                <a href="/gtc" target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {chunks}
                </a>
              ),
              privacy: (chunks) => (
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {chunks}
                </a>
              ),
            })}
          </span>
        </label>

        <ErrorNotice message={error} />

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={pending || !displayName.trim() || !termsAccepted}
            className={primaryButtonClass}
          >
            {pending ? t('submitting') : t('submit')}
          </button>
          {invitations.length > 0 && (
            <button type="button" disabled={pending} className={secondaryButtonClass} onClick={() => setMode('choose')}>
              ← {t('inviteChoiceEyebrow')}
            </button>
          )}
        </div>
      </form>
    </OnboardingCard>
  )
}
