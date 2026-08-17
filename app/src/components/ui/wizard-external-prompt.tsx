import { OpenInNewWindowLink } from '@/components/ui/open-in-new-window-link'

export type WizardExternalLink = {
  href: string
  label: string
  description: string
}

/** Új-ablakos kitérő: skill / kapcsolat / profil létrehozása a varázsló elvesztése nélkül. */
export function WizardExternalPrompt({
  links,
  onRefresh,
  refreshing = false,
}: {
  links: WizardExternalLink[]
  onRefresh?: () => void
  refreshing?: boolean
}) {
  if (links.length === 0) return null

  return (
    <div className="rounded-lg border border-line bg-night-2/40 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
        Közben eszedbe jutott valami?
      </p>
      <p className="mt-1 text-xs text-ink-faint">
        Új böngészőablakban nyílik — ez a varázsló itt marad. Ha ott létrehoztál
        valamit, frissítsd a listát.
      </p>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <OpenInNewWindowLink href={link.href}>{link.label}</OpenInNewWindowLink>
            <p className="text-xs text-ink-faint">{link.description}</p>
          </li>
        ))}
      </ul>
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="mt-3 rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:border-coral/40 hover:text-ink disabled:opacity-50"
        >
          {refreshing ? 'Frissítés…' : 'Lista frissítése'}
        </button>
      ) : null}
    </div>
  )
}
