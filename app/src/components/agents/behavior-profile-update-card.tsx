'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { acceptBehaviorProfileUpdate } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

type BehaviorProfileLink = {
  id: string
  name: string
  currentVersion: number
  pinnedVersion: number
}

/**
 * Megosztott viselkedés-profil kaszkád-befogadás (§3.4, I7).
 *
 * A profil új al-verzióra promótálása NEM frissíti automatikusan a hivatkozó
 * agentet (drift-mentesség). Ha a profil aktuális al-verziója újabb, mint az
 * agentre pinnelt verzió, ez a kártya felkínálja a befogadást — ami új
 * `agent_versions` snapshotot fagyaszt (reprodukálhatóság).
 */
export function BehaviorProfileUpdateCard({
  agentId,
  link,
}: {
  agentId: string
  link: BehaviorProfileLink
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const isStale = link.pinnedVersion < link.currentVersion

  function accept() {
    startTransition(async () => {
      setError(null)
      const res = await acceptBehaviorProfileUpdate({
        agentId,
        profileId: link.id,
        profileVersion: link.currentVersion,
      })
      if (res.success) {
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <Card title="Megosztott munkastílus">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/control-plane/behavior-profiles"
            className="font-medium text-ink hover:text-coral-deep"
          >
            {link.name}
          </Link>
          <p className="mt-1 text-xs text-ink-faint">
            Pinnelt v{link.pinnedVersion} · profil aktuális v{link.currentVersion}
          </p>
        </div>
        <Badge tone={isStale ? 'danger' : 'success'}>{isStale ? 'elavult' : 'naprakész'}</Badge>
      </div>

      {error && <p className="mt-3 text-xs text-coral">{error}</p>}

      {isStale ? (
        <div className="mt-4 rounded-xl border border-coral/30 bg-coral/5 p-3">
          <p className="text-sm leading-relaxed text-ink-soft">
            A megosztott profil újabb al-verziója elérhető. A befogadás új reprodukálhatósági
            verziót fagyaszt, és erre az agentre a profil v{link.currentVersion} törzsét állítja —
            csendes drift nélkül.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={accept}
            className="mt-3 rounded-full bg-coral px-5 py-2 text-sm font-semibold text-card disabled:opacity-50"
          >
            {pending ? 'Befogadás…' : `Frissítés befogadása (v${link.currentVersion})`}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-faint">
          Az agent a megosztott profil legfrissebb al-verzióját használja.
        </p>
      )}
    </Card>
  )
}
