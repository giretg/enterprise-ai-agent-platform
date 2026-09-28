'use client'

import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs'
import { useTranslations } from 'next-intl'

const authButtonClass =
  'rounded-full border border-line bg-card px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep'

export function ShellAuth({ clerkEnabled }: { clerkEnabled: boolean }) {
  const t = useTranslations('Auth')
  if (!clerkEnabled) {
    return (
      <span className="rounded-full border border-honey/30 bg-honey/10 px-3 py-1.5 text-xs font-medium text-honey">
        {t('devAuth')}
      </span>
    )
  }

  return (
    <>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button type="button" className={authButtonClass}>
            {t('signIn')}
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button
            type="button"
            className={`${authButtonClass} border-coral/30 bg-coral/10 text-coral-deep hover:border-coral/50`}
          >
            {t('signUp')}
          </button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <UserButton
          appearance={{
            elements: {
              avatarBox: 'h-9 w-9',
            },
          }}
        />
      </Show>
    </>
  )
}
