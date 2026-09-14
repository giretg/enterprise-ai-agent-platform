'use client'

import { ClerkProvider } from '@clerk/nextjs'
import { createContext, useContext, type ReactNode } from 'react'
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog'

const ClerkEnabledContext = createContext(false)

/** A root layout `isClerkEnabled()` döntése — AUTH_DISABLED mellett false. */
export function useClerkEnabled() {
  return useContext(ClerkEnabledContext)
}

export function AuthProviders({
  children,
  clerkEnabled = false,
}: {
  children: ReactNode
  /**
   * A szerver `isClerkEnabled()` döntése. AUTH_DISABLED / hiányzó titok esetén
   * a kliens NE mountolja a ClerkProvider-t — különben a publishable key
   * magában is a Clerk beléptetőre visz, és a DevAuth soha nem fut a böngészőben.
   */
  clerkEnabled?: boolean
}) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  const tree =
    clerkEnabled && publishableKey ? (
      <ClerkProvider
        publishableKey={publishableKey}
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
        signInFallbackRedirectUrl="/control-plane"
        signUpFallbackRedirectUrl="/control-plane"
        afterSignOutUrl="/"
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
