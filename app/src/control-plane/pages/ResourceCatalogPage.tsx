import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'
import type { CatalogResource } from '../../shared/types'

type TypeFilter = 'all' | CatalogResource['type']

const typeLabels: Record<CatalogResource['type'], string> = {
  policy: 'Policy',
  secret: 'Secret',
  file: 'File',
  dataset: 'Dataset',
  connector: 'Connector',
  tool: 'Tool',
}

export function ResourceCatalogPage() {
  const { catalogResources, agentDetails } = useDemo()
  const [filter, setFilter] = useState<TypeFilter>('all')

  const filtered = useMemo(
    () =>
      catalogResources.filter((r) => filter === 'all' || r.type === filter),
    [catalogResources, filter],
  )

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">
            Erőforrás-katalógus
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Secret · Policy · File · Dataset · Connector · Tool — scope, verzió,
            kötött agentek
          </p>
        </div>
        <Link
          to="/control-plane/agents/new"
          className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
        >
          + Agent wizard
        </Link>
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap gap-1">
          {(['all', 'policy', 'secret', 'file', 'dataset', 'connector', 'tool'] as const).map(
            (f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded px-3 py-1.5 text-xs font-medium capitalize ${
                  filter === f
                    ? 'bg-slate-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {f === 'all' ? 'Mind' : typeLabels[f]}
              </button>
            ),
          )}
        </div>
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase text-slate-500">
                <th className="pb-3 pr-4">Név</th>
                <th className="pb-3 pr-4">Típus</th>
                <th className="pb-3 pr-4">Scope</th>
                <th className="pb-3 pr-4">Verzió</th>
                <th className="pb-3">Kötött agentek</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((res) => (
                <tr
                  key={res.id}
                  className="border-b border-slate-800/60 hover:bg-slate-800/30"
                >
                  <td className="py-3 pr-4">
                    <p className="font-medium text-slate-200">{res.name}</p>
                    <p className="text-xs text-slate-500">{res.description}</p>
                  </td>
                  <td className="py-3 pr-4">
                    <Badge variant="mono">{res.type}</Badge>
                  </td>
                  <td className="py-3 pr-4 text-slate-400">{res.scope}</td>
                  <td className="py-3 pr-4">
                    <Badge variant="mono">v{res.version}</Badge>
                  </td>
                  <td className="py-3">
                    <div className="flex flex-wrap gap-1">
                      {res.boundAgentIds.map((id) => (
                        <Link
                          key={id}
                          to={`/control-plane/agents/${id}`}
                          className="text-xs text-sky-400 hover:text-sky-300"
                        >
                          {agentDetails[id]?.name ?? id}
                        </Link>
                      ))}
                      {res.boundAgentIds.length === 0 && (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
