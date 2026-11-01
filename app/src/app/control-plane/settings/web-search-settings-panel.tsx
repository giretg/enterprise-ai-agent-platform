'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { saveWebSearchSettingsAction, type WebSearchAdminView } from '@/app/actions/web-search'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge, Card } from '@/components/ui/shell'

const lines = (text: string) => text.split(/[\n,]/).map((d) => d.trim()).filter(Boolean)

type LimitKey = 'maxQueriesPerAgentDay' | 'maxQueriesPerTenantDay' | 'maxFetchesPerAgentDay' | 'maxFetchesPerTenantDay'

const LIMITS: Array<{ key: LimitKey; label: string }> = [
  { key: 'maxQueriesPerAgentDay', label: 'Keresés munkatársanként' },
  { key: 'maxQueriesPerTenantDay', label: 'Keresés az egész cégnél' },
  { key: 'maxFetchesPerAgentDay', label: 'Megnyitott oldal munkatársanként' },
  { key: 'maxFetchesPerTenantDay', label: 'Megnyitott oldal az egész cégnél' },
]

const limitTexts = (config: WebSearchAdminView['config']) =>
  Object.fromEntries(LIMITS.map(({ key }) => [key, String(config[key])])) as Record<LimitKey, string>

/** #1020/#1021: céges webes keresés és oldalolvasás — kulcs, domain-szabályok, napi keretek, külső AI-kliensek kapcsolója. */
export function WebSearchSettingsPanel({ initial, canEdit }: { initial: WebSearchAdminView; canEdit: boolean }) {
  const [view, setView] = useState(initial)
  const [apiKey, setApiKey] = useState('')
  const [generalWeb, setGeneralWeb] = useState(initial.config.allowGeneralWeb)
  const [allowed, setAllowed] = useState(initial.config.allowedDomains.join('\n'))
  const [denied, setDenied] = useState(initial.config.deniedDomains.join('\n'))
  const [limitText, setLimitText] = useState<Record<LimitKey, string>>(() => limitTexts(initial.config))
  const [externalClients, setExternalClients] = useState(initial.externalClients)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const limits = Object.fromEntries(LIMITS.map(({ key }) => [key, Number(limitText[key])])) as Record<LimitKey, number>

  function save() {
    if (!canEdit || pending) return
    if (LIMITS.some(({ key }) => !Number.isInteger(limits[key]) || limits[key] < 1)) {
      setMessage({ tone: 'error', text: 'Minden napi keret legalább 1 legyen.' })
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
          ...limits,
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
        <p className="flex items-center text-ink-soft">
          A keresés találatait (weboldalt vagy PDF-et) a munkatárs meg is nyithatja és elolvashatja.
          <HelpHint>
            Csak olyan oldalt nyit meg, amelynek a linkje keresési találat, egy már megnyitott oldalon szerepel, a felhasználó maga
            írta be a beszélgetésbe, vagy az engedélyezett oldalak között van. Belső hálózati címet soha nem ér el. Az oldalak
            megnyitását az AI-kliens szabályzatban a web_fetch eszköz tiltásával lehet kikapcsolni.
          </HelpHint>
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

        <div>
          <span className="mb-1 flex items-center font-semibold">
            Napi keretek
            <HelpHint>
              Gördülő 24 órára számolva. Ha egy keret elfogy, a munkatárs közli, hogy aznap már nem keres vagy nem nyit meg több
              oldalt. A cégre vonatkozó keret a keresőszolgáltató költségének plafonja.
            </HelpHint>
          </span>
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            {LIMITS.map(({ key, label }) => (
              <label key={key} className="block">
                <span className="mb-1 block text-ink-soft">{label}</span>
                <input
                  type="number"
                  min={1}
                  disabled={!canEdit}
                  value={limitText[key]}
                  onChange={(e) => setLimitText((prev) => ({ ...prev, [key]: e.target.value }))}
                  className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-ink"
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-ink-soft">
            Használat az egész cégnél — elmúlt 24 óra: {view.usage.searchesDay} keresés, {view.usage.fetchesDay} megnyitott oldal ·
            elmúlt 30 nap: {view.usage.searches30d} keresés, {view.usage.fetches30d} megnyitott oldal. A keresőszolgáltató díja nem
            a modell-keretből megy.
          </p>
        </div>

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
