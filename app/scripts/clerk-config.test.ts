/**
 * Clerk / DevAuth kapcsoló.
 * Futtatás: npx tsx scripts/clerk-config.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isClerkEnabled, isClerkUiEnabled, isDevAuthAllowed } from '../src/lib/clerk-config'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const saved = {
  AUTH_DISABLED: process.env.AUTH_DISABLED,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  NODE_ENV: process.env.NODE_ENV,
}

function restore() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

try {
  check('AUTH_DISABLED=true → Clerk ki, akkor is ha mindkét kulcs megvan', () => {
    process.env.AUTH_DISABLED = 'true'
    process.env.CLERK_SECRET_KEY = 'sk_test'
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test'
    assert.equal(isClerkEnabled(), false)
    assert.equal(isClerkUiEnabled(), true)
  })

  check('kulcsok megvannak, flag nincs → Clerk be', () => {
    delete process.env.AUTH_DISABLED
    process.env.CLERK_SECRET_KEY = 'sk_test'
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test'
    assert.equal(isClerkEnabled(), true)
  })

  check('hiányzó publishable key → Clerk ki', () => {
    delete process.env.AUTH_DISABLED
    process.env.CLERK_SECRET_KEY = 'sk_test'
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    assert.equal(isClerkEnabled(), false)
  })

  check('dev auth csak nem-productionban engedett', () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    assert.equal(isDevAuthAllowed(), true)
    process.env.NODE_ENV = 'production'
    assert.equal(isDevAuthAllowed(), false)
    process.env.NODE_ENV = previous
  })

  check('a root layout a szerver isClerkEnabled döntését adja a ClerkProvidernek', () => {
    const layout = readFileSync(resolve(process.cwd(), 'src/app/layout.tsx'), 'utf8')
    const providers = readFileSync(
      resolve(process.cwd(), 'src/components/auth/providers.tsx'),
      'utf8',
    )
    const shell = readFileSync(resolve(process.cwd(), 'src/components/ui/shell.tsx'), 'utf8')
    assert.match(layout, /clerkEnabled=\{isClerkEnabled\(\)\}/)
    assert.match(
      layout,
      /<html lang="hu" suppressHydrationWarning>/,
      'html: böngésző-extension attribútum ne indítson Next recovery-flasht',
    )
    assert.match(providers, /ClerkEnabledContext.Provider/)
    assert.match(shell, /useClerkEnabled\(\)/)
    assert.doesNotMatch(shell, /isClerkUiEnabled/)
    const pkg = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    assert.match(
      pkg,
      /"dev:local-auth": "AUTH_DISABLED=true NEXT_DIST_DIR=\.next-local-auth next dev --port 3001"/,
    )
  })
} finally {
  restore()
}

if (failures > 0) {
  console.error(`\n${failures} teszt megbukott`)
  process.exit(1)
}
console.log('\nMinden teszt rendben.')
