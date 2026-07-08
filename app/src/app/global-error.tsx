'use client'

/**
 * WP-7 (O4) — Gyökér-layout hibahatár.
 *
 * A gyökér `layout.tsx`-ben (vagy annak renderelésekor) dobott hibát kapja el;
 * mivel a layoutot váltja, saját `<html>/<body>`-t kell renderelnie és
 * importálnia a globális stílusokat. Strukturáltan jelent a WP-6 error-trackingbe.
 */
import { useEffect } from 'react'
import { captureException } from '@/lib/observability'
import './globals.css'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    captureException(error, { source: 'app-global-error-boundary', digest: error.digest ?? null })
  }, [error])

  return (
    <html lang="hu">
      <body>
        <div className="flex min-h-screen items-center justify-center bg-night px-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Kritikus hiba</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink">
              Az alkalmazás nem tölthető be
            </h2>
            <p className="mt-3 text-sm text-ink-soft">
              Váratlan hiba akadályozza a megjelenítést. Kérjük, próbálja újra.
            </p>
            <p className="mt-4 font-mono text-xs text-ink-faint">
              Hivatkozás: {error.digest ?? '—'}
            </p>
            <button
              onClick={reset}
              className="mt-6 rounded-lg bg-coral px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-coral-deep"
            >
              Újrapróbálkozás
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
