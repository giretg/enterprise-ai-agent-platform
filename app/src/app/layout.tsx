import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { AuthProviders } from '@/components/auth/providers'
import { defaultLocale, isAppLocale, type AppLocale } from '@/i18n/config'
import { isClerkClientEnabledForRequest } from '@/lib/control-plane-embed'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Excellence AI',
    template: '%s · Excellence AI',
  },
  description:
    "Excellence AI is a secure enterprise MCP server that connects your team's AI tools to company systems — with governed access, a full audit trail, and human approval.",
}

async function documentLocale(): Promise<AppLocale> {
  const fromHeader = (await headers()).get('x-next-intl-locale')
  if (fromHeader && isAppLocale(fromHeader)) return fromHeader
  try {
    const locale = await getLocale()
    return isAppLocale(locale) ? locale : defaultLocale
  } catch {
    return defaultLocale
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers()
  const clerkEnabled = isClerkClientEnabledForRequest(headerList)
  const locale = await documentLocale()
  const messages = await getMessages()

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AuthProviders clerkEnabled={clerkEnabled} locale={locale}>
            {children}
          </AuthProviders>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
