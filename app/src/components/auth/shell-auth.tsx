'use client'

import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs'

const authButtonClass =
  'rounded-full border border-white/12 bg-white/5 px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-ink'

export function ShellAuth({ clerkEnabled }: { clerkEnabled: boolean }) {
  if (!clerkEnabled) {
    return (
      <span className="rounded-full border border-honey/30 bg-honey/10 px-3 py-1.5 text-xs font-medium text-honey">
        Dev auth
      </span>
    )
  }

  return (
    <>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button type="button" className={authButtonClass}>
            Bejelentkezés
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button
            type="button"
            className={`${authButtonClass} border-coral/30 bg-coral/10 text-ink hover:border-coral/50`}
          >
            Regisztráció
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
