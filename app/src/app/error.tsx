'use client'

/**
 * WP-7 (O4) — App Router route-szintu hibahatár.
 *
 * A renderelés közben dobott hibát elkapja, strukturáltan jelenti a WP-6
 * error-trackingbe (a `digest` a szerver-oldali log-sorral korrelálható), és
 * kulturált, márka-illesztett UI-t ad `reset()`-tel újrapróbálkozáshoz.
 */
import { useEffect } from 'react'
import { CP_EMBED_READY_MESSAGE } from '@/lib/control-plane-embed-messages'
import { captureException } from '@/lib/observability'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    captureException(error, { source: 'app-error-boundary', digest: error.digest ?? null })
    // Modal-iframe: a szülő overlay addig nem tűnik el, amíg cp-embed-ready nem jön —
    // hiba esetén is jelezzünk, hogy a felhasználó lássa a hibaüzenetet, ne csak „Betöltés…”.
    if (window.parent !== window) {
      window.parent.postMessage(CP_EMBED_READY_MESSAGE, window.location.origin)
    }
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Hiba</p>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Valami félresiklott</h2>
        <p className="mt-3 text-sm text-ink-soft">
          Váratlan hiba történt. A hivatkozási azonosítót megadva a support gyorsabban tud segíteni.
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
  )
}
