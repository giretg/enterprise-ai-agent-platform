'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { adminUnlinkTelegram, type TenantChannelLinkView } from '@/app/actions/channel-link'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Tenant-admin nézet: a szervezet aktív Telegram-kötései, tagonként megszüntethetők
 * (kilépő kolléga esetén azonnal lezárható a csatorna) — Telegram feature-spec #72, D12.
 */
export function AdminChannelLinks({ initialLinks }: { initialLinks: TenantChannelLinkView[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  return (
    <Card title="A szervezet Telegram-kötései">
      <p className="mb-4 text-sm text-ink-soft">
        Adminként bármely tag összekötését megszüntetheted — a hozzáférés azonnal lezárul.
      </p>
      {initialLinks.length === 0 ? (
        <p className="text-sm text-ink-soft">Ebben a szervezetben jelenleg nincs aktív Telegram-kötés.</p>
      ) : (
        <ul className="space-y-2">
          {initialLinks.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-night-2 p-3"
            >
              <div className="text-sm">
                <p className="font-medium text-ink">{l.userName}</p>
                <p className="text-ink-soft">
                  {l.userEmail} · összekötve: {formatDateTime(l.linkedAt)}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                className="rounded-full border border-coral/50 px-4 py-2 text-xs font-semibold text-coral-deep disabled:opacity-50"
                onClick={() => {
                  startTransition(async () => {
                    const res = await adminUnlinkTelegram(l.id)
                    if (res.success) {
                      setMessage({ ok: true, text: `${l.userName} összekötését megszüntettük.` })
                      router.refresh()
                    } else {
                      setMessage({ ok: false, text: res.error })
                    }
                  })
                }}
              >
                Megszüntetés
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <div
          className={`mt-4 rounded-lg border p-3 text-sm ${
            message.ok
              ? 'border-sage/35 bg-sage/10 text-sage'
              : 'border-coral/35 bg-coral/10 text-coral-deep'
          }`}
        >
          {message.text}
        </div>
      )}
    </Card>
  )
}
