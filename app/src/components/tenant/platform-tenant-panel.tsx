'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createTenant,
  suspendTenant,
  reactivateTenant,
  offboardTenant,
  archiveTenant,
} from '@/app/actions/tenant'
import { Badge, Card } from '@/components/ui/shell'
import {
  PlatformTenantMembershipPanel,
  type PlatformUserOption,
} from '@/components/tenant/platform-tenant-membership-panel'

/** A `listTenants` action által visszaadott (szerializálható) tenant-nézet. */
export type TenantRow = {
  id: string
  slug: string
  displayName: string
  legalName: string | null
  status: string
  createdAt: string | Date
}

const statusTone: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  suspended: 'warning',
  offboarding: 'warning',
  archived: 'neutral',
}

export function PlatformTenantPanel({
  tenants,
  users,
  canManageMemberships,
}: {
  tenants: TenantRow[]
  users: PlatformUserOption[]
  canManageMemberships: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null)
  const [form, setForm] = useState({
    slug: '',
    displayName: '',
    legalName: '',
    domainAllowlist: '',
    initialAdminUserId: '',
  })

  const run = (fn: () => Promise<{ success: boolean; error?: string }>) => {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.success) setError(res.error ?? 'Ismeretlen hiba')
      else router.refresh()
    })
  }

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault()
    const domainAllowlist = form.domainAllowlist
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
    run(async () => {
      const res = await createTenant({
        slug: form.slug,
        displayName: form.displayName,
        legalName: form.legalName || undefined,
        domainAllowlist: domainAllowlist.length > 0 ? domainAllowlist : undefined,
        initialAdminUserId: form.initialAdminUserId || undefined,
      })
      if (res.success) {
        setForm({ slug: '', displayName: '', legalName: '', domainAllowlist: '', initialAdminUserId: '' })
      }
      return res
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

      <Card title="Új tenant létrehozása">
        <form onSubmit={submitCreate} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Slug</span>
            <input
              required
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
              placeholder="acme-bank"
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Megjelenített név</span>
            <input
              required
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="Acme Bank Zrt."
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Jogi név (opc.)</span>
            <input
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">Domain allowlist (vesszővel)</span>
            <input
              value={form.domainAllowlist}
              onChange={(e) => setForm((f) => ({ ...f, domainAllowlist: e.target.value }))}
              placeholder="acme.hu, acme.com"
              className={inputClass}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Első tenant-admin (opc.)
            </span>
            <select
              value={form.initialAdminUserId}
              onChange={(e) => setForm((f) => ({ ...f, initialAdminUserId: e.target.value }))}
              className={inputClass}
            >
              <option value="">Nincs — később adom hozzá</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
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
              Tenant létrehozása
            </button>
          </div>
        </form>
      </Card>

      <Card title={`Tenantok (${tenants.length})`}>
        {tenants.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs tenant.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-3">Tenant</th>
                  <th className="py-2 pr-3">Slug</th>
                  <th className="py-2 pr-3">Státusz</th>
                  <th className="py-2 pr-3 text-right">Műveletek</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-b border-line/50">
                    <td className="py-2.5 pr-3">
                      <span className="font-medium text-ink">{t.displayName}</span>
                      {t.legalName && <span className="block text-xs text-ink-faint">{t.legalName}</span>}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-ink-soft">{t.slug}</td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={statusTone[t.status] ?? 'neutral'}>{t.status}</Badge>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={pending}
                          className={btnClass}
                          onClick={() => setSelectedTenantId((cur) => (cur === t.id ? null : t.id))}
                        >
                          {selectedTenantId === t.id ? 'Tagok ▲' : 'Tagok'}
                        </button>
                        {t.status === 'active' && (
                          <>
                            <button disabled={pending} className={btnClass} onClick={() => run(() => suspendTenant({ tenantId: t.id }))}>
                              Felfüggeszt
                            </button>
                            <button disabled={pending} className={btnClass} onClick={() => run(() => offboardTenant({ tenantId: t.id }))}>
                              Offboarding
                            </button>
                          </>
                        )}
                        {(t.status === 'suspended' || t.status === 'offboarding') && (
                          <button disabled={pending} className={btnClass} onClick={() => run(() => reactivateTenant({ tenantId: t.id }))}>
                            Visszaállít
                          </button>
                        )}
                        {t.status === 'offboarding' && (
                          <button disabled={pending} className={btnClass} onClick={() => run(() => archiveTenant({ tenantId: t.id }))}>
                            Archivál
                          </button>
                        )}
                        {t.status === 'archived' && <span className="text-xs text-ink-faint">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedTenantId && (
        <PlatformTenantMembershipPanel
          tenantId={selectedTenantId}
          tenantLabel={tenants.find((t) => t.id === selectedTenantId)?.displayName ?? selectedTenantId}
          users={users}
          canManage={canManageMemberships}
          onClose={() => setSelectedTenantId(null)}
        />
      )}
    </div>
  )
}
