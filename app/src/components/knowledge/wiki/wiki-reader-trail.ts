/**
 * Az olvasó nézet „Vissza” gombjának emlékezete: a böngészőfülön megnézett lapok sora.
 * Saját sor kell, nem a böngésző előzménye: a beágyazott (iframe) nézetben a `history.back()`
 * a szülőoldalt is elnavigálhatja, ha az iframe-ben még nem történt lapváltás.
 */
export type TrailStep = { href: string; scrollY: number }

const MAX_STEPS = 50

/** Új lap a sor végére; ugyanaz a lap újra (pl. frissítés) nem számít új lépésnek. */
export function rememberStep(trail: TrailStep[], href: string): TrailStep[] {
  if (trail.at(-1)?.href === href) return trail
  return [...trail, { href, scrollY: 0 }].slice(-MAX_STEPS)
}

/** Hova vinne a Vissza a `href` lapról; `null`, ha nincs korábbi lap. */
export function previousStep(trail: TrailStep[], href: string): TrailStep | null {
  const last = trail.at(-1)
  if (last?.href !== href) return last ?? null
  return trail.at(-2) ?? null
}

/** A `href` lapot levéve ez marad, ha visszalépünk. */
export function stepBack(trail: TrailStep[], href: string): TrailStep[] {
  return trail.at(-1)?.href === href ? trail.slice(0, -1) : trail
}

/** A lap görgetési helye, hogy a visszalépés oda érkezzen, ahol az olvasó abbahagyta. */
export function withScroll(trail: TrailStep[], href: string, scrollY: number): TrailStep[] {
  const last = trail.at(-1)
  if (last?.href !== href) return trail
  return [...trail.slice(0, -1), { href, scrollY }]
}
