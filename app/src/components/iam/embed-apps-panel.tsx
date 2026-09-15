'use client'

/**
 * Beágyazott agent-chat — „Beágyazó alkalmazások" szerkesztő (feature-spec #481, D7).
 *
 * ÜZLETI JELENTÉS: itt engedélyezheted, hogy egy másik rendszered — például a CRM —
 * a saját felületéről nyisson beszélgetést az agenteiddel. Add meg a rendszer nevét
 * és a címét (origin); a felhasználók a platform-fiókjukkal lépnek be.
 */
import { useState, useTransition } from 'react'
import { addEmbedApp, removeEmbedApp } from '@/app/actions/embed-apps'
import { Card } from '@/components/ui/shell'
import type { EmbedApp } from '@/lib/embed-apps'

export function EmbedAppsPanel({ initialApps }: { initialApps: EmbedApp[] }) {
  const [apps, setApps] = useState(initialApps)
  const [name, setName] = useState('')
  const [origin, setOrigin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [removingSlug, setRemovingSlug] = useState<string | null>(null)
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)

  /** A beágyazó app fejlesztőjének átadható bekötő-kód (spec §8) — a slug már benne van. */
  function snippetFor(app: EmbedApp): string {
    const platform = typeof window === 'undefined' ? '' : window.location.origin
    return [
      `const PLATFORM = '${platform}'`,
      `const win = window.open(`,
      `  \`\${PLATFORM}/embed/agents/\${agentId}?app=${app.slug}&thread=\${encodeURIComponent(recordId)}\`,`,
      `  'eai-chat', 'popup,width=480,height=720')`,
      `window.addEventListener('message', (e) => {`,
      `  if (e.origin !== PLATFORM || e.data?.type !== 'eai:ready') return`,
      `  win.postMessage({ type: 'eai:context', label: 'Megnyitott ügy', data: record }, PLATFORM)`,
      `})`,
    ].join('\n')
  }

  function copySnippet(app: EmbedApp) {
    void navigator.clipboard.writeText(snippetFor(app)).then(() => {
      setCopiedSlug(app.slug)
      setTimeout(() => setCopiedSlug(null), 2000)
    })
  }

  function submitAdd() {
    setError(null)
    startTransition(async () => {
      const res = await addEmbedApp({ name, origin })
      if (res.success) {
        setApps(res.data.apps)
        setName('')
        setOrigin('')
      } else {
        setError(res.error)
      }
    })
  }

  function submitRemove(slug: string) {
    setError(null)
    setRemovingSlug(slug)
    startTransition(async () => {
      const res = await removeEmbedApp({ slug })
      if (res.success) setApps(res.data.apps)
      else setError(res.error)
      setRemovingSlug(null)
    })
  }

  return (
    <Card title="Beágyazó alkalmazások">
      <p className="mb-4 text-sm text-ink-soft">
        Itt engedélyezheted, hogy egy másik rendszered — például a CRM — a saját
        felületéről nyisson beszélgetést az agenteiddel. Add meg a rendszer nevét és a
        címét (origin); a felhasználók a platform-fiókjukkal lépnek be.
      </p>
      <p className="mb-4 text-xs text-ink-faint">
        Hogyan működik: a másik rendszerben egy gomb külön ablakban megnyitja a platform
        chatjét (<code>/embed/agents/&lt;agent-azonosító&gt;?app=&lt;slug&gt;&amp;thread=&lt;ügy-azonosító&gt;</code>),
        és átadja neki a megnyitott ügy adatait. A bekötő-kódot a „Bekötő-kód másolása”
        gombbal add át a rendszer fejlesztőjének.
      </p>

      {apps.length === 0 ? (
        <p className="mb-5 rounded-lg border border-line bg-ink/5 px-3 py-2 text-sm text-ink-faint">
          Még nincs engedélyezett alkalmazás — amíg a lista üres, a beágyazott chat
          zárva van.
        </p>
      ) : (
        <ul className="mb-5 divide-y divide-line rounded-lg border border-line">
          {apps.map((app) => (
            <li key={app.slug} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{app.name}</p>
                <p className="truncate text-xs text-ink-faint">
                  {app.origin} · slug: {app.slug}
                </p>
              </div>
              <button
                type="button"
                onClick={() => copySnippet(app)}
                className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-ink/5"
                title="A beágyazó app fejlesztőjének átadható JavaScript-részlet, ezzel a sluggal."
              >
                {copiedSlug === app.slug ? 'Másolva' : 'Bekötő-kód másolása'}
              </button>
              <button
                type="button"
                onClick={() => submitRemove(app.slug)}
                disabled={pending}
                className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10 disabled:opacity-50"
              >
                {removingSlug === app.slug && pending ? 'Törlés...' : 'Törlés'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rendszer neve (pl. CRM)"
          className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder="https://crm.example.com"
          title="A rendszer címe a böngésző címsorából, útvonal nélkül (pl. https://crm.cegnev.hu). Csak innen fogadjuk el az átadott ügy-adatokat."
          className="flex-1 rounded-lg border border-line bg-card px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={submitAdd}
          disabled={pending || !name.trim() || !origin.trim()}
          className="shrink-0 rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
        >
          {pending && removingSlug === null ? 'Hozzáadás...' : 'Hozzáadás'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-coral">{error}</p>}
    </Card>
  )
}
