import { Suspense } from 'react'
import { getAuthContext } from '@/auth/context'
import {
  listMyChannelLinks,
  listMyNotifications,
  listTenantChannelLinks,
} from '@/app/actions/channel-link'
import { TelegramLinkPanel } from '@/components/account/telegram-link-panel'
import { AdminChannelLinks } from '@/components/account/admin-channel-links'

/**
 * „Fiókom" — a felhasználó saját csatorna-kötései (Telegram feature-spec #70/#72, D12).
 * Itt látszik a kötött Telegram-fiók és az összekötés ideje, itt indul az összekötés
 * (figyelmeztetéssel) és a megszüntetése. Admin számára a szervezet kötéseit is listázza.
 */
export default async function AccountPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold text-ink">Fiókom</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Itt kötheted össze és bonthatod a Telegram-fiókodat, és itt látod a biztonsági
          értesítéseidet.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-ink-soft">Betöltés…</p>}>
        <AccountContent />
      </Suspense>
    </div>
  )
}

async function AccountContent() {
  const ctx = await getAuthContext()
  const isTenantAdmin = ctx?.kind === 'tenant' && ctx.activeTenantRole === 'admin'

  const [links, notifications, tenantLinks] = await Promise.all([
    listMyChannelLinks(),
    listMyNotifications(),
    isTenantAdmin ? listTenantChannelLinks() : Promise.resolve([]),
  ])

  return (
    <div className="space-y-8">
      <TelegramLinkPanel initialLinks={links} initialNotifications={notifications} />
      {isTenantAdmin && <AdminChannelLinks initialLinks={tenantLinks} />}
    </div>
  )
}
