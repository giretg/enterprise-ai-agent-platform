'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { setPlatformChatSettingsAction, type PlatformChatAdminView } from '@/app/actions/platform-chat'
import { Card } from '@/components/ui/shell'
import { PLATFORM_CHAT_SUGGESTED_BUDGET_USD } from '@/lib/platform-chat-settings'

const usd = (n: number) => `${n.toLocaleString('hu-HU', { maximumFractionDigits: 2 })} USD`

/** #1004 D2/D14: „Beszélgetés a platformon” — be/ki, kötelező napi keret, mai felhasználás. */
export function PlatformChatSettingsPanel({ initial, canEdit }: { initial: PlatformChatAdminView; canEdit: boolean }) {
  const [settings, setSettings] = useState(initial.settings)
  const [budgetText, setBudgetText] = useState(
    String(initial.settings.dailyBudgetUsd ?? PLATFORM_CHAT_SUGGESTED_BUDGET_USD),
  )
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const budget = Number(budgetText.replace(',', '.'))
  const budgetValid = Number.isFinite(budget) && budget > 0
  const spent = initial.spentTodayUsd
  const ratio = settings.dailyBudgetUsd ? Math.min(spent / settings.dailyBudgetUsd, 1) : 0

  function save(enabled: boolean) {
    if (!canEdit || pending) return
    if (!budgetValid) {
      setMessage({ tone: 'error', text: 'Adj meg egy 0-nál nagyobb napi keretet (USD).' })
      return
    }
    startTransition(async () => {
      setMessage(null)
      const res = await setPlatformChatSettingsAction({ enabled, dailyBudgetUsd: budget })
      if (res.success) {
        setSettings(res.data)
        setMessage({
          tone: 'ok',
          text: res.data.enabled
            ? 'Bekapcsolva. A munkatársak a fejléc Chat gombjával érik el a beszélgetést.'
            : 'Mentve. A beszélgetés a platformon most ki van kapcsolva.',
        })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title="Beszélgetés a platformon">
      <div className="space-y-5 text-sm">
        <p className="text-ink-soft">
          Bekapcsolva a munkatársak külön program telepítése nélkül, közvetlenül itt a platformon beszélgethetnek az AI
          munkatársakkal. A beszélgetés a céges modell-kulcson fut, ezért a költséget egy napi keret korlátozza.
        </p>

        {!initial.keyConfigured ? (
          <div className="rounded-lg border border-honey/40 bg-honey/10 p-3">
            <p className="text-ink">A beszélgetéshez céges modell-kulcs kell.</p>
            <Link
              href="/control-plane/settings?section=openrouter"
              className="mt-2 inline-block rounded-lg bg-coral px-3 py-1.5 font-medium text-white"
            >
              Kulcs beállítása
            </Link>
          </div>
        ) : null}

        <div className="space-y-2">
          <label className="block font-medium text-ink" htmlFor="platform-chat-budget">
            Napi keret (USD)
          </label>
          <p className="text-ink-soft">
            Ennyit költhetnek el egy nap alatt összesen a platformon folytatott beszélgetések. Budapesti idő szerint
            éjfélkor nullázódik. Javasolt kezdőérték: {PLATFORM_CHAT_SUGGESTED_BUDGET_USD} USD. A Hermes és a többi
            külső kliens forgalmát ez nem érinti.
          </p>
          <input
            id="platform-chat-budget"
            inputMode="decimal"
            value={budgetText}
            disabled={!canEdit || pending}
            onChange={(e) => setBudgetText(e.target.value)}
            className="w-40 rounded-lg border border-line bg-panel px-3 py-2"
          />
        </div>

        {settings.dailyBudgetUsd ? (
          <div className="space-y-1">
            <p className="text-ink-soft">
              Mai felhasználás: <span className="font-medium text-ink">{usd(spent)}</span> / {usd(settings.dailyBudgetUsd)}
            </p>
            <div className="h-2 w-full max-w-md overflow-hidden rounded-full bg-line/40">
              <div
                className={`h-full ${ratio >= 0.8 ? 'bg-coral' : 'bg-emerald-500'}`}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </div>
            {ratio >= 1 ? (
              <p className="text-coral-deep">A mai keret elfogyott: holnap reggelig nem indul új modellhívás.</p>
            ) : ratio >= 0.8 ? (
              <p className="text-coral-deep">A mai keret több mint 80%-a elfogyott.</p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {settings.enabled ? (
            <>
              <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-800">Bekapcsolva</span>
              <button
                type="button"
                disabled={!canEdit || pending}
                onClick={() => save(true)}
                className="rounded-lg border border-line bg-panel px-4 py-2 font-medium text-ink hover:border-coral/50 disabled:opacity-50"
              >
                Keret mentése
              </button>
              <button
                type="button"
                disabled={!canEdit || pending}
                onClick={() => save(false)}
                className="rounded-lg border border-line bg-panel px-4 py-2 font-medium text-ink hover:border-coral/50 disabled:opacity-50"
              >
                Kikapcsolás
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!canEdit || pending || !initial.keyConfigured}
              onClick={() => save(true)}
              className="rounded-lg bg-coral px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              Bekapcsolás
            </button>
          )}
        </div>

        <p className="text-xs text-ink-soft">
          Munkatársanként a munkatárs oldalán kapcsolhatod ki („Elérhető a platform-chatben”). Alapból minden publikált
          munkatárs elérhető, akihez a felhasználónak hozzáférése van.
          {settings.adminInsight
            ? ' A platform üzemeltetője ennél a cégnél engedélyezte, hogy az adminisztrátor megtekinthesse a beszélgetéseket; a felhasználók ezt a chatben látják.'
            : ''}
        </p>

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800'
                : 'border-coral/35 bg-coral/10 text-coral-deep'
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </Card>
  )
}
