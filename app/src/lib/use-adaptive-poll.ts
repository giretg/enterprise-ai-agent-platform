'use client'

import { useEffect, useRef } from 'react'

export type AdaptivePollOptions = {
  /** Élő időköz ms-ben: amikor van tennivaló (fut valami / vár rád valaki). */
  activeMs: number
  /** Nyugalmi időköz ms-ben: amikor nincs élő futás. Legyen ≥ activeMs. */
  idleMs: number
  /** true, ha épp nincs élő futás → a lassabb (idleMs) időköz jár. */
  idle: boolean
  /** false esetén a poll teljesen áll (pl. a funkció kikapcsolva). Alap: true. */
  enabled?: boolean
}

/**
 * Ismétlődő háttérfrissítés, ami nem pazarol erőforrást:
 *
 *  - A háttérbe tett böngészőfül NEM pollozik: rejtett `document` alatt kihagyjuk
 *    a lekérdezést, a fül visszahozásakor viszont azonnal frissítünk. Így egy
 *    nyitva felejtett vezérlőpult-fül nem terheli a végtelenségig a szervert és
 *    az adatbázist.
 *  - Ha nincs élő futás, ritkábban kérdezünk (`idleMs`); amint elindul valami,
 *    visszavált a sűrűbb (`activeMs`) ütemre. Az `idle` váltása nem indítja újra
 *    az időzítőt — a következő tick már az új időközzel ütemez.
 */
export function useAdaptivePoll(
  refresh: () => void | Promise<void>,
  { activeMs, idleMs, idle, enabled = true }: AdaptivePollOptions,
): void {
  const refreshRef = useRef(refresh)
  const delayRef = useRef(idle ? idleMs : activeMs)

  // A legfrissebb `refresh` és időköz referencián keresztül jut be a futó
  // időzítőbe, így az `idle`/callback váltás nem építi újra a poll-ciklust.
  useEffect(() => {
    refreshRef.current = refresh
  })
  useEffect(() => {
    delayRef.current = idle ? idleMs : activeMs
  }, [idle, idleMs, activeMs])

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return

    let cancelled = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (cancelled || running) return
      running = true
      try {
        if (document.visibilityState !== 'hidden') {
          await refreshRef.current()
        }
      } finally {
        running = false
        if (!cancelled) timer = setTimeout(tick, delayRef.current)
      }
    }

    // Felcsatoláskor azonnali első betöltés; a következő csak annak
    // befejezése után indul, tehát lassú hálózaton sincs átfedő poll.
    void tick()

    const onVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer)
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled])
}
