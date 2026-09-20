'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setAgentUserAccess } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

export type AgentAccessUser = {
  id: string
  name: string
  email: string
  role: string | null
  accessLevel: 'view' | 'operate' | null
}

const ACCESS_OPTIONS = [
  { value: 'none', label: 'Nincs' },
  { value: 'view', label: 'Megtekintés' },
  { value: 'operate', label: 'Használat' },
] as const

/**
 * Kik használhatják az agentet. Admin és jóváhagyó alapból hozzáfér —
 * itt az operátor/néző körnek adható Megtekintés (adatlap) vagy Használat
 * (chatben és ticketben is dolgozhat vele).
 */
export function AgentAccessPanel({
  agentId,
  users,
}: {
  agentId: string
  users: AgentAccessUser[]
}) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, start] = useTransition()

  function setAccess(userId: string, accessLevel: 'view' | 'operate' | 'none') {
    setPendingId(userId)
    start(async () => {
      setError(null)
      const res = await setAgentUserAccess({ agentId, userId, accessLevel })
      setPendingId(null)
      if (res.success) router.refresh()
      else setError(res.error)
    })
  }

  return (
    <Card title="Hozzáférés">
      <p className="mb-4 text-xs text-ink-faint">
        Adminok és jóváhagyók alapból látják az agentet. Itt állítod, melyik operátor
        vagy néző tekintheti meg, illetve használhatja chatben és ticketben.
      </p>
      {error ? <p className="mb-3 text-sm text-coral-deep">{error}</p> : null}
      {users.length === 0 ? (
        <p className="text-sm text-ink-soft">Nincs más user a szervezetben.</p>
      ) : (
        <ul className="space-y-2">
          {users.map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="font-medium">{member.name || member.email}</span>{' '}
                <span className="text-xs text-ink-faint">
                  {member.email} · {member.role ?? '—'}
                </span>
              </span>
              <label className="flex items-center gap-2 text-xs text-ink-soft">
                Hozzáférés
                <select
                  value={member.accessLevel ?? 'none'}
                  disabled={pendingId === member.id}
                  onChange={(event) =>
                    setAccess(
                      member.id,
                      event.target.value as 'view' | 'operate' | 'none',
                    )
                  }
                  className="rounded-lg border border-line bg-paper px-2 py-1 text-sm disabled:opacity-50"
                >
                  {ACCESS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
