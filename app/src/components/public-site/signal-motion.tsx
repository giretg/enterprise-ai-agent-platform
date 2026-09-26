'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Scroll-driven motion for the public Signal pages. The page stays a server
 * component; this wires behaviour onto data attributes:
 *  - [data-reveal]        fades/slides in when it enters the viewport
 *  - [data-draw]          SVG whose `--draw` (0→1) follows scroll; gets `.is-drawn` at 1
 *  - [data-step]/[data-screen]  sticky "how it works": the step nearest the middle
 *                         of the viewport and its screen get `.is-on`
 *  - [data-progress]      width follows page scroll
 */
export function ScrollEffects() {
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const reveals = document.querySelectorAll<HTMLElement>('[data-reveal]')
    const draws = document.querySelectorAll<SVGSVGElement>('[data-draw]')
    const steps = [...document.querySelectorAll<HTMLElement>('[data-step]')]
    const screens = [...document.querySelectorAll<HTMLElement>('[data-screen]')]
    const progress = document.querySelector<HTMLElement>('[data-progress]')

    if (reduced) {
      reveals.forEach((el) => el.classList.add('is-in'))
      draws.forEach((el) => {
        el.style.setProperty('--draw', '1')
        el.classList.add('is-drawn')
      })
    }

    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return
          e.target.classList.add('is-in')
          io.unobserve(e.target)
        }),
      { threshold: 0.15 },
    )
    if (!reduced) reveals.forEach((el) => io.observe(el))

    const onScroll = () => {
      const h = document.documentElement
      if (progress) progress.style.width = `${(h.scrollTop / Math.max(h.scrollHeight - h.clientHeight, 1)) * 100}%`
      if (!reduced) {
        draws.forEach((svg) => {
          const r = svg.getBoundingClientRect()
          const p = Math.min(Math.max((innerHeight - r.top) / (innerHeight * 0.7), 0), 1)
          svg.style.setProperty('--draw', String(p))
          if (p >= 1) svg.classList.add('is-drawn')
        })
      }
      let active = 0
      steps.forEach((s, i) => {
        if (s.getBoundingClientRect().top < innerHeight * 0.55) active = i
      })
      steps.forEach((s, i) => s.classList.toggle('is-on', i === active))
      screens.forEach((s, i) => s.classList.toggle('is-on', i === active))
    }
    addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      io.disconnect()
      removeEventListener('scroll', onScroll)
    }
  }, [])
  return null
}

export type ChatFrame = { node: ReactNode; from: number; to?: number }

/**
 * Plays a scripted chat: after `delays[s]` ms the step advances, and every
 * frame with from <= step < to is shown. Loops after the last step; reduced
 * motion shows the final state only.
 */
export function ChatSequence({ frames, delays }: { frames: ChatFrame[]; delays: number[] }) {
  const last = delays.length
  const [step, setStep] = useState(0)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced && step === last) return
    const next = () => setStep((s) => (reduced ? last : s >= last ? 0 : s + 1))
    const timer = setTimeout(next, reduced ? 0 : step >= last ? 5000 : delays[step])
    return () => clearTimeout(timer)
  }, [step, last, delays])

  useEffect(() => {
    const anchor = endRef.current
    const panel = anchor?.closest<HTMLElement>('[data-chat-scroll]')
    if (!panel) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth'
    panel.scrollTo({ top: step === 0 ? 0 : panel.scrollHeight, behavior })
  }, [step])

  return (
    <>
      {frames.map((f, i) =>
        f.from <= step && (f.to === undefined || step < f.to) ? (
          <div key={`${i}-${f.from}`} className="animate-rise">
            {f.node}
          </div>
        ) : null,
      )}
      <div ref={endRef} aria-hidden className="h-px shrink-0" />
    </>
  )
}
