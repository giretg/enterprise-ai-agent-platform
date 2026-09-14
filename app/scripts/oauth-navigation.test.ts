import assert from 'node:assert/strict'
import { oauthNavigationTarget } from '../src/lib/oauth-navigation'

const parent = { location: { assign: () => {} } }
const frame = { location: { assign: () => {} } }

assert.equal(oauthNavigationTarget(frame, parent), parent)
assert.equal(oauthNavigationTarget(frame, null), frame)

console.log('✅ OAuth navigáció iframe-ből is a felső ablakot célozza')
