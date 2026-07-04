/**
 * Graduation-readiness / hordozhatóság kiértékelés (SandboxVersioning-Graduation
 * spec §7.2 + §9.1). A `sandbox_projects.portability` egy szabad JSON-jelölő-halmaz,
 * amit a projekt élete során karbantartunk (pl. "nincs platform-specifikus
 * API-függés", "séma önálló DDL-ként kiírható"). A graduation csak akkor
 * "triviális", ha ezek a jelölők rendben vannak — ha egy is sérül, a UI figyelmeztet,
 * különben a "bármikor kiveheted" ígéret üres, súrlódás-alapú lock-inná válik.
 *
 * Konvenció: `portability` egy `Record<string, flag>`, ahol a `flag`:
 *   - boolean → közvetlen pass/fail,
 *   - `{ ok | pass: boolean, label?, detail? }` → strukturált jelölő,
 *   - string ('ok'|'pass'|'ready'|'true' → pass; 'fail'|'broken'|'false' → fail).
 * Bármi más truthy érték óvatosan pass-nak számít; a `false`/`{ok:false}` fail.
 */

export type GraduationReadinessStatus = 'ready' | 'at_risk' | 'unassessed'

export type GraduationReadiness = {
  status: GraduationReadinessStatus
  /** UI Badge tone (illeszkedik a shell Badge-hez). */
  tone: 'success' | 'warning' | 'neutral'
  /** Rövid, ember-olvasható állapotcímke. */
  label: string
  total: number
  passed: number
  failed: number
  /** A megbukott jelölők ember-olvasható címkéi (figyelmeztetéshez). */
  failingChecks: string[]
}

const FAIL_STRINGS = new Set(['fail', 'failed', 'broken', 'false', 'no', 'blocked'])
const PASS_STRINGS = new Set(['ok', 'pass', 'passed', 'ready', 'true', 'yes'])

/** Egyetlen jelölő pass/fail kiértékelése. */
function flagPasses(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (FAIL_STRINGS.has(v)) return false
    if (PASS_STRINGS.has(v)) return true
    return v.length > 0 // ismeretlen, de kitöltött → óvatos pass
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.ok === 'boolean') return o.ok
    if (typeof o.pass === 'boolean') return o.pass
    return true // strukturált, de nincs explicit fail-jelölő
  }
  // null / undefined / 0 / NaN → fail (nem teljesített jelölő)
  return Boolean(value)
}

/** Egy jelölő ember-olvasható címkéje (kulcs + opcionális `label`). */
function flagLabel(key: string, value: unknown): string {
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.label === 'string' && o.label.trim()) return o.label
  }
  return key
}

/**
 * A projekt hordozhatósági jelölőiből graduation-readiness állapotot számol.
 * Üres/hiányzó jelölőkészlet → `unassessed` (semleges), nem hamis "kész".
 */
export function evaluateGraduationReadiness(portability: unknown): GraduationReadiness {
  const entries =
    portability && typeof portability === 'object' && !Array.isArray(portability)
      ? Object.entries(portability as Record<string, unknown>)
      : []

  if (entries.length === 0) {
    return {
      status: 'unassessed',
      tone: 'neutral',
      label: 'Hordozhatóság nem értékelt',
      total: 0,
      passed: 0,
      failed: 0,
      failingChecks: [],
    }
  }

  const failingChecks: string[] = []
  let passed = 0
  for (const [key, value] of entries) {
    if (flagPasses(value)) {
      passed += 1
    } else {
      failingChecks.push(flagLabel(key, value))
    }
  }
  const total = entries.length
  const failed = failingChecks.length

  if (failed > 0) {
    return {
      status: 'at_risk',
      tone: 'warning',
      label: `Hordozhatóság sérült (${passed}/${total})`,
      total,
      passed,
      failed,
      failingChecks,
    }
  }

  return {
    status: 'ready',
    tone: 'success',
    label: 'Graduálható',
    total,
    passed,
    failed: 0,
    failingChecks: [],
  }
}
