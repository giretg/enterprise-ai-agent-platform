import type { ReactNode } from 'react'

/**
 * Katalógus / provisioning oldalak megnyitása új böngészőablakban, hogy a
 * varázsló vagy a szerkesztő űrlap ne vesszen el (pl. közben új skill / kapcsolat).
 */
export function OpenInNewWindowLink({
  href,
  children,
  className = 'inline-flex items-center gap-1 font-medium text-coral hover:text-coral-deep',
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span aria-hidden className="text-[0.75em]">
        ↗
      </span>
    </a>
  )
}
