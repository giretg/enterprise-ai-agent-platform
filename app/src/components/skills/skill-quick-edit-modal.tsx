'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  listSkillCatalogAction,
  type SkillCatalogEntry,
} from '@/app/actions/skills'
import { EditSkillVersionForm, SkillModal } from '@/components/skills/skill-catalog-manager'
import { skillDisplayLabel } from '@/lib/skill/skill-name'

/**
 * Skill-szerkesztés ott, ahol a felhasználó éppen dolgozik (agent-detail), a
 * katalógus-oldalra navigálás nélkül. Ugyanazt az űrlapot nyitja modalban, mint a
 * katalógus „Szerkesztés” füle — így a két hely nem tud szétcsúszni, és a mentés
 * itt is JAVASLAT (proposed) marad, amit a katalógusban kell jóváhagyni.
 *
 * A skill törzsét (verziólista + tartalom) a katalógus-listából olvassuk ki, hogy ne
 * kelljen külön szerver-utat nyitni; a szerkesztést a `proposeSkillVersionAction`
 * saját admin-kapuja engedi vagy tiltja — a gomb láthatósága csak UI-jelzés.
 */
export function SkillQuickEditModal({
  skillId,
  onClose,
}: {
  skillId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [skill, setSkill] = useState<SkillCatalogEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await listSkillCatalogAction()
      if (cancelled) return
      if (!res.success) {
        setError(res.error)
        return
      }
      const found = res.data.find((s) => s.id === skillId) ?? null
      if (!found) {
        setError('A skill nem érhető el a katalógusban.')
        return
      }
      setSkill(found)
    })()
    return () => {
      cancelled = true
    }
  }, [skillId])

  async function refreshCatalog() {
    const res = await listSkillCatalogAction()
    if (res.success) {
      const found = res.data.find((s) => s.id === skillId) ?? null
      if (found) setSkill(found)
    }
    router.refresh()
  }

  function run(
    fn: () => Promise<{ success: boolean; error?: string }>,
    okMsg: string,
    onSuccess?: () => void | Promise<void>,
  ) {
    startTransition(async () => {
      setError(null)
      setNotice(null)
      const res = await fn()
      if (!res.success) {
        setError(res.error ?? 'Ismeretlen hiba.')
        return
      }
      setNotice(okMsg)
      await refreshCatalog()
      await onSuccess?.()
    })
  }

  return (
    <SkillModal
      eyebrow="Képesség szerkesztése"
      title={skill ? skillDisplayLabel(skill) : 'Betöltés…'}
      subtitle="A mentés új verziót javasol — élessé a katalógusban tett jóváhagyás teszi."
      onClose={onClose}
      error={error}
      notice={notice}
    >
      {skill ? (
        <EditSkillVersionForm
          key={skill.id}
          skill={skill}
          running={pending}
          onRun={run}
          onRefreshCatalog={refreshCatalog}
          onClose={onClose}
        />
      ) : error ? null : (
        <p key="loading" className="text-sm text-ink-faint">Betöltés…</p>
      )}
    </SkillModal>
  )
}
