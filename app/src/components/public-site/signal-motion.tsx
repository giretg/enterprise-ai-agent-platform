'use client'

import { useEffect } from 'react'

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
