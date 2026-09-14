/**
 * Google OAuth verification — a dedicated /privacy page must contain the
 * English disclosures the Trust & Safety crawler looks for.
 * Futtatás: npx tsx scripts/oauth-privacy-policy-page.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const page = readFileSync(join(root, 'src/app/privacy/page.tsx'), 'utf8')
const shell = readFileSync(join(root, 'src/components/public-site/public-site-shell.tsx'), 'utf8')

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

check('title is Privacy Policy, not a homepage alias', () => {
  assert.match(page, /title:\s*'Privacy Policy'/)
  assert.match(page, /title="Privacy Policy"/)
  assert.match(page, /canonical: 'https:\/\/ai\.excellencepay\.com\/privacy'/)
})

const requiredHeadings = [
  'What Google user data is accessed by this application',
  'How this application uses Google user data',
  'How this application stores Google user data',
  'How we share, transfer, or disclose Google user data',
  'Data protection mechanisms',
  'Data retention and deletion',
  'Limited Use of Google user data',
]

for (const heading of requiredHeadings) {
  check(`contains heading: ${heading}`, () => {
    assert.ok(page.includes(heading), `missing: ${heading}`)
  })
}

check('Limited Use: no non-personalized AI/ML training', () => {
  assert.match(page, /Google API Services User Data Policy/)
  assert.match(page, /non-personalized AI/)
  assert.match(page, /sell Google user data/)
})

check('encryption and deletion are explicit', () => {
  assert.match(page, /TLS encryption/i)
  assert.match(page, /encrypted/)
  assert.match(page, /delete the[\s\S]{0,20}stored tokens/)
  assert.match(page, /myaccount\.google\.com\/permissions/)
})

check('homepage chrome links to Privacy Policy in English', () => {
  assert.match(shell, /href: '\/privacy',\s*label: 'Privacy Policy'/)
  assert.match(shell, /Privacy Policy/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
