/**
 * Default user→agent grant — deny-by-default rendszer-szerepű agentekre (#344).
 *
 * Futtatás: npm run test:default-user-agent-grants
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_GRANTABLE_SYSTEM_ROLES,
  RUN_ANALYST_SYSTEM_ROLE,
  WEB_EGRESS_SYSTEM_ROLE,
  receivesDefaultUserAgentGrants,
} from '../src/lib/platform-agent-registry'

let failures = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : error}`)
  }
}

console.log('\nDefault user→agent grant — deny-by-default')

test('a deny-by-default allowlist üres', () => {
  assert.deepEqual(DEFAULT_GRANTABLE_SYSTEM_ROLES, [])
})

test('normál agent (systemRole: null) grantolható', () => {
  assert.equal(receivesDefaultUserAgentGrants({ systemRole: null }), true)
  assert.equal(receivesDefaultUserAgentGrants({}), true)
})

test('web_egress nem kap kiinduló user→agent grantot', () => {
  assert.equal(receivesDefaultUserAgentGrants({ systemRole: WEB_EGRESS_SYSTEM_ROLE }), false)
})

test('egy tetszőleges (nem allowlist-elt) rendszer-szerep (run_analyst) nem grantolható', () => {
  assert.equal(receivesDefaultUserAgentGrants({ systemRole: RUN_ANALYST_SYSTEM_ROLE }), false)
})

console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} teszt elbukott.`)
process.exitCode = failures === 0 ? 0 : 1
