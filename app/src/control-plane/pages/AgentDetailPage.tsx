import { Link, useParams } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'

const resourceTypeLabels = {
  policy: 'Policy',
  secret: 'Secret',
  file: 'File',
  connector: 'Connector',
  tool: 'Tool',
} as const

export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const { getAgentDetail, rollbackMemory } = useDemo()

  const agent = agentId ? getAgentDetail(agentId) : undefined

  if (!agent) {
    return (
      <div className="text-center">
        <p className="text-slate-400">Agent nem található</p>
        <Link
          to="/control-plane/agents"
          className="mt-4 inline-block text-sky-400"
        >
          ← Registry
        </Link>
      </div>
    )
  }

  const activeMemory = agent.memoryVersions.find((m) => m.isActive)
  const rollbackCandidates = agent.memoryVersions.filter((m) => !m.isActive)

  return (
    <div>
      <Link
        to="/control-plane/agents"
        className="mb-4 inline-block text-sm text-slate-400 hover:text-slate-200"
      >
        ← Agent Registry
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap gap-2">
            <Badge variant="mono">{agent.id}</Badge>
            <Badge variant="mono">v{agent.version}</Badge>
            <Badge variant={agent.status === 'active' ? 'success' : 'warning'}>
              {agent.status}
            </Badge>
            <Badge variant="info">{agent.lifecycle}</Badge>
          </div>
          <h1 className="text-2xl font-semibold text-slate-50">{agent.name}</h1>
          <p className="mt-1 text-sm text-slate-400">{agent.role}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Identitás (service account)">
          <dl className="space-y-2 text-sm">
            <Row label="Service account" value={agent.serviceAccount} mono />
            <Row label="API-kulcs" value={agent.apiKeyPreview} mono />
          </dl>
          <div className="mt-4 flex flex-wrap gap-1">
            {agent.permissions.map((p) => (
              <Badge key={p} variant="mono">
                {p}
              </Badge>
            ))}
          </div>
        </Card>

        <Card title="Modell-konfiguráció (Model Gateway)">
          <dl className="space-y-2 text-sm">
            <Row label="Provider" value={agent.modelConfig.provider} />
            <Row label="Modell" value={agent.modelConfig.model} mono />
            <Row label="Temperature" value={String(agent.modelConfig.temperature)} />
            <Row label="Max tokens" value={String(agent.modelConfig.maxTokens)} />
          </dl>
          <div className="mt-4 flex flex-wrap gap-1">
            {agent.modelConfig.guardrails.map((g) => (
              <Badge key={g} variant="purple">
                {g}
              </Badge>
            ))}
          </div>
        </Card>

        <Card title="Alapprompt (system prompt)" className="lg:col-span-2">
          <pre className="whitespace-pre-wrap rounded border border-slate-700/60 bg-slate-900/60 p-4 font-mono text-xs leading-relaxed text-slate-300">
            {agent.systemPrompt}
          </pre>
        </Card>

        <Card
          title="Memória (verziózott, write-gate-elt)"
          className="lg:col-span-2"
          action={
            activeMemory && (
              <Badge variant="success">Aktív: v{activeMemory.version}</Badge>
            )
          }
        >
          <div className="space-y-4">
            {agent.memoryVersions.map((mem) => (
              <div
                key={mem.id}
                className={`rounded-lg border p-4 ${
                  mem.isActive
                    ? 'border-emerald-800/50 bg-emerald-950/20'
                    : 'border-slate-700/50 bg-slate-900/40'
                }`}
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="mono">v{mem.version}</Badge>
                    <span className="text-sm font-medium text-slate-200">
                      {mem.label}
                    </span>
                    {mem.isActive && <Badge variant="success">aktív</Badge>}
                  </div>
                  {!mem.isActive && (
                    <button
                      type="button"
                      onClick={() => rollbackMemory(agent.id, mem.id)}
                      className="rounded border border-amber-700/60 bg-amber-950/30 px-3 py-1 text-xs font-medium text-amber-200 hover:bg-amber-950/50"
                    >
                      ↩ Rollback ide
                    </button>
                  )}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs text-slate-400">
                  {mem.content}
                </pre>
                <p className="mt-2 text-xs text-slate-600">
                  {new Date(mem.createdAt).toLocaleString('hu-HU')}
                </p>
              </div>
            ))}
          </div>
          {rollbackCandidates.length > 0 && (
            <p className="mt-4 text-xs text-amber-300/70">
              A Rollback gomb visszaállítja az agent memóriáját egy korábbi
              verzióra — minden lépés auditálva.
            </p>
          )}
        </Card>

        <Card title="Hozzárendelt erőforrások">
          {agent.resources.length === 0 ? (
            <p className="text-sm text-slate-500">Nincs erőforrás</p>
          ) : (
            <ul className="space-y-2">
              {agent.resources.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between rounded border border-slate-700/50 px-3 py-2"
                >
                  <div>
                    <p className="text-sm text-slate-200">{r.name}</p>
                    <p className="text-xs text-slate-500">
                      {resourceTypeLabels[r.type]} · {r.scope}
                    </p>
                  </div>
                  <Badge variant="mono">v{r.version}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Eszközök / képességek">
          {agent.tools.length === 0 ? (
            <p className="text-sm text-slate-500">Nincs eszköz</p>
          ) : (
            <ul className="space-y-2">
              {agent.tools.map((t) => (
                <li
                  key={t.id}
                  className="rounded border border-slate-700/50 px-3 py-2"
                >
                  <p className="font-mono text-sm text-slate-200">{t.name}</p>
                  <p className="text-xs text-slate-500">{t.description}</p>
                  <Badge variant="mono" className="mt-1">
                    {t.scope}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
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
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`text-right ${mono ? 'font-mono text-xs text-slate-300' : 'text-slate-200'}`}
      >
        {value}
      </dd>
    </div>
  )
}
