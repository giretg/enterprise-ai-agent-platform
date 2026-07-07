/**
 * Fail-closed titok-feloldás (Architektúra-review F1 / WP-1).
 *
 * Egyetlen, központi feloldó, hogy a "prod alatt kötelező az env" minta ne
 * szóródjon szét a hívóhelyekre. Prod alatt env hiányában a folyamat
 * induláskor (import-időben) leáll — így élesben SOHA nem futhat a nyilvános,
 * hamisítható dev-default titokkal. Nem-prod alatt determinisztikus dev-defaultot
 * ad vissza, de figyelmeztet.
 *
 * A NODE_ENV-et szándékosan a függvényen belül olvassuk (nem modul-szintű
 * konstansként), hogy a feloldó egységtesztelhető legyen a prod- és a
 * dev-ágra egyaránt.
 */

/**
 * @param names      Fallback-lánc env-változónevekből (elsőbbség sorrendben),
 *                   pl. `['OAUTH_STATE_SECRET','WRITE_GATE_SECRET']`.
 * @param devDefault CSAK nem-prod alatt használt determinisztikus default.
 * @throws Prod (`NODE_ENV==='production'`) alatt, ha egyik env sincs beállítva.
 */
export function resolveSecret(names: string[], devDefault: string): string {
  for (const n of names) {
    const v = process.env[n]
    if (v && v.length > 0) return v
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[secret-resolver] Kötelező titok hiányzik prod alatt: ${names.join(' | ')}. ` +
        `Állítsd be a Secret Managerben és az apphosting.yaml-ban.`,
    )
  }
  console.warn(
    `[secret-resolver] DEV default használatban: ${names[0]} (NE használd prod-ban)`,
  )
  return devDefault
}
