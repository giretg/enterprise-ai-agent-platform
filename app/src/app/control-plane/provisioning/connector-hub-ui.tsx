'use client'

import { type ReactNode, useState } from 'react'
import { ConnectorTemplateIcon } from '@/components/account/provider-icon'

/**
 * A Kapcsolatok oldal egyszerű, lista-alapú építőkockái (alkalmazás-sor, szekció,
 * részlet-fejléc, kapcsoló, eszközlista). A logika a provisioning-panelben marad;
 * itt csak a megjelenés van, hogy minden nézet ugyanúgy nézzen ki.
 */

export function AppIcon({
  iconDataUrl,
  provider,
  size = 'md',
}: {
  iconDataUrl?: string | null
  provider: string
  size?: 'md' | 'lg'
}) {
  const box = size === 'lg' ? 'h-16 w-16 rounded-2xl' : 'h-11 w-11 rounded-xl'
  const img = size === 'lg' ? 'h-9 w-9' : 'h-6 w-6'
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden border border-ink/10 bg-white text-ink-soft ${box}`}
    >
      <ConnectorTemplateIcon iconDataUrl={iconDataUrl ?? undefined} provider={provider} className={img} />
    </span>
  )
}

const pillBase =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45'

export function PillButton({
  children,
  variant = 'soft',
  disabled,
  onClick,
  title,
}: {
  children: ReactNode
  variant?: 'primary' | 'soft' | 'danger' | 'success'
  disabled?: boolean
  onClick?: () => void
  title?: string
}) {
  const variants = {
    primary: 'bg-ink text-card hover:bg-ink/85',
    soft: 'bg-ink/[0.06] text-ink hover:bg-ink/[0.11]',
    danger: 'bg-coral/10 text-coral hover:bg-coral/18',
    success: 'bg-sage/12 text-sage hover:bg-sage/20',
  }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      className={`${pillBase} ${variants[variant]}`}
    >
      {children}
    </button>
  )
}

export function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
        active ? 'bg-ink text-card' : 'bg-ink/[0.06] text-ink hover:bg-ink/[0.11]'
      }`}
    >
      {children}
    </button>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-3 rounded-full border border-ink/12 bg-paper px-4 py-2.5 focus-within:border-ink/30">
      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-ink-soft" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-soft"
      />
    </label>
  )
}

export function HubSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-sm text-ink-soft">{hint}</p> : null}
      </div>
      <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">{children}</div>
    </section>
  )
}

export type RowTone = 'success' | 'warning' | 'danger' | 'neutral'

const toneText: Record<RowTone, string> = {
  success: 'text-sage',
  warning: 'text-honey',
  danger: 'text-coral',
  neutral: 'text-ink-soft',
}

/** Egy alkalmazás a listában: ikon, név, rövid állapot, jobb oldalt egy gomb. */
export function HubRow({
  icon,
  title,
  subtitle,
  subtitleTone = 'neutral',
  actionLabel,
  actionVariant = 'soft',
  onOpen,
}: {
  icon: ReactNode
  title: string
  subtitle?: string | null
  subtitleTone?: RowTone
  actionLabel: string
  actionVariant?: 'primary' | 'soft' | 'success'
  onOpen: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="group flex min-w-0 cursor-pointer items-center gap-4 rounded-2xl px-3 py-3 transition hover:bg-ink/[0.04] focus-visible:bg-ink/[0.05] focus-visible:outline-none"
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-ink">{title}</span>
        {subtitle ? (
          <span className={`mt-0.5 block truncate text-xs ${toneText[subtitleTone]}`}>{subtitle}</span>
        ) : null}
      </span>
      <PillButton variant={actionVariant} onClick={onOpen}>
        {actionLabel}
      </PillButton>
    </div>
  )
}

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="-ml-2 inline-flex items-center gap-1 rounded-full px-2 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-ink/[0.05] hover:text-ink"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path d="m15 5-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </button>
  )
}

