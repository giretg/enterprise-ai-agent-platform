/**
 * Pozitív egész env/szám-parser közös alakja. Érvénytelen, nem-véges vagy
 * nem pozitív érték esetén a megadott alapértékre esik vissza.
 */
export function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
