'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

export function SignupNoticeDialog() {
  const t = useTranslations('ControlPlane.signupNotice')
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!visible) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisible(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [visible])

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setVisible(false)
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="signup-notice-title"
        aria-describedby="signup-notice-body"
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/75 bg-card shadow-[0_24px_90px_-26px_rgba(7,14,33,0.52)]"
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-coral via-grape to-lime" />
          <button
            type="button"
            onClick={() => setVisible(false)}
            aria-label={t('close')}
            autoFocus
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full text-ink-faint transition hover:bg-night-2 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
        <div className="p-7 pt-9 sm:p-9 sm:pt-10">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-coral/10 text-coral">
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3 3.5 7v5c0 4.4 3.5 7.7 8.5 9 5-1.3 8.5-4.6 8.5-9V7L12 3Z" />
              <path d="M12 8v4m0 4h.01" />
            </svg>
          </span>
          <p className="mt-6 font-mono text-[11px] font-semibold uppercase tracking-[0.15em] text-coral">{t('eyebrow')}</p>
          <h2 id="signup-notice-title" className="mt-2 max-w-sm text-3xl font-bold leading-tight tracking-[-0.04em] text-ink">
            {t('title')}
          </h2>
          <p id="signup-notice-body" className="mt-4 text-[15px] leading-7 text-ink-soft">{t('body')}</p>
          <div className="mt-6 flex flex-col gap-3 rounded-xl border border-line bg-card-2 p-4 sm:flex-row sm:items-center">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-sage shadow-sm" aria-hidden>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16v12H4zM4 7l8 6 8-6" /></svg>
            </span>
            <p className="text-sm leading-relaxed text-ink-soft">{t('help')}</p>
          </div>
          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setVisible(false)}
              className="rounded-lg border border-line px-4 py-3 text-sm font-semibold text-ink-soft transition hover:bg-card-2 hover:text-ink"
            >
              {t('close')}
            </button>
            <Link
              href="/contact"
              className="signal-btn inline-flex items-center justify-center gap-2 rounded-lg border border-ink bg-ink px-5 py-3 text-sm font-semibold text-white [--sweep:var(--color-lime)] hover:text-ink"
            >
              {t('contact')}
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
