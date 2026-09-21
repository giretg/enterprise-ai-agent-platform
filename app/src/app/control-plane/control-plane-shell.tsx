'use client'

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { AppShell, type NavEntry } from '@/components/ui/shell'
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
  children,
}: {
  embedFromServer: boolean
  navItems?: NavEntry[]
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
    <ControlPlaneShell key="shell" navItems={navItems}>
      {children}
    </ControlPlaneShell>
  )
}

export function ControlPlaneShell({
  navItems,
  children,
}: {
  navItems: NavEntry[]
  children: React.ReactNode
}) {
  const pathname = usePathname()
  // TenantSwitcher useRouter()-t hív — loading.tsx + RSC redirect közben ez Router hook-hibát dob.
  // useSyncExternalStore(getClientSnapshot=true) NEM ugyanaz: első kliens-renderen
  // azonnal true, tehát pont a belépés utáni soft-nav + redirect ablakban mountol.
  const [headerReady, setHeaderReady] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-paint gate; first client render must stay false
    setHeaderReady(true)
  }, [])

  return (
    <AppShell
      appName="E-AI"
      appSubtitle="Control Plane"
      navItems={navItems}
      accentColor="slate"
      pathname={pathname}
      headerExtra={headerReady ? <TenantSwitcher /> : null}
    >
      {children}
    </AppShell>
  )
}
