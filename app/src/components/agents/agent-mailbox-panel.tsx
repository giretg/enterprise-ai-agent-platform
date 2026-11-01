'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  createAgentPrimaryMailboxAction,
  setAgentPrimaryMailboxAction,
  updateAgentMailIdentityAction,
  type AgentMailboxSettings,
} from '@/app/actions/agent-mailbox'
import { mailboxKindLabel } from '@/domain/agent-mailbox/agent-mailbox'

const MAILBOXES_HREF = '/control-plane/provisioning/agentmail'

type Choice = 'create' | 'existing' | 'none'

const inputClass = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'
const buttonClass = 'rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50'

/**
 * #1029 az agent saját e-mail címe: elsődleges postafiók (új AgentMail-cím, meglévő
 * postafiók vagy semmi), aláírás és megjelenő név. Az agent beállításaiban és a
 * felvételi varázslóban is ez jelenik meg.
 */
export function AgentMailboxPanel({
  settings,
  canEdit = true,
  onChanged,
}: {
  settings: AgentMailboxSettings
  canEdit?: boolean
  onChanged?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const hasPrimary = Boolean(settings.primaryConnectorId)
  const [editing, setEditing] = useState(!hasPrimary)
  const [choice, setChoice] = useState<Choice>(settings.agentMailConfigured ? 'create' : 'existing')
  const [username, setUsername] = useState(settings.suggestedUsername)
  const [domain, setDomain] = useState('')
  const selectable = settings.mailboxes.filter(
    (row) => !row.readOnly && (!row.primaryOf || row.primaryOf.agentId === settings.agentId),
  )
  const [selected, setSelected] = useState(settings.primaryConnectorId ?? selectable[0]?.connectorId ?? '')

  function done(message: string, displayNameSynced = true) {
    setNotice(displayNameSynced ? message : `${message} A postafiókon látszó nevet nem sikerült frissíteni — próbáld újra később.`)
    setEditing(false)
    onChanged?.()
    router.refresh()
  }

  function run(task: () => Promise<void>) {
    startTransition(async () => {
      setError(null)
      setNotice(null)
      await task()
    })
  }

  function savePrimary() {
    run(async () => {
      if (choice === 'create') {
        const res = await createAgentPrimaryMailboxAction({ agentId: settings.agentId, username, domain })
        if (!res.success) return setError(res.error)
        return done(`Kész: ${res.data.email} lett ${settings.agentName} saját címe.`)
      }
      const connectorId = choice === 'none' ? null : selected || null
      if (choice === 'existing' && !connectorId) return setError('Válassz egy postafiókot.')
      const res = await setAgentPrimaryMailboxAction({ agentId: settings.agentId, connectorId })
      if (!res.success) return setError(res.error)
      done(connectorId ? 'Elmentve: ez a postafiók lett a saját címe.' : 'Elmentve: nincs saját e-mail címe.', res.data.displayNameSynced)
    })
  }

  const primaryRow = settings.mailboxes.find((row) => row.connectorId === settings.primaryConnectorId)

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Saját e-mail cím</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Erről a címről küld levelet, ha nem kérsz mást, és az ide érkező levelekről tudja, hogy neki szólnak. Egy
            postafiók csak egy munkatárs saját címe lehet; más munkatársak ettől még használhatják.
          </p>
        </div>

        {settings.lostPrimaryAddress ? (
          <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-sm text-ink">
            A korábbi saját címe ({settings.lostPrimaryAddress}) már nem elérhető — a postafiókot törölték vagy
            leválasztották. Válassz neki új címet, vagy jelöld, hogy nem kell saját cím.
          </p>
        ) : null}

        {hasPrimary && !editing ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper/70 px-4 py-3">
            <span className="text-sm text-ink">
              ✉ <strong>{settings.primaryAddress ?? primaryRow?.name}</strong>
              {primaryRow ? <span className="text-ink-soft"> · {mailboxKindLabel(primaryRow.kind)}</span> : null}
            </span>
            {canEdit ? (
              <button type="button" onClick={() => setEditing(true)} className="text-sm font-semibold text-coral">
                Módosítás
              </button>
            ) : null}
          </div>
        ) : null}

        {canEdit && editing ? (
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="mailboxChoice" checked={choice === 'create'} onChange={() => setChoice('create')} disabled={!settings.agentMailConfigured} className="mt-1" />
              <span className="flex-1">
                <span className="font-semibold text-ink">Új cím létrehozása</span>
                {settings.agentMailConfigured ? (
                  <span className="block text-ink-soft">Új postafiókot nyitunk neki, és azonnal be is kötjük.</span>
                ) : (
                  <span className="block text-ink-soft">
                    Az adminnak előbb be kell állítania a postafiókokat.{' '}
                    <Link href={MAILBOXES_HREF} className="font-semibold text-coral underline">
                      Postafiókok beállítása
                    </Link>
                  </span>
                )}
              </span>
            </label>
            {choice === 'create' && settings.agentMailConfigured ? (
              <div className="ml-6 grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-ink-soft">Felhasználónév (a @ előtti rész)</span>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} className={inputClass} />
                </label>
                <label className="block text-sm">
                  <span className="text-ink-soft">Domain (üresen hagyva az alapértelmezett)</span>
                  <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="pl. ceg.hu" maxLength={253} className={inputClass} />
                </label>
              </div>
            ) : null}

            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="mailboxChoice" checked={choice === 'existing'} onChange={() => setChoice('existing')} className="mt-1" />
              <span className="flex-1">
                <span className="font-semibold text-ink">Meglévő postafiók választása</span>
                <span className="block text-ink-soft">A cég már bekötött postafiókjai közül. Ha még nincs hozzárendelve, írási joggal hozzárendeljük.</span>
              </span>
            </label>
            {choice === 'existing' ? (
              <div className="ml-6 space-y-2">
                {settings.mailboxes.length === 0 ? (
                  <p className="text-sm text-ink-soft">
                    Még nincs bekötött postafiók.{' '}
                    <Link href={MAILBOXES_HREF} className="font-semibold text-coral underline">
                      Postafiókok
                    </Link>
                  </p>
                ) : (
                  <select value={selected} onChange={(e) => setSelected(e.target.value)} className={inputClass}>
                    {settings.mailboxes.map((row) => {
                      const takenBy = row.primaryOf && row.primaryOf.agentId !== settings.agentId ? row.primaryOf.agentName : null
                      const note = takenBy
                        ? ` — már ${takenBy} saját címe`
                        : row.readOnly
                          ? ' — csak olvasható, nem küldhet róla'
                          : row.accessMode === 'write'
                            ? ''
                            : ' — írási joggal hozzárendeljük'
                      return (
                        <option key={row.connectorId} value={row.connectorId} disabled={Boolean(takenBy) || row.readOnly}>
                          {row.address ?? row.name} ({mailboxKindLabel(row.kind)}){note}
                        </option>
                      )
                    })}
                  </select>
                )}
              </div>
            ) : null}

            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="mailboxChoice" checked={choice === 'none'} onChange={() => setChoice('none')} className="mt-1" />
              <span className="flex-1">
                <span className="font-semibold text-ink">Nem kell saját cím</span>
                <span className="block text-ink-soft">Csak akkor küld levelet, ha kifejezetten kéred, és megmondod, melyik fiókból.</span>
              </span>
            </label>

            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={savePrimary} disabled={pending} className={buttonClass}>
                {pending ? 'Mentés…' : choice === 'create' ? 'Cím létrehozása' : 'Mentés'}
              </button>
              {hasPrimary ? (
                <button type="button" onClick={() => setEditing(false)} disabled={pending} className="px-3 py-2 text-sm text-ink-soft">
                  Mégse
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {!canEdit && !hasPrimary ? <p className="text-sm text-ink-soft">Nincs saját e-mail címe.</p> : null}
      </section>

      <MailIdentityForm settings={settings} canEdit={canEdit} onSaved={done} />

      {error ? <p className="text-sm text-coral">{error}</p> : null}
      {notice ? (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{notice}</p>
      ) : null}
    </div>
  )
}

function MailIdentityForm({
  settings,
  canEdit,
  onSaved,
}: {
  settings: AgentMailboxSettings
  canEdit: boolean
  onSaved: (message: string, displayNameSynced?: boolean) => void
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        const data = new FormData(e.currentTarget)
        startTransition(async () => {
          setError(null)
          const res = await updateAgentMailIdentityAction({
            agentId: settings.agentId,
            signature: String(data.get('signature') ?? ''),
            displayName: String(data.get('displayName') ?? ''),
          })
          if (res.success) onSaved('Elmentve: aláírás és megjelenő név.', res.data.displayNameSynced)
          else setError(res.error)
        })
      }}
    >
      <div>
        <h3 className="text-sm font-semibold text-ink">Aláírás és megjelenő név</h3>
        <p className="mt-1 text-sm text-ink-soft">
          Az aláírás a saját címéről küldött levelek végére kerül automatikusan (ha már beleírta, nem duplázzuk). A
          megjelenő nevet látja a címzett feladóként.
        </p>
      </div>
      <label className="block text-sm">
        <span className="text-ink-soft">Megjelenő név</span>
        <input name="displayName" defaultValue={settings.displayName} placeholder={settings.agentName} maxLength={120} disabled={!canEdit} className={inputClass} />
      </label>
      <label className="block text-sm">
        <span className="text-ink-soft">Aláírás</span>
        <textarea
          name="signature"
          defaultValue={settings.signature}
          rows={3}
          maxLength={2000}
          disabled={!canEdit}
          placeholder={`Üdvözlettel,\n${settings.agentName}`}
          className={inputClass}
        />
      </label>
      {error ? <p className="text-sm text-coral">{error}</p> : null}
      {canEdit ? (
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Mentés…' : 'Mentés'}
        </button>
      ) : null}
    </form>
  )
}
