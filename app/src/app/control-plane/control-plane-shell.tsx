'use client'

import { useSyncExternalStore, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AppShell, type NavEntry } from '@/components/ui/shell'
import { LocaleSwitcher } from '@/components/public-site/locale-switcher'
import { TenantSwitcher } from '@/components/tenant/tenant-switcher'
import { ControlPlaneEmbedBridge } from '@/lib/control-plane-embed-bridge'

function subscribeNever() {
  return () => {}
}

function readInIframe() {
  return window.parent !== window
}

function readClientMounted() {
  return true
}

/** Embed iframe (régi /embed/control-plane rewrite) soha ne kapjon teljes shellt. */
export function ControlPlaneRoot({
  embedFromServer,
  navItems = [],
  chatAvailable = false,
  children,
}: {
  embedFromServer: boolean
  navItems?: NavEntry[]
  /** #1004: a Chat gomb csak bekapcsolt tenantnál és elérhető munkatárssal látszik. */
  chatAvailable?: boolean
  canCreateAgent?: boolean
  children: ReactNode
}) {
  const hydrated = useSyncExternalStore(subscribeNever, readClientMounted, () => false)

  // A szerver csak fejlécből tud embedet — preview/iframe-ben a kliens is látja.
  // Hydration előtt ne váltsunk ágakat, különben Shell ↔ EmbedBridge fiber újrahasználat
  // → „Rendered more hooks than during the previous render”.
  const inIframeLive = useSyncExternalStore(subscribeNever, readInIframe, () => false)
  const embed = embedFromServer || (hydrated && inIframeLive)

  if (embed) {
    return (
      <ControlPlaneEmbedBridge key="embed">
        <div className="min-h-full bg-night px-4 py-6 text-ink sm:px-6">{children}</div>
      </ControlPlaneEmbedBridge>
    )
  }
  return (
    <ControlPlaneShell key="shell" navItems={navItems} chatAvailable={chatAvailable}>
      {children}
    </ControlPlaneShell>
  )
}

export function ControlPlaneShell({
  navItems,
  chatAvailable = false,
  children,
}: {
  navItems: NavEntry[]
  chatAvailable?: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const t = useTranslations('ControlPlane.shell')
  // TenantSwitcher useRouter()-t hív — loading.tsx + RSC redirect közben ez Router hook-hibát dob.
  const headerReady = useSyncExternalStore(subscribeNever, readClientMounted, () => false)

  return (
    <AppShell
      appName={t('appName')}
      appSubtitle={t('appSubtitle')}
      navItems={navItems}
      accentColor="slate"
      pathname={pathname}
      headerExtra={
        headerReady ? (
          <div className="flex items-center gap-1.5 sm:gap-2">
            {chatAvailable ? (
              <Link
                href="/control-plane/chat"
                title="Beszélgetés a munkatársakkal itt a platformon"
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  pathname?.startsWith('/control-plane/chat')
                    ? 'bg-coral text-white'
                    : 'border border-line bg-panel text-ink hover:border-coral/50'
                }`}
              >
                Chat
              </Link>
            ) : null}
            <LocaleSwitcher />
            <TenantSwitcher />
          </div>
        ) : null
      }
    >
      {children}
    </AppShell>
  )
}
