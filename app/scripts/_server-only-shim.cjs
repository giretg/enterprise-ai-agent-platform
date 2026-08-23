/**
 * `server-only` no-op a Node-ból futó teszt-szkripteknek.
 *
 * A `server-only` csomag futásidőben dob, ha nem a Next szerver-grafikonjából
 * töltik be — a `tsx` alatt futó DoD-tesztek emiatt indulás előtt elszállnak.
 * A csomag célja a KLIENS-BUNDLE védelme; ezt a `next build` ellenőrzi, nem a
 * teszt. Itt tehát a modul-feloldást némítjuk, semmi mást.
 *
 * Használat: `tsx --require ./scripts/_server-only-shim.cjs <teszt>`
 */
const Module = require('node:module')

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'server-only' || request === 'client-only') return {}
  return originalLoad.call(this, request, parent, isMain)
}
