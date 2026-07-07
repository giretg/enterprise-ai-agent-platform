/**
 * Fail-closed titok-feloldás — DB nélküli logikai tesztek (Architektúra-review F1 / WP-1).
 * Futtatás: npm run test:secret-config
 *
 * Fedi: prod-throw (hiányzó env), dev-fallback + warn, env-elsőbbség, fallback-lánc.
 */
import assert from 'node:assert/strict'
import { resolveSecret } from '../src/lib/crypto/secret-resolver'

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

/** Ideiglenesen beállítja a NODE_ENV-et és a megadott env-kulcsokat, majd visszaállít. */
function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k]
    if (overrides[k] === undefined) delete process.env[k]
    else process.env[k] = overrides[k]
  }
  try {
    fn()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// ── prod-ág: fail-closed ───────────────────────────────────────────────────

check('prod + hiányzó env → dob (nem fut default-tal)', () => {
  withEnv({ NODE_ENV: 'production', WRITE_GATE_SECRET: undefined }, () => {
    assert.throws(
      () => resolveSecret(['WRITE_GATE_SECRET'], 'dev-default'),
      /Kötelező titok hiányzik prod alatt/,
    )
  })
})

check('prod + üres string env → dob (üres nem számít beállítottnak)', () => {
  withEnv({ NODE_ENV: 'production', WRITE_GATE_SECRET: '' }, () => {
    assert.throws(() => resolveSecret(['WRITE_GATE_SECRET'], 'dev-default'))
  })
})

check('prod + beállított env → az env-értéket adja (nem dob)', () => {
  withEnv({ NODE_ENV: 'production', WRITE_GATE_SECRET: 'real-prod-secret' }, () => {
    assert.equal(resolveSecret(['WRITE_GATE_SECRET'], 'dev-default'), 'real-prod-secret')
  })
})

check('prod hibaüzenet felsorolja a teljes fallback-láncot', () => {
  withEnv(
    { NODE_ENV: 'production', OAUTH_STATE_SECRET: undefined, WRITE_GATE_SECRET: undefined },
    () => {
      assert.throws(
        () => resolveSecret(['OAUTH_STATE_SECRET', 'WRITE_GATE_SECRET'], 'dev-default'),
        /OAUTH_STATE_SECRET \| WRITE_GATE_SECRET/,
      )
    },
  )
})

// ── dev-ág: fail-open determinisztikus default + warn ──────────────────────

check('nem-prod + hiányzó env → dev-default + warn', () => {
  withEnv({ NODE_ENV: 'test', WRITE_GATE_SECRET: undefined }, () => {
    const warnings: string[] = []
    const orig = console.warn
    console.warn = (msg?: unknown) => warnings.push(String(msg))
    try {
      const v = resolveSecret(['WRITE_GATE_SECRET'], 'dev-default')
      assert.equal(v, 'dev-default')
      assert.ok(
        warnings.some((w) => w.includes('DEV default')),
        'warn-nak jeleznie kell a dev-default használatát',
      )
    } finally {
      console.warn = orig
    }
  })
})

check('development + beállított env → az env nyer a default felett', () => {
  withEnv({ NODE_ENV: 'development', WRITE_GATE_SECRET: 'local-secret' }, () => {
    assert.equal(resolveSecret(['WRITE_GATE_SECRET'], 'dev-default'), 'local-secret')
  })
})

// ── fallback-lánc elsőbbség ─────────────────────────────────────────────────

check('fallback-lánc: az első beállított env nyer', () => {
  withEnv(
    { NODE_ENV: 'test', OAUTH_STATE_SECRET: 'primary', WRITE_GATE_SECRET: 'secondary' },
    () => {
      assert.equal(
        resolveSecret(['OAUTH_STATE_SECRET', 'WRITE_GATE_SECRET'], 'dev-default'),
        'primary',
      )
    },
  )
})

check('fallback-lánc: primer hiányában a másodlagos env-re esik', () => {
  withEnv(
    { NODE_ENV: 'test', OAUTH_STATE_SECRET: undefined, WRITE_GATE_SECRET: 'secondary' },
    () => {
      assert.equal(
        resolveSecret(['OAUTH_STATE_SECRET', 'WRITE_GATE_SECRET'], 'dev-default'),
        'secondary',
      )
    },
  )
})

// ── összegzés ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
