/**
 * Központi, fail-closed titok-feloldó a platform kriptográfiai aláíró/titkosító
 * kulcsaihoz (write-gate token HMAC, OAuth-state HMAC + AES-256-GCM, sandbox preview
 * token HMAC).
 *
 * Miért kell: a korábbi minta minden titkot egy beégetett fejlesztői alapértékre
 * ejtett vissza (`... ?? 'dev-...-change-in-prod'`). Ha egy éles környezetben az
 * env-változó hiányzott (új környezet, elfelejtett secret, félrekonfiguráció), a
 * rendszer NEM állt le — némán egy forráskódban publikált, mindenki által ismert
 * kulccsal írt alá és titkosított. Ez azt jelenti, hogy bárki, aki látta a repót,
 * hamisíthatott write-gate jóváhagyást, OAuth-state-et (CSRF / fiók-összekötés),
 * vagy más tenant sandbox-preview tokenjét — és vissza is fejthette az OAuth-state
 * titkosított PKCE code_verifier-jét.
 *
 * A helyes enterprise-viselkedés: FAIL CLOSED. Éles futásidőben (`NODE_ENV=production`)
 * valós, konfigurált titok nélkül dobjunk, ne essünk vissza a beégetett defaultra.
 * Fejlesztésben/tesztben a determinisztikus dev-default marad, hogy a lokális futás és
 * a tesztek változatlanok legyenek.
 *
 * A feloldás LUSTA (a signing/verify hívás idején fut, nem modul-betöltéskor), így a
 * Next.js production build (ami NODE_ENV=production alatt importálja a modulokat) nem
 * dől el pusztán attól, hogy a titok build-időben nincs jelen.
 */

/** A beégetett dev-alapértékeket jelölő marker — konfigurált titokban is tiltott. */
const DEV_PLACEHOLDER_MARKER = 'change-in-prod'

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production'
}

/**
 * Igazi, konfigurált titoknak számít-e az érték: nem üres és nem a beégetett
 * dev-placeholder (sem a pontos default, sem a `change-in-prod` markert tartalmazó).
 */
function isRealSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes(DEV_PLACEHOLDER_MARKER)
}

/**
 * Feloldja egy aláíró/titkosító titok értékét fail-closed módon.
 *
 * @param envNames  A vizsgálandó env-változók neve prioritási sorrendben (pl. az
 *                  elsődleges és a megosztott fallback: `['OAUTH_STATE_SECRET', 'WRITE_GATE_SECRET']`).
 * @param devDefault Determinisztikus fejlesztői alapérték (csak nem-production futásidőben).
 * @returns A feloldott titok.
 * @throws Ha production futásidőben egyetlen env-változó sincs valós titokra állítva.
 */
export function resolveSigningSecret(envNames: string[], devDefault: string): string {
  for (const name of envNames) {
    const value = process.env[name]
    if (isRealSecret(value)) return value
  }

  if (isProductionRuntime()) {
    throw new Error(
      `[secret-config] Nincs beállítva valós titok (${envNames.join(' vagy ')}). ` +
        `A platform elutasítja, hogy éles környezetben beégetett fejlesztői kulccsal írjon alá / ` +
        `titkosítson. Állíts be egy erős, véletlen értéket a fenti env-változók egyikére.`,
    )
  }

  return devDefault
}
