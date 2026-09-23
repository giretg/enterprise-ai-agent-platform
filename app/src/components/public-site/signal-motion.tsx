'use client'

import { useEffect, useState } from 'react'

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

export type TerminalLine = { tone?: 'dim' | 'accent' | 'ok' | 'warn'; text: string }

const toneClass = { dim: 'text-[#777]', accent: 'text-[#8ea2ff]', ok: 'text-[#6ee7a8]', warn: 'text-[#ffb366]' }

/** Types the lines out once, character by character (instant with reduced motion). */
export function TypedTerminal({ title, lines }: { title: string; lines: TerminalLine[] }) {
  const full = lines.reduce((n, l) => n + l.text.length, 0)
  const [shown, setShown] = useState(0)

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let i = 0
    let timer: ReturnType<typeof setTimeout>
    const all = lines.map((l) => l.text).join('')
    const tick = () => {
      i = reduced ? full : i + 1
      setShown(i)
      if (i < full) timer = setTimeout(tick, all[i - 1] === '\n' ? 180 : 18)
    }
    timer = setTimeout(tick, reduced ? 0 : 400)
    return () => clearTimeout(timer)
  }, [full, lines])

  const starts = lines.map((_, i) => lines.slice(0, i).reduce((n, l) => n + l.text.length, 0))
  return (
    <div className="overflow-hidden rounded-md bg-ink font-mono text-[13px] leading-[1.7] text-[#e6e6e6] shadow-[10px_10px_0_var(--color-coral)]">
      <div className="flex items-center gap-1.5 border-b border-[#2a2a2e] px-3.5 py-2.5 text-[#777]">
        <b className="h-2.5 w-2.5 rounded-full bg-[#3a3a3f]" />
        <b className="h-2.5 w-2.5 rounded-full bg-[#3a3a3f]" />
        <b className="h-2.5 w-2.5 rounded-full bg-[#3a3a3f]" />
        <span className="ml-2">{title}</span>
      </div>
      <pre aria-label={lines.map((l) => l.text).join('')} className="min-h-[300px] whitespace-pre-wrap p-[18px] font-mono">
        {lines.map((l, i) => {
          const part = l.text.slice(0, Math.max(shown - starts[i], 0))
          return (
            <span key={i} aria-hidden className={l.tone ? toneClass[l.tone] : undefined}>
              {part}
            </span>
          )
        })}
        <span aria-hidden className="inline-block h-[15px] w-2 bg-lime align-[-2px] animate-blink" />
      </pre>
    </div>
  )
}
