import { listAuditLog } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { AuditChainPanel } from './audit-chain-panel'

const policyBadge = (decision: string | null) => {
  if (!decision) return <span className="text-ink-faint">—</span>
  const tone =
    decision === 'allowed' || decision === 'write_gate_consumed' || decision === 'rollback' || decision.startsWith('eval_override')
      ? 'bg-sage/15 text-sage'
      : decision.startsWith('denied') || decision === 'blocked'
        ? 'bg-coral/15 text-coral-deep'
        : 'bg-honey/15 text-honey'
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {decision}
    </span>
  )
}

export default async function AuditLogPage() {
  const res = await listAuditLog({ limit: 100 })
  const entries = res.success ? res.data : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Audit log</h1>
          <p className="mt-1 text-ink-soft">Append-only, hash-láncolt</p>
        </div>
        <Badge tone="success">Hash-lánc: aktív</Badge>
      </div>

      <AuditChainPanel />

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-ink-faint">
                <th className="pb-2 pr-4 text-xs">Idő</th>
                <th className="pb-2 pr-4 text-xs">Actor</th>
                <th className="pb-2 pr-4 text-xs">Action</th>
                <th className="pb-2 pr-4 text-xs">Target</th>
                <th className="pb-2 pr-4 text-xs">Policy</th>
                <th className="pb-2 text-xs">Hash</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-line/50 hover:bg-card/50">
                  <td className="py-2 pr-4 font-mono text-[11px] text-ink-soft">
                    {new Date(entry.createdAt).toLocaleString('hu-HU')}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="text-xs">{entry.actorType}</span>
                    {entry.actorId && (
                      <span className="ml-1 font-mono text-[10px] text-ink-faint">
                        {entry.actorId.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{entry.action}</td>
                  <td className="py-2 pr-4 text-xs text-ink-soft">
                    {entry.targetType}
                    {entry.targetId && (
                      <span className="ml-1 font-mono text-[10px] text-ink-faint">
                        {entry.targetId.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4">{policyBadge(entry.policyDecision)}</td>
                  <td className="py-2">
                    {entry.hash ? (
                      <span
                        className="cursor-default font-mono text-[10px] text-ink-faint"
                        title={entry.hash}
                      >
                        {entry.hash.slice(0, 12)}…
                      </span>
                    ) : (
                      <span className="text-[10px] text-coral/60">—</span>
                    )}
                  </td>
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
