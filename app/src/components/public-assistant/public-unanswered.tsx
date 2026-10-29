'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  approvePublicAnswerAction,
  dismissPublicSignalAction,
  savePublicAnswerDraftAction,
} from '@/app/actions/public-assistant'

export type UnansweredGroup = {
  /** Az első jelzés azonosítója — a művelet a csoport összes nyitott jelzésére vonatkozik. */
  signalId: string
  label: string
  count: number
  sources: string[]
  examples: string[]
  answerDraft: string | null
  lastAt: string
}

const SOURCE_LABEL: Record<string, string> = {
  uncertain: 'nem volt biztos a válaszban',
  no_kb_hit: 'nem talált a tudásbázisban',
  forward: 'továbbítást kértek',
}

/** #1016 D20: megválaszolatlan kérdések → válasz → (admin jóváhagyás után) nyilvános KB. */
export function PublicUnanswered({
  agentId,
  groups,
  canEdit,
  isAdmin,
}: {
  agentId: string
  groups: UnansweredGroup[]
  canEdit: boolean
  isAdmin: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string) {
    startTransition(async () => {
      const res = await fn()
      setNotice(res.success ? okText : (res.error ?? 'Nem sikerült.'))
      if (res.success) {
        setEditing(null)
        router.refresh()
      }
    })
  }

  return (
    <section className="atelier-card space-y-3 p-5">
      <h2 className="font-display text-lg font-semibold">Megválaszolatlan kérdések</h2>
      <p className="text-xs text-ink-soft">
        Azok a kérdések, amelyekre az asszisztens nem tudott biztosan válaszolni. Naponta egyszer a hasonlókat
        összevonjuk. Írj rájuk választ: adminisztrátori jóváhagyás után a nyilvános tudásbázisba kerül, és legközelebb az
        asszisztens is tudni fogja.
      </p>
      {notice ? <p className="text-sm text-ink">{notice}</p> : null}
      {groups.length === 0 ? (
        <p className="text-sm text-ink-soft">Nincs megválaszolatlan kérdés.</p>
      ) : (
        <ul className="divide-y divide-line">
          {groups.map((g) => (
            <li key={g.signalId} className="space-y-2 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{g.label}</p>
                  <p className="text-xs text-ink-soft">
                    {g.count}× · {g.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ')} · utoljára {new Date(g.lastAt).toLocaleDateString('hu-HU')}
                  </p>
                  {g.examples.length > 1 ? (
                    <ul className="mt-1 list-disc pl-5 text-xs text-ink-soft">
                      {g.examples.slice(0, 3).map((ex, i) => (
                        <li key={i}>{ex}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {canEdit ? (
                  <button type="button" className="shrink-0 text-xs font-semibold text-ink-soft" disabled={pending} onClick={() => run(() => dismissPublicSignalAction({ agentId, signalId: g.signalId }), 'Elrejtve.')}>
                    Elrejtés
                  </button>
                ) : null}
              </div>
              {g.answerDraft && editing !== g.signalId ? (
                <div className="rounded-lg border border-line px-3 py-2 text-sm">
                  <p className="text-xs font-semibold text-ink-soft">Válasz-javaslat (jóváhagyásra vár)</p>
                  <p className="whitespace-pre-wrap">{g.answerDraft}</p>
                  {isAdmin ? (
                    <button
                      type="button"
                      disabled={pending}
                      className="mt-2 rounded-lg bg-coral px-3 py-1.5 text-xs font-semibold text-white"
                      onClick={() => run(() => approvePublicAnswerAction({ agentId, signalId: g.signalId }), 'Jóváhagyva — bekerült a nyilvános tudásbázisba.')}
                    >
                      Jóváhagyás → nyilvános tudásbázis
                    </button>
                  ) : null}
                </div>
              ) : null}
              {canEdit && editing === g.signalId ? (
                <div className="space-y-2">
                  <textarea className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm" rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={pending || !answer.trim()}
                      className="rounded-lg bg-coral px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                      onClick={() => run(() => savePublicAnswerDraftAction({ agentId, signalId: g.signalId, answer }), 'Válasz mentve — adminisztrátori jóváhagyásra vár.')}
                    >
                      Mentés jóváhagyásra
                    </button>
                    <button type="button" className="text-xs text-ink-soft" onClick={() => setEditing(null)}>
                      Mégse
                    </button>
                  </div>
                </div>
              ) : canEdit ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-coral"
                  onClick={() => {
                    setEditing(g.signalId)
                    setAnswer(g.answerDraft ?? '')
                  }}
                >
                  {g.answerDraft ? 'Válasz szerkesztése' : 'Válasz írása'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
