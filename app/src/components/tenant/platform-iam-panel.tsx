'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { grantPlatformRole, revokePlatformRole } from '@/app/actions/tenant'
import { Badge, Card } from '@/components/ui/shell'

/** A `listPlatformMembers` action szerializálható sora (§9.3). */
export type PlatformMemberRow = {
  id: string
  userId: string
  userEmail: string
  userName: string
  role: string
  status: string
  createdAt: string | Date
}

/** A platform audit-napló szerializálható sora (§9.3). */
export type PlatformAuditRow = {
  id: string
  action: string
  actorId: string | null
  targetType: string | null
  targetId: string | null
  policyDecision: string | null
  createdAt: string | Date
}

const roleTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  superadmin: 'danger',
  platform_operator: 'warning',
  platform_auditor: 'neutral',
}

const PLATFORM_ROLES = ['superadmin', 'platform_operator', 'platform_auditor'] as const

export function PlatformIamPanel({
  members,
  audit,
  canManage,
}: {
  members: PlatformMemberRow[]
  audit: PlatformAuditRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ userId: string; role: (typeof PLATFORM_ROLES)[number] }>({
    userId: '',
    role: 'platform_auditor',
  })

  const run = (fn: () => Promise<{ success: boolean; error?: string }>) => {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.success) setError(res.error ?? 'Ismeretlen hiba')
      else router.refresh()
    })
  }

  const inputClass =
    'w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-coral/50'
  const btnClass =
    'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep disabled:opacity-50'

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-3 text-sm text-coral-deep">{error}</div>
      )}

      {canManage && (
        <Card title="Platform-szerep kiosztása">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              run(async () => {
                const res = await grantPlatformRole({ userId: form.userId.trim(), role: form.role })
                if (res.success) setForm({ userId: '', role: 'platform_auditor' })
                return res
              })
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">User ID (UUID)</span>
              <input
                required
                value={form.userId}
                onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                placeholder="00000000-0000-4000-a000-…"
                className={inputClass}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Platform-szerep</span>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as (typeof PLATFORM_ROLES)[number] }))}
                className={inputClass}
              >
                {PLATFORM_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={pending}
                className="rounded-full border border-coral/35 bg-coral/10 px-4 py-2 text-sm font-semibold text-coral-deep transition-colors hover:border-coral/55 disabled:opacity-50"
              >
                Szerep kiosztása
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card title={`Platform-tagok (${members.length})`}>
        {members.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs platform-tag.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-3">Tag</th>
                  <th className="py-2 pr-3">Szerep</th>
                  <th className="py-2 pr-3">Státusz</th>
                  {canManage && <th className="py-2 pr-3 text-right">Művelet</th>}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b border-line/50">
                    <td className="py-2.5 pr-3">
                      <span className="font-medium text-ink">{m.userName}</span>
                      <span className="block text-xs text-ink-faint">{m.userEmail}</span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={roleTone[m.role] ?? 'neutral'}>{m.role}</Badge>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-ink-soft">{m.status}</td>
                    {canManage && (
                      <td className="py-2.5 pr-3 text-right">
                        <button
                          disabled={pending}
                          className={btnClass}
                          onClick={() => run(() => revokePlatformRole({ userId: m.userId, role: m.role as (typeof PLATFORM_ROLES)[number] }))}
                        >
                          Megvonás
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Platform audit-napló (tenant lifecycle + assume)">
        {audit.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs esemény.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-3">Idő</th>
                  <th className="py-2 pr-3">Esemény</th>
                  <th className="py-2 pr-3">Cél</th>
                  <th className="py-2 pr-3">Döntés</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id} className="border-b border-line/50">
                    <td className="py-2 pr-3 font-mono text-xs text-ink-faint">
                      {new Date(a.createdAt).toLocaleString('hu-HU')}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-soft">{a.action}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-faint">
                      {a.targetType}
                      {a.targetId ? `:${a.targetId.slice(0, 8)}` : ''}
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink-soft">{a.policyDecision}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
