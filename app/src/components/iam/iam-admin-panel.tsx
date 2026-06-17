'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import type { Invitation, User, UserRole, UserStatus } from '@prisma/client'
import {
  changeUserRole,
  inviteUser,
  setUserStatus,
} from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

const ROLES: UserRole[] = ['viewer', 'operator', 'approver', 'admin']
const STATUSES: UserStatus[] = ['pending', 'active', 'suspended']

const roleLabel: Record<UserRole, string> = {
  admin: 'Admin',
  approver: 'Jóváhagyó',
  operator: 'Operátor',
  viewer: 'Olvasó',
}

const statusLabel: Record<UserStatus, string> = {
  active: 'Aktív',
  pending: 'Függőben',
  suspended: 'Felfüggesztve',
}

const invitationStatusTone: Record<Invitation['status'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'warning',
  redeemed: 'success',
  expired: 'neutral',
}

function formatDate(value: Date | string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('hu-HU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function userStatusTone(status: UserStatus): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'suspended') return 'danger'
  return 'warning'
}

export function IamAdminPanel({
  users,
  invitations,
}: {
  users: User[]
  invitations: Invitation[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('operator')
  const [message, setMessage] = useState<string | null>(null)
  const [issuedToken, setIssuedToken] = useState<string | null>(null)
  const [clerkInvited, setClerkInvited] = useState(false)

  const pendingInvitations = useMemo(
    () => invitations.filter((invitation) => invitation.status === 'pending').length,
    [invitations],
  )

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
      <Card title="Felhasználók">
        {users.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs felhasználó.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-[0.14em] text-ink-faint">
                <tr>
                  <th className="pb-3 font-semibold">Név</th>
                  <th className="pb-3 font-semibold">Email</th>
                  <th className="pb-3 font-semibold">Szerep</th>
                  <th className="pb-3 font-semibold">Státusz</th>
                  <th className="pb-3 font-semibold">Létrehozva</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((user) => (
                  <UserRow key={user.id} user={user} disabled={pending} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="space-y-6">
        <Card title="Új meghívó">
          <div className="space-y-3">
            <label className="block text-sm text-ink-soft">
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
                placeholder="kollega@ceg.hu"
              />
            </label>
            <label className="block text-sm text-ink-soft">
              Szerep
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
              >
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {roleLabel[option]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={pending || !email.trim()}
              className="w-full rounded-full bg-coral px-4 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(178,58,85,0.7)] disabled:opacity-50"
              onClick={() => {
                startTransition(async () => {
                  setIssuedToken(null)
                  const result = await inviteUser({ email, role })
                  if (result.success) {
                    setEmail('')
                    setClerkInvited(result.data.clerkInvited)
                    setMessage(
                      result.data.clerkInvited
                        ? 'Meghívó e-mail kiküldve (Clerk).'
                        : 'Meghívó létrehozva.',
                    )
                    setIssuedToken(result.data.token)
                    router.refresh()
                  } else {
                    setMessage(result.error)
                  }
                })
              }}
            >
              Meghívó létrehozása
            </button>
          </div>

          {issuedToken && (
            <div className="mt-4 rounded-lg border border-honey/35 bg-honey/10 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-honey">
                {clerkInvited ? 'Belső token (fallback)' : 'Egyszer látható token'}
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                {clerkInvited
                  ? 'A meghívott e-mailben kap Clerk-linket — a regisztrációkor a szerepkör automatikusan beáll. Ezt a tokent nem kell kézzel megosztani; csak belső/dev fallback.'
                  : 'Oszd meg ezt a tokent a meghívottal a beváltó oldalhoz.'}
              </p>
              <code className="mt-2 block break-all rounded bg-night-2 p-2 font-mono text-xs text-ink-soft">
                {issuedToken}
              </code>
              <Link
                href={`/control-plane/iam/redeem?token=${encodeURIComponent(issuedToken)}`}
                className="mt-3 inline-flex text-sm font-semibold text-coral-deep hover:underline"
              >
                Beváltó oldal megnyitása
              </Link>
            </div>
          )}

          {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
        </Card>

        <Card title="Meghívók">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="text-ink-soft">Függőben</span>
            <Badge tone={pendingInvitations > 0 ? 'warning' : 'neutral'}>{pendingInvitations}</Badge>
          </div>
          <ul className="max-h-[520px] space-y-3 overflow-auto pr-1">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="atelier-soft p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{invitation.email}</p>
                    <p className="mt-1 text-xs text-ink-faint">
                      {roleLabel[invitation.role]} · lejár: {formatDate(invitation.expiresAt)}
                    </p>
                  </div>
                  <Badge tone={invitationStatusTone[invitation.status]}>
                    {invitation.status}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-ink-faint">
                  Létrehozva: {formatDate(invitation.createdAt)}
                </p>
              </li>
            ))}
            {invitations.length === 0 && (
              <li className="text-sm text-ink-faint">Még nincs meghívó.</li>
            )}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function UserRow({ user, disabled }: { user: User; disabled: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [role, setRole] = useState<UserRole>(user.role)
  const [status, setStatus] = useState<UserStatus>(user.status)
  const [message, setMessage] = useState<string | null>(null)
  const isDisabled = disabled || pending

  return (
    <tr className="align-top">
      <td className="py-3 pr-4">
        <p className="font-medium">{user.name}</p>
        <p className="mt-1 font-mono text-[11px] text-ink-faint">{user.id.slice(0, 8)}</p>
        {message && <p className="mt-2 text-xs text-coral-deep">{message}</p>}
      </td>
      <td className="py-3 pr-4 text-ink-soft">{user.email}</td>
      <td className="py-3 pr-4">
        <div className="flex items-center gap-2">
          <select
            value={role}
            disabled={isDisabled}
            onChange={(event) => setRole(event.target.value as UserRole)}
            className="rounded-lg border border-line bg-night-2 px-2 py-1.5 text-sm"
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {roleLabel[option]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={isDisabled || role === user.role}
            className="rounded-full bg-sky/15 px-3 py-1.5 text-xs font-semibold text-sky disabled:opacity-50"
            onClick={() => {
              startTransition(async () => {
                const result = await changeUserRole({ targetUserId: user.id, newRole: role })
                if (result.success) {
                  setMessage(null)
                  router.refresh()
                } else {
                  setMessage(result.error)
                  setRole(user.role)
                }
              })
            }}
          >
            Mentés
          </button>
        </div>
      </td>
      <td className="py-3 pr-4">
        <div className="flex items-center gap-2">
          <Badge tone={userStatusTone(user.status)}>{statusLabel[user.status]}</Badge>
          <select
            value={status}
            disabled={isDisabled}
            onChange={(event) => setStatus(event.target.value as UserStatus)}
            className="rounded-lg border border-line bg-night-2 px-2 py-1.5 text-sm"
          >
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {statusLabel[option]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={isDisabled || status === user.status}
            className="rounded-full bg-honey/15 px-3 py-1.5 text-xs font-semibold text-honey disabled:opacity-50"
            onClick={() => {
              startTransition(async () => {
                const result = await setUserStatus({ targetUserId: user.id, status })
                if (result.success) {
                  setMessage(null)
                  router.refresh()
                } else {
                  setMessage(result.error)
                  setStatus(user.status)
                }
              })
            }}
          >
            Mentés
          </button>
        </div>
      </td>
      <td className="py-3 text-ink-faint">{formatDate(user.createdAt)}</td>
    </tr>
  )
}
