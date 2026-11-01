'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setWidgetDomainsAction, updatePublicAssistantSlugAction } from '@/app/actions/public-assistant'

type Tab = 'own' | 'wordpress' | 'wix'

function CopyBox({ value, multiline = false }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-start gap-2">
      {multiline ? (
        <pre className="flex-1 overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-night-2 p-3 text-xs">{value}</pre>
      ) : (
        <code className="flex-1 overflow-x-auto rounded-lg border border-line bg-night-2 px-3 py-2 text-xs">{value}</code>
      )}
      <button
        type="button"
        className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-semibold"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? 'Másolva' : 'Másolás'}
      </button>
    </div>
  )
}

/** #1016 D21: hétköznapi nyelvű beépítési útmutató — script, link, QR, állapot, domain-lista. */
export function PublicEmbedGuide({
  agentId,
  slug,
  appOrigin,
  color,
  qrSvg,
  isPublished,
  paused,
  lastLoaded,
  domains,
  isAdmin,
  turnstileReady,
  testHref,
}: {
  agentId: string
  slug: string
  appOrigin: string
  color: string
  qrSvg: string
  isPublished: boolean
  paused: boolean
  lastLoaded: { domain: string | null; at: string } | null
  domains: string[]
  isAdmin: boolean
  turnstileReady: boolean
  testHref: string | null
}) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('own')
  const [domainText, setDomainText] = useState(domains.join('\n'))
  const [slugText, setSlugText] = useState(slug)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const link = `${appOrigin}/c/${slug}`
  const snippet = `<script src="${appOrigin}/public-chat-widget.js" data-slug="${slug}" data-color="${color}" async></script>`
  const contextSnippet = `<script>\n  window.ExcellenceChat = { context: { ugyfelAzonosito: "12345", oldal: "Kosár" } }\n</script>`

  const status = !isPublished
    ? 'Még nincs élesítve — a látogatók nem érik el.'
    : paused
      ? 'Szüneteltetve — a látogatók „nem elérhető” üzenetet látnak.'
      : 'Élesítve — a link és a widget működik.'

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string) {
    startTransition(async () => {
      const res = await fn()
      setNotice(res.success ? okText : (res.error ?? 'Nem sikerült.'))
      if (res.success) router.refresh()
    })
  }

  return (
    <div className="space-y-5">
      <section className="atelier-card space-y-2 p-5">
        <h2 className="font-display text-lg font-semibold">Állapot</h2>
        <p className="text-sm text-ink">{status}</p>
        <p className="text-sm text-ink-soft">
          {lastLoaded
            ? `Utoljára betöltve: ${lastLoaded.domain ?? 'ismeretlen oldalról'}, ${new Date(lastLoaded.at).toLocaleString('hu-HU')}`
            : 'Még senki nem töltötte be a chatet.'}
        </p>
        {!turnstileReady ? (
          <p className="rounded-lg border border-honey/30 bg-honey/10 px-3 py-2 text-xs text-ink">
            A robotok elleni védelem (Cloudflare Turnstile) ezen a platformon még nincs beállítva. A napi keret és az
            üzenetkorlát így is véd, de kérd meg az üzemeltetőt a bekapcsolására.
          </p>
        ) : null}
        {testHref ? (
          <a href={testHref} target="_blank" rel="noopener" className="inline-block rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white">
            Próbáld ki most
          </a>
        ) : null}
      </section>

      <section className="atelier-card space-y-3 p-5">
        <h2 className="font-display text-lg font-semibold">1. Megosztható link</h2>
        <p className="text-sm text-ink-soft">Ezt küldheted e-mailben, teheted ki a közösségi oldaladra vagy nyomtathatod QR-kódként.</p>
        <CopyBox value={link} />
        <div className="flex items-end gap-4">
          <div className="h-36 w-36 rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <a
            className="text-xs font-semibold text-coral"
            download={`${slug}-qr.svg`}
            href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
          >
            QR-kód letöltése
          </a>
        </div>
      </section>

      <section className="atelier-card space-y-3 p-5">
        <h2 className="font-display text-lg font-semibold">2. Chat-buborék a weboldaladon</h2>
        <div className="flex gap-2 text-sm">
          {(
            [
              ['own', 'Saját oldal'],
              ['wordpress', 'WordPress'],
              ['wix', 'Wix'],
            ] as const
          ).map(([id, text]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-full px-3 py-1 ${tab === id ? 'bg-coral text-white' : 'border border-line text-ink-soft'}`}
            >
              {text}
            </button>
          ))}
        </div>
        {tab === 'own' ? (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>Másold ki az alábbi sort.</li>
            <li>Illeszd be a weboldalad minden oldalára, a záró &lt;/body&gt; elé (vagy kérd meg a fejlesztődet).</li>
            <li>Add hozzá a weboldalad címét lent, az „Engedélyezett weboldalak” listához.</li>
          </ol>
        ) : tab === 'wordpress' ? (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>Telepítsd a „WPCode” (vagy hasonló „fejléc/lábléc kód”) bővítményt.</li>
            <li>Kódrészletek → Fejléc és lábléc → a „Lábléc” mezőbe illeszd be az alábbi sort, majd ments.</li>
            <li>Add hozzá a weboldalad címét lent, az „Engedélyezett weboldalak” listához.</li>
          </ol>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>Wix szerkesztő → Beállítások → Egyéni kód → „+ Egyéni kód hozzáadása”.</li>
            <li>Illeszd be az alábbi sort, válaszd: „Minden oldal”, elhelyezés: „Body – vége”.</li>
            <li>Add hozzá a weboldalad címét lent, az „Engedélyezett weboldalak” listához.</li>
          </ol>
        )}
        <CopyBox value={snippet} multiline />
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-soft">Haladó: információ átadása a beszélgetésnek</summary>
          <p className="mt-2 text-xs text-ink-soft">
            A widget a beillesztés előtt megadott adatokat (pl. ügyfélazonosító, melyik oldalon jár a látogató) átadja az
            asszisztensnek. Ezt ellenőrizetlen információként kezeljük: segít a válaszban, de semmilyen adat
            lekérdezéséhez nem használjuk. Legfeljebb 8 kB.
          </p>
          <div className="mt-2">
            <CopyBox value={contextSnippet} multiline />
          </div>
        </details>
      </section>

      <section className="atelier-card space-y-3 p-5">
        <h2 className="font-display text-lg font-semibold">Engedélyezett weboldalak</h2>
        <p className="text-sm text-ink-soft">
          A chat-buborék csak ezeken a weboldalakon jelenhet meg (a cég összes nyilvános asszisztensére érvényes).
          Soronként egy cím, pl. <code>www.ceg.hu</code> vagy <code>*.ceg.hu</code>. Üres lista esetén csak a link működik.
        </p>
        <textarea
          className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          rows={4}
          value={domainText}
          disabled={!isAdmin || pending}
          onChange={(e) => setDomainText(e.target.value)}
        />
        {isAdmin ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => setWidgetDomainsAction({ agentId, domains: domainText.split('\n') }), 'A weboldal-lista mentve.')}
            className="rounded-lg border border-line px-4 py-2 text-sm font-semibold"
          >
            Lista mentése
          </button>
        ) : (
          <p className="text-xs text-ink-soft">A listát adminisztrátor módosíthatja.</p>
        )}
      </section>

      {isAdmin ? (
        <section className="atelier-card space-y-3 p-5">
          <h2 className="font-display text-lg font-semibold">A link címe</h2>
          <p className="text-sm text-ink-soft">
            Figyelem: ha élesítés után módosítod, a régi link, QR-kód és beépített widget nem fog működni.
          </p>
          <div className="flex gap-2">
            <span className="self-center text-sm text-ink-soft">{appOrigin}/c/</span>
            <input className="flex-1 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm" value={slugText} onChange={(e) => setSlugText(e.target.value)} />
            <button
              type="button"
              disabled={pending || slugText === slug}
              onClick={() => run(() => updatePublicAssistantSlugAction({ agentId, slug: slugText }), 'A cím módosult.')}
              className="rounded-lg border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Módosítás
            </button>
          </div>
        </section>
      ) : null}
      {notice ? <p className="text-sm text-ink">{notice}</p> : null}
    </div>
  )
}
