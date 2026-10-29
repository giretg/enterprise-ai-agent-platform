'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  publicAssistantTestLinkAction,
  publishPublicAssistantAction,
  savePublicAssistantDraftAction,
  setPublicAssistantPausedAction,
} from '@/app/actions/public-assistant'
import { PUBLIC_BEHAVIOR_PREFIX, publicView, type PublicAssistantConfig } from '@/domain/public-chat/config'
import type { ModelRef } from '@/lib/model-policy'

const input = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'
const label = 'text-sm font-medium text-ink'
const hint = 'text-xs text-ink-soft'

export type ForwardOption = { connectorId: string; connectorName: string; senders: Array<{ userId: string; label: string }> }

/**
 * #1016 WP-5: a profil szerkesztése (draft), élő előnézettel (D19), élesítés/szünet (D16, csak admin),
 * „Kipróbálás látogatóként” (D22). Az előnézet ugyanaz az oldal, amit a látogató lát (dry-run).
 */
export function PublicAssistantEditor({
  agentId,
  initial,
  reviewNote,
  canEdit,
  isAdmin,
  isPublished,
  hasUnpublishedChanges,
  paused,
  models,
  forwardOptions,
  publicKbs,
}: {
  agentId: string
  initial: PublicAssistantConfig
  reviewNote: string | null
  canEdit: boolean
  isAdmin: boolean
  isPublished: boolean
  hasUnpublishedChanges: boolean
  paused: boolean
  models: ModelRef[]
  forwardOptions: ForwardOption[]
  publicKbs: Array<{ id: string; label: string }>
}) {
  const router = useRouter()
  const [config, setConfig] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [previewHref, setPreviewHref] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    void publicAssistantTestLinkAction({ agentId }).then((res) => {
      if (res.success) setPreviewHref(res.data.href)
    })
  }, [agentId])

  // D19 élő előnézet: a mentetlen arculatot is azonnal mutatja (a beszélgetés a mentett draftból fut).
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: 'excellence-chat:preview', view: publicView(config) }, window.location.origin)
  }, [config])

  function update<K extends keyof PublicAssistantConfig>(key: K, value: PublicAssistantConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }))
    setDirty(true)
  }

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string) {
    startTransition(async () => {
      setNotice(null)
      const res = await fn()
      if (res.success) {
        setNotice({ tone: 'ok', text: okText })
        router.refresh()
      } else setNotice({ tone: 'error', text: res.error ?? 'Nem sikerült.' })
    })
  }

  const save = () =>
    run(async () => {
      const res = await savePublicAssistantDraftAction({ agentId, config })
      if (res.success) {
        setDirty(false)
        frame.current?.contentWindow?.location.reload()
      }
      return res
    }, 'Mentve. A látogatók csak élesítés után látják.')

  const sender = forwardOptions.find((o) => o.connectorId === config.forwardConnectorId)
  const disabled = !canEdit || pending

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5">
        {reviewNote ? (
          <p className="rounded-lg border border-honey/30 bg-honey/10 px-3 py-2 text-sm text-ink">{reviewNote}</p>
        ) : null}

        <section className="atelier-card space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold">Megjelenés</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label}>Név</label>
              <input className={input} value={config.displayName} maxLength={60} disabled={disabled} onChange={(e) => update('displayName', e.target.value)} />
            </div>
            <div>
              <label className={label}>Szín</label>
              <div className="mt-1 flex items-center gap-2">
                <input type="color" value={config.color} disabled={disabled} onChange={(e) => update('color', e.target.value)} className="h-9 w-12 rounded border border-line" />
                <span className={hint}>{config.color}</span>
              </div>
            </div>
          </div>
          <div>
            <label className={label}>Profilkép címe (nem kötelező)</label>
            <p className={hint}>Egy https:// kezdetű képcím, pl. a cég logója.</p>
            <input className={input} value={config.avatarUrl ?? ''} disabled={disabled} placeholder="https://…" onChange={(e) => update('avatarUrl', e.target.value.trim() || null)} />
          </div>
          <div>
            <label className={label}>Üdvözlő üzenet</label>
            <textarea className={input} rows={2} maxLength={500} value={config.welcome} disabled={disabled} onChange={(e) => update('welcome', e.target.value)} />
          </div>
          <div>
            <label className={label}>Javasolt első kérdések</label>
            <p className={hint}>Soronként egy, legfeljebb négy. A látogató egy kattintással elküldheti.</p>
            <textarea
              className={input}
              rows={3}
              value={config.suggestions.join('\n')}
              disabled={disabled}
              onChange={(e) => update('suggestions', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4))}
            />
          </div>
        </section>

        <section className="atelier-card space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold">Miről beszélhet?</h2>
          <div>
            <p className={label}>Fix szabályok (minden nyilvános asszisztensre érvényesek)</p>
            <p className={hint}>Ezt a szöveget a modell minden beszélgetés elején megkapja. Nem titkos, és nem módosítható.</p>
            <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-night-2 p-3 text-xs text-ink-soft">{PUBLIC_BEHAVIOR_PREFIX}</pre>
          </div>
          <div>
            <label className={label}>A cég és a témák</label>
            <p className={hint}>Mit csinál a cég, miben segíthet az asszisztens, mire ne válaszoljon. Ez a fix szabályok után következik.</p>
            <textarea className={input} rows={6} maxLength={4000} value={config.topicGuide} disabled={disabled} onChange={(e) => update('topicGuide', e.target.value)} />
          </div>
          <div>
            <label className={label}>Tudnivalók</label>
            <p className={hint}>
              Rövid, mindig igaz tények: nyitvatartás, cím, elérhetőség, szállítási idő. Csak munkatárs írhatja — a
              látogatói beszélgetésből semmi nem kerül ide.
            </p>
            <textarea className={input} rows={5} maxLength={8000} value={config.knownFacts} disabled={disabled} onChange={(e) => update('knownFacts', e.target.value)} />
          </div>
          <div>
            <p className={label}>Bekötött nyilvános tudásbázis</p>
            {publicKbs.length === 0 ? (
              <p className={hint}>Még nincs nyilvános tudásbázis.</p>
            ) : (
              <div className="mt-1 space-y-1">
                {publicKbs.map((kb) => (
                  <label key={kb.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={config.kbConnectorIds.includes(kb.id)}
                      onChange={(e) =>
                        update('kbConnectorIds', e.target.checked ? [...config.kbConnectorIds, kb.id] : config.kbConnectorIds.filter((id) => id !== kb.id))
                      }
                    />
                    {kb.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="atelier-card space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold">Továbbítás munkatársnak</h2>
          <p className={hint}>
            Ha az asszisztens nem tud segíteni, a látogató elérhetőségét és a beszélgetés összefoglalóját e-mailben
            továbbítja erre a címre. A látogató nem kap másolatot. Ha nincs beállítva e-mail, a kérés a „Beszélgetések”
            listában „Visszahívást kér” jelöléssel jelenik meg.
          </p>
          <div>
            <label className={label}>Ügyfélszolgálati e-mail cím</label>
            <input className={input} type="email" value={config.supportEmail ?? ''} disabled={disabled} placeholder="ugyfelszolgalat@ceg.hu" onChange={(e) => update('supportEmail', e.target.value.trim() || null)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label}>Melyik Gmail-fiókból menjen?</label>
              <select
                className={input}
                disabled={disabled}
                value={config.forwardConnectorId ?? ''}
                onChange={(e) => {
                  const next = forwardOptions.find((o) => o.connectorId === e.target.value)
                  setConfig((c) => ({ ...c, forwardConnectorId: next?.connectorId ?? null, forwardSenderUserId: next?.senders[0]?.userId ?? null }))
                  setDirty(true)
                }}
              >
                <option value="">Nincs (csak „Visszahívást kér”)</option>
                {forwardOptions.map((o) => (
                  <option key={o.connectorId} value={o.connectorId} disabled={o.senders.length === 0}>
                    {o.connectorName}
                    {o.senders.length === 0 ? ' — nincs bejelentkezett fiók' : ''}
                  </option>
                ))}
              </select>
            </div>
            {sender && sender.senders.length > 1 ? (
              <div>
                <label className={label}>Fiók</label>
                <select className={input} disabled={disabled} value={config.forwardSenderUserId ?? ''} onChange={(e) => update('forwardSenderUserId', e.target.value || null)}>
                  {sender.senders.map((s) => (
                    <option key={s.userId} value={s.userId}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </section>

        <section className="atelier-card space-y-4 p-5">
          <h2 className="font-display text-lg font-semibold">Korlátok és modell</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label}>Üzenet / beszélgetés</label>
              <p className={hint}>Ennyi kérdést tehet fel egy látogató egy beszélgetésben.</p>
              <input className={input} type="number" min={1} max={200} value={config.sessionMessageLimit} disabled={disabled} onChange={(e) => update('sessionMessageLimit', Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
            </div>
            <div>
              <label className={label}>Napi keret (USD)</label>
              <p className={hint}>Ha a cég nyilvános chatjei aznap elérik, a látogató „most nem elérhető” üzenetet lát.</p>
              <input className={input} type="number" min={0.5} step={0.5} max={1000} value={config.dailyBudgetUsd} disabled={disabled} onChange={(e) => update('dailyBudgetUsd', Math.max(0.5, Math.min(1000, Number(e.target.value) || 0.5)))} />
            </div>
          </div>
          <div>
            <label className={label}>Modell</label>
            <p className={hint}>Alapból egy olcsó, gyors modell fut; ha az nem elérhető, a megszokott tartalék-lánc lép be.</p>
            <select
              className={input}
              disabled={disabled}
              value={config.model ? `${config.model.provider}/${config.model.model}` : ''}
              onChange={(e) => {
                const ref = models.find((m) => `${m.provider}/${m.model}` === e.target.value)
                update('model', ref ? { ...ref, fallbackModels: [] } : null)
              }}
            >
              <option value="">Automatikus (olcsó-gyors)</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>
                  {m.provider} / {m.model}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Adatkezelési tájékoztató linkje</label>
            <p className={hint}>Az első üzenet előtt a látogató egy rövid tájékoztatót és ezt a linket látja.</p>
            <input className={input} value={config.privacyUrl ?? ''} disabled={disabled} placeholder="https://ceg.hu/adatvedelem" onChange={(e) => update('privacyUrl', e.target.value.trim() || null)} />
          </div>
        </section>

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-line bg-night/95 py-3 backdrop-blur">
          {canEdit ? (
            <button type="button" onClick={save} disabled={pending || !dirty} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">
              {dirty ? 'Mentés' : 'Mentve'}
            </button>
          ) : null}
          {isAdmin ? (
            <button
              type="button"
              disabled={pending || dirty}
              title={dirty ? 'Előbb mentsd a változásokat.' : undefined}
              onClick={() => run(() => publishPublicAssistantAction({ agentId }), 'Élesítve — a látogatók mostantól ezt a változatot látják.')}
              className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {isPublished ? (hasUnpublishedChanges ? 'Változások élesítése' : 'Élesítve') : 'Élesítés'}
            </button>
          ) : (
            <span className={hint}>Élesíteni csak adminisztrátor tud.</span>
          )}
          {isAdmin && isPublished ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => setPublicAssistantPausedAction({ agentId, paused: !paused }), paused ? 'Újra elérhető.' : 'Szüneteltetve — a látogatók „nem elérhető” üzenetet látnak.')}
              className="rounded-lg border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-semibold text-coral"
            >
              {paused ? 'Folytatás' : 'Szüneteltetés'}
            </button>
          ) : null}
          {notice ? <p className={notice.tone === 'ok' ? 'text-sm text-sage' : 'text-sm text-coral-deep'}>{notice.text}</p> : null}
        </div>
      </div>

      <aside className="space-y-2 lg:sticky lg:top-4 lg:self-start">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Előnézet — így látja a látogató</p>
          {previewHref ? (
            <a href={previewHref} target="_blank" rel="noopener" className="text-xs font-semibold text-coral">
              Kipróbálás látogatóként ↗
            </a>
          ) : null}
        </div>
        <p className={hint}>A mentett piszkozattal beszélget, „teszt” címkével; az analitikába nem számít bele.</p>
        <div className="h-[560px] overflow-hidden rounded-xl border border-line bg-white">
          {previewHref ? (
            <iframe ref={frame} src={previewHref} title="Előnézet" className="h-full w-full border-0" onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'excellence-chat:preview', view: publicView(config) }, window.location.origin)} />
          ) : (
            <p className="p-4 text-sm text-ink-soft">Előnézet betöltése…</p>
          )}
        </div>
      </aside>
    </div>
  )
}
