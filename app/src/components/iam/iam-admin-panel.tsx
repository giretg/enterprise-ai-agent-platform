'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { Agent, Invitation, RolePermission, User, UserRole, UserStatus } from '@prisma/client'
import { formatDateTime } from '@/i18n/format'
import {
  approveUser,
  changeUserRole,
  inviteUser,
  provisionUser,
  reactivateUser,
  revokeInvitation,
  setUserAgentAccess,
  suspendUser,
  updateRolePermission,
} from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { isPreProvisionedAuthId } from '@/lib/iam-policy'

const ROLES: UserRole[] = ['viewer', 'operator', 'approver', 'admin']

const ROLE_KEYS: Record<UserRole, 'roleAdmin' | 'roleApprover' | 'roleOperator' | 'roleViewer'> = {
  admin: 'roleAdmin',
  approver: 'roleApprover',
  operator: 'roleOperator',
  viewer: 'roleViewer',
}

const STATUS_KEYS: Record<UserStatus, 'statusActive' | 'statusPending' | 'statusSuspended'> = {
  active: 'statusActive',
  pending: 'statusPending',
  suspended: 'statusSuspended',
}

const invitationStatusTone: Record<Invitation['status'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'warning',
  redeemed: 'success',
  expired: 'neutral',
  revoked: 'danger',
}

function useIamCopy() {
  const t = useTranslations('IamPanel')
  const locale = useLocale()
  return {
    t,
    role: (role: UserRole) => t(ROLE_KEYS[role]),
    status: (status: UserStatus) => t(STATUS_KEYS[status]),
    date: (value: Date | string | null) => formatDateTime(value, locale),
  }
}

function userStatusTone(status: UserStatus): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success'
  if (status === 'suspended') return 'danger'
  return 'warning'
}

function isAwaitingFirstLogin(user: User): boolean {
  return user.status === 'pending' && user.role !== null && isPreProvisionedAuthId(user.externalAuthId)
}

/** Első auth-claim megtörtént (nem pre-provisioned externalAuthId). */
function hasCompletedFirstLogin(user: User): boolean {
  return !isPreProvisionedAuthId(user.externalAuthId)
}

