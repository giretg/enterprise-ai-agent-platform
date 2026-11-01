'use client'

import { useState, useTransition } from 'react'
import { setPlatformChatAdminInsightAction, type PlatformChatInsightRow } from '@/app/actions/platform-chat'
import { Card } from '@/components/ui/shell'

/** #1004 D15: csak superadmin — tenantonként engedélyezi, hogy a tenant admin lássa a platform-chat beszélgetéseket. */
export function PlatformChatAdminInsightPanel({ rows: initialRows }: { rows: PlatformChatInsightRow[] }) {
  const [rows, setRows] = useState(initialRows)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(row: PlatformChatInsightRow) {
    const next = !row.adminInsight
    if (next && !window.confirm(
      `Engedélyezed, hogy a(z) ${row.displayName} adminisztrátora elolvashassa a munkatársak platform-chat beszélgetéseit?\n\nA munkavállalók tájékoztatása a cég felelőssége. A felhasználók a chatben folyamatosan látni fogják, hogy az adminisztrátor megtekintheti a beszélgetéseiket.`,
    )) return
    startTransition(async () => {
      setError(null)
      const res = await setPlatformChatAdminInsightAction({ tenantId: row.tenantId, enabled: next })
      if (res.success) setRows((all) => all.map((r) => (r.tenantId === row.tenantId ? { ...r, adminInsight: next } : r)))
      else setError(res.error)
    })
  }

  return (
    <Card title="Platform-chat: admin-betekintés">
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">
          Alapból a cég adminisztrátora nem olvashatja a munkatársak platformon folytatott beszélgetéseit. Itt cégenként
          engedélyezheted. Minden megnyitás naplózott, és a felhasználók a chat fejlécében látják, hogy a betekintés be
          van kapcsolva. A munkavállalók tájékoztatása a cég felelőssége.
        </p>
        <ul className="divide-y divide-line/50">
          {rows.map((row) => (
            <li key={row.tenantId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium text-ink">{row.displayName}</span>{' '}
                <span className="text-ink-faint">({row.slug})</span>
                {!row.chatEnabled ? <span className="ml-2 text-xs text-ink-faint">a chat ki van kapcsolva</span> : null}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => toggle(row)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                  row.adminInsight ? 'bg-coral text-white' : 'border border-line bg-panel text-ink hover:border-coral/50'
                }`}
              >
                {row.adminInsight ? 'Engedélyezve — kikapcsolás' : 'Tiltva — engedélyezés'}
              </button>
            </li>
          ))}
        </ul>
        {error ? <p className="text-coral-deep">{error}</p> : null}
      </div>
    </Card>
  )
}
