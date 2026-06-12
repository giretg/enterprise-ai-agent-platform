'use client'

import { ClerkProvider } from '@clerk/nextjs'
import type { ReactNode } from 'react'

export function AuthProviders({ children }: { children: ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

  if (!publishableKey) {
    return children
  }

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/sign-in"
    >
      {children}
    </ClerkProvider>
  )
}
