import { isClerkEnabled, isDevAuthAllowed } from '@/lib/clerk-config'
import { ClerkAuthProvider } from './clerk-provider'
import { DevAuthProvider } from './dev-provider'
import type { AuthProvider } from './types'

let provider: AuthProvider | null = null

function assertAuthConfigured(): void {
  if (isClerkEnabled()) return
  if (isDevAuthAllowed()) return
  throw new Error(
    'Clerk authentication is required in production. Set CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.',
  )
}

export function getAuthProvider(): AuthProvider {
  if (provider) return provider

  assertAuthConfigured()
  provider = isClerkEnabled() ? new ClerkAuthProvider() : new DevAuthProvider()
  return provider
}

export async function getCurrentUser() {
  return getAuthProvider().getCurrentUser()
}

export async function requireRole(minimum: Parameters<AuthProvider['requireRole']>[0]) {
  return getAuthProvider().requireRole(minimum)
}
