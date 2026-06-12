import { SignInButton, SignUpButton, useAuth } from '@clerk/react'
import { Outlet } from 'react-router-dom'

const authButtonClass =
  'rounded-full border border-white/12 bg-white/5 px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-ink'

export function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth()

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-soft">
        Betöltés…
      </div>
    )
  }

  if (!isSignedIn) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-5 text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">Excellence AI</h1>
        <p className="max-w-md text-ink-soft">Jelentkezz be a platform használatához.</p>
        <div className="flex gap-3">
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
        </div>
      </div>
    )
  }

  return <Outlet />
}
