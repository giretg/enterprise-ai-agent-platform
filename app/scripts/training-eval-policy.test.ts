/** Kötelező eval-kapu — override-policy regressziós teszt. */
import assert from 'node:assert/strict'
import { mayOverrideFailedEval } from '../src/domain/training/training-service'
import { resolveSelfEvolutionProfile } from '../src/lib/self-evolution-profile'

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

console.log('4/4 eval override-policy eset zöld')
