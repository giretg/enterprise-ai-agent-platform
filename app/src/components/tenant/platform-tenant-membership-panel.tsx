'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { UserRole } from '@prisma/client'
import {
  addPlatformTenantMember,
  changePlatformTenantMemberRole,
  listPlatformTenantMembers,
  suspendPlatformTenantMember,
} from '@/app/actions/tenant'
import { Badge, Card } from '@/components/ui/shell'

export type PlatformUserOption = {
  id: string
  email: string
  name: string
}

export type TenantMemberRow = {
  id: string
  userId: string
  userEmail: string
  userName: string
  role: string
  status: string
  isDefault: boolean
}

const ROLES: UserRole[] = ['admin', 'approver', 'operator', 'viewer']

const roleLabel: Record<UserRole, string> = {
  admin: 'Admin',
  approver: 'Jóváhagyó',
  operator: 'Operátor',
  viewer: 'Olvasó',
}

const roleTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  admin: 'danger',
  approver: 'warning',
  operator: 'neutral',
  viewer: 'neutral',
}

const statusTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  pending: 'warning',
  suspended: 'danger',
}

type Props = {
  tenantId: string
  tenantLabel: string
  users: PlatformUserOption[]
  canManage: boolean
  onClose: () => void
}

export function PlatformTenantMembershipPanel({ tenantId, tenantLabel, users, canManage, onClose }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<TenantMemberRow[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<{ userId: string; role: UserRole }>({ userId: '', role: 'operator' })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listPlatformTenantMembers({ tenantId }).then((res) => {
      if (cancelled) return
      if (res.success) setMembers(res.data)
      else setError(res.error ?? 'Nem sikerült betölteni a tagokat')
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [tenantId])

  const reloadMembers = () => {
    listPlatformTenantMembers({ tenantId }).then((res) => {
      if (res.success) setMembers(res.data)
    })
  }

  const run = (fn: () => Promise<{ success: boolean; error?: string }>) => {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.success) setError(res.error ?? 'Ismeretlen hiba')
      else {
        reloadMembers()
        router.refresh()
      }
    })
  }

  const inputClass =
    'w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-coral/50'
  const btnClass =
    'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep disabled:opacity-50'

  const activeMemberUserIds = new Set(
    members.filter((m) => m.status === 'active' || m.status === 'pending').map((m) => m.userId),
  )
  const availableUsers = users.filter((u) => !activeMemberUserIds.has(u.id))

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight">Tenant tagok — {tenantLabel}</h2>
        <button type="button" onClick={onClose} className={btnClass}>
          Bezárás
        </button>
      </div>
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-coral/35 bg-coral/10 p-3 text-sm text-coral-deep">{error}</div>
        )}

        {canManage && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!form.userId) return
              run(async () => {
                const res = await addPlatformTenantMember({ tenantId, userId: form.userId, role: form.role })
                if (res.success) setForm({ userId: '', role: 'operator' })
                return res
              })
            }}
            className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(140px,0.6fr)_auto]"
          >
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Felhasználó</span>
              <select
                required
                value={form.userId}
                onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                className={inputClass}
              >
                <option value="">Válassz felhasználót…</option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Szerep</span>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                className={inputClass}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel[r]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={pending || !form.userId || availableUsers.length === 0}
                className="rounded-full border border-coral/35 bg-coral/10 px-4 py-2 text-sm font-semibold text-coral-deep transition-colors hover:border-coral/55 disabled:opacity-50"
              >
                Tag hozzáadása
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text-sm text-ink-faint">Betöltés…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-ink-faint">Ehhez a tenanthoz még nincs tag.</p>
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
                      {canManage && m.status === 'active' ? (
                        <select
                          value={m.role}
                          disabled={pending}
                          onChange={(e) =>
                            run(() =>
                              changePlatformTenantMemberRole({
                                tenantId,
                                targetUserId: m.userId,
                                newRole: e.target.value as UserRole,
                              }),
                            )
                          }
                          className="rounded-lg border border-line bg-card px-2 py-1 text-xs text-ink"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {roleLabel[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge tone={roleTone[m.role] ?? 'neutral'}>{roleLabel[m.role as UserRole] ?? m.role}</Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={statusTone[m.status] ?? 'neutral'}>{m.status}</Badge>
                    </td>
                    {canManage && (
                      <td className="py-2.5 pr-3 text-right">
                        {m.status === 'active' && (
                          <button
                            disabled={pending}
                            className={btnClass}
                            onClick={() =>
                              run(() => suspendPlatformTenantMember({ tenantId, targetUserId: m.userId }))
                            }
                          >
                            Felfüggeszt
                          </button>
                        )}
                        {m.status === 'suspended' && (
                          <button
                            disabled={pending}
                            className={btnClass}
                            onClick={() =>
                              run(() =>
                                addPlatformTenantMember({
                                  tenantId,
                                  userId: m.userId,
                                  role: m.role as UserRole,
                                }),
                              )
                            }
                          >
                            Visszaállít
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}
