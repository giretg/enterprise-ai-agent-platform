/**
 * Az inline (izolált) workspace-HTML megnyitás biztonsági fejléceinek
 * invariánsai. A nem-megbízható HTML nem futtathat scriptet ÉS nem indíthat
 * KÜLSŐ hálózati kérést (kép-beacon / CSS-háttér exfiltráció).
 * Run: npm run test:workspace-inline-html-headers
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  INLINE_HTML_CONTENT_TYPE,
  INLINE_HTML_CONTENT_SECURITY_POLICY,
  INLINE_HTML_META_CSP,
  htmlWithInlinePreviewCsp,
  inlineHtmlPreviewSecurityHeaders,
} from '../src/lib/workspace-inline-html-headers'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function directive(policy: string, name: string): string | null {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
  return found ?? null
}

console.log('Workspace inline HTML biztonsági fejlécek')

check('a sandbox opak origin aktív (nincs script/same-origin/form)', () => {
  // A bare `sandbox` token — allow-* nélkül — tiltja a scriptet, a same-origin
  // hozzáférést, a formot és a popupot.
  assert.equal(directive(INLINE_HTML_CONTENT_SECURITY_POLICY, 'sandbox'), 'sandbox')
})

check('default-src none — alapból semmilyen erőforrás nem tölthető', () => {
  assert.equal(directive(INLINE_HTML_CONTENT_SECURITY_POLICY, 'default-src'), "default-src 'none'")
})

check('img-src KIZÁRÓLAG data: — nincs külső kép-egress (beacon/exfiltráció)', () => {
  const imgSrc = directive(INLINE_HTML_CONTENT_SECURITY_POLICY, 'img-src')
  assert.equal(imgSrc, 'img-src data:')
  // Regressziós zár: külső séma/host SOHA nem kerülhet vissza az img-src-be —
  // ezen menne ki a kép- és CSS-háttér-alapú kiszivárogtatás.
  assert.ok(imgSrc && !/https?:/.test(imgSrc), 'img-src nem engedhet http(s) forrást')
  assert.ok(imgSrc && !imgSrc.includes('*'), 'img-src nem engedhet wildcardot')
})

check('semmilyen direktíva nem nyit külső http(s) egresst', () => {
  // A teljes policy egyetlen direktívája sem engedhet külső hálózati forrást.
  assert.ok(!/https?:/.test(INLINE_HTML_CONTENT_SECURITY_POLICY), INLINE_HTML_CONTENT_SECURITY_POLICY)
})

check('style-src unsafe-inline megmarad (a riport megjeleníthető)', () => {
  assert.equal(directive(INLINE_HTML_CONTENT_SECURITY_POLICY, 'style-src'), "style-src 'unsafe-inline'")
})

check('a válasz nosniff + no-referrer, text/html', () => {
  const headers = inlineHtmlPreviewSecurityHeaders()
  assert.equal(headers['content-security-policy'], INLINE_HTML_CONTENT_SECURITY_POLICY)
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['referrer-policy'], 'no-referrer')
  assert.equal(INLINE_HTML_CONTENT_TYPE, 'text/html; charset=utf-8')
})

check('a meta-CSP (blob előnézet) sem enged külső egresst, és nincs benne sandbox', () => {
  // A sandbox direktíva meta-ban érvénytelen — az iframe attribútum viszi.
  assert.equal(directive(INLINE_HTML_META_CSP, 'sandbox'), null)
  assert.equal(directive(INLINE_HTML_META_CSP, 'img-src'), 'img-src data:')
  assert.ok(!/https?:/.test(INLINE_HTML_META_CSP), INLINE_HTML_META_CSP)
  const injected = htmlWithInlinePreviewCsp('<html><head></head><body>ok</body></html>')
  assert.match(injected, /http-equiv="Content-Security-Policy"/)
})

// A wiring-lock: nem elég, hogy a policy-string biztonságos — mindkét
// workspace-fájl route-nak TÉNYLEGESEN a közös helperről kell vennie a
// fejléceket az inline ágon, és sehol nem élhet tovább a régi, külső egresst
// engedő inline CSP-literál. Ez statikus forrás-ellenőrzés (a route-handler
// tenant-auth + prisma + storage függése miatt nem indítható olcsón unit-ban),
// de megfogja, ha egy jövőbeli szerkesztés kiejti a helpert vagy visszahozza a
// beégetett `img-src ... https:` policyt.
const routeDir = fileURLToPath(new URL('../src/app/api/v1', import.meta.url))
const inlineRoutes = [
  `${routeDir}/conversations/[id]/workspace/files/route.ts`,
  `${routeDir}/tickets/[id]/workspace/files/route.ts`,
]

for (const routePath of inlineRoutes) {
  const label = routePath.split('/api/v1/')[1] ?? routePath
  check(`a(z) ${label} a közös helperről veszi az inline fejléceket`, () => {
    const src = readFileSync(routePath, 'utf8')
    assert.ok(
      src.includes('inlineHtmlPreviewSecurityHeaders'),
      'a route-nak a közös inlineHtmlPreviewSecurityHeaders()-t kell hívnia',
    )
    // A régi, beégetett inline CSP (külső képforrással) nem élhet tovább.
    assert.ok(
      !/img-src[^'"]*https?:/.test(src),
      'a route nem tartalmazhat beégetett, külső egresst engedő img-src CSP-t',
    )
  })
}

if (failures > 0) {
  console.error(`\n${failures} teszt elbukott.`)
  process.exit(1)
}
console.log('\nMinden inline-HTML fejléc-teszt zöld.')
