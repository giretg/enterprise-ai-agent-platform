/** Kötelező eval-kapu — override-policy regressziós teszt. */
import assert from 'node:assert/strict'
import { mayOverrideFailedEval } from '../src/domain/training/training-service'
import { resolveSelfEvolutionProfile } from '../src/lib/self-evolution-profile'
import { normalizeTicketTypeConfig } from '../src/domain/ticket/ticket-type-config'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'

const profiles = [
  ['human', true],
  ['higher_role', true],
  ['eval_only', false],
  ['auto_after_eval', false],
] as const

for (const [approvalMode, expected] of profiles) {
  const profile = resolveSelfEvolutionProfile({ scope: ['memory'], approval_mode: approvalMode })
  assert.equal(
    mayOverrideFailedEval(profile),
    expected,
    `${approvalMode}: sikertelen eval override-policy`,
  )
}

const configured = normalizeTicketTypeConfig(
  {
    type: 'training',
    allowedTransitions: [{ from: 'awaiting_human', to: 'rejected', allowed: 'operator' }],
  },
  'training',
)
assert.equal(
  configured.allowedTransitions.find((rule) => rule.from === 'awaiting_human' && rule.to === 'rejected')
    ?.allowed,
  'system_or_operator',
  'a kötelező eval-bukás system rejectionje testreszabott ticket-configban is megmarad',
)

for (const action of ['training.eval_created', 'training.eval', 'training.eval_read']) {
  assert.doesNotThrow(() => assertAuditActionRegistered(action), `${action}: audit-katalógus`)
}

console.log('8/8 eval governance policy eset zöld')
