import { Link, useParams } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { AgentAvatar } from '../../shared/components/AgentAvatar'
import { getPersona, humanStatus } from '../../shared/agent-persona'
import { useDemo } from '../../shared/context/DemoContext'

const resourceTypeLabels = {
  policy: 'Policy',
  secret: 'Secret',
  file: 'File',
  dataset: 'Dataset',
  connector: 'Connector',
  tool: 'Tool',
} as const

export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const { getAgentDetail, rollbackMemory } = useDemo()

  const agent = agentId ? getAgentDetail(agentId) : undefined

  if (!agent) {
    return (
      <div className="atelier-card mx-auto max-w-md p-10 text-center">
        <p className="text-4xl" aria-hidden>
          🕵️
        </p>
        <p className="mt-3 text-ink-soft">Ezt a munkatársat nem találom.</p>
        <Link
          to="/control-plane/agents"
          className="mt-4 inline-block font-medium text-honey hover:underline"
        >
          ← Vissza a csapathoz
        </Link>
      </div>
    )
  }

  const activeMemory = agent.memoryVersions.find((m) => m.isActive)
  const rollbackCandidates = agent.memoryVersions.filter((m) => !m.isActive)
  const persona = getPersona(agent)
  const mood = humanStatus(agent.status)

  return (
    <div>
      <Link
        to="/control-plane/agents"
        className="mb-5 inline-block text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Vissza a csapathoz
      </Link>

      {/* Persona hero */}
      <div className="rise-in atelier-card mb-7 flex flex-col gap-5 p-6 sm:flex-row sm:items-center">
        <AgentAvatar agent={agent} size="xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-3xl font-semibold text-ink">
              {persona.nickname}
            </h1>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
              style={{ background: `${mood.dot}1f`, color: mood.color }}
            >
              {mood.emoji} {mood.label}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            {agent.name} · {agent.role}
          </p>
          <p className="font-display mt-3 max-w-2xl text-lg italic text-ink">
            “{persona.greeting}”
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="info">{agent.lifecycle}</Badge>
            <Badge variant="mono">v{agent.version}</Badge>
            <Badge variant="mono">{agent.id}</Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="🪪 Személyazonosság">
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

        <Card title="🧠 Az agya (modell)">
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

        <Card title="💬 Ki ő? (alapprompt)" className="lg:col-span-2">
          <pre className="atelier-soft whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-ink-soft">
            {agent.systemPrompt}
          </pre>
        </Card>

        <Card
          title="📚 Amit megtanult (memória)"
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
                className={`rounded-2xl border p-4 ${
                  mem.isActive
                    ? 'border-sage/35 bg-sage/8'
                    : 'border-white/10 bg-white/[0.02]'
                }`}
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="mono">v{mem.version}</Badge>
                    <span className="text-sm font-medium text-ink">
                      {mem.label}
                    </span>
                    {mem.isActive && <Badge variant="success">✨ aktív</Badge>}
                  </div>
                  {!mem.isActive && (
                    <button
                      type="button"
                      onClick={() => rollbackMemory(agent.id, mem.id)}
                      className="rounded-full border border-honey/40 bg-honey/10 px-3 py-1 text-xs font-medium text-honey transition-colors hover:bg-honey/20"
                    >
                      ↩ Visszaállítás ide
                    </button>
                  )}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs text-ink-soft">
                  {mem.content}
                </pre>
                <p className="mt-2 text-xs text-ink-faint">
                  {new Date(mem.createdAt).toLocaleString('hu-HU')}
                </p>
              </div>
            ))}
          </div>
          {rollbackCandidates.length > 0 && (
            <p className="mt-4 text-xs text-honey/80">
              A visszaállítás egy korábbi emlékhez téríti vissza a munkatársat —
              minden lépés feljegyezve a naplóba.
            </p>
          )}
        </Card>

        <Card title="🔑 Amihez hozzáfér">
          {agent.resources.length === 0 ? (
            <p className="text-sm text-ink-faint">Egyelőre semmihez sincs hozzákötve.</p>
          ) : (
            <ul className="space-y-2">
              {agent.resources.map((r) => (
                <li
                  key={r.id}
                  className="atelier-soft flex items-center justify-between px-3 py-2"
                >
                  <div>
                    <p className="text-sm text-ink">{r.name}</p>
                    <p className="text-xs text-ink-faint">
                      {resourceTypeLabels[r.type]} · {r.scope}
                    </p>
                  </div>
                  <Badge variant="mono">v{r.version}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="🛠️ Amit tud (képességek)">
          {agent.tools.length === 0 ? (
            <p className="text-sm text-ink-faint">Még nincs külön eszköze.</p>
          ) : (
            <ul className="space-y-2">
              {agent.tools.map((t) => (
                <li key={t.id} className="atelier-soft px-3 py-2">
                  <p className="font-mono text-sm text-ink">{t.name}</p>
                  <p className="text-xs text-ink-faint">{t.description}</p>
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
      <dt className="text-ink-faint">{label}</dt>
      <dd
        className={`text-right ${mono ? 'font-mono text-xs text-ink-soft' : 'text-ink'}`}
      >
        {value}
      </dd>
    </div>
  )
}
