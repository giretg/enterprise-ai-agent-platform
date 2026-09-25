/**
 * WP-7 (O4) — 404 határ.
 *
 * A gyökér `layout.tsx`-en belül renderelodik (globális stílus elérheto),
 * ezért sima szerver-komponens. Nem hiba → nincs error-tracking.
 */
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

export default async function NotFound() {
  const t = await getTranslations('Errors')
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sage">{t('notFoundKicker')}</p>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink">{t('notFoundTitle')}</h2>
        <p className="mt-3 text-sm text-ink-soft">{t('notFoundBody')}</p>
        <Link
          href="/control-plane"
          className="mt-6 inline-block rounded-lg bg-coral px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-coral-deep"
        >
          {t('notFoundBack')}
        </Link>
      </div>
    </div>
  )
}
