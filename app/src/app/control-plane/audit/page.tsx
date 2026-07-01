import Link from 'next/link'
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

const FILE_TOOL_PREFIXES = ['file_', 'xlsx_', 'docx_', 'pdf_'] as const

function isFileToolAction(action: string, inputRef: string | null): boolean {
  if (action !== 'tool.call' && action !== 'tool.call.denied') return false
  if (!inputRef) return false
  return FILE_TOOL_PREFIXES.some((prefix) => inputRef.startsWith(prefix))
}

function fileToolDetail(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null
  const meta = metadata as {
    argsMeta?: { path?: string; pattern?: string }
    resultMeta?: { bytesWritten?: number; cellsUpdated?: number; rowsAppended?: number }
  }
  const parts: string[] = []
  if (meta.argsMeta?.path) parts.push(`path: ${meta.argsMeta.path}`)
  if (meta.argsMeta?.pattern) parts.push(`pattern: ${meta.argsMeta.pattern}`)
  if (typeof meta.resultMeta?.bytesWritten === 'number') {
    parts.push(`${meta.resultMeta.bytesWritten} B`)
  }
  if (typeof meta.resultMeta?.cellsUpdated === 'number') {
    parts.push(`${meta.resultMeta.cellsUpdated} cell`)
  }
  if (typeof meta.resultMeta?.rowsAppended === 'number') {
    parts.push(`${meta.resultMeta.rowsAppended} sor`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    action?: string
    actorType?: 'human' | 'agent' | 'system'
    actorId?: string
    targetType?: string
    targetId?: string
    ticketId?: string
    conversationId?: string
    since?: string
  }>
}) {
  const { action, actorType, actorId, targetType, targetId, ticketId, conversationId, since } =
    await searchParams
  const isFiltered = Boolean(
    action || actorType || actorId || targetType || targetId || ticketId || conversationId || since,
  )
  const res = await listAuditLog({
    limit: 200,
    action,
    actorType,
    actorId,
    targetType,
    targetId,
    ticketId,
    conversationId,
    since: since ? new Date(since) : undefined,
  })
  const entries = res.success ? res.data : []
  const filterParts = [
    action ? `action=${action}` : null,
    actorType ? `actor=${actorType}` : null,
    actorId ? `actorId=${actorId.slice(0, 8)}…` : null,
    targetType ? `target=${targetType}` : null,
    targetId ? `targetId=${targetId.slice(0, 8)}…` : null,
    ticketId ? `ticket=${ticketId.slice(0, 8)}…` : null,
    conversationId ? `conversation=${conversationId.slice(0, 8)}…` : null,
    since ? `since=${since.slice(0, 10)}` : null,
  ].filter((part): part is string => part !== null)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Audit log</h1>
          <p className="mt-1 text-ink-soft">Append-only, hash-láncolt</p>
        </div>
        <div className="flex items-center gap-3">
          {isFiltered && (
            <div className="flex items-center gap-2 rounded-full border border-honey/30 bg-honey/10 px-3 py-1 text-xs text-honey">
              <span>Szűrés: {filterParts.join(' · ')}</span>
              <Link
                href="/control-plane/audit"
                className="font-bold hover:text-honey/70"
                title="Szűrő törlése"
              >
                ✕
              </Link>
            </div>
          )}
          <Badge tone="success">Hash-lánc: aktív</Badge>
        </div>
      </div>

      {!isFiltered && <AuditChainPanel />}

      <Card>
        <form className="mb-4 flex flex-wrap items-end gap-3 text-xs" action="/control-plane/audit">
          <label className="flex flex-col gap-1">
            <span className="text-ink-faint">Action</span>
            <input
              name="action"
              defaultValue={action ?? ''}
              placeholder="pl. ticket.transition"
              className="rounded border border-line bg-transparent px-2 py-1 font-mono text-[11px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-ink-faint">Actor típus</span>
            <select
              name="actorType"
              defaultValue={actorType ?? ''}
              className="rounded border border-line bg-transparent px-2 py-1"
            >
              <option value="">bármely</option>
              <option value="human">human</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-ink-faint">Actor ID</span>
            <input
              name="actorId"
              defaultValue={actorId ?? ''}
              className="rounded border border-line bg-transparent px-2 py-1 font-mono text-[11px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-ink-faint">Ticket ID</span>
            <input
              name="ticketId"
              defaultValue={ticketId ?? ''}
              className="rounded border border-line bg-transparent px-2 py-1 font-mono text-[11px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-ink-faint">Conversation ID</span>
            <input
              name="conversationId"
              defaultValue={conversationId ?? ''}
              className="rounded border border-line bg-transparent px-2 py-1 font-mono text-[11px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-ink-faint">Ettől</span>
            <input
              type="date"
              name="since"
              defaultValue={since?.slice(0, 10) ?? ''}
              className="rounded border border-line bg-transparent px-2 py-1"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-honey/15 px-3 py-1.5 font-medium text-honey hover:bg-honey/25"
          >
            Szűrés
          </button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-ink-faint">
                <th className="pb-2 pr-4 text-xs">Idő</th>
                <th className="pb-2 pr-4 text-xs">Actor</th>
                <th className="pb-2 pr-4 text-xs">Action</th>
                <th className="pb-2 pr-4 text-xs">Target</th>
                <th className="pb-2 pr-4 text-xs">Fájl / meta</th>
                <th className="pb-2 pr-4 text-xs">Policy</th>
                <th className="pb-2 text-xs">Hash</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const detail =
                  isFileToolAction(entry.action, entry.inputRef) ? fileToolDetail(entry.metadata) : null
                return (
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
                    <td className="py-2 pr-4 font-mono text-xs">
                      {entry.inputRef && isFileToolAction(entry.action, entry.inputRef)
                        ? entry.inputRef
                        : entry.action}
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-soft">
                      {entry.targetType}
                      {entry.targetId && (
                        <span className="ml-1 font-mono text-[10px] text-ink-faint">
                          {entry.targetId.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-xs text-ink-soft">{detail ?? '—'}</td>
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
                )
              })}
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
