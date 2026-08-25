/**
 * MemoryTraining v1.1 — tartós memória-jóváhagyási policy és gombkészlet.
 *
 * Futtatás: npm run test:durable-memory-policy
 */
import assert from 'node:assert/strict'
import { resolveSelfEvolutionProfile } from '../src/lib/self-evolution-profile'
import {
  STRICT_DURABLE_MEMORY_POLICY,
  assertValidDurableMemoryPolicy,
  computeTrainingAllowedActions,
  fourEyesBlocksActor,
  hasTrainingActivationRight,
  nextStepLabel,
  resolveDurableMemoryApprovalPolicy,
} from '../src/domain/training/durable-memory-policy'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const OPERATOR = 'operator' as const
const APPROVER = 'approver' as const
const VIEWER = 'viewer' as const
const ADMIN = 'admin' as const
const USER_A = 'user-a'
const USER_B = 'user-b'

async function run() {
  await test('NULL profil = approver_required + four_eyes', () => {
    const profile = resolveSelfEvolutionProfile(null)
    assert.deepEqual(resolveDurableMemoryApprovalPolicy(profile), STRICT_DURABLE_MEMORY_POLICY)
  })

  await test('hiányzó policy mező a szigorú defaultot kapja', () => {
    const profile = resolveSelfEvolutionProfile({ scope: ['memory'], approval_mode: 'human' })
    assert.deepEqual(resolveDurableMemoryApprovalPolicy(profile), STRICT_DURABLE_MEMORY_POLICY)
  })

  await test('négy szem + operator_can_activate érvénytelen', () => {
    assert.throws(
      () =>
        resolveSelfEvolutionProfile({
          scope: ['memory'],
          approval_mode: 'human',
          durable_memory_approval_policy: {
            activation_mode: 'operator_can_activate',
            four_eyes_required: true,
          },
        }),
      /négy szem/,
    )
    assert.throws(
      () =>
        assertValidDurableMemoryPolicy({
          activation_mode: 'operator_can_activate',
          four_eyes_required: true,
        }),
      /négy szem/,
    )
  })

  await test('T13: operator + approver_required nem aktiválhat', () => {
    const policy = { activation_mode: 'approver_required' as const, four_eyes_required: false }
    assert.equal(hasTrainingActivationRight(OPERATOR, policy), false)
    const actions = computeTrainingAllowedActions({
      role: OPERATOR,
      policy,
      actorId: USER_A,
      pending: { createdById: USER_A },
    })
    assert.ok(actions.includes('preview'))
    assert.ok(actions.includes('submit_for_approval'))
    assert.ok(actions.includes('build_on_pending'))
    assert.equal(actions.includes('activate'), false)
    assert.equal(nextStepLabel({ allowedActions: actions, pending: true, fourEyesWaiting: false }), 'Jóváhagyó döntésére vár')
  })

  await test('T14: operator + operator_can_activate aktiválhat', () => {
    const policy = { activation_mode: 'operator_can_activate' as const, four_eyes_required: false }
    assert.equal(hasTrainingActivationRight(OPERATOR, policy), true)
    const actions = computeTrainingAllowedActions({
      role: OPERATOR,
      policy,
      actorId: USER_A,
      pending: { createdById: USER_A },
    })
    assert.ok(actions.includes('activate'))
  })

  await test('T15: viewer nem kap szerkesztő/aktiváló gombot', () => {
    const actions = computeTrainingAllowedActions({
      role: VIEWER,
      policy: STRICT_DURABLE_MEMORY_POLICY,
      actorId: USER_A,
      pending: { createdById: USER_B },
    })
    assert.deepEqual(actions, [])
  })

  await test('T21: approver saját javaslatát négy szem elvnél nem aktiválhatja', () => {
    assert.equal(
      fourEyesBlocksActor({
        policy: STRICT_DURABLE_MEMORY_POLICY,
        actorId: USER_A,
        revisionCreatedById: USER_A,
      }),
      true,
    )
    const actions = computeTrainingAllowedActions({
      role: APPROVER,
      policy: STRICT_DURABLE_MEMORY_POLICY,
      actorId: USER_A,
      pending: { createdById: USER_A },
    })
    assert.equal(actions.includes('activate'), false)
    assert.ok(actions.includes('reject'))
    assert.equal(
      nextStepLabel({ allowedActions: actions, pending: true, fourEyesWaiting: true }),
      'Másik jóváhagyóra vár',
    )
  })

  await test('T22: másik approver aktiválhatja', () => {
    const actions = computeTrainingAllowedActions({
      role: APPROVER,
      policy: STRICT_DURABLE_MEMORY_POLICY,
      actorId: USER_B,
      pending: { createdById: USER_A },
    })
    assert.ok(actions.includes('activate'))
    assert.ok(actions.includes('reject'))
  })

  await test('más javaslatát operator nem cserélheti le, approver igen', () => {
    const operator = computeTrainingAllowedActions({
      role: OPERATOR,
      policy: STRICT_DURABLE_MEMORY_POLICY,
      actorId: USER_B,
      pending: { createdById: USER_A },
    })
    assert.ok(operator.includes('build_on_pending'))
    assert.equal(operator.includes('replace_pending'), false)

    const own = computeTrainingAllowedActions({
      role: OPERATOR,
      policy: STRICT_DURABLE_MEMORY_POLICY,
      actorId: USER_A,
      pending: { createdById: USER_A },
    })
    assert.ok(own.includes('replace_pending'))

    const approver = computeTrainingAllowedActions({
      role: APPROVER,
      policy: STRICT_DURABLE_MEMORY_POLICY,
      actorId: USER_B,
      pending: { createdById: USER_A },
    })
    assert.ok(approver.includes('replace_pending'))
  })

  await test('admin beállíthatja a policy-t és rollbackelhet', () => {
    const actions = computeTrainingAllowedActions({
      role: ADMIN,
      policy: STRICT_DURABLE_MEMORY_POLICY,
      actorId: USER_A,
      pending: null,
    })
    assert.ok(actions.includes('configure_policy'))
    assert.ok(actions.includes('rollback'))
    assert.ok(actions.includes('preview'))
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nÖsszes durable-memory-policy teszt zöld')
}

run()
