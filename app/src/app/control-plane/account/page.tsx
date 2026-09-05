import { Suspense } from 'react'
import { listMyChannelLinks, listMyNotifications } from '@/app/actions/channel-link'
import { listMyChannelAgents } from '@/app/actions/channel-agents'
import { listConnectorsPanelContext } from '@/app/actions/connector-grants'
import { LinkedAccountsPanel } from '@/components/account/linked-accounts-panel'
import type {
  LinkedConnectorView,
  LinkedGrantView,
} from '@/components/account/connector-connection-card'

/**
 * Kapcsolt fiókok — a felhasználó saját csatorna-kötései és delegált connectorjai
 * (Telegram, Gmail, későbbi providerek) egy UI-logikán. A szervezeti admin-beállítások
 * a Rendszer oldalon élnek.
 */
export default async function LinkedAccountsPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold text-ink">Kapcsolt fiókok</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Itt kötöd össze és bontod a saját fiókjaidat. Az agent csak ezekkel, a te
          engedélyeddel járhat el.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-ink-soft">Betöltés…</p>}>
        <LinkedAccountsContent />
      </Suspense>
    </div>
  )
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

async function LinkedAccountsContent() {
  const [links, notifications, myAgents, connectorsRes] = await Promise.all([
    listMyChannelLinks(),
    listMyNotifications(),
    listMyChannelAgents(),
    listConnectorsPanelContext(),
  ])

  const connectors: LinkedConnectorView[] = connectorsRes.success
    ? connectorsRes.data.connectors.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        authMode: c.authMode,
        tenantId: c.tenantId,
        config: c.config,
        assignedAgentCount: connectorsRes.data.connectorUsage[c.id]?.assignedAgentCount ?? 0,
        capableAgentCount: connectorsRes.data.connectorUsage[c.id]?.capableAgentCount ?? 0,
        capableAgentDisplayNames:
          connectorsRes.data.connectorUsage[c.id]?.capableAgentDisplayNames ?? [],
      }))
    : []

  const grants: LinkedGrantView[] = connectorsRes.success
    ? connectorsRes.data.grants.map((g) => ({
        id: g.id,
        connectorId: g.connectorId,
        status: g.status,
        accountLabel: g.accountLabel,
        scopes: g.scopes,
        grantedAt: toIso(g.grantedAt),
        metadata: g.metadata,
      }))
    : []

  return (
    <div className="space-y-4">
      {!connectorsRes.success && (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
          {connectorsRes.error}
        </p>
      )}
      <LinkedAccountsPanel
        links={links}
        notifications={notifications}
        myAgents={myAgents}
        connectors={connectors}
        grants={grants}
        isAdmin={connectorsRes.success ? connectorsRes.data.isAdmin : false}
        drivePickerConfigured={
          connectorsRes.success ? connectorsRes.data.drivePickerConfigured : false
        }
      />
    </div>
  )
}
