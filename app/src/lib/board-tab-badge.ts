/**
 * A munkaterület Feladatok-fülének figyelemjelzője.
 * Ugyanaz a ticket-halmaz, mint a fül táblája (az agent érintettjei),
 * dátumszűrő nélkül — a kapu akkor is látszik, ha a tábla 30 napos ablaka
 * épp nem fedi. Ready / backlog / ütemezett nem számít: azok a tábla belseje.
 */
export type BoardTabBadge = {
  count: number
  tone: 'wait' | 'run'
  spoken: string
  hint: string
}

function asCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

export function boardTabBadge(input: {
  attention: number
  running: number
}): BoardTabBadge | null {
  const attention = asCount(input.attention)
  if (attention > 0) {
    return {
      count: attention,
      tone: 'wait',
      spoken: 'rád vár',
      hint: 'Emberi jóváhagyásra vagy pontosításra várnak — nélküled nem haladnak.',
    }
  }
  const running = asCount(input.running)
  if (running > 0) {
    return {
      count: running,
      tone: 'run',
      spoken: 'fut',
      hint: 'Az AI munkatárs éppen dolgozik ezeken.',
    }
  }
  return null
}
