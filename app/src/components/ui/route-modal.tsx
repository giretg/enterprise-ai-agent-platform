'use client'

import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  closeControlPlanePanel,
  closeControlPlanePanelByKey,
  minimizeControlPlanePanel,
  openControlPlanePanel,
  setControlPlanePanelKey,
  syncControlPlanePanelFromUrl,
  useControlPlaneDockedPanelKeys,
  useControlPlanePanelKey,
} from '@/lib/control-plane-panel-store'
import { LoadingOverlay } from '@/components/ui/spinner'
import { isControlPlaneEmbedReadyMessage } from '@/lib/control-plane-embed-messages'
import {
  panelDefForKey,
  panelSizeClass,
  type ControlPlanePanelSize,
} from '@/lib/control-plane-panels'

let lastPanelOpener: HTMLElement | null = null

export function rememberPanelOpener(el: HTMLElement | null) {
  lastPanelOpener = el
}

export { openControlPlanePanel } from '@/lib/control-plane-panel-store'

function usePanelIframeReady(panelKey: string) {
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [embedReady, setEmbedReady] = useState(false)
  const loadGeneration = useRef(0)

  useEffect(() => {
    loadGeneration.current += 1
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIframeLoaded(false)
    setEmbedReady(false)
  }, [panelKey])

  useEffect(() => {
    const generation = loadGeneration.current
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (!isControlPlaneEmbedReadyMessage(event.data)) return
      if (generation !== loadGeneration.current) return
      setEmbedReady(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [panelKey])

  return {
    iframeLoaded,
    embedReady,
    showLoading: !iframeLoaded || !embedReady,
    onIframeLoad: () => setIframeLoaded(true),
  }
}

function PanelIframe({
  panelKey,
  title,
  visible,
}: {
  panelKey: string
  title: string
  visible: boolean
}) {
  const { showLoading, onIframeLoad } = usePanelIframeReady(panelKey)

  return (
    <div
      className={
        visible
          ? 'relative min-h-0 flex-1 overflow-hidden'
          : 'pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0'
      }
      aria-hidden={!visible}
    >
      {visible && showLoading ? <LoadingOverlay /> : null}
      <iframe
        key={panelKey}
        title={title}
        src={`/embed/control-plane/${encodeURIComponent(panelKey)}`}
        className="h-full w-full border-0"
        onLoad={onIframeLoad}
        tabIndex={visible ? undefined : -1}
      />
    </div>
  )
}

function RouteModalFrame({
  panelKey,
  onClose,
  onMinimize,
}: {
  panelKey: string
  onClose: () => void
  onMinimize: () => void
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const def = panelDefForKey(panelKey)
  const size: ControlPlanePanelSize = def?.size ?? 'sz-m'

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!def) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/40 p-4">
        <div className="rounded-2xl border border-line bg-card p-6 shadow-xl">
          <p className="text-sm text-ink-soft">Ismeretlen panel: {panelKey}</p>
          <button type="button" onClick={onClose} className="mt-4 text-sm font-semibold text-coral">
            Bezárás
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/40 p-3 backdrop-blur-[2px] sm:p-6"
      onClick={onMinimize}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex max-h-[90vh] flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl ${panelSizeClass(size)}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {def.eyebrow}
            </p>
            <h2 id={titleId} className="font-display text-lg font-semibold">
              {def.title}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={def.href}
              className="hidden rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-coral/40 sm:inline-flex"
            >
              Teljes oldal
            </Link>
            <button
              type="button"
              onClick={onMinimize}
              className="grid h-8 w-8 place-items-center rounded-lg border border-line text-sm text-ink-soft hover:bg-night-2"
              aria-label="Tálcára rakás"
              title="Tálcára rakás"
            >
              −
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-lg border border-line text-sm text-ink-soft hover:bg-night-2"
              aria-label="Bezárás"
            >
              ✕
            </button>
          </div>
        </header>
        <PanelIframe panelKey={panelKey} title={def.title} visible />
      </div>
    </div>
  )
}

/** Query-param alapú modal-hordozó — a háttér (chat/stream) nem mountol újra. */
export function RouteModalHost() {
  const pathname = usePathname()
  const panelKey = useControlPlanePanelKey()
  const dockedKeys = useControlPlaneDockedPanelKeys()
  const [mounted, setMounted] = useState(false)

  const aliveKeys = useMemo(() => {
    const keys = [...dockedKeys]
    if (panelKey && !keys.includes(panelKey)) keys.push(panelKey)
    return keys
  }, [dockedKeys, panelKey])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  useEffect(() => {
    const onPop = () => {
      syncControlPlanePanelFromUrl(pathname)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [pathname])

  const close = useCallback(() => {
    if (panelKey) {
      closeControlPlanePanelByKey(panelKey, pathname)
    } else {
      closeControlPlanePanel(pathname)
    }
    queueMicrotask(() => {
      lastPanelOpener?.focus()
    })
  }, [panelKey, pathname])

  const minimize = useCallback(() => {
    minimizeControlPlanePanel(pathname)
  }, [pathname])

  if (!mounted) return null

  return (
    <>
      {aliveKeys
        .filter((key) => key !== panelKey)
        .map((key) => {
          const def = panelDefForKey(key)
          return (
            <PanelIframe
              key={key}
              panelKey={key}
              title={def?.title ?? key}
              visible={false}
            />
          )
        })}
      {panelKey ? (
        <RouteModalFrame panelKey={panelKey} onClose={close} onMinimize={minimize} />
      ) : null}
    </>
  )
}

/** SSR / teszt: popstate nélküli panel-kulcs szinkron. */
export function syncRouteModalPanelKeyFromSearchParam(key: string | null) {
  setControlPlanePanelKey(key)
}
