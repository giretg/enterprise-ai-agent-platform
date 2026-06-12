import { Link } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'

export function AgentRegistryPage() {
  const { agentDetails } = useDemo()
  const agentList = Object.values(agentDetails)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-50">Agent Registry</h1>
        <p className="mt-1 text-sm text-slate-400">
          Regisztrált AI-munkatársak — identitás, modell, verzió, életciklus
        </p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase text-slate-500">
                <th className="pb-3 pr-4">Név</th>
                <th className="pb-3 pr-4">Szerep</th>
                <th className="pb-3 pr-4">Modell</th>
                <th className="pb-3 pr-4">Verzió</th>
                <th className="pb-3 pr-4">Állapot</th>
                <th className="pb-3">Művelet</th>
              </tr>
            </thead>
            <tbody>
              {agentList.map((agent) => (
                <tr
                  key={agent.id}
                  className="border-b border-slate-800/60 hover:bg-slate-800/30"
                >
                  <td className="py-3 pr-4">
                    <Link
                      to={`/control-plane/agents/${agent.id}`}
                      className="font-medium text-sky-300 hover:text-sky-200"
                    >
                      {agent.name}
                    </Link>
                    <p className="font-mono text-xs text-slate-500">{agent.id}</p>
                  </td>
                  <td className="py-3 pr-4 text-slate-300">{agent.role}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-slate-400">
                    {agent.modelConfig.model}
                  </td>
                  <td className="py-3 pr-4">
                    <Badge variant="mono">v{agent.version}</Badge>
                  </td>
                  <td className="py-3 pr-4">
                    <Badge
                      variant={
                        agent.status === 'active'
                          ? 'success'
                          : agent.status === 'paused'
                            ? 'warning'
                            : 'default'
                      }
                    >
                      {agent.status}
                    </Badge>
                  </td>
                  <td className="py-3">
                    <Link
                      to={`/control-plane/agents/${agent.id}`}
                      className="text-xs text-sky-400 hover:text-sky-300"
                    >
                      Anatómia →
                    </Link>
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
