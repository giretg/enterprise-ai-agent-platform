/**
 * Nyilvános i18n útvonalak — a locale-prefixek, az OAuth-aliasok és a Clerk/crawler
 * allowlist egy forrásból jön (`src/i18n/config.ts`). Ez a teszt azt rögzíti, hogy
 * egy új publikus oldal felvétele ne nyissa ki a control-plane-t, és a Google
 * OAuth URL-ek (`/privacy`, `/gtc`) megmaradjanak.
 *
 * Futtatás: npm run test:i18n
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allPublicBrandingPaths,
  isAppLocale,
  isPublicBrandingPath,
  localizedPublicPath,
  publicBrandingRoutePatterns,
  robotsAllowRules,
  unprefixedAliasLocale,
} from '../src/i18n/config'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

function messageKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : []
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    messageKeys(nested, prefix ? `${prefix}.${key}` : key),
  )
}

check('a támogatott locale-ok hu és en, alapértelmezés hu', () => {
  assert.equal(isAppLocale('hu'), true)
  assert.equal(isAppLocale('en'), true)
  assert.equal(isAppLocale('de'), false)
  assert.equal(localizedPublicPath('/', 'hu'), '/hu')
  assert.equal(localizedPublicPath('/privacy', 'en'), '/en/privacy')
})

check('a branding-útvonalak tartalmazzák a locale-prefixes verziókat is', () => {
  const paths = allPublicBrandingPaths()
  for (const path of ['/', '/privacy', '/gtc', '/hu', '/en', '/hu/privacy', '/en/privacy', '/hu/gtc', '/en/gtc']) {
    assert.ok(paths.includes(path), `hiányzik: ${path}`)
    assert.equal(isPublicBrandingPath(path), true, `${path} branding-útvonal kell legyen`)
    assert.equal(isPublicBrandingPath(`${path}/`), true, `${path}/ trailing slash-sel is branding`)
  }
})

check('a control-plane és a szomszédos útvonalak NEM branding-oldalak', () => {
  assert.equal(isPublicBrandingPath('/control-plane'), false)
  assert.equal(isPublicBrandingPath('/sign-in'), false)
  assert.equal(isPublicBrandingPath('/privacy-admin'), false)
  assert.equal(isPublicBrandingPath('/gtc-admin'), false)
  assert.equal(isPublicBrandingPath('/hu/control-plane'), false)
  assert.equal(isPublicBrandingPath('/en/agents'), false)
})

check('a Clerk minták nem nyitják ki a /hu/* catch-allt', () => {
  const patterns = publicBrandingRoutePatterns()
  assert.ok(patterns.includes('/hu'))
  assert.ok(patterns.includes('/en/privacy'))
  assert.ok(patterns.includes('/en/privacy/(.*)'))
  assert.ok(!patterns.includes('/hu/(.*)'), 'a /hu/(.*) a control-plane-t is publikussá tenné locale-prefix alatt')
  assert.ok(!patterns.includes('/en/(.*)'))
})

check('a prefix nélküli /privacy angol, a /gtc magyar alias marad (OAuth + meglévő könyvjelzők)', () => {
  assert.equal(unprefixedAliasLocale('/privacy'), 'en')
  assert.equal(unprefixedAliasLocale('/privacy/'), 'en')
  assert.equal(unprefixedAliasLocale('/gtc'), 'hu')
  assert.equal(unprefixedAliasLocale('/'), null)
  assert.equal(unprefixedAliasLocale('/hu/privacy'), null)
})

check('a robots allow-lista a gyökeret, a locale-home-ot és a jogi oldalakat engedi', () => {
  const allow = robotsAllowRules()
  assert.ok(allow.includes('/$'))
  assert.ok(allow.includes('/hu$'))
  assert.ok(allow.includes('/en$'))
  assert.ok(allow.includes('/privacy'))
  assert.ok(allow.includes('/gtc'))
  assert.ok(allow.includes('/hu/'))
  assert.ok(allow.includes('/en/'))
})

check('a hu és en üzenetfájlok kulcskészlete megegyezik', () => {
  const hu = JSON.parse(readFileSync(join(root, 'src/messages/hu.json'), 'utf8')) as unknown
  const en = JSON.parse(readFileSync(join(root, 'src/messages/en.json'), 'utf8')) as unknown
  assert.deepEqual(messageKeys(hu).sort(), messageKeys(en).sort())
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
