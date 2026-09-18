'use client'

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import { CP_EMBED_READY_MESSAGE } from '@/lib/control-plane-embed-messages'

type EmbedBridgeContextValue = {
  setLoading: (loading: boolean) => void
}

const EmbedBridgeContext = createContext<EmbedBridgeContextValue | null>(null)

function postEmbedReady() {
  if (window.parent === window) return
  window.parent.postMessage({ type: CP_EMBED_READY_MESSAGE }, window.location.origin)
}

/** Embed layout: jelzi a szülő modalnak, ha a tartalom készen áll. */
export function ControlPlaneEmbedBridge({ children }: { children: ReactNode }) {
  const pendingRef = useRef(0)
  const readySentRef = useRef(false)

  const maybeNotifyReady = useCallback(() => {
    if (pendingRef.current > 0 || readySentRef.current) return
    readySentRef.current = true
    postEmbedReady()
  }, [])

  const setLoading = useCallback(
    (loading: boolean) => {
      if (loading) {
        pendingRef.current += 1
        readySentRef.current = false
        return
      }
      pendingRef.current = Math.max(0, pendingRef.current - 1)
      if (pendingRef.current === 0) {
        maybeNotifyReady()
      }
    },
    [maybeNotifyReady],
  )

  useEffect(() => {
    // Gyerek hookok után: statikus SSR-oldalak azonnal „kész”-nek számítanak.
    const id = window.requestAnimationFrame(() => {
      maybeNotifyReady()
    })
    return () => window.cancelAnimationFrame(id)
  }, [maybeNotifyReady])

  return <EmbedBridgeContext.Provider value={{ setLoading }}>{children}</EmbedBridgeContext.Provider>
}

/** Kliens-oldali adatbetöltés jelzése az embed modalnak (loading=true amíg tart). */
export function useEmbedLoading(loading: boolean) {
  const ctx = useContext(EmbedBridgeContext)
  useEffect(() => {
    if (!ctx || !loading) return
    ctx.setLoading(true)
    return () => ctx.setLoading(false)
  }, [ctx, loading])
}
