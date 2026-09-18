'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  createBehaviorProfile,
  getBehaviorProfile,
  updateBehaviorProfile,
} from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

type ProfileSummary = {
  id: string
  name: string
  currentVersion: number
  referrerCount: number
}

type ProfileDetail = {
  profile: {
    id: string
    name: string
    currentVersion: number
    versions: { version: number; body: string; createdAt: string | Date }[]
  }
  referrers: { id: string; name: string; pinnedVersion: number; status: string }[]
}

export function BehaviorProfileCatalog({ profiles }: { profiles: ProfileSummary[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [newVersionBody, setNewVersionBody] = useState('')

  function handleCreate() {
    startTransition(async () => {
      setError(null)
      const res = await createBehaviorProfile({ name: name.trim(), body: body.trim() })
      if (res.success) {
        setName('')
        setBody('')
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  function toggle(profileId: string) {
    if (openId === profileId) {
      setOpenId(null)
      setDetail(null)
      return
    }
    setOpenId(profileId)
    setDetail(null)
    setNewVersionBody('')
    startTransition(async () => {
      const res = await getBehaviorProfile({ profileId })
      if (res.success) setDetail(res.data as unknown as ProfileDetail)
      else setError(res.error)
    })
  }

  function publishVersion(profileId: string) {
    startTransition(async () => {
      setError(null)
      const res = await updateBehaviorProfile({ profileId, body: newVersionBody.trim() })
      if (res.success) {
        setNewVersionBody('')
        const refreshed = await getBehaviorProfile({ profileId })
        if (refreshed.success) setDetail(refreshed.data as unknown as ProfileDetail)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="space-y-6">
      <Card title="Új megosztott profil">
        <p className="mb-3 text-sm text-ink-soft">
          A viselkedés-profil a „hogyan&quot; (hangnem, nyelv, formázás, citálás) — több agent is
          hivatkozhatja. A módosítás új al-verziót hoz létre, de a hivatkozó agentek viselkedése csak
          külön befogadással változik (kontrollált, drift-mentes).
        </p>
        {error && <p className="mb-3 text-xs text-coral">{error}</p>}
        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Profil neve — pl. Excellence – magyar, tömör, citálás-kötelező"
            className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="A profil törzse: hangnem, nyelv, formázási és citálási elvárások…"
            className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={pending || name.trim().length === 0 || body.trim().length === 0}
            onClick={handleCreate}
            className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-card disabled:opacity-50"
          >
            {pending ? 'Mentés…' : 'Profil létrehozása'}
          </button>
        </div>
      </Card>

      <div className="space-y-4">
        {profiles.length === 0 && (
          <Card>
            <p className="text-sm text-ink-faint">Még nincs megosztott viselkedés-profil.</p>
          </Card>
        )}
        {profiles.map((p) => (
          <Card key={p.id}>
            <button
              type="button"
              onClick={() => toggle(p.id)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div>
                <p className="font-display text-lg font-semibold text-ink">{p.name}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  v{p.currentVersion} · {p.referrerCount} hivatkozó agent
                </p>
              </div>
              <Badge tone="neutral">{openId === p.id ? 'Bezár' : 'Részletek'}</Badge>
            </button>

            {openId === p.id && (
              <div className="mt-4 space-y-4 border-t border-line pt-4">
                {!detail ? (
                  <p className="text-sm text-ink-faint">Betöltés…</p>
                ) : (
                  <>
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                        Al-verziók
                      </p>
                      <ul className="space-y-2">
                        {detail.profile.versions.map((v) => (
                          <li key={v.version} className="atelier-soft p-3">
                            <p className="text-xs font-semibold text-ink">
                              v{v.version}
                              {v.version === detail.profile.currentVersion && (
                                <span className="ml-2 text-sage">aktuális</span>
                              )}
                            </p>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{v.body}</p>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                        Hivatkozó agentek
                      </p>
                      {detail.referrers.length === 0 ? (
                        <p className="text-sm text-ink-faint">Egy agent sem hivatkozza még.</p>
                      ) : (
                        <ul className="space-y-1 text-sm">
                          {detail.referrers.map((r) => (
                            <li key={r.id} className="flex items-center justify-between">
                              <span className="text-ink-soft">{r.name}</span>
                              <span className="text-xs text-ink-faint">
                                pinnelt v{r.pinnedVersion}
                                {r.pinnedVersion < detail.profile.currentVersion && (
                                  <span className="ml-2 text-coral">elavult</span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                        Új al-verzió publikálása
                      </p>
                      <textarea
                        value={newVersionBody}
                        onChange={(e) => setNewVersionBody(e.target.value)}
                        rows={4}
                        placeholder="A profil új törzse…"
                        className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={pending || newVersionBody.trim().length === 0}
                        onClick={() => publishVersion(p.id)}
                        className="mt-2 rounded-full border border-coral/30 px-4 py-1.5 text-sm font-semibold text-coral disabled:opacity-50"
                      >
                        {pending ? 'Publikálás…' : 'Új verzió (a hivatkozók nem frissülnek automatikusan)'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
