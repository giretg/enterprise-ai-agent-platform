'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import {
  startTelegramLink,
  unlinkMyTelegram,
  type ChannelLinkView,
} from '@/app/actions/channel-link'
import type { MyChannelAgentsView } from '@/app/actions/channel-agents'
import { ConnectionCard } from '@/components/account/connection-card'
import { MyChannelAgents } from '@/components/account/my-channel-agents'

const STATUS_LABEL: Record<string, string> = {
  active: 'Összekötve',
  revoked: 'Megszüntetve',
  blocked: 'A bot letiltva a Telegramon',
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short' })
}

type PendingTelegramLink = {
  deepLink: string
  warning: string
  expiresAt: string
}

function TelegramConnectionModal({
  pending,
  pendingLink,
  error,
  returnFocusRef,
  onClose,
}: {
  pending: boolean
  pendingLink: PendingTelegramLink | null
  error: string | null
  returnFocusRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const returnFocusTarget = returnFocusRef.current
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = originalOverflow
      returnFocusTarget?.focus()
    }
  }, [mounted, onClose, returnFocusRef])

  if (!mounted) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="atelier-card w-full max-w-lg overflow-hidden p-0 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], select:not([disabled])',
          )
          if (!focusable || focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="flex items-start gap-4 border-b border-line/70 px-5 py-5 sm:px-6">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#2AABEE]/12 text-[#168AC0]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="h-6 w-6"
              aria-hidden="true"
            >
              <path d="M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="9" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#168AC0]">
              Így fog menni
            </p>
            <h3 id={titleId} className="mt-1 font-display text-xl font-semibold text-ink">
              Telegram összekötése
            </h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Bezárás"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl leading-none text-ink-soft transition-colors hover:bg-line/40 hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <ol id={descriptionId} className="space-y-4">
            {[
              'Megnyitjuk a Telegramot a hivatalos botunkkal.',
              'A Telegramban a „Start” gombra koppintasz.',
              'A bot visszaigazolja az összekötést. Jelszót sehol nem adsz meg.',
            ].map((step, index) => (
              <li key={step} className="flex gap-3 text-sm leading-6 text-ink-soft">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-coral/10 text-xs font-semibold text-coral-deep">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          {pending && !pendingLink ? (
            <p className="rounded-xl border border-line bg-night-2 px-4 py-3 text-sm text-ink-soft" role="status">
              Az egyszer használható, biztonságos link előkészítése…
            </p>
          ) : null}

          {error ? (
            <p className="rounded-xl border border-coral/35 bg-coral/10 px-4 py-3 text-sm text-coral-deep" role="alert">
              {error}
            </p>
          ) : null}

          {pendingLink ? (
            <div className="rounded-xl border border-amber/40 bg-amber/10 p-4">
              <p className="text-sm font-semibold text-ink">Mielőtt folytatod</p>
              <p className="mt-1 text-sm leading-6 text-ink-soft">{pendingLink.warning}</p>
              <a
                href={pendingLink.deepLink}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(178,58,85,0.7)]"
              >
                Megnyitom a Telegramban
              </a>
              <p className="mt-3 text-xs leading-5 text-ink-soft">
                A link {formatDateTime(pendingLink.expiresAt)}-ig és csak egyszer érvényes.
              </p>
            </div>
          ) : null}

          <p className="flex gap-2 text-xs leading-5 text-ink-soft">
            <span aria-hidden="true">🔒</span>
            <span>
              Ha elveszíted a telefonod, ezen az oldalon azonnal megszüntetheted a hozzáférést.
            </span>
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function TelegramLinkPanel({
  initialLinks,
  myAgents,
}: {
  initialLinks: ChannelLinkView[]
  myAgents: MyChannelAgentsView
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [pendingLink, setPendingLink] = useState<PendingTelegramLink | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const connectButtonRef = useRef<HTMLButtonElement>(null)
  const closeGuide = useCallback(() => setGuideOpen(false), [])

  const activeTelegram = initialLinks.find((l) => l.channelType === 'telegram' && l.status === 'active')
  const history = initialLinks.filter((l) => l !== activeTelegram)

  return (
    <ConnectionCard
      name="Telegram"
      provider="telegram"
      description="Telefonról is eléred az agentjeidet — jelszó megadása nélkül. Egy összekötés mindig egyetlen szervezethez tartozik."
      connected={Boolean(activeTelegram)}
      connectedDetail={
        activeTelegram
          ? `${activeTelegram.orgName ?? 'Szervezet'} · ${formatDateTime(activeTelegram.linkedAt)}`
          : undefined
      }
    >
      {activeTelegram ? (
        <div>
          <button
            type="button"
            disabled={pending}
            className="rounded-full border border-coral/50 px-4 py-2 text-sm font-semibold text-coral-deep disabled:opacity-50"
            onClick={() => {
              startTransition(async () => {
                const res = await unlinkMyTelegram(activeTelegram.id)
                if (res.success) {
                  setMessage({
                    ok: true,
                    text: 'Az összekötést megszüntettük. A hozzáférés azonnal lezárult.',
                  })
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
            ref={connectButtonRef}
            type="button"
            disabled={pending}
            className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(178,58,85,0.7)] disabled:opacity-50"
            onClick={() => {
              setGuideOpen(true)
              setPendingLink(null)
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
            Összekötés
          </button>

          {guideOpen ? (
            <TelegramConnectionModal
              pending={pending}
              pendingLink={pendingLink}
              error={message && !message.ok ? message.text : null}
              returnFocusRef={connectButtonRef}
              onClose={closeGuide}
            />
          ) : null}
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

      {activeTelegram ? <MyChannelAgents initialView={myAgents} embedded /> : null}

      {history.length > 0 && (
        <div className="border-t border-line/60 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Korábbi összekötések
          </p>
          <ul className="space-y-1 text-sm text-ink-soft">
            {history.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-3">
                <span className="text-ink">{l.orgName ?? '—'}</span>
                <span>{STATUS_LABEL[l.status] ?? l.status}</span>
                <span>· {formatDateTime(l.linkedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConnectionCard>
  )
}
