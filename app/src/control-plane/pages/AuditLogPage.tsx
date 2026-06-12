import { useMemo, useState } from 'react'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'
import type { AuditEntry } from '../../shared/types'

type FilterActor = 'all' | 'human' | 'agent' | 'system'

export function AuditLogPage() {
  const { auditLog } = useDemo()
  const [filter, setFilter] = useState<FilterActor>('all')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    return auditLog.filter((entry) => {
      if (filter !== 'all' && entry.actorType !== filter) return false
      if (!search) return true
      const q = search.toLowerCase()
      return (
        entry.action.toLowerCase().includes(q) ||
        entry.resource.toLowerCase().includes(q) ||
        entry.actor.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q)
      )
    })
  }, [auditLog, filter, search])

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">Audit Log</h1>
          <p className="mt-1 text-sm text-slate-400">
            Append-only, tamper-evident napló — minden agent- és emberi művelet
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="success">Audited</Badge>
          <Badge variant="mono">hash-lánc aktív</Badge>
          <button
            type="button"
            className="rounded border border-slate-600 bg-slate-800 px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
            onClick={() =>
              alert('SIEM export — szimuláció (MVP mockup)')
            }
          >
            SIEM export ↓
          </button>
        </div>
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap gap-3">
          <input
            type="search"
            placeholder="Keresés: action, resource, actor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-[240px] flex-1 rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
          />
          <div className="flex gap-1">
            {(['all', 'human', 'agent', 'system'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded px-3 py-1.5 text-xs font-medium ${
                  filter === f
                    ? 'bg-slate-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {f === 'all' ? 'Mind' : f}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card title={`Bejegyzések (${filtered.length})`}>
        <div className="space-y-2">
          {filtered.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
          {filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-slate-500">
              Nincs találat
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const actorVariant =
    entry.actorType === 'human'
      ? 'info'
      : entry.actorType === 'agent'
        ? 'purple'
        : 'default'

  return (
    <div className="rounded border border-slate-700/50 bg-slate-900/40 px-4 py-3 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-500">{entry.id}</span>
        <span className="text-slate-400">
          {new Date(entry.timestamp).toLocaleString('hu-HU')}
        </span>
        <Badge variant={actorVariant}>{entry.actorType}</Badge>
      </div>
      <div className="mt-2 text-slate-300">
        <span className="text-slate-200">{entry.actor}</span>{' '}
        <span className="text-emerald-400">{entry.action}</span>{' '}
        <span className="text-slate-500">→ {entry.resource}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-slate-600">
        <span>
          prev: <span className="text-slate-500">{entry.previousHash}</span>
        </span>
        <span>
          hash: <span className="text-emerald-600/80">{entry.hash}</span>
        </span>
        {entry.agentVersion && (
          <span>agent v{entry.agentVersion}</span>
        )}
        {entry.model && <span>{entry.model}</span>}
      </div>
    </div>
  )
}
