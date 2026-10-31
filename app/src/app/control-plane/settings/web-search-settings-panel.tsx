'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { saveWebSearchSettingsAction, type WebSearchAdminView } from '@/app/actions/web-search'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge, Card } from '@/components/ui/shell'

const lines = (text: string) => text.split(/[\n,]/).map((d) => d.trim()).filter(Boolean)

/** #1020: céges webes keresés — kulcs, domain-szabályok, napi keret, külső AI-kliensek kapcsolója. */
export function WebSearchSettingsPanel({ initial, canEdit }: { initial: WebSearchAdminView; canEdit: boolean }) {
  const [view, setView] = useState(initial)
  const [apiKey, setApiKey] = useState('')
  const [generalWeb, setGeneralWeb] = useState(initial.config.allowGeneralWeb)
  const [allowed, setAllowed] = useState(initial.config.allowedDomains.join('\n'))
  const [denied, setDenied] = useState(initial.config.deniedDomains.join('\n'))
  const [dailyText, setDailyText] = useState(String(initial.config.maxQueriesPerAgentDay))
  const [externalClients, setExternalClients] = useState(initial.externalClients)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const daily = Number(dailyText)

  function save() {
    if (!canEdit || pending) return
    if (!Number.isInteger(daily) || daily < 1) {
      setMessage({ tone: 'error', text: 'A napi keret legalább 1 keresés legyen.' })
      return
    }
    if (!generalWeb && lines(allowed).length === 0) {
      setMessage({ tone: 'error', text: 'Ha nem kereshet bárhol, adj meg legalább egy engedélyezett oldalt.' })
      return
    }
    startTransition(async () => {
      setMessage(null)
      const res = await saveWebSearchSettingsAction({
        apiKey,
        config: {
          ...view.config,
          allowGeneralWeb: generalWeb,
          allowedDomains: lines(allowed),
          deniedDomains: lines(denied),
          maxQueriesPerAgentDay: daily,
        },
        externalClients,
      })
      if (res.success) {
        setView(res.data)
        setApiKey('')
        setMessage({ tone: 'ok', text: 'Mentve. A munkatársaknál az újraközzététel után érvényes.' })
      } else {
        setMessage({ tone: 'error', text: res.error })
      }
    })
  }

  return (
    <Card title="Webes keresés">
      <div className="space-y-5 text-sm">
        <p className="text-ink-soft">
          A munkatársak a cég saját keresőkulcsával kereshetnek a nyilvános weben. Minden keresés a cég naplójába kerül, a
          kártyaszámot, jelszót vagy személyes adatot tartalmazó keresést a rendszer nem küldi ki.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {view.keyConfigured ? <Badge tone="success">Keresőkulcs beállítva</Badge> : <Badge tone="warning">Nincs keresőkulcs</Badge>}
          {view.agentsWithWebSearch === 0 ? (
            <span className="text-ink-soft">
              Még egy munkatársnál sincs bekapcsolva: a munkatárs szerkesztésénél kapcsold be a „Webes keresés” eszközt, majd tedd
              közzé.
            </span>
          ) : (
            <span className="text-ink-soft">{view.agentsWithWebSearch} munkatársnál bekapcsolva.</span>
          )}
        </div>

        <label className="block">
          <span className="mb-1 flex items-center font-semibold">
            Brave Search API-kulcs
            <HelpHint>
              A keresést a Brave Search végzi, a cég saját előfizetésével. Kulcsot a brave.com/search/api oldalon lehet kérni. A
              kulcs titkosított tárolóba kerül, itt később sem látszik.
            </HelpHint>
          </span>
          <input
            type="password"
            autoComplete="new-password"
            disabled={!canEdit}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={view.keyConfigured ? 'Üresen hagyva a mostani kulcs marad' : 'BSA…'}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-ink"
          />
        </label>

        <label className="flex items-start gap-2">
          <input type="checkbox" disabled={!canEdit} checked={generalWeb} onChange={(e) => setGeneralWeb(e.target.checked)} className="mt-1" />
          <span>
            <span className="font-semibold">Bárhol kereshet a weben</span>
            <span className="block text-ink-soft">
              Kikapcsolva csak az alább engedélyezett oldalakon keres (például hatósági vagy szállítói oldalakon).
            </span>
          </span>
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block font-semibold">Engedélyezett oldalak</span>
            <textarea
              rows={4}
              disabled={!canEdit}
              value={allowed}
              onChange={(e) => setAllowed(e.target.value)}
              placeholder={'mnb.hu\n*.gov.hu'}
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-ink"
            />
            <span className="text-xs text-ink-soft">Soronként egy. A *.gov.hu minden aloldalt jelent.</span>
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold">Tiltott oldalak</span>
            <textarea
              rows={4}
              disabled={!canEdit}
              value={denied}
              onChange={(e) => setDenied(e.target.value)}
              placeholder="pastebin.com"
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-ink"
            />
            <span className="text-xs text-ink-soft">Ezekről az oldalakról találat sem jelenik meg.</span>
          </label>
        </div>

        <label className="block max-w-xs">
          <span className="mb-1 block font-semibold">Napi keret munkatársanként</span>
          <input
            type="number"
            min={1}
            disabled={!canEdit}
            value={dailyText}
            onChange={(e) => setDailyText(e.target.value)}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-ink"
          />
          <span className="text-xs text-ink-soft">Keresés / 24 óra. Ennyi után a munkatárs másnapig nem keres.</span>
        </label>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={externalClients}
            onChange={(e) => setExternalClients(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="flex items-center font-semibold">
              Céges webes eszközök külső AI-klienseknek is
              <HelpHint>
                Bekapcsolva a Claude, ChatGPT/Codex és hasonló programok is a céges webes keresőt kapják, így minden keresés a cég
                naplójában lesz. Kikapcsolva ezek a programok a saját keresőjüket használják.
              </HelpHint>
            </span>
            <span className="block text-ink-soft">A platform beszélgetése és a menedzselt Hermes ettől függetlenül megkapja.</span>
          </span>
        </label>

        <p className="text-ink-soft">
          Hogy kinek engedett a webes keresés, azt az{' '}
          <Link href="/control-plane/ai-client-policy" className="text-coral-deep underline">
            AI-kliens szabályzat
          </Link>{' '}
          dönti el: a Kötött pályán tiltott, a Standard és a Szabad beállításnál engedett.
        </p>

        {canEdit ? (
          <button
            type="button"
            disabled={pending}
            onClick={save}
            className="rounded-lg bg-coral px-4 py-2 font-semibold text-white disabled:opacity-40"
          >
            {pending ? 'Mentés…' : 'Mentés'}
          </button>
        ) : null}
        {message ? <p className={message.tone === 'ok' ? 'text-sage' : 'text-coral'}>{message.text}</p> : null}
      </div>
    </Card>
  )
}
