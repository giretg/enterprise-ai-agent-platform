'use client'

/**
 * WP-7 (O4) — Gyökér-layout hibahatár.
 *
 * A gyökér `layout.tsx`-ben (vagy annak renderelésekor) dobott hibát kapja el;
 * mivel a layoutot váltja, saját `<html>/<body>`-t kell renderelnie és
 * importálnia a globális stílusokat. Strukturáltan jelent a WP-6 error-trackingbe.
 */
import { useEffect, useState } from 'react'
import { captureException } from '@/lib/observability'
import { LOCALE_COOKIE } from '@/i18n/locale-cookie'
import './globals.css'

const COPY = {
  hu: {
    kicker: 'Kritikus hiba',
    title: 'Az alkalmazás nem tölthető be',
    body: 'Váratlan hiba akadályozza a megjelenítést. Kérjük, próbálja újra.',
    ref: 'Hivatkozás',
    retry: 'Újrapróbálkozás',
  },
  en: {
    kicker: 'Critical error',
    title: 'The application could not load',
    body: 'An unexpected error is blocking the page. Please try again.',
    ref: 'Reference',
    retry: 'Try again',
  },
} as const

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [locale, setLocale] = useState<'hu' | 'en'>('hu')
  useEffect(() => {
    captureException(error, { source: 'app-global-error-boundary', digest: error.digest ?? null })
    const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=(hu|en)(?:;|$)`))
    if (match?.[1] === 'en' || match?.[1] === 'hu') setLocale(match[1])
  }, [error])
  const copy = COPY[locale]

  return (
    <html lang={locale}>
      <body>
        <div className="flex min-h-screen items-center justify-center bg-night px-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{copy.kicker}</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink">{copy.title}</h2>
            <p className="mt-3 text-sm text-ink-soft">{copy.body}</p>
            <p className="mt-4 font-mono text-xs text-ink-faint">
              {copy.ref}: {error.digest ?? '—'}
            </p>
            <button
              onClick={reset}
              className="mt-6 rounded-lg bg-coral px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-coral-deep"
            >
              {copy.retry}
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