export function DetailHeader({
  icon,
  title,
  status,
  statusTone = 'neutral',
  description,
  actions,
}: {
  icon: ReactNode
  title: string
  status?: string | null
  statusTone?: RowTone
  description?: string | null
  actions?: ReactNode
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        {icon}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-2xl font-semibold tracking-tight text-ink">{title}</h2>
          {status ? <p className={`mt-0.5 text-sm font-medium ${toneText[statusTone]}`}>{status}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {description ? <p className="max-w-3xl text-[15px] leading-relaxed text-ink-soft">{description}</p> : null}
    </div>
  )
}

/** Részlet-oldali blokk: kis szürke cím, alatta lekerekített keretes doboz. */
export function DetailSection({
  title,
  count,
  hint,
  children,
  flush = false,
}: {
  title: string
  count?: number
  hint?: string
  children: ReactNode
  flush?: boolean
}) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-sm font-medium text-ink-soft">
        {title}
        {typeof count === 'number' ? <span className="ml-1.5 text-ink-soft/70">{count}</span> : null}
      </h3>
      {hint ? <p className="px-1 text-xs text-ink-soft">{hint}</p> : null}
      <div className={`rounded-2xl border border-ink/10 bg-paper ${flush ? '' : 'p-4 sm:p-5'}`}>{children}</div>
    </section>
  )
}

export function InfoRows({ rows }: { rows: Array<{ label: string; value: ReactNode; title?: string }> }) {
  return (
    <dl className="divide-y divide-ink/[0.07]">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-6 px-4 py-3.5 sm:px-5" title={row.title}>
          <dt className="shrink-0 text-[15px] text-ink">{row.label}</dt>
          <dd className="min-w-0 text-right text-[15px] text-ink-soft">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange?: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled || !onChange}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:cursor-default ${
        checked ? 'bg-accent' : 'bg-ink/15'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  )
}

export type ToolItem = {
  key: string
  label: string
  detail?: string
  access?: 'read' | 'write'
  enabled: boolean
}

/**
 * „N közül M engedélyezve" lenyíló: az alkalmazás eszközei egy-egy sorban.
 * `onToggle` nélkül csak megjelenít (a kapcsolók ekkor az állapotot mutatják).
 */
export function ToolList({
  tools,
  summary,
  accessLabels,
  onToggle,
  defaultOpen = false,
  emptyText,
}: {
  tools: ToolItem[]
  summary: string
  accessLabels: { read: string; write: string }
  onToggle?: (key: string, next: boolean) => void
  defaultOpen?: boolean
  emptyText: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (tools.length === 0) {
    return <p className="rounded-2xl border border-ink/10 bg-paper px-5 py-4 text-sm text-ink-soft">{emptyText}</p>
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-ink/10 bg-paper">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-[15px] text-ink transition ${
          open ? 'bg-ink/[0.04]' : 'hover:bg-ink/[0.03]'
        }`}
      >
        <span>{summary}</span>
        <svg
          viewBox="0 0 24 24"
          className={`h-4 w-4 text-ink-soft transition ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden
        >
          <path d="m6 9.5 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul className="divide-y divide-ink/[0.07] border-t border-ink/[0.07]">
          {tools.map((tool) => (
            <li key={tool.key} className="flex items-center gap-4 px-5 py-3">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] text-ink">{tool.label}</span>
                  {tool.access === 'write' ? (
                    <span className="rounded-full bg-honey/15 px-2 py-0.5 text-[11px] font-semibold text-honey">
                      {accessLabels.write}
                    </span>
                  ) : null}
                </span>
                {tool.detail ? (
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-soft">{tool.detail}</span>
                ) : null}
              </span>
              <Toggle
                checked={tool.enabled}
                label={tool.label}
                onChange={onToggle ? (next) => onToggle(tool.key, next) : undefined}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Összecsukható „Haladó" doboz a technikai részleteknek. */
export function AdvancedDisclosure({
  title,
  hint,
  children,
  defaultOpen = false,
}: {
  title: string
  hint?: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details open={defaultOpen} className="group rounded-2xl border border-ink/10 bg-paper">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-[15px] text-ink [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block">{title}</span>
          {hint ? <span className="mt-0.5 block text-xs text-ink-soft">{hint}</span> : null}
        </span>
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-ink-soft transition group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden
        >
          <path d="m6 9.5 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="space-y-4 border-t border-ink/[0.07] px-5 py-4 text-sm">{children}</div>
    </details>
  )
}

/** Egymásra csúsztatott ikonok a „N csatlakoztatva" gombhoz. */
export function IconStack({ items }: { items: Array<{ key: string; iconDataUrl?: string | null; provider: string }> }) {
  return (
    <span className="flex -space-x-2">
      {items.slice(0, 4).map((item) => (
        <span
          key={item.key}
          className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg border-2 border-card bg-white"
        >
          <ConnectorTemplateIcon iconDataUrl={item.iconDataUrl ?? undefined} provider={item.provider} className="h-4 w-4" />
        </span>
      ))}
    </span>
  )
}
