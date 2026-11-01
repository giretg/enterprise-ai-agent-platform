'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  addPublicKbTextAction,
  copyDocumentToPublicKbAction,
  deletePublicKbDocumentAction,
  uploadPublicKbFileAction,
} from '@/app/actions/public-assistant'

const input = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

/** #1016 D4: a nyilvános tudásbázis — „ami ide kerül, az nyilvános”. Belső dokumentum csak másolással. */
export function PublicKbPanel({
  agentId,
  connectorId,
  documents,
  copyable,
  canEdit,
}: {
  agentId: string
  connectorId: string
  documents: Array<{ id: string; filename: string; createdAt: string }>
  copyable: Array<{ id: string; filename: string }>
  canEdit: boolean
}) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [copyId, setCopyId] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string, after?: () => void) {
    startTransition(async () => {
      const res = await fn()
      setNotice(res.success ? okText : (res.error ?? 'Nem sikerült.'))
      if (res.success) {
        after?.()
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-honey/30 bg-honey/10 px-3 py-2 text-sm text-ink">
        Ami ebbe a tudásbázisba kerül, azt az interneten bárki megtudhatja az asszisztenstől. Belső, bizalmas anyagot ne
        tegyél ide.
      </p>

      <section className="atelier-card space-y-3 p-5">
        <h2 className="font-display text-lg font-semibold">Tartalom ({documents.length})</h2>
        {documents.length === 0 ? (
          <p className="text-sm text-ink-soft">Még üres. Adj hozzá szöveget vagy fájlt, hogy az asszisztens tudjon miből válaszolni.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">{doc.filename}</span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-ink-soft">
                  {new Date(doc.createdAt).toLocaleDateString('hu-HU')}
                  {canEdit ? (
                    <button
                      type="button"
                      disabled={pending}
                      className="font-semibold text-coral"
                      onClick={() => {
                        if (confirm(`Törlöd: ${doc.filename}?`)) run(() => deletePublicKbDocumentAction({ agentId, connectorId, documentId: doc.id }), 'Törölve.')
                      }}
                    >
                      Törlés
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit ? (
        <>
          <section className="atelier-card space-y-3 p-5">
            <h2 className="font-display text-lg font-semibold">Szöveg hozzáadása</h2>
            <input className={input} placeholder="Cím, pl. Szállítási feltételek" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            <textarea className={input} rows={6} placeholder="Ide írd vagy másold be a szöveget…" value={text} onChange={(e) => setText(e.target.value)} />
            <button
              type="button"
              disabled={pending || !text.trim()}
              className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              onClick={() => run(() => addPublicKbTextAction({ agentId, connectorId, title, text }), 'Hozzáadva.', () => { setTitle(''); setText('') })}
            >
              Hozzáadás
            </button>
          </section>

          <section className="atelier-card space-y-3 p-5">
            <h2 className="font-display text-lg font-semibold">Fájl feltöltése</h2>
            <p className="text-xs text-ink-soft">PDF, Word, szöveg — a szövegét olvassa ki az asszisztens.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const form = e.currentTarget
                const data = new FormData(form)
                data.set('agentId', agentId)
                data.set('connectorId', connectorId)
                run(() => uploadPublicKbFileAction(data), 'Feltöltve.', () => form.reset())
              }}
              className="flex flex-wrap items-center gap-3"
            >
              <input type="file" name="file" className="text-sm" required />
              <button type="submit" disabled={pending} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold">
                Feltöltés
              </button>
            </form>
          </section>

          <section className="atelier-card space-y-3 p-5">
            <h2 className="font-display text-lg font-semibold">Meglévő dokumentum másolása</h2>
            <p className="text-xs text-ink-soft">
              Egy belső tudásbázis dokumentumáról másolat készül ide. Az eredeti a helyén marad, és a későbbi
              módosításai nem kerülnek át automatikusan.
            </p>
            {copyable.length === 0 ? (
              <p className="text-sm text-ink-soft">Nincs másolható dokumentum.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select className="min-w-0 flex-1 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm" value={copyId} onChange={(e) => setCopyId(e.target.value)}>
                  <option value="">Válassz dokumentumot…</option>
                  {copyable.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.filename}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={pending || !copyId}
                  className="rounded-lg border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  onClick={() => {
                    if (confirm('A másolat tartalmát bárki megtudhatja az asszisztenstől. Folytatod?')) {
                      run(() => copyDocumentToPublicKbAction({ agentId, connectorId, documentId: copyId }), 'Átmásolva.', () => setCopyId(''))
                    }
                  }}
                >
                  Másolás ide
                </button>
              </div>
            )}
          </section>
        </>
      ) : null}
      {notice ? <p className="text-sm text-ink">{notice}</p> : null}
    </div>
  )
}
