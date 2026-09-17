'use client'

import { useEffect, useRef } from 'react'
import { shouldFireVisibilityGatedPoll, ticketPollPauseOnHiddenTabEnabled } from '@/lib/visibility-gated-poll'

/**
 * Mint a `setInterval`, de rejtett fülön szünetel (lásd `visibility-gated-poll.ts`).
 * Fülváltáskor azonnal lefut egyet, hogy visszatéréskor ne legyen elavult adat.
 */
export function useVisibilityGatedInterval(callback: () => void, ms: number, enabled: boolean) {
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    if (!enabled) return
    const pauseOnHidden = ticketPollPauseOnHiddenTabEnabled()
    const tick = () => {
      if (shouldFireVisibilityGatedPoll(document.hidden, pauseOnHidden)) callbackRef.current()
    }
    const timer = window.setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ms, enabled])
}
