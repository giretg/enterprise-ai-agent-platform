import type { Metadata } from 'next'
import { AuthProviders } from '@/components/auth/providers'
import { isClerkEnabled } from '@/lib/clerk-config'
import './globals.css'

export const metadata: Metadata = {
  title: 'Enterprise AI Agent Platform',
  description: 'Fázis 1 — Control Plane + Sandbox',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hu" suppressHydrationWarning>
      <body>
        <AuthProviders clerkEnabled={isClerkEnabled()}>{children}</AuthProviders>
      </body>
    </html>
  )
}
