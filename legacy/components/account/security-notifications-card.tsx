'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  markMyNotificationRead,
  type UserNotificationView,
} from '@/app/actions/channel-link'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short' })
}

export function SecurityNotificationsCard({
  initialNotifications,
}: {
  initialNotifications: UserNotificationView[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Card title="Biztonsági értesítések">
      {initialNotifications.length === 0 ? (
        <p className="text-sm text-ink-soft">Nincs értesítésed.</p>
      ) : (
        <ul className="space-y-3">
          {initialNotifications.map((n) => (
            <li
              key={n.id}
              className={`rounded-lg border p-3 ${
                n.readAt ? 'border-line bg-night-2' : 'border-amber/40 bg-amber/10'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">{n.title}</p>
                  <p className="mt-1 text-sm text-ink-soft">{n.body}</p>
                  <p className="mt-1 text-xs text-ink-soft">{formatDateTime(n.createdAt)}</p>
                </div>
                {!n.readAt && (
                  <button
                    type="button"
                    disabled={pending}
                    className="shrink-0 text-xs font-semibold text-coral-deep disabled:opacity-50"
                    onClick={() => {
                      startTransition(async () => {
                        await markMyNotificationRead(n.id)
                        router.refresh()
                      })
                    }}
                  >
                    Olvasottnak jelölöm
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
