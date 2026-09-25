'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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

const ROLE_KEYS: Record<UserRole, 'roleAdmin' | 'roleApprover' | 'roleOperator' | 'roleViewer'> = {
  admin: 'roleAdmin',
  approver: 'roleApprover',
  operator: 'roleOperator',
  viewer: 'roleViewer',
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
  const t = useTranslations('PlatformMembers')
  const roleName = (role: UserRole) => t(ROLE_KEYS[role])
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [snapshot, setSnapshot] = useState<{
    tenantId: string
    members: TenantMemberRow[]
    error: string | null
    loading: boolean
  }>({ tenantId, members: [], error: null, loading: true })
  const [form, setForm] = useState<{ userId: string; role: UserRole }>({ userId: '', role: 'operator' })

  const loading = snapshot.tenantId !== tenantId || snapshot.loading
  const members = snapshot.tenantId === tenantId ? snapshot.members : []
  const error = snapshot.tenantId === tenantId ? snapshot.error : null

  useEffect(() => {
    let cancelled = false
    listPlatformTenantMembers({ tenantId }).then((res) => {
      if (cancelled) return
      if (res.success) {
        setSnapshot({ tenantId, members: res.data, error: null, loading: false })
      } else {
        setSnapshot({
          tenantId,
          members: [],
          error: res.error ?? t('loadFailed'),
          loading: false,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [tenantId])

  const reloadMembers = () => {
    listPlatformTenantMembers({ tenantId }).then((res) => {
      if (res.success) {
        setSnapshot((current) => ({ ...current, tenantId, members: res.data, loading: false, error: null }))
      }
    })
  }

  const run = (fn: () => Promise<{ success: boolean; error?: string }>) => {
    startTransition(async () => {
      const res = await fn()
      if (!res.success) {
        setSnapshot((current) => ({ ...current, tenantId, error: res.error ?? 'Ismeretlen hiba' }))
      } else {
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
        <h2 className="font-display text-lg font-semibold tracking-tight">{t('title', { label: tenantLabel })}</h2>
        <button type="button" onClick={onClose} className={btnClass}>
          {t('close')}
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
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">{t('user')}</span>
              <select
                required
                value={form.userId}
                onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                className={inputClass}
              >
                <option value="">{t('pickUser')}</option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">{t('role')}</span>
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                className={inputClass}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleName(r)}
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
                {t('add')}
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text-sm text-ink-faint">{t('loading')}</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-3">{t('colMember')}</th>
                  <th className="py-2 pr-3">{t('colRole')}</th>
                  <th className="py-2 pr-3">{t('colStatus')}</th>
                  {canManage && <th className="py-2 pr-3 text-right">{t('colAction')}</th>}
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
                              {roleName(r)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge tone={roleTone[m.role] ?? 'neutral'}>
                          {m.role in ROLE_KEYS ? roleName(m.role as UserRole) : m.role}
                        </Badge>
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
                            {t('suspend')}
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
                            {t('reactivate')}
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
