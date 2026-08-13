'use client'

/**
 * A tenant skill-listája a `/` slash-választóhoz olyan felületeken, ahol nincs
 * konkrét agent (Playbook-szerző prompt). Egy oldalon több szerkesztő-doboz is
 * kérheti (spec + minden lépés/kapu segéd-panelje), ezért a betöltés egyetlen,
 * megosztott ígéret — nem N szerver-hívás.
 */
import { useEffect, useState } from 'react'
import { listTenantSkillOptionsAction, type TenantSkillOption } from '@/app/actions/skills'

let pending: Promise<TenantSkillOption[]> | null = null

/** Katalógus-változás után (új skill jóváhagyása) a következő kérés újratölt. */
export function resetTenantSkillOptionsCache(): void {
  pending = null
}

export function useTenantSkillOptions(enabled = true): TenantSkillOption[] {
  const [skills, setSkills] = useState<TenantSkillOption[]>([])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    if (!pending) {
      pending = listTenantSkillOptionsAction()
        .then((res) => (res.success ? res.data : []))
        .catch(() => [])
    }
    void pending.then((rows) => {
      if (!cancelled) setSkills(rows)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return skills
}

export type { TenantSkillOption }
