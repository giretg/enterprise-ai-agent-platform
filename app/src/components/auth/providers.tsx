'use client'

import { ClerkProvider } from '@clerk/nextjs'
import { enUS, huHU } from '@clerk/localizations'
import { createContext, useContext, type ReactNode } from 'react'
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog'
import type { AppLocale } from '@/i18n/config'

const ClerkEnabledContext = createContext(false)

/** A root layout `isClerkEnabled()` döntése — AUTH_DISABLED mellett false. */
export function useClerkEnabled() {
  return useContext(ClerkEnabledContext)
}

export function AuthProviders({
  children,
  clerkEnabled = false,
  locale = 'hu',
}: {
  children: ReactNode
  /**
   * A szerver `isClerkEnabled()` döntése. AUTH_DISABLED / hiányzó titok esetén
   * a kliens NE mountolja a ClerkProvider-t — különben a publishable key
   * magában is a Clerk beléptetőre visz, és a DevAuth soha nem fut a böngészőben.
   */
  clerkEnabled?: boolean
  locale?: AppLocale
}) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  const tree =
    clerkEnabled && publishableKey ? (
      <ClerkProvider
        publishableKey={publishableKey}
        localization={locale === 'en' ? enUS : huHU}
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
        signInFallbackRedirectUrl="/control-plane"
        signUpFallbackRedirectUrl="/control-plane"
        afterSignOutUrl="/"
        appearance={{
          variables: {
            colorPrimary: '#0b0b0c',
            colorForeground: '#0b0b0c',
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
            borderRadius: '0.375rem',
          },
        }}
      >
        {children}
      </ClerkProvider>
    ) : (
      children
    )

  return (
    <ClerkEnabledContext.Provider value={clerkEnabled}>
      {tree}
      <ConfirmDialogHost />
    </ClerkEnabledContext.Provider>
  )
}
