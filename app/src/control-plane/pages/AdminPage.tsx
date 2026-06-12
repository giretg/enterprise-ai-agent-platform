import { useState } from 'react'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { ticketTypeConfigs } from '../../shared/mock-data'
import { TICKET_COLUMNS, type TicketTypeConfig } from '../../shared/types'

const statusLabels = Object.fromEntries(
  TICKET_COLUMNS.map((c) => [c.key, c.label]),
) as Record<string, string>

export function AdminPage() {
  const [selectedId, setSelectedId] = useState(ticketTypeConfigs[0]?.id ?? '')

  const selected = ticketTypeConfigs.find((c) => c.id === selectedId)

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">
            Admin paraméterezés
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Tickettípusok, állapotgép, jóváhagyási láncok — szerveroldali
            kikényszerítés
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="warning">Csak platform admin</Badge>
          <Badge variant="mono">szerveroldali validáció</Badge>
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-amber-900/40 bg-amber-950/20 px-4 py-3 text-xs text-amber-200/90">
        A control plane konfigurációja kizárólag a szállító (Excellence Pay)
        által módosítható élesben — itt a governance-modell vizualizációja.
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card title="Tickettípusok">
          <div className="space-y-1">
            {ticketTypeConfigs.map((config) => (
              <button
                key={config.id}
                type="button"
                onClick={() => setSelectedId(config.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  selectedId === config.id
                    ? 'bg-slate-600 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                <p className="font-medium">{config.label}</p>
                <p className="mt-0.5 text-xs opacity-70">{config.type}</p>
              </button>
            ))}
          </div>
        </Card>

        {selected && <TicketTypeDetail config={selected} />}
      </div>
    </div>
  )
}

function TicketTypeDetail({ config }: { config: TicketTypeConfig }) {
  return (
    <div className="space-y-4">
      <Card title={config.label}>
        <p className="text-sm text-slate-400">{config.description}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant="info">
            Alapértelmezett felelős: {config.defaultAssignee}
          </Badge>
          {config.writeGateRequired && (
            <Badge variant="purple">Write-gate kötelező</Badge>
          )}
        </div>
      </Card>

      <Card title="Engedélyezett állapotok">
        <div className="flex flex-wrap gap-2">
          {config.allowedStatuses.map((status) => (
            <Badge key={status} variant="mono">
              {statusLabels[status] ?? status}
            </Badge>
          ))}
        </div>
        <div className="mt-4 overflow-x-auto">
          <div className="flex min-w-max items-center gap-1">
            {config.allowedStatuses.map((status, i) => (
              <div key={status} className="flex items-center">
                <span className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                  {statusLabels[status]}
                </span>
                {i < config.allowedStatuses.length - 1 && (
                  <span className="mx-1 text-slate-600">→</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Állapotátmenetek (szerveroldali)">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase text-slate-500">
                <th className="pb-3 pr-4">Honnan</th>
                <th className="pb-3 pr-4">Hova</th>
                <th className="pb-3 pr-4">Ki</th>
                <th className="pb-3">Jóváhagyás</th>
              </tr>
            </thead>
            <tbody>
              {config.transitions.map((tr, i) => (
                <tr
                  key={`${tr.from}-${tr.to}-${i}`}
                  className="border-b border-slate-800/60"
                >
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">
                    {tr.from === '*' ? '*' : statusLabels[tr.from]}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-emerald-400">
                    {statusLabels[tr.to]}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {tr.allowedRoles.map((r) => (
                        <Badge key={r} variant="default">
                          {r}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="py-2">
                    {tr.requiresApproval ? (
                      <Badge variant="warning">Human-in-the-loop</Badge>
                    ) : (
                      <span className="text-xs text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Jóváhagyási lánc">
        <ol className="space-y-2">
          {config.approvalChain.map((step) => (
            <li
              key={step.order}
              className="flex items-center gap-3 rounded border border-slate-700/50 bg-slate-900/40 px-3 py-2"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-slate-200">
                {step.order}
              </span>
              <div>
                <p className="text-sm text-slate-200">{step.label}</p>
                <p className="text-xs text-slate-500">Szerep: {step.role}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}
