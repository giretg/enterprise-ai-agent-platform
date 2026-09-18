/** Playbook spec kritikusság — UI segéd (L0–L3, §5.4 / §11.2). */

export const PLAYBOOK_CRITICALITY_OPTIONS = [
  { value: 'L0', label: 'L0 — minimális' },
  { value: 'L1', label: 'L1 — normál' },
  { value: 'L2', label: 'L2 — four-eyes kötelező' },
  { value: 'L3', label: 'L3 — four-eyes kötelező' },
] as const

const CRITICALITY_ORDER = ['L0', 'L1', 'L2', 'L3'] as const

type SpecWithGates = Record<string, unknown> & {
  criticality?: string
  gates?: Array<{ criticality?: string; blocking?: boolean; [k: string]: unknown }>
}

export function isFourEyesCriticality(c?: string | null): boolean {
  return c === 'L2' || c === 'L3'
}

export function isValidCriticality(c: string): c is (typeof CRITICALITY_ORDER)[number] {
  return CRITICALITY_ORDER.includes(c as (typeof CRITICALITY_ORDER)[number])
}

/** Legmagasabb kritikusság a spec szintjén vagy bármely kapun. */
export function summarizeSpecCriticality(spec: unknown): {
  level: string | null
  fourEyes: boolean
} {
  if (!spec || typeof spec !== 'object') return { level: null, fourEyes: false }
  const s = spec as SpecWithGates
  const levels = [s.criticality, ...(s.gates?.map((g) => g.criticality) ?? [])].filter(
    (c): c is string => !!c && isValidCriticality(c),
  )
  if (levels.length === 0) return { level: null, fourEyes: false }
  const highest = [...levels].sort(
    (a, b) => CRITICALITY_ORDER.indexOf(b as (typeof CRITICALITY_ORDER)[number]) - CRITICALITY_ORDER.indexOf(a as (typeof CRITICALITY_ORDER)[number]),
  )[0]
  return { level: highest, fourEyes: levels.some(isFourEyesCriticality) }
}

/** Effektív kritikusság — a dropdown ezt mutatja. */
export function readEffectiveCriticality(spec: unknown): string {
  return summarizeSpecCriticality(spec).level ?? ''
}

/** Playbook + kapu kritikusság együttes beállítása. */
export function applySpecCriticality(spec: SpecWithGates, criticality: string): SpecWithGates {
  const next = structuredClone(spec)
  if (criticality) {
    next.criticality = criticality
    if (Array.isArray(next.gates)) {
      next.gates = next.gates.map((g) => ({
        ...g,
        criticality,
        ...(isFourEyesCriticality(criticality) ? { blocking: true } : {}),
      }))
    }
  } else {
    delete next.criticality
    if (Array.isArray(next.gates)) {
      next.gates = next.gates.map((g) => {
        const gate = { ...g }
        delete gate.criticality
        return gate
      })
    }
  }
  return next
}

export function patchSpecCriticality(specText: string, criticality: string): string {
  try {
    const spec = JSON.parse(specText) as SpecWithGates
    return JSON.stringify(applySpecCriticality(spec, criticality), null, 2)
  } catch {
    return specText
  }
}

/** @deprecated Használd readEffectiveCriticality-t a megjelenítéshez. */
export function readSpecCriticality(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return ''
  const c = (spec as { criticality?: string }).criticality
  return c && isValidCriticality(c) ? c : ''
}
