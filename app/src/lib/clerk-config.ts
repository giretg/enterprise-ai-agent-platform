export function isClerkUiEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
}

/** Mindkét Clerk-kulcs megvan — az AUTH_DISABLED-től függetlenül. */
export function hasClerkKeys(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY) && isClerkUiEnabled()
}

export function isClerkEnabled(): boolean {
  if (process.env.AUTH_DISABLED === 'true') return false
  return hasClerkKeys()
}

/**
 * A belépés nélküli dev-hozzáférés (DevAuthProvider) kapcsolója — **fail-closed**.
 *
 * Ez a kapu dönti el, hogy Clerk-kényszerítés hiányában (nincs Clerk-kulcs, vagy
 * `AUTH_DISABLED=true`) a `proxy` és a `getAuthProvider` átengedi-e a kérést a
 * `DevAuthProvider`-nek, ami MINDEN kérést egy fix, `active`, env-ből állítható
 * szerepű (a dev-login seed által tenant-adminra + platform-superadminra emelt)
 * felhasználóként hitelesít. Ezért a kaput csak EXPLICIT, felismert fejlesztői
 * környezet nyithatja ki.
 *
 * A korábbi `NODE_ENV !== 'production'` fail-OPEN volt: `undefined`, `''`,
 * `'staging'`, `'preview'` vagy akár a `'prod'` elgépelés is kinyitotta — egy
 * nem-standard boot (custom server, pinneletlen NODE_ENV) vagy egy
 * titok-feloldási hiba így az egész platformot (minden tenant) névtelenül,
 * superadminként tárta volna az internetnek. A standard `next build`/`next start`
 * `'production'`-t állít, a `next dev` `'development'`-et, a teszt-/CI-futás
 * `'test'`-et — más (ismeretlen) érték alatt a hitelesítést NEM kerüljük meg.
 */
export function isDevAuthAllowed(): boolean {
  const env = process.env.NODE_ENV
  return env === 'development' || env === 'test'
}
