'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { setAgentBehaviorProfile } from '@/app/actions/platform'
import { Badge } from '@/components/ui/shell'

type ProfileOption = {
  id: string
  name: string
  currentVersion: number
}

type BehaviorProfileLink = {
  id: string
  name: string
  currentVersion: number
  pinnedVersion: number
  pinnedBody: string
}

/**
 * A "Munkastílus" doboz tartalma (§3.4). A ténylegesen használt viselkedés-profil
 * két rétegből áll: a választott KÖZPONTI profil (pinnelt verzió) + az agent
 * EGYEDI kiegészítése (overlay).
 *
 * Ugyanannak a doboznak két állapota: az olvasható nézet (mindenki ezt látja
 * elsőre) és a szerkesztő (az admin a doboz „Szerkesztés" gombjával váltja át).
 */
export function BehaviorProfileView({
  link,
  overlay,
}: {
  link: BehaviorProfileLink | null
  overlay: string
}) {
  const profilePart = link?.pinnedBody ?? ''

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Központi profil
        </p>
        {link ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{link.name}</Badge>
            <span className="text-xs text-ink-faint">v{link.pinnedVersion}</span>
          </div>
        ) : (
          <p className="text-sm italic text-ink-faint">
            Nincs központi profil — csak egyedi munkastílus.
          </p>
        )}
        {profilePart && (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
            {profilePart}
          </p>
        )}
      </div>

      <div className="border-t border-line pt-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Egyedi rész
        </p>
        {overlay.trim() ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{overlay}</p>
        ) : (
          <p className="text-sm italic text-ink-faint">Nincs egyedi kiegészítés.</p>
        )}
      </div>

      <p className="text-xs text-ink-faint">
        A kettő együtt adja a ténylegesen használt munkastílust.
      </p>
    </div>
  )
}

/** Szerkesztő nézet — ugyanannak a doboznak a másik állapota. */
export function BehaviorProfileEditForm({
  agentId,
  profiles,
  link,
  overlay,
}: {
  agentId: string
  profiles: ProfileOption[]
  link: BehaviorProfileLink | null
  overlay: string
}) {
  const isStale = link != null && link.pinnedVersion < link.currentVersion
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState(link?.id ?? '')
  const [overlayText, setOverlayText] = useState(overlay)

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  )
  // A pinnelt törzs csak akkor mutatható referenciaként, ha a kiválasztott profil
  // megegyezik a jelenleg pinnelttel; profilváltásnál a mentés tölti be a friss törzset.
  const profilePartPreview = selectedId && selectedId === link?.id ? link.pinnedBody : ''

  function save() {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await setAgentBehaviorProfile({
        agentId,
        profileId: selectedId || null,
        overlay: overlayText,
      })
      if (res.success) {
        setDone(`Mentve — agent v${res.data.agentVersion}`)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="space-y-4">
      <label className="block text-sm">
        <span className="text-ink-soft">Központi profil</span>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
        >
          <option value="">Egyedi (nincs központi profil)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} (v{p.currentVersion})
            </option>
          ))}
        </select>
      </label>

      {profiles.length === 0 && (
        <p className="text-xs text-ink-faint">
          Még nincs megosztott profil.{' '}
          <Link
            href="/control-plane/behavior-profiles"
            className="font-medium text-coral hover:text-coral-deep"
          >
            Hozz létre egyet a katalógusban.
          </Link>
        </p>
      )}

      {isStale && selectedId === link?.id && (
        <div className="rounded-xl border border-coral/30 bg-coral/5 p-3 text-sm text-ink-soft">
          A központi profil újabb al-verziója elérhető (pinnelt v{link.pinnedVersion} · aktuális v
          {link.currentVersion}). A mentés a friss v{link.currentVersion} törzsre állítja, és új
          reprodukálhatósági verziót fagyaszt.
        </div>
      )}

      {profilePartPreview && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Központi profil rész (v{link?.pinnedVersion})
          </p>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-night-2 p-3 text-sm leading-relaxed text-ink-soft">
            {profilePartPreview}
          </p>
        </div>
      )}

      {selectedProfile && selectedId !== link?.id && (
        <p className="text-xs text-ink-faint">
          Mentéskor a(z) „{selectedProfile.name}” profil aktuális (v{selectedProfile.currentVersion})
          törzse kerül be a munkastílusba.
        </p>
      )}

      <label className="block text-sm">
        <span className="text-ink-soft">Egyedi rész (ehhez az agenthez)</span>
        <textarea
          value={overlayText}
          onChange={(e) => setOverlayText(e.target.value)}
          rows={5}
          placeholder="Csak erre az agentre igaz stílus-kiegészítés — pl. külön hangnem, kiemelt szabály…"
          className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
        />
      </label>

      <p className="text-xs text-ink-faint">
        A választott központi profil és az egyedi rész EGYÜTT adja a ténylegesen használt
        munkastílust.
      </p>

      {error && <p className="text-sm text-coral">{error}</p>}
      {done && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={save}
        className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-card disabled:opacity-50"
      >
        {pending ? 'Mentés…' : 'Munkastílus mentése'}
      </button>
    </div>
  )
}
