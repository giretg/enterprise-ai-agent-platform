import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import {
  agentServiceAccounts,
  humanUsers,
  roleDefinitions,
} from '../../shared/mock-data'
import type { AgentServiceAccount, HumanRole, HumanUser } from '../../shared/types'

type Tab = 'humans' | 'agents' | 'roles'

const roleLabels: Record<HumanRole, string> = {
  platform_admin: 'Platform admin',
  agent_admin: 'Agent admin',
  approver: 'Jóváhagyó',
  operator: 'Operátor',
  auditor: 'Auditor',
}

export function IamPage() {
  const [tab, setTab] = useState<Tab>('humans')

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">
            IAM — hozzáférés
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Emberi identitás (SSO/RBAC) + agent service account — jogosultság a
            control plane-ben
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="info">Clerk SSO (prototípus)</Badge>
          <Badge variant="mono">agent-authz: control plane</Badge>
        </div>
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap gap-1">
          {(
            [
              ['humans', 'Emberek'],
              ['agents', 'Agent service accountok'],
              ['roles', 'Szerepkörök (RBAC)'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded px-3 py-1.5 text-xs font-medium ${
                tab === key
                  ? 'bg-slate-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {tab === 'humans' && <HumansTab users={humanUsers} />}
      {tab === 'agents' && <AgentsTab accounts={agentServiceAccounts} />}
      {tab === 'roles' && <RolesTab />}
    </div>
  )
}

function HumansTab({ users }: { users: HumanUser[] }) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search) return users
    const q = search.toLowerCase()
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.includes(q),
    )
  }, [users, search])

  return (
    <>
      <Card className="mb-4">
        <input
          type="search"
          placeholder="Keresés: név, e-mail, szerep…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
        />
      </Card>
      <Card title={`Humán felhasználók (${filtered.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase text-slate-500">
                <th className="pb-3 pr-4">Név</th>
                <th className="pb-3 pr-4">Szerep</th>
                <th className="pb-3 pr-4">Auth</th>
                <th className="pb-3 pr-4">Utolsó belépés</th>
                <th className="pb-3">Jogosultságok</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-slate-800/60 hover:bg-slate-800/30"
                >
                  <td className="py-3 pr-4">
                    <p className="font-medium text-slate-200">{user.name}</p>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </td>
                  <td className="py-3 pr-4">
                    <Badge variant="info">{roleLabels[user.role]}</Badge>
                  </td>
                  <td className="py-3 pr-4 text-xs text-slate-400">
                    {user.authProvider}
                  </td>
                  <td className="py-3 pr-4 text-xs text-slate-400">
                    {new Date(user.lastLogin).toLocaleString('hu-HU')}
                  </td>
                  <td className="py-3">
                    <div className="flex flex-wrap gap-1">
                      {user.permissions.slice(0, 3).map((p) => (
                        <Badge key={p} variant="mono">
                          {p}
                        </Badge>
                      ))}
                      {user.permissions.length > 3 && (
                        <Badge variant="default">
                          +{user.permissions.length - 3}
                        </Badge>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}

function AgentsTab({ accounts }: { accounts: AgentServiceAccount[] }) {
  return (
    <Card title="Agent service accountok">
      <p className="mb-4 text-xs text-slate-500">
        Az agentek nem humán felhasználók — scoped API-kulcs + finom jogosultság
        a control plane-ben. Minden művelet non-repudiation elven naplózott.
      </p>
      <div className="space-y-3">
        {accounts.map((sa) => (
          <div
            key={sa.id}
            className="rounded border border-slate-700/60 bg-slate-900/40 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                {sa.agentId.startsWith('agent-cowork') ? (
                  <p className="font-medium text-slate-200">{sa.agentName}</p>
                ) : (
                  <Link
                    to={`/control-plane/agents/${sa.agentId}`}
                    className="font-medium text-sky-400 hover:text-sky-300"
                  >
                    {sa.agentName}
                  </Link>
                )}
                <p className="mt-1 font-mono text-xs text-slate-500">
                  {sa.serviceAccount}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    sa.runtime === 'trusted_internal' ? 'success' : 'warning'
                  }
                >
                  {sa.runtime === 'trusted_internal'
                    ? 'Trusted internal'
                    : 'Untrusted external'}
                </Badge>
                <Badge variant={sa.status === 'active' ? 'success' : 'default'}>
                  {sa.status}
                </Badge>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
              <span>
                API kulcs:{' '}
                <span className="font-mono text-slate-300">{sa.apiKeyPreview}</span>
              </span>
              <span>
                Lejár: {new Date(sa.keyExpiresAt).toLocaleDateString('hu-HU')}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {sa.permissions.map((p) => (
                <Badge key={p} variant="mono">
                  {p}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function RolesTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {roleDefinitions.map((role) => (
        <Card key={role.id} title={role.label}>
          <p className="mb-3 text-sm text-slate-400">{role.description}</p>
          <div className="flex flex-wrap gap-1">
            {role.permissions.map((p) => (
              <Badge key={p} variant="mono">
                {p}
              </Badge>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
