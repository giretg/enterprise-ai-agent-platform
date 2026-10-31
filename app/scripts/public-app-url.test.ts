import assert from 'node:assert/strict'
import { publicAppUrl, resolvePublicAppOrigin } from '../src/lib/public-app-url'

const previousUrl = process.env.NEXT_PUBLIC_APP_URL
const previousNodeEnv = process.env.NODE_ENV
const forged = new Request('https://internal.example/api/client-policy/machine-floor', {
  headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
})

try {
  process.env.NODE_ENV = 'production'
  delete process.env.NEXT_PUBLIC_APP_URL
  assert.throws(() => resolvePublicAppOrigin(forged), /missing_NEXT_PUBLIC_APP_URL/)
  assert.throws(() => publicAppUrl('/connectors/oauth/callback', forged), /missing_NEXT_PUBLIC_APP_URL/)

  process.env.NEXT_PUBLIC_APP_URL = 'https://company.example/'
  assert.equal(resolvePublicAppOrigin(forged), 'https://company.example')
  assert.equal(publicAppUrl('/connectors/oauth/callback', forged).href, 'https://company.example/connectors/oauth/callback')

  for (const invalid of ['http://company.example', 'https://company.example/path', 'https://user@company.example']) {
    process.env.NEXT_PUBLIC_APP_URL = invalid
    assert.throws(() => resolvePublicAppOrigin(forged), /invalid_NEXT_PUBLIC_APP_URL/)
  }

  process.env.NODE_ENV = 'development'
  delete process.env.NEXT_PUBLIC_APP_URL
  assert.equal(resolvePublicAppOrigin(forged), 'https://attacker.example')
  console.log('public-app-url.test.ts: OK')
} finally {
  if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = previousUrl
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
}
