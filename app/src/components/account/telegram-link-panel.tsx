'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  markMyNotificationRead,
  startTelegramLink,
  unlinkMyTelegram,
  type ChannelLinkView,
  type UserNotificationView,
} from '@/app/actions/channel-link'

const STATUS_LABEL: Record<string, string> = {
  active: 'Összekötve',
  revoked: 'Megszüntetve',
  blocked: 'A bot letiltva a Telegramon',
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short' })
}

export function TelegramLinkPanel({
  initialLinks,
  initialNotifications,
}: {
  initialLinks: ChannelLinkView[]
  initialNotifications: UserNotificationView[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [pendingLink, setPendingLink] = useState<{ deepLink: string; warning: string; expiresAt: string } | null>(null)

  const activeTelegram = initialLinks.find((l) => l.channelType === 'telegram' && l.status === 'active')
  const history = initialLinks.filter((l) => l !== activeTelegram)

  return (
    <div className="space-y-6">
      <Card title="Telegram összekötése">
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            Ha összekötöd a Telegram-fiókodat, telefonról is elérheted az agentjeidet — jelszó
            megadása nélkül. Egy összekötés mindig egyetlen szervezethez tartozik; a szerepköreid
            minden üzenetnél frissen érvényesülnek.
          </p>
          {!activeTelegram && (
            <div className="rounded-lg border border-line bg-night-2 p-3 text-sm text-ink-soft">
              <p className="font-medium text-ink">Így fog menni:</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                <li>Rákattintasz az alábbi gombra, és elolvasod a figyelmeztetést.</li>
                <li>Megnyílik a Telegram a mi botunkkal — ott a „Start&rdquo; gombra koppintasz.</li>
                <li>A bot visszaigazolja az összekötést. Jelszót sehol nem adsz meg.</li>
              </ol>
              <p className="mt-2">
                Ha elveszíted a telefonod, ezen az oldalon egy gombbal azonnal lezárhatod a
                hozzáférést.
              </p>
            </div>
          )}

          {activeTelegram ? (
            <div className="rounded-lg border border-sage/35 bg-sage/10 p-4">
              <p className="text-sm font-medium text-ink">Telegram-fiók összekötve</p>
              <dl className="mt-2 space-y-1 text-sm text-ink-soft">
                <div className="flex gap-2">
                  <dt>Szervezet:</dt>
                  <dd className="text-ink">{activeTelegram.orgName ?? '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt>Összekötve:</dt>
                  <dd className="text-ink">{formatDateTime(activeTelegram.linkedAt)}</dd>
                </div>
              </dl>
              <button
                type="button"
                disabled={pending}
                className="mt-4 rounded-full border border-coral/50 px-4 py-2 text-sm font-semibold text-coral-deep disabled:opacity-50"
                onClick={() => {
                  startTransition(async () => {
                    const res = await unlinkMyTelegram(activeTelegram.id)
                    if (res.success) {
                      setMessage({ ok: true, text: 'Az összekötést megszüntettük. A hozzáférés azonnal lezárult.' })
                      router.refresh()
                    } else {
                      setMessage({ ok: false, text: res.error })
                    }
                  })
                }}
              >
                Összekötés megszüntetése
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={pending}
                className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(178,58,85,0.7)] disabled:opacity-50"
                onClick={() => {
                  startTransition(async () => {
                    setMessage(null)
                    const res = await startTelegramLink()
                    if (res.success) {
                      setPendingLink(res.data)
                    } else {
                      setMessage({ ok: false, text: res.error })
                    }
                  })
                }}
              >
                Telegram összekötése
              </button>

              {pendingLink && (
                <div className="rounded-lg border border-amber/40 bg-amber/10 p-4">
                  <p className="text-sm font-semibold text-ink">Mielőtt folytatod:</p>
                  <p className="mt-1 text-sm text-ink-soft">{pendingLink.warning}</p>
                  <a
                    href={pendingLink.deepLink}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card"
                  >
                    Megnyitom a Telegramban
                  </a>
                  <p className="mt-2 text-xs text-ink-soft">
                    A link {formatDateTime(pendingLink.expiresAt)}-ig, és csak egyszer érvényes.
                    Ha lejár, kérj újat ezzel a gombbal.
                  </p>
                </div>
              )}
            </>
          )}

          {message && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                message.ok
                  ? 'border-sage/35 bg-sage/10 text-sage'
                  : 'border-coral/35 bg-coral/10 text-coral-deep'
              }`}
            >
              {message.text}
            </div>
          )}
        </div>
      </Card>

      {history.length > 0 && (
        <Card title="Korábbi összekötések">
          <ul className="space-y-2 text-sm text-ink-soft">
            {history.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-3">
                <span className="text-ink">{l.orgName ?? '—'}</span>
                <span>{STATUS_LABEL[l.status] ?? l.status}</span>
                <span>· {formatDateTime(l.linkedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
    </div>
  )
}
