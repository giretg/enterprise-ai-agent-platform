/**
 * Content-Security-Policy az AGENT által írt sandbox-app HTML kiszolgálásához
 * (Feature-spec — App Registry §4.5, §6.3).
 *
 * A kulcs a `sandbox allow-scripts` direktíva: a böngészőt arra kényszeríti, hogy a
 * dokumentumot egyedi, ÁTLÁTSZATLAN origó-ban futtassa — akkor is, ha valaki a preview
 * URL-t top-level (új fülön) megnyitja, vagy ha a beágyazó iframe `sandbox` attribútuma
 * megváltozna. Így az izoláció magának a VÁLASZNAK a tulajdonsága, nem a deployment-configé
 * (`SANDBOX_PREVIEW_ORIGIN`, ami alapból üres → platform-azonos origó) vagy a beágyazó
 * markup-é. A `allow-scripts` pontosan megegyezik a preview-iframe meglévő
 * `sandbox="allow-scripts"` attribútumával, ezért a normál (beágyazott) útra nézve NINCS
 * viselkedés-változás — csak a nem szándékolt (top-level / rosszul konfigurált) utat zárja.
 *
 * A network (`connect-src`), a form, az object és a base-uri továbbra is tiltott, így a
 * sandboxolt tartalom nem tud a platform API-jához nyúlni, se navigációval/űrlappal
 * adatot kiszivárogtatni.
 */

const BASE_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts',
]

/**
 * A beágyazott (iframe) preview CSP-je. A `frameAncestors` szabályozza, mely platform-origó
 * ágyazhatja be a previewt (clickjacking-védelem).
 */
export function sandboxPreviewCsp(frameAncestors: string): string {
  return [...BASE_DIRECTIVES, `frame-ancestors ${frameAncestors}`].join('; ')
}

/**
 * Az export (letöltött HTML) CSP-je. A letöltés `attachment`, ezért a fájl lemezre kerül;
 * a CSP defense-in-depth arra az esetre, ha egy böngésző/kiegészítő mégis inline renderelné.
 * Beágyazást nem engedünk (`frame-ancestors 'none'`).
 */
export function sandboxExportCsp(): string {
  return [...BASE_DIRECTIVES, "frame-ancestors 'none'"].join('; ')
}
