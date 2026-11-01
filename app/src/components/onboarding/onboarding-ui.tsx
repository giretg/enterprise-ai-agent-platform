'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useClerkEnabled } from '@/components/auth/providers'
import { ShellAuth } from '@/components/auth/shell-auth'

export const ONBOARDING_STEPS = ['account', 'company', 'team', 'start'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export const inputClass =
  'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-coral/60 focus:outline-none'
export const primaryButtonClass =
  'rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(43,80,255,0.6)] transition-opacity disabled:opacity-50'
export const secondaryButtonClass =
  'rounded-full border border-line bg-card px-5 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep disabled:opacity-50'

/** Fiók-menü (kijelentkezés) a varázsló fejlécében. */
export function OnboardingAccountButton() {
  const clerkEnabled = useClerkEnabled()
  return <ShellAuth clerkEnabled={clerkEnabled} />
}

/** 1. fiók → 2. cég → 3. munkatársak → 4. kezdés; a kész lépések pipát kapnak. */
export function OnboardingStepper({ current }: { current: OnboardingStep }) {
  const t = useTranslations('Onboarding')
  const currentIndex = ONBOARDING_STEPS.indexOf(current)
  return (
    <ol aria-label={t('stepsAria')} className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs font-semibold">
      {ONBOARDING_STEPS.map((step, index) => {
        const done = index < currentIndex
        const active = index === currentIndex
        return (
          <li key={step} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${
                done
                  ? 'border-sage/40 bg-sage/15 text-sage'
                  : active
                    ? 'border-coral bg-coral text-card'
                    : 'border-line text-ink-faint'
              }`}
            >
              {done ? '✓' : index + 1}
            </span>
            <span className={active ? 'text-ink' : 'text-ink-faint'}>{t(`steps.${step}`)}</span>
            {index < ONBOARDING_STEPS.length - 1 && <span aria-hidden className="text-ink-faint">›</span>}
          </li>
        )
      })}
    </ol>
  )
}

/** Kerek `?` gomb, kattintásra/hoverre rövid magyarázattal (üzleti nyelven). */
export function HelpHint({ children }: { children: ReactNode }) {
  const t = useTranslations('Onboarding')
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={t('help')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="ml-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-line text-[10px] font-bold text-ink-faint hover:border-coral/50 hover:text-coral-deep"
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-6 top-1/2 z-20 w-64 -translate-y-1/2 rounded-lg border border-line bg-card p-2.5 text-xs font-normal leading-relaxed text-ink-soft shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  )
}

export function OnboardingCard({
  eyebrow,
  title,
  body,
  children,
}: {
  eyebrow: string
  title: string
  body?: string
  children?: ReactNode
}) {
  return (
    <section className="atelier-card p-5 sm:p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-coral">{eyebrow}</p>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      {body && <p className="mt-2 text-sm leading-relaxed text-ink-soft">{body}</p>}
      {children && <div className="mt-6">{children}</div>}
    </section>
  )
}

export function ErrorNotice({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="rounded-lg border border-coral/35 bg-coral/10 p-3 text-sm text-coral-deep">
      {message}
    </p>
  )
}
