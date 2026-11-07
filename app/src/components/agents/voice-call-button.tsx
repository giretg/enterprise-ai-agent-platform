'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyVoiceEvent,
  INITIAL_VOICE_CALL_VIEW,
  microphoneFailureMessage,
  voiceEndedMessage,
  voiceBackendWorkVisible,
  voiceEndReport,
  voiceFailureMessage,
  voiceProviderNotice,
} from '@/components/agents/voice-call-events'

type Phase = 'idle' | 'connecting' | 'live' | 'closing' | 'ended' | 'failed'

const ICE_GATHERING_TIMEOUT_MS = 4000
const CLOSE_TIMEOUT_MS = 15_000
const DEFAULT_MAX_SECONDS = 600

function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS)
    connection.addEventListener('icegatheringstatechange', () => {
      if (connection.iceGatheringState === 'complete') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const ROLE_LABEL = { user: 'Te', assistant: 'Munkatárs' } as const

const VOICE_CALL_HINT = 'Böngészőben beszélhetsz a munkatárssal, mintha felhívtad volna. Telefonszám nem kell.'

/** Hullámforma-ikon a chat beviteli dobozába, a munkatárs-kártyára és az adatlapra. */
export function VoiceCallIconButton({ agentName, onClick }: { agentName: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Beszélgetés hangon: ${agentName}`}
      title={VOICE_CALL_HINT}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-coral/10 text-coral-deep transition hover:bg-coral/20"
    >
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M4 10.5v3M8 7.5v9M12 4.5v15M16 7.5v9M20 10.5v3" />
      </svg>
    </button>
  )
}

/** #1111 hang-pilot: a gomb és az ablak együtt, ahol a gomb helye a hívás alatt biztosan nem változik. */
export function VoiceCallButton({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <VoiceCallIconButton agentName={agentName} onClick={() => setOpen(true)} />
      {open ? <VoiceCallDialog agentId={agentId} agentName={agentName} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** Böngészős beszélgetés a munkatárssal, mintha felhívtuk volna. Eltávolításkor lecsatol, ezért a hívás alatt a helyén kell maradnia. */
export function VoiceCallDialog({ agentId, agentName, onClose }: { agentId: string; agentName: string; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [view, setView] = useState(INITIAL_VOICE_CALL_VIEW)
  const [limitReached, setLimitReached] = useState(false)
  const [maxSeconds, setMaxSeconds] = useState(DEFAULT_MAX_SECONDS)
  const [copied, setCopied] = useState(false)
  // A lezárási jelentésnek az utolsó esemény utáni állapot kell, a következő renderre nem várhat.
  const viewRef = useRef(INITIAL_VOICE_CALL_VIEW)

  const connectionRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const reportedRef = useRef(false)
  // Minden indítás és megszakítás új értéket ad, így a régi indítás folytatása felismeri, hogy lejárt.
  const runRef = useRef(0)

  const release = useCallback(() => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    channelRef.current?.close()
    channelRef.current = null
    connectionRef.current?.close()
    connectionRef.current = null
  }, [])

  const sendEndReport = useCallback(
    (sessionId: string, summary: ReturnType<typeof voiceEndReport>) => {
      void fetch('/api/voice/session/end', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, sessionId, ...summary }),
      }).catch(() => undefined)
    },
    [agentId],
  )

  const report = useCallback(() => {
    if (reportedRef.current || !sessionIdRef.current) return
    reportedRef.current = true
    sendEndReport(sessionIdRef.current, voiceEndReport(viewRef.current))
  }, [sendEndReport])

  const finish = useCallback(
    (next: 'ended' | 'failed') => {
      release()
      report()
      setPhase(next)
    },
    [release, report],
  )

  function cancelConnecting() {
    runRef.current += 1
    release()
    setPhase('idle')
  }

  const requestClose = useCallback(() => {
    const channel = channelRef.current
    if (channel?.readyState !== 'open') {
      finish('ended')
      return
    }
    setPhase('closing')
    channel.send(JSON.stringify({ type: 'session.close' }))
    timersRef.current.push(setTimeout(() => finish('ended'), CLOSE_TIMEOUT_MS))
  }, [finish])

  useEffect(() => {
    const onLeave = () => {
      // A folyamatban lévő indítás így nem nyitja meg a mikrofont az oldal elhagyása után.
      runRef.current += 1
      release()
      report()
    }
    window.addEventListener('pagehide', onLeave)
    return () => {
      window.removeEventListener('pagehide', onLeave)
      onLeave()
    }
  }, [release, report])

  useEffect(() => {
    if (phase !== 'live') return
    const startedAt = Date.now()
    const interval = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 1000)
    return () => clearInterval(interval)
  }, [phase])

  async function start() {
    const run = ++runRef.current
    const stale = () => run !== runRef.current
    setFailure(null)
    setElapsed(0)
    setLimitReached(false)
    viewRef.current = INITIAL_VOICE_CALL_VIEW
    setView(INITIAL_VOICE_CALL_VIEW)
    sessionIdRef.current = null
    reportedRef.current = false
    setPhase('connecting')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      if (stale()) return
      setFailure(microphoneFailureMessage(error instanceof Error ? error.name : ''))
      setPhase('failed')
      return
    }
    if (stale()) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    streamRef.current = stream

    try {
      const connection = new RTCPeerConnection()
      connectionRef.current = connection
      stream.getAudioTracks().forEach((track) => connection.addTrack(track, stream))
      connection.ontrack = (event) => {
        if (audioRef.current) audioRef.current.srcObject = event.streams[0] ?? null
      }
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'failed') {
          setFailure('Megszakadt a kapcsolat. Ellenőrizd a hálózatot, és indítsd újra a beszélgetést.')
          finish('failed')
        }
      }

      const channel = connection.createDataChannel('oai-events')
      channelRef.current = channel
      let greeting = ''
      channel.onmessage = (message) => {
        let event: unknown
        try {
          event = JSON.parse(String(message.data))
        } catch {
          return
        }
        viewRef.current = applyVoiceEvent(viewRef.current, event, Date.now())
        setView(viewRef.current)
        const type = (event as { type?: unknown } | null)?.type
        if (type === 'session.started' && greeting) {
          channel.send(
            JSON.stringify({ type: 'session.commentary.append', event_id: `greeting-${Date.now()}`, delegation_id: null, content: greeting }),
          )
        }
        if (type === 'session.closed') finish('ended')
      }

      await connection.setLocalDescription(await connection.createOffer())
      await waitForIceGathering(connection)
      if (stale()) return
      const response = await fetch('/api/voice/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, sdp: connection.localDescription?.sdp }),
      })
      const payload = (await response.json().catch(() => null)) as {
        error?: string
        sessionId?: string
        sdpAnswer?: string
        greeting?: string
        maxSeconds?: number
      } | null
      if (stale()) {
        // Megszakítás közben a szerver már elindíthatta: az indítási auditsor mellé kerüljön lezárás is.
        if (payload?.sessionId) sendEndReport(payload.sessionId, { ...voiceEndReport(INITIAL_VOICE_CALL_VIEW), reason: 'cancelled_while_connecting' })
        return
      }
      if (!response.ok || !payload?.sessionId || !payload.sdpAnswer) {
        setFailure(voiceFailureMessage(payload?.error ?? 'unknown'))
        release()
        setPhase('failed')
        return
      }
      sessionIdRef.current = payload.sessionId
      greeting = payload.greeting ?? ''
      await connection.setRemoteDescription({ type: 'answer', sdp: payload.sdpAnswer })
      setPhase('live')
      setMaxSeconds(payload.maxSeconds ?? DEFAULT_MAX_SECONDS)
      timersRef.current.push(
        setTimeout(() => {
          setLimitReached(true)
          requestClose()
        }, (payload.maxSeconds ?? DEFAULT_MAX_SECONDS) * 1000),
      )
    } catch {
      if (stale()) return
      setFailure('A beszélgetést nem sikerült elindítani. Próbáld újra pár perc múlva.')
      finish('failed')
    }
  }

  async function copyTranscript() {
    const text = view.lines
      .map((line) => (line.role === 'tool' ? `[${line.text}]` : `${ROLE_LABEL[line.role]}: ${line.text}`))
      .join('\n')
    await navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))
  }

  function closeDialog() {
    if (phase === 'live' || phase === 'closing' || phase === 'connecting') return
    onClose()
  }

  const busy = phase === 'connecting' || phase === 'live' || phase === 'closing'
  const providerNotice = voiceProviderNotice(view)

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-[2px]">
      <div role="dialog" aria-modal="true" aria-label={`Hangos beszélgetés: ${agentName}`} className="atelier-card flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden p-0 shadow-2xl">
        <div className="border-b border-line px-5 py-4">
          <h3 className="font-display text-lg font-semibold text-ink">Hangos beszélgetés: {agentName}</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Úgy működik, mintha felhívnád: te szólsz, a munkatárs válaszol. A hang és a szöveg az OpenAI-hoz kerül, ezért
            ne mondj valódi ügyféladatot. Legfeljebb 10 percig tart. Hangfelvétel nem készül. Ha a szervezet naplózási beállítása engedi, az átirat
            minőségbiztosítási célból titkosítva a platform naplójába kerül, és alapból 90 napig őrizzük.
          </p>
          <p className="mt-1 text-sm text-ink-soft">Ez külön beszélgetés: a munkatárs nem látja a szöveges chatet, és a hangos beszélgetés sem kerül be oda.</p>
        </div>

        <div className="min-h-40 flex-1 space-y-2 overflow-y-auto px-5 py-4 text-sm" aria-live="polite">
          {view.lines.length === 0 ? (
            <p className="text-ink-soft">
              {phase === 'idle' ? 'Még nem indult el a beszélgetés. Az Indítás után kéri a böngésző a mikrofon-engedélyt.' : null}
              {phase === 'connecting' ? 'Kapcsolódás… Ha a böngésző mikrofon-engedélyt kér, engedélyezd.' : null}
              {phase === 'live' ? 'A munkatárs mindjárt megszólal. Ha néhány másodpercig csend van, köszönj neki te. Az elhangzott szöveg itt jelenik meg.' : null}
            </p>
          ) : null}
          {view.lines.map((line, index) =>
            line.role === 'tool' ? (
              <p key={index} className="text-xs text-ink-soft">
                {line.text}
              </p>
            ) : (
              <p key={index}>
                <span className="font-semibold text-ink">{ROLE_LABEL[line.role]}: </span>
                <span className="text-ink">{line.text}</span>
              </p>
            ),
          )}
          {voiceBackendWorkVisible(phase, view) ? <p className="text-xs text-ink-soft">A munkatárs utánanéz…</p> : null}
          {failure ? <p className="text-coral-deep">{failure}</p> : null}
          {providerNotice ? <p className="text-coral-deep">{providerNotice}</p> : null}
          {phase === 'ended' ? (
            <p className="text-ink-soft">{voiceEndedMessage(view.closedReason, limitReached)} Ez a nézet az ablak bezárásával eltűnik.</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 text-sm">
          <div className="text-ink-soft">
            {busy || phase === 'ended' ? <span title="Eltelt idő és a beszélgetés leghosszabb ideje">{formatClock(Math.max(elapsed, view.seconds))} / {formatClock(maxSeconds)}</span> : null}
            {view.lastBackendWaitMs !== null ? (
              <span
                className="ml-3"
                title="Ennyi ideig tartott, amíg a háttér válaszolt, például amíg a munkatárs a tudásbázisban keresett."
              >
                Utolsó háttérválasz: {(view.lastBackendWaitMs / 1000).toFixed(1)} mp
              </span>
            ) : null}
          </div>
          <div className="flex gap-2">
            {phase === 'connecting' ? (
              <button type="button" onClick={cancelConnecting} className="rounded-full border border-line px-4 py-2 font-semibold text-ink-soft hover:bg-night-2">
                Mégse
              </button>
            ) : busy ? (
              <button
                type="button"
                onClick={requestClose}
                disabled={phase !== 'live'}
                className="rounded-full bg-coral px-4 py-2 font-semibold text-white hover:bg-coral/90 disabled:opacity-60"
              >
                {phase === 'closing' ? 'Befejezés…' : 'Befejezés'}
              </button>
            ) : (
              <>
                {phase === 'ended' && view.lines.length > 0 ? (
                  <button type="button" onClick={() => void copyTranscript()} className="rounded-full border border-line px-4 py-2 font-semibold text-ink-soft hover:bg-night-2">
                    {copied ? 'Kimásolva' : 'Átirat másolása'}
                  </button>
                ) : null}
                <button type="button" onClick={closeDialog} className="rounded-full border border-line px-4 py-2 font-semibold text-ink-soft hover:bg-night-2">
                  Bezárás
                </button>
                <button type="button" onClick={() => void start()} className="rounded-full bg-coral px-4 py-2 font-semibold text-white hover:bg-coral/90">
                  {phase === 'idle' ? 'Indítás' : 'Újra'}
                </button>
              </>
            )}
          </div>
        </div>
        <audio ref={audioRef} autoPlay className="hidden" />
      </div>
    </div>
  )
}
