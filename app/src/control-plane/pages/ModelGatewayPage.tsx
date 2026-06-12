import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'

export function ModelGatewayPage() {
  const {
    agentModelUsage,
    modelUsageByDay,
    guardrailViolations,
    agentDetails,
  } = useDemo()
  const [selectedAgentId, setSelectedAgentId] = useState(
    agentModelUsage[0]?.agentId ?? '',
  )

  const selected = agentModelUsage.find((a) => a.agentId === selectedAgentId)
  const maxTokens = Math.max(...modelUsageByDay.map((d) => d.tokens))

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-50">
          Model Gateway / Observability
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Modellabsztrakció agentenként — token, költség, guardrail-sértések
        </p>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <MiniStat label="Token ma (összes)" value="48 200" sub="≈ €12.40" />
        <MiniStat label="Guardrail sértés (7 nap)" value="2" sub="0 blokkoló ma" />
        <MiniStat label="Aktív modellek" value="3" sub="2 provider" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Modellválasztó agentenként">
          <div className="space-y-2">
            {agentModelUsage.map((usage) => (
              <button
                key={usage.agentId}
                type="button"
                onClick={() => setSelectedAgentId(usage.agentId)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  selectedAgentId === usage.agentId
                    ? 'border-sky-600 bg-sky-950/30'
                    : 'border-slate-700/50 hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-200">
                    {usage.agentName}
                  </span>
                  <Badge variant="mono">{usage.model}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Ma: {usage.tokensToday.toLocaleString('hu-HU')} token · €
                  {usage.costTodayEur.toFixed(2)}
                </p>
              </button>
            ))}
          </div>
          {selected && (
            <div className="mt-4 rounded border border-slate-700/50 bg-slate-900/40 p-3 text-sm">
              <p className="text-slate-400">Havi összesítés — {selected.agentName}</p>
              <p className="mt-1 text-slate-200">
                {selected.tokensMonth.toLocaleString('hu-HU')} token · €
                {selected.costMonthEur.toFixed(2)}
              </p>
              <Link
                to={`/control-plane/agents/${selected.agentId}`}
                className="mt-2 inline-block text-xs text-sky-400"
              >
                Agent anatómia →
              </Link>
            </div>
          )}
        </Card>

        <Card title="Token / költség (7 nap)">
          <div className="flex h-40 items-end gap-2">
            {modelUsageByDay.map((day) => (
              <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-sky-600/80"
                  style={{
                    height: `${(day.tokens / maxTokens) * 100}%`,
                    minHeight: 4,
                  }}
                  title={`${day.tokens} token · €${day.costEur}`}
                />
                <span className="text-[10px] text-slate-500">{day.date}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Szimulált grafikon — valódi Model Gateway naplózás nélkül
          </p>
        </Card>

        <Card title="Guardrail-sértések" className="lg:col-span-2">
          <div className="space-y-3">
            {guardrailViolations.map((v) => (
              <div
                key={v.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded border border-slate-700/50 px-4 py-3"
              >
                <div>
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={
                        v.severity === 'high'
                          ? 'danger'
                          : v.severity === 'medium'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {v.severity}
                    </Badge>
                    <Badge variant="mono">{v.rule}</Badge>
                    <span className="text-sm text-slate-300">{v.agentName}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{v.action}</p>
                </div>
                <span className="text-xs text-slate-600">
                  {new Date(v.timestamp).toLocaleString('hu-HU')}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Gateway konfiguráció (kiválasztott agent)" className="lg:col-span-2">
          {selectedAgentId && agentDetails[selectedAgentId] ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Row label="Provider" value={agentDetails[selectedAgentId].modelConfig.provider} />
              <Row label="Modell" value={agentDetails[selectedAgentId].modelConfig.model} mono />
              <Row
                label="Temperature"
                value={String(agentDetails[selectedAgentId].modelConfig.temperature)}
              />
              <Row
                label="Guardrails"
                value={agentDetails[selectedAgentId].modelConfig.guardrails.join(', ')}
              />
            </dl>
          ) : (
            <p className="text-sm text-slate-500">Válassz agentet</p>
          )}
        </Card>
      </div>
    </div>
  )
}

function MiniStat({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-800/60 pb-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-slate-300' : 'text-slate-200'}>
        {value}
      </dd>
    </div>
  )
}
