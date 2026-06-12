import { listAuditLog } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

export default async function AuditLogPage() {
  const res = await listAuditLog({ limit: 50 })
  const entries = res.success ? res.data : []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold">Audit Log</h1>
          <p className="mt-1 text-ink-soft">Append-only, perzisztált</p>
        </div>
        <Badge tone="warning">Hash-lánc: Fázis 2</Badge>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-ink-faint">
                <th className="pb-2 pr-4">Idő</th>
                <th className="pb-2 pr-4">Actor</th>
                <th className="pb-2 pr-4">Action</th>
                <th className="pb-2 pr-4">Target</th>
                <th className="pb-2">Modell</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-line/50">
                  <td className="py-2 pr-4 font-mono text-xs">
                    {new Date(entry.createdAt).toLocaleString('hu-HU')}
                  </td>
                  <td className="py-2 pr-4">{entry.actorType}</td>
                  <td className="py-2 pr-4">{entry.action}</td>
                  <td className="py-2 pr-4">
                    {entry.targetType}:{entry.inputRef}→{entry.outputRef}
                  </td>
                  <td className="py-2">{entry.modelUsed ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && (
            <p className="py-8 text-center text-ink-faint">Még nincs audit bejegyzés</p>
          )}
        </div>
      </Card>
    </div>
  )
}
