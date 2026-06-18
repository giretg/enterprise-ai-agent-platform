'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { purgeTenantWorkspaces } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type WorkspaceOffboardingPanelProps = {
  tenantIds: string[]
}

export function WorkspaceOffboardingPanel({ tenantIds }: WorkspaceOffboardingPanelProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selectedTenant, setSelectedTenant] = useState(tenantIds[0] ?? 'global')
  const [customTenant, setCustomTenant] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveTenant = customTenant.trim() || selectedTenant

  function handlePurge() {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const res = await purgeTenantWorkspaces(effectiveTenant)
      if (res.success) {
        setMessage(`${res.data.deletedObjects} objektum törölve a(z) „${effectiveTenant}” tenant workspace-eiből.`)
        setConfirmed(false)
        router.refresh()
      } else {
        setError(res.error ?? 'Törlés sikertelen')
      }
    })
  }

  return (
    <Card title="Tenant offboarding — workspace törlés">
      <p className="mb-4 text-sm text-ink-soft">
        GDPR / offboarding esetén az összes agent workspace azonnal törlődik a kiválasztott tenant
        prefix alatt (§5.3). A művelet visszavonhatatlan.
      </p>

      <div className="space-y-3">
        <label className="block text-sm text-ink-soft">
          Tenant
          <select
            value={selectedTenant}
            onChange={(event) => {
              setSelectedTenant(event.target.value)
              setCustomTenant('')
            }}
            disabled={pending}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
          >
            <option value="global">global (null tenantId fallback)</option>
            {tenantIds.map((tenantId) => (
              <option key={tenantId} value={tenantId}>
                {tenantId}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm text-ink-soft">
          Egyedi tenant ID (opcionális)
          <input
            value={customTenant}
            onChange={(event) => setCustomTenant(event.target.value)}
            placeholder="uuid vagy „global”"
            disabled={pending}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 font-mono text-sm text-ink"
          />
        </label>

        <label className="flex items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={pending}
            className="mt-1"
          />
          <span>
            Megerősítem, hogy a(z){' '}
            <span className="font-mono text-ink">{effectiveTenant}</span> tenant összes workspace
            fájlja véglegesen törlődik.
          </span>
        </label>

        <button
          type="button"
          onClick={handlePurge}
          disabled={pending || !confirmed}
          className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Törlés...' : 'Workspace-ek törlése'}
        </button>
      </div>

      {message && <p className="mt-3 text-sm text-sage">{message}</p>}
      {error && <p className="mt-3 text-sm text-coral">{error}</p>}
    </Card>
  )
}