export function IamAdminPanel({
  users,
  invitations,
  permissions,
  agents,
  grantsByUserId,
}: {
  users: User[]
  invitations: Invitation[]
  permissions: RolePermission[]
  agents: Agent[]
  grantsByUserId: Record<string, string[]>
}) {
  const [modal, setModal] = useState<null | 'access' | 'invitations'>(null)

  const { t } = useIamCopy()
  const pendingInvitations = useMemo(
    () => invitations.filter((invitation) => invitation.status === 'pending').length,
    [invitations],
  )

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const rank = (user: User) => {
        if (isAwaitingFirstLogin(user)) return 0
        if (user.status === 'pending' && user.role === null) return 1
        if (user.status === 'pending') return 2
        if (user.status === 'suspended') return 3
        return 4
      }
      const delta = rank(a) - rank(b)
      if (delta !== 0) return delta
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
  }, [users])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setModal('access')}
          className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(43,80,255,0.6)]"
        >
          {t('newAccess')}
        </button>
        <button
          type="button"
          onClick={() => setModal('invitations')}
          className="inline-flex items-center gap-2 rounded-full border border-line bg-night-2 px-5 py-2.5 text-sm font-semibold text-ink"
        >
          {t('invitations')}
          <Badge tone={pendingInvitations > 0 ? 'warning' : 'neutral'}>{pendingInvitations}</Badge>
        </button>
      </div>

      <Card title={t('users')}>
          {sortedUsers.length === 0 ? (
            <p className="text-sm text-ink-faint">{t('noUsers')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-line text-xs uppercase tracking-[0.14em] text-ink-faint">
                  <tr>
                    <th className="pb-3 font-semibold">{t('colName')}</th>
                    <th className="pb-3 font-semibold">{t('colEmail')}</th>
                    <th className="pb-3 font-semibold">{t('colLogin')}</th>
                    <th className="pb-3 font-semibold">{t('colStatus')}</th>
                    <th className="pb-3 font-semibold">{t('colRole')}</th>
                    <th className="pb-3 font-semibold">{t('colAgentAccess')}</th>
                    <th className="pb-3 font-semibold">{t('colJob')}</th>
                    <th className="pb-3 font-semibold">{t('colCreated')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {sortedUsers.map((user) => (
                    <UserRow
                      key={`${user.id}-${new Date(user.updatedAt).getTime()}`}
                      user={user}
                      agents={agents}
                      grantedAgentIds={grantsByUserId[user.id] ?? []}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

      <PermissionMatrixCard permissions={permissions} />

      <Card title={t('auditTitle')}>
        <p className="text-sm text-ink-soft">
          {t('auditBodyLead')}{' '}
          <Link href="/control-plane/audit?targetType=user" className="font-semibold text-coral-deep hover:underline">
            {t('auditUsers')}
          </Link>{' '}
          {t('auditAnd')}{' '}
          <Link
            href="/control-plane/audit?targetType=invitation"
            className="font-semibold text-coral-deep hover:underline"
          >
            {t('auditInvites')}
          </Link>{' '}
          {t('auditBodyTail')}
        </p>
      </Card>

      {modal === 'access' && <AccessModal onClose={() => setModal(null)} />}
      {modal === 'invitations' && (
        <Modal title={t('invitations')} onClose={() => setModal(null)}>
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="text-ink-soft">{t('pending')}</span>
            <Badge tone={pendingInvitations > 0 ? 'warning' : 'neutral'}>
              {pendingInvitations}
            </Badge>
          </div>
          <ul className="max-h-[50vh] space-y-3 overflow-auto pr-1">
            {invitations.map((invitation) => (
              <InvitationRow key={invitation.id} invitation={invitation} />
            ))}
            {invitations.length === 0 && (
              <li className="text-sm text-ink-faint">{t('noInvites')}</li>
            )}
          </ul>
        </Modal>
      )}
    </div>
  )
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const { t } = useIamCopy()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="atelier-card max-h-[90vh] w-full max-w-lg overflow-auto p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-sm text-ink-soft hover:bg-night-2"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function AccessModal({ onClose }: { onClose: () => void }) {
  const { t, role: roleName } = useIamCopy()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<'invite' | 'provision'>('invite')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('operator')
  const [message, setMessage] = useState<string | null>(null)
  const [issuedToken, setIssuedToken] = useState<string | null>(null)
  const [clerkInvited, setClerkInvited] = useState(false)

  const submit = () => {
    startTransition(async () => {
      setMessage(null)
      setIssuedToken(null)
      if (mode === 'provision') {
        const result = await provisionUser({ email, role })
        if (result.success) {
          setEmail('')
          setMessage(t('provisioned'))
          router.refresh()
        } else {
          setMessage(result.error)
        }
        return
      }
      const result = await inviteUser({ email, role })
      if (result.success) {
        setEmail('')
        setClerkInvited(result.data.clerkInvited)
        setMessage(
          result.data.clerkInvited ? t('inviteSent') : t('inviteCreated'),
        )
        setIssuedToken(result.data.token)
        router.refresh()
      } else {
        setMessage(result.error)
      }
    })
  }

  return (
    <Modal title={t('newAccess')} onClose={onClose}>
      <div className="mb-4 grid gap-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-checked:border-coral/50">
          <input
            type="radio"
            name="access-mode"
            value="invite"
            checked={mode === 'invite'}
            onChange={() => setMode('invite')}
            className="mt-1 accent-[#2b50ff]"
          />
          <span>
            <span className="block text-sm font-semibold">{t('inviteMode')}</span>
            <span className="mt-0.5 block text-xs text-ink-faint">
              {t('inviteModeHint')}
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-checked:border-coral/50">
          <input
            type="radio"
            name="access-mode"
            value="provision"
            checked={mode === 'provision'}
            onChange={() => setMode('provision')}
            className="mt-1 accent-[#2b50ff]"
          />
          <span>
            <span className="block text-sm font-semibold">{t('provisionMode')}</span>
            <span className="mt-0.5 block text-xs text-ink-faint">
              {t('provisionModeHint')}
            </span>
          </span>
        </label>
      </div>

      <div className="space-y-3">
        <label className="block text-sm text-ink-soft">
          {t('email')}
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
            placeholder={t('emailPlaceholder')}
          />
        </label>
        <label className="block text-sm text-ink-soft">
          {t('role')}
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole)}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {roleName(option)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={pending || !email.trim()}
          className="w-full rounded-full bg-coral px-4 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(43,80,255,0.6)] disabled:opacity-50"
          onClick={submit}
        >
          {mode === 'invite' ? t('createInvite') : t('provision')}
        </button>
      </div>

      {issuedToken && (
        <div className="mt-4 rounded-lg border border-honey/35 bg-honey/10 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-honey">
            {clerkInvited ? t('tokenFallback') : t('tokenOnce')}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            {clerkInvited ? t('tokenFallbackHint') : t('tokenOnceHint')}
          </p>
          <code className="mt-2 block break-all rounded bg-night-2 p-2 font-mono text-xs text-ink-soft">
            {issuedToken}
          </code>
          <Link
            href={`/control-plane/iam/redeem?token=${encodeURIComponent(issuedToken)}`}
            className="mt-3 inline-flex text-sm font-semibold text-coral-deep hover:underline"
          >
            {t('openRedeem')}
          </Link>
        </div>
      )}

      {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
    </Modal>
  )
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const { t, role, date } = useIamCopy()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const isDisabled = pending

  return (
    <li className="atelier-soft p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{invitation.email}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {role(invitation.role)} · {t('expires', { date: date(invitation.expiresAt) })}
          </p>
        </div>
        <Badge tone={invitationStatusTone[invitation.status]}>{invitation.status}</Badge>
      </div>
      <p className="mt-2 text-xs text-ink-faint">{t('created', { date: date(invitation.createdAt) })}</p>
      {invitation.status === 'pending' && (
        <button
          type="button"
          disabled={isDisabled}
          className="mt-2 rounded-full bg-coral/15 px-3 py-1 text-xs font-semibold text-coral-deep disabled:opacity-50"
          onClick={() => {
            startTransition(async () => {
              const result = await revokeInvitation({ invitationId: invitation.id })
              if (result.success) {
                setMessage(null)
                router.refresh()
              } else {
                setMessage(result.error)
              }
            })
          }}
        >
          {t('revoke')}
        </button>
      )}
      {message && <p className="mt-2 text-xs text-coral-deep">{message}</p>}
    </li>
  )
}

function AgentAccessEditor({
  user,
  agents,
  grantedAgentIds,
  disabled,
}: {
  user: User
  agents: Agent[]
  grantedAgentIds: string[]
  disabled: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null)
  const [grantPending, startGrantTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const granted = useMemo(() => new Set(grantedAgentIds), [grantedAgentIds])
  // Admin/jóváhagyó mindent lát grant nélkül is — a lista csak az explicit
  // hozzáféréseket mutatja (operátor/olvasó szerephez számítanak).
  const seesEverything = user.role === 'admin' || user.role === 'approver'
  const { t } = useIamCopy()
  const busy = disabled || grantPending

  const toggle = (agentId: string, has: boolean) => {
    setBusyAgentId(agentId)
    startGrantTransition(async () => {
      const result = await setUserAgentAccess({
        targetUserId: user.id,
        agentId,
        granted: !has,
      })
      if (result.success) {
        setMessage(null)
        router.refresh()
      } else {
        setMessage(result.error)
      }
      setBusyAgentId(null)
    })
  }

  return (
    <div className="min-w-44">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="rounded-full bg-sky/15 px-3 py-1.5 text-xs font-semibold text-sky"
      >
        {t('agentsCount', { count: grantedAgentIds.length })}
        {open ? ' ▴' : ' ▾'}
      </button>
      {seesEverything && <p className="mt-1 text-[11px] text-ink-faint">{t('seesEverything')}</p>}
      {open && (
        <div className="mt-2 space-y-1.5">
          {agents.length === 0 && (
            <p className="text-xs text-ink-faint">{t('noAgents')}</p>
          )}
          {agents.map((agent) => {
            const has = granted.has(agent.id)
            const agentBusy = busyAgentId === agent.id
            return (
              <label
                key={agent.id}
                className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft"
              >
                <input
                  type="checkbox"
                  checked={has}
                  disabled={busy}
                  onChange={() => toggle(agent.id, has)}
                  className="h-3.5 w-3.5 accent-[#3a7ca5]"
                />
                <span className="truncate">
                  {agent.name}
                  {agentBusy ? ' …' : ''}
                </span>
              </label>
            )
          })}
          {message && <p className="text-xs text-coral-deep">{message}</p>}
        </div>
      )}
    </div>
  )
}

function UserRow({
  user,
  agents,
  grantedAgentIds,
}: {
  user: User
  agents: Agent[]
  grantedAgentIds: string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [role, setRole] = useState<UserRole>(user.role ?? 'viewer')
  const [reason, setReason] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const isDisabled = pending
  const isPendingApproval = user.status === 'pending' && user.role === null
  const awaitingFirstLogin = isAwaitingFirstLogin(user)
  const loggedIn = hasCompletedFirstLogin(user)
  const jobDescriptionDirty = jobDescription.trim() !== ''
  const { t, role: roleName, status: statusName, date } = useIamCopy()
  const loginAt = user.lastLoginAt ?? user.activatedAt

  return (
    <tr className="align-top">
      <td className="py-3 pr-4">
        <p className="font-medium">{user.name}</p>
        <p className="mt-1 font-mono text-[11px] text-ink-faint">{user.id.slice(0, 8)}</p>
        {message && <p className="mt-2 text-xs text-coral-deep">{message}</p>}
      </td>
      <td className="py-3 pr-4 text-ink-soft">{user.email}</td>
      <td className="py-3 pr-4">
        <div className="flex flex-col gap-1">
          <Badge tone={loggedIn ? 'success' : 'warning'}>
            {loggedIn ? t('loggedIn') : t('notLoggedIn')}
          </Badge>
          {loggedIn && loginAt ? (
            <p className="text-[11px] text-ink-faint">{date(loginAt)}</p>
          ) : null}
        </div>
      </td>
      <td className="py-3 pr-4">
        <div className="flex flex-col gap-2">
          <Badge tone={userStatusTone(user.status)}>
            {awaitingFirstLogin ? t('awaitingFirstLogin') : statusName(user.status)}
          </Badge>
          {user.status === 'active' && (
            <div className="flex items-center gap-2">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={isDisabled}
                placeholder={t('suspendReason')}
                className="w-40 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs"
              />
              <button
                type="button"
                disabled={isDisabled || !reason.trim()}
                className="rounded-full bg-honey/15 px-3 py-1.5 text-xs font-semibold text-honey disabled:opacity-50"
                onClick={() => {
                  startTransition(async () => {
                    const result = await suspendUser({ targetUserId: user.id, reason: reason.trim() })
                    if (result.success) {
                      setMessage(null)
                      setReason('')
                      router.refresh()
                    } else {
                      setMessage(result.error)
                    }
                  })
                }}
              >
                {t('suspend')}
              </button>
            </div>
          )}
          {user.status === 'suspended' && (
            <button
              type="button"
              disabled={isDisabled}
              className="rounded-full bg-sage/15 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
              onClick={() => {
                startTransition(async () => {
                  const result = await reactivateUser({ targetUserId: user.id })
                  if (result.success) {
                    setMessage(null)
                    router.refresh()
                  } else {
                    setMessage(result.error)
                  }
                })
              }}
            >
              {t('reactivate')}
            </button>
          )}
        </div>
      </td>
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
                {roleName(option)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={isDisabled || (!isPendingApproval && role === user.role)}
            className="rounded-full bg-sky/15 px-3 py-1.5 text-xs font-semibold text-sky disabled:opacity-50"
            onClick={() => {
              startTransition(async () => {
                const result = isPendingApproval
                  ? await approveUser({ targetUserId: user.id, role })
                  : await changeUserRole({ targetUserId: user.id, newRole: role })
                if (result.success) {
                  setMessage(null)
                  router.refresh()
                } else {
                  setMessage(result.error)
                  setRole(user.role ?? 'viewer')
                }
              })
            }}
          >
            {isPendingApproval ? t('approve') : t('save')}
          </button>
        </div>
      </td>
      <td className="py-3 pr-4">
        <AgentAccessEditor
          user={user}
          agents={agents}
          grantedAgentIds={grantedAgentIds}
          disabled={isDisabled}
        />
      </td>
      <td className="py-3 pr-4">
        <div className="flex items-start gap-2">
          <textarea
            value={jobDescription}
            disabled={isDisabled}
            onChange={(event) => setJobDescription(event.target.value)}
            rows={2}
            maxLength={280}
            placeholder={t('jobPlaceholder')}
            className="w-48 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            disabled={isDisabled || !jobDescriptionDirty}
            className="rounded-full bg-sky/15 px-3 py-1.5 text-xs font-semibold text-sky disabled:opacity-50"
            onClick={() => {
              startTransition(async () => {
                setMessage(null)
                router.refresh()
              })
            }}
          >
            {t('save')}
          </button>
        </div>
      </td>
      <td className="py-3 text-ink-faint">{date(user.createdAt)}</td>
    </tr>
  )
}

function PermissionMatrixCard({ permissions }: { permissions: RolePermission[] }) {
  const { t, role: roleName } = useIamCopy()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)

  return (
    <Card title={t('matrixTitle')}>
      <p className="mb-3 text-xs text-ink-faint">{t('matrixHint')}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-[0.14em] text-ink-faint">
            <tr>
              <th className="pb-2 font-semibold">{t('colKey')}</th>
              <th className="pb-2 font-semibold">{t('colDescription')}</th>
              <th className="pb-2 font-semibold">{t('colMinRole')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {permissions.map((permission) => (
              <tr key={permission.id}>
                <td className="py-2 pr-4 font-mono text-xs">{permission.permissionKey}</td>
                <td className="py-2 pr-4 text-ink-soft">{permission.description ?? '—'}</td>
                <td className="py-2">
                  <select
                    defaultValue={permission.minRole}
                    disabled={pending}
                    className="rounded-lg border border-line bg-night-2 px-2 py-1.5 text-sm"
                    onChange={(event) => {
                      const minRole = event.target.value as UserRole
                      startTransition(async () => {
                        const result = await updateRolePermission({
                          permissionKey: permission.permissionKey,
                          minRole,
                        })
                        if (result.success) {
                          setMessage(null)
                          router.refresh()
                        } else {
                          setMessage(result.error)
                        }
                      })
                    }}
                  >
                    {ROLES.map((option) => (
                      <option key={option} value={option}>
                        {roleName(option)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message && <p className="mt-3 text-sm text-coral-deep">{message}</p>}
    </Card>
  )
}
