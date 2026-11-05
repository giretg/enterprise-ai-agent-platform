'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { previousStep, rememberStep, stepBack, withScroll, type TrailStep } from './wiki-reader-trail'

const STORAGE_KEY = 'wiki-reader-trail'
const subscribeNever = () => () => {}

function loadTrail(): TrailStep[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as TrailStep[]) : []
  } catch {
    return []
  }
}

function saveTrail(trail: TrailStep[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail))
  } catch {
    // Tiltott tárhelynél a gomb letiltva marad, az olvasás ettől még működik.
  }
}

/** A visszalépés célja: az új lap megjelenése után ide görgetünk. */
let pendingRestore: TrailStep | null = null

/** Olvasó nézet: visszalépés az előzőleg nézett lapra, a korábbi görgetési helyre. */
export function WikiReaderBack({ href }: { href: string }) {
  const t = useTranslations('ControlPlane.wiki.reader')
  const router = useRouter()
  const previousHref = useSyncExternalStore(
    subscribeNever,
    () => previousStep(loadTrail(), href)?.href ?? null,
    () => null,
  )

  useEffect(() => {
    saveTrail(rememberStep(loadTrail(), href))
    if (pendingRestore?.href === href) {
      window.scrollTo(0, pendingRestore.scrollY)
      pendingRestore = null
    }
    // Capture: a linkre kattintáskor még a régi lap görgetési helyét látjuk.
    const saveScroll = () => saveTrail(withScroll(loadTrail(), href, window.scrollY))
    document.addEventListener('click', saveScroll, true)
    return () => document.removeEventListener('click', saveScroll, true)
  }, [href])

  const goBack = () => {
    const trail = loadTrail()
    const target = previousStep(trail, href)
    if (!target) return
    saveTrail(stepBack(trail, href))
    pendingRestore = target
    router.push(target.href, { scroll: false })
  }

  return (
    <button
      type="button"
      onClick={goBack}
      disabled={!previousHref}
      title={previousHref ? undefined : t('backDisabled')}
      data-testid="wiki-reader-back"
      className="rounded-lg border border-line/70 px-2.5 py-1 text-sm font-medium text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-ink-soft"
    >
      ← {t('back')}
    </button>
  )
}
