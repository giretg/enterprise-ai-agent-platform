import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { AuthProviders } from '@/components/auth/providers'
import { isClerkClientEnabledForRequest } from '@/lib/control-plane-embed'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Excellence AI',
    template: '%s · Excellence AI',
  },
  description:
    'Excellence AI is a governed enterprise AI coworker platform. Access-controlled agents, audit, and human approval.',
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
