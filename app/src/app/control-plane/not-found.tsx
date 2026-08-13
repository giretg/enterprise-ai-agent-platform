/**
 * A control-plane szegmens saját 404-e. A layout (fejléc + tenant-váltó) megmarad —
 * a gyökér `not-found.tsx` leszedné a héjat, és a felhasználó bent ragadna.
 */
import Link from 'next/link'

export default function ControlPlaneNotFound() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sage">404</p>
        <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Ez az oldal nincs meg</h2>
        <p className="mt-3 text-sm text-ink-soft">
          A keresett oldal nem létezik, vagy ehhez a tenanthoz nincs hozzáférésed. A fejlécben
          válthatsz tenantot, vagy menj vissza a vezérlőpultra.
        </p>
        <Link
          href="/control-plane"
          className="mt-6 inline-block rounded-lg bg-coral px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-coral-deep"
        >
          Vissza a vezérlőpultra
        </Link>
      </div>
    </div>
  )
}
