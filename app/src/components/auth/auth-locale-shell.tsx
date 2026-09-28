'use client'

import Image from 'next/image'
import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { LocaleSwitcher } from '@/components/public-site/locale-switcher'

export function AuthLocaleShell({ children }: { children: ReactNode }) {
  const t = useTranslations('SignInShell')
  return (
    <div className="signal-grid flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <Image
            src="/excellence-ai-logo.png"
            alt="Excellence AI"
            width={40}
            height={40}
            className="h-9 w-9 rounded-xl object-cover"
          />
          <div>
            <p className="font-display text-lg font-semibold leading-none">Excellence AI</p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-ink-faint">{t('tagline')}</p>
          </div>
        </div>
        <LocaleSwitcher />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">{children}</div>
    </div>
  )
}
