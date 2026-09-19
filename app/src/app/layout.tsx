import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getLocale } from 'next-intl/server'
import { AuthProviders } from '@/components/auth/providers'
import { defaultLocale, isAppLocale } from '@/i18n/config'
import { isClerkClientEnabledForRequest } from '@/lib/control-plane-embed'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Excellence AI',
    template: '%s · Excellence AI',
  },
  description:
    'Excellence AI is an enterprise MCP server. Company-managed agents, connectors, audit, and human approval — connected to any MCP-compatible AI.',
}

async function documentLocale(): Promise<string> {
  const fromHeader = (await headers()).get('x-next-intl-locale')
  if (fromHeader && isAppLocale(fromHeader)) return fromHeader
  try {
    return await getLocale()
  } catch {
    return defaultLocale
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers()
  const clerkEnabled = isClerkClientEnabledForRequest(headerList)
  const locale = await documentLocale()

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <AuthProviders clerkEnabled={clerkEnabled}>{children}</AuthProviders>
      </body>
    </html>
  )
}
