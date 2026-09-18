import { listConnectorsPanelContext } from '@/app/actions/connector-grants'
import { Card } from '@/components/ui/shell'

export default async function LinkedAccountsPage() {
  const connectorsRes = await listConnectorsPanelContext()
  const connectors = connectorsRes.success ? connectorsRes.data.connectors : []
  const grants = connectorsRes.success ? connectorsRes.data.grants : []

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold text-ink">Kapcsolt fiókok</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Delegált Google Drive (és későbbi) kötések. A Telegram-csatorna kikerült.
        </p>
      </header>
      <Card title="Konnektorok">
        <ul className="divide-y divide-line/70">
          {connectors.map((connector) => (
            <li key={connector.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium">{connector.name}</span>
              <span className="text-ink-soft">{String(connector.type)}</span>
            </li>
          ))}
        </ul>
        {connectors.length === 0 ? (
          <p className="text-sm text-ink-soft">Nincs megjeleníthető konnektor.</p>
        ) : null}
        <p className="mt-3 text-xs text-ink-faint">{grants.length} grant</p>
      </Card>
    </div>
  )
}
