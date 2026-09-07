import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { AuthProviders } from '@/components/auth/providers'
import { isClerkClientEnabledForRequest } from '@/lib/control-plane-embed'
import './globals.css'

export const metadata: Metadata = {
  title: 'Enterprise AI Agent Platform',
  description: 'Fázis 1 — Control Plane + Sandbox',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const clerkEnabled = isClerkClientEnabledForRequest(await headers())

  return (
    <html lang="hu" suppressHydrationWarning>
      <body>
        <AuthProviders clerkEnabled={clerkEnabled}>{children}</AuthProviders>
      </body>
    </html>
  )
}
