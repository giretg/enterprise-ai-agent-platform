'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { AgentProductKind, AgentProductLink } from '@/lib/agent-product-links'

const ICON_PATHS: Record<AgentProductKind, ReactNode> = {
  miniApps: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
    </>
  ),
  knowledge: (
    <>
      <path d="M12 6.5C10.4 5.2 8 4.5 4.5 4.5v14c3.5 0 5.9.7 7.5 2 1.6-1.3 4-2 7.5-2v-14c-3.5 0-5.9.7-7.5 2Z" />
      <path d="M12 6.5v14" />
    </>
  ),
  workFiles: (
    <>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
      <path d="M13.5 3.5V9H19M8.5 13h7M8.5 16.5h7" />
    </>
  ),
  scheduledTasks: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
}

const TEXT = {
  miniApps: { label: 'miniApps', hint: 'miniAppsHint' },
  knowledge: { label: 'knowledge', hint: 'knowledgeHint' },
  workFiles: { label: 'workFiles', hint: 'workFilesHint' },
  scheduledTasks: { label: 'scheduledTasks', hint: 'scheduledTasksHint' },
} as const

/**
 * A kétoszlopos kártyán 1440 px-től fér ki biztosan négy felirat, az adatlapon és a chatben telefonon felül is.
 * Felirat nélkül a szám az ikon sarkába kerül, a név a súgóbuborékban és a képernyőolvasónak marad meg.
 */
const LAYOUTS = {
  card: {
    button: 'w-9 min-[1440px]:w-auto min-[1440px]:px-2',
    label: 'hidden min-[1440px]:inline',
    count: 'absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10px] font-semibold text-white min-[1440px]:static min-[1440px]:h-auto min-[1440px]:min-w-0 min-[1440px]:bg-transparent min-[1440px]:px-0 min-[1440px]:text-xs min-[1440px]:font-normal min-[1440px]:text-ink-faint',
  },
  wide: {
    button: 'w-9 sm:w-auto sm:px-3',
    label: 'hidden sm:inline',
    count: 'absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10px] font-semibold text-white sm:static sm:h-auto sm:min-w-0 sm:bg-transparent sm:px-0 sm:text-xs sm:font-normal sm:text-ink-faint',
  },
} as const

const BUTTON =
  'relative inline-flex h-9 items-center justify-center gap-1 rounded-full border border-line text-[13px] font-medium text-ink-soft transition-colors hover:border-ink/25 hover:bg-ink/[0.03] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/40'

type Layout = keyof typeof LAYOUTS

function ProductButtonContent({ link, layout }: { link: AgentProductLink; layout: Layout }) {
  const t = useTranslations('ControlPlane.agents.products')
  return (
    <>
      <svg aria-hidden viewBox="0 0 24 24" className="h-[17px] w-[17px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[link.kind]}
      </svg>
      <span className={LAYOUTS[layout].label}>{t(TEXT[link.kind].label)}</span>
      {link.count > 1 ? <span className={`tabular-nums ${LAYOUTS[layout].count}`}>{link.count}</span> : null}
    </>
  )
}

function Tooltip({ children }: { children: ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 w-max max-w-56 rounded-lg bg-ink px-2.5 py-1.5 text-left text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity delay-150 group-hover/product:opacity-100 group-focus-visible/product:opacity-100"
    >
      {children}
    </span>
  )
}

function ProductMenu({ link, layout, label }: { link: AgentProductLink; layout: Layout; label: string }) {
  const t = useTranslations('ControlPlane.agents.products')
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className={`group/product ${BUTTON} ${LAYOUTS[layout].button}`}
      >
        <ProductButtonContent link={link} layout={layout} />
        {open ? null : <Tooltip>{t(TEXT[link.kind].hint)}</Tooltip>}
      </button>
      {open ? (
        <div
          role="menu"
          className="z-30 rounded-2xl border border-line bg-card p-1.5 max-sm:fixed max-sm:inset-x-4 max-sm:bottom-4 sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-64 text-left shadow-[0_18px_40px_-20px_rgba(11,11,12,0.45)]"
        >
          {link.items.map((item) => (
            <Link key={item.href} role="menuitem" href={item.href} className="block truncate rounded-xl px-3 py-2 text-sm text-ink transition-colors hover:bg-ink/5" title={item.label}>
              {item.label}
            </Link>
          ))}
          {link.count > link.items.length ? (
            <Link role="menuitem" href={link.href} className="mt-1 block rounded-xl border-t border-line px-3 py-2 text-sm text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink">
              {t('showAll', { count: link.count })}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Csendes gombsor a munkatárs-dobozon: ahol az ember eléri, amit ez a munkatárs készített vagy használ. */
export function AgentProductLinks({
  agentName,
  links,
  layout = 'card',
  className = '',
}: {
  agentName: string
  links: AgentProductLink[] | undefined
  layout?: Layout
  className?: string
}) {
  const t = useTranslations('ControlPlane.agents.products')
  if (!links?.length) return null
  return (
    <div role="group" aria-label={t('aria', { name: agentName })} className={`flex flex-wrap items-center gap-1 ${className}`}>
      {links.map((link) => {
        const name = t(TEXT[link.kind].label)
        const label = link.count > 1 ? `${name}: ${agentName} (${link.count})` : `${name}: ${agentName}`
        if (link.items.length > 1) return <ProductMenu key={link.kind} link={link} layout={layout} label={label} />
        return (
          <Link
            key={link.kind}
            href={link.items[0]?.href ?? link.href}
            aria-label={label}
            className={`group/product ${BUTTON} ${LAYOUTS[layout].button}`}
          >
            <ProductButtonContent link={link} layout={layout} />
            <Tooltip>{t(TEXT[link.kind].hint)}</Tooltip>
          </Link>
        )
      })}
    </div>
  )
}
