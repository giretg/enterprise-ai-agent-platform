'use client'

import type { ComponentProps } from 'react'
import { useTranslations } from 'next-intl'

const SIZE_CLASS = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
} as const

export type SpinnerSize = keyof typeof SIZE_CLASS

/** Egységes betöltés-jelző — egy helyen módosítható vizuál. */
export function Spinner({
  size = 'md',
  className = '',
  ...props
}: { size?: SpinnerSize } & ComponentProps<'svg'>) {
  return (
    <svg
      className={`animate-spin shrink-0 ${SIZE_CLASS[size]} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-hidden="true"
      {...props}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  )
}

/** Középre igazított betöltés-blokk (Suspense fallback, üres panel, stb.). */
export function LoadingState({
  label,
  size = 'md',
  className = '',
}: {
  label?: string
  size?: SpinnerSize
  className?: string
}) {
  const t = useTranslations('Common')
  const text = label ?? t('loading')
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${className}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <Spinner size={size} className="text-coral" />
      {text ? <p className="text-sm text-ink-soft">{text}</p> : null}
    </div>
  )
}

/** Abszolút kitöltő overlay — pl. modal iframe betöltéséhez. */
export function LoadingOverlay({
  label,
  size = 'lg',
}: {
  label?: string
  size?: SpinnerSize
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/80 backdrop-blur-[1px]">
      <LoadingState label={label} size={size} className="py-0" />
    </div>
  )
}
