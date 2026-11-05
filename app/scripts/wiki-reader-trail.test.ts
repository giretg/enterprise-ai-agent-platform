import assert from 'node:assert/strict'
import { previousStep, rememberStep, stepBack, withScroll, type TrailStep } from '../src/components/knowledge/wiki/wiki-reader-trail'

const visit = (...hrefs: string[]) => hrefs.reduce<TrailStep[]>((trail, href) => rememberStep(trail, href), [])

// Első lapnál nincs hova visszalépni, frissítés nem új lépés.
assert.equal(previousStep(visit('a'), 'a'), null)
assert.equal(visit('a', 'a').length, 1)

// A → B: a B lapról A-ra lép vissza, még mielőtt a B bekerült volna a sorba (render közben is).
assert.equal(previousStep(visit('a', 'b'), 'b')?.href, 'a')
assert.equal(previousStep(visit('a'), 'b')?.href, 'a')

// A → B → C: visszafelé végigjárható, a sor elején vége.
let trail = visit('a', 'b', 'c')
trail = stepBack(trail, 'c')
assert.equal(previousStep(trail, 'b')?.href, 'a')
trail = stepBack(trail, 'b')
assert.equal(previousStep(trail, 'a'), null)

// A → B → A linkkel: az előző lap a B, nem „elfogyott” a sor.
assert.equal(previousStep(visit('a', 'b', 'a'), 'a')?.href, 'b')

// A görgetési hely az adott laphoz tartozik, és visszalépéskor megkapjuk.
trail = withScroll(visit('a'), 'a', 640)
trail = rememberStep(trail, 'b')
assert.equal(previousStep(trail, 'b')?.scrollY, 640)
assert.deepEqual(withScroll(visit('a'), 'b', 10), visit('a'))

// Korlátos hossz: a sessionStorage nem nő a végtelenségig.
const long = visit(...Array.from({ length: 80 }, (_, i) => `p${i}`))
assert.equal(long.length, 50)
assert.equal(long.at(-1)?.href, 'p79')

console.log('wiki-reader-trail: OK')
