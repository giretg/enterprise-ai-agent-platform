import type { UserRole } from '@prisma/client'
import { hasMinimumRole } from '@/lib/iam-policy'
import type { SelfEvolutionProfile } from '@/lib/self-evolution-profile'

/**
 * MemoryTraining v1.1 §3.5 / §4.5 — user-kezdeményezett tartós memóriaírás
 * jóváhagyási küszöbe. Az általános `approval_mode` ezt NEM írhatja felül.
 *
 * NULL / hiányzó mező = legszigorúbb: jóváhagyó kell, négy szem elv be.
 */
export type DurableMemoryActivationMode = 'approver_required' | 'operator_can_activate'

export type DurableMemoryApprovalPolicy = {
  activation_mode: DurableMemoryActivationMode
  four_eyes_required: boolean
}

export const STRICT_DURABLE_MEMORY_POLICY: DurableMemoryApprovalPolicy = {
  activation_mode: 'approver_required',
  four_eyes_required: true,
}

export const INVALID_FOUR_EYES_WITH_OPERATOR_ACTIVATE =
  'A négy szem elv bekapcsolása jóváhagyót követel — az operátor nem aktiválhat saját javaslatot'

export type TrainingAllowedAction =
  | 'preview'
  | 'submit_for_approval'
  | 'activate'
  | 'reject'
  | 'build_on_pending'
  | 'replace_pending'
  | 'rollback'
  | 'configure_policy'

export type TrainingActionErrorCode =
  | 'stale_revision'
  | 'base_version_stale'
  | 'four_eyes_required'
  | 'activation_forbidden'
  | 'composition_required'
  | 'replace_not_allowed'
  | 'hard_floor'
  | 'scope_exceeded'
  | 'diff_limit_exceeded'
  | 'eval_failed'
  | 'pending_blocked'

export const TRAINING_USER_ERRORS: Record<TrainingActionErrorCode, string> = {
  stale_revision: 'A javaslat időközben frissült — nézd át a legújabb változatot',
  base_version_stale: 'A tanítás alapja időközben megváltozott — állítsd össze újra, és nézd át',
  four_eyes_required: 'Másik jóváhagyóra vár',
  activation_forbidden: 'Ehhez a tanításhoz jóváhagyó kell',
  composition_required: 'Válaszd ki, a meglévő javaslatba építed-e be, vagy lecseréled',
  replace_not_allowed: 'Más javaslatát csak jóváhagyó cserélheti le vagy vonhatja vissza',
  hard_floor: 'Ez a változás jogosultságot vagy eszközhozzáférést érintene — tanítással nem engedhető meg',
  scope_exceeded: 'Ez a tanítás kívül esik az agent önfejlesztési hatókörén',
  diff_limit_exceeded: 'A változás nagyobb, mint amit az agent tanítási korlátja megenged',
  eval_failed: 'Az ellenőrzés nem ment át — a tanítás nem léphet életbe',
  pending_blocked: 'A javaslatot a rendszer nem engedheti meg',
}

export class TrainingGateError extends Error {
  constructor(
    readonly code: TrainingActionErrorCode,
    message: string = TRAINING_USER_ERRORS[code],
  ) {
    super(message)
    this.name = 'TrainingGateError'
  }
}

export function resolveDurableMemoryApprovalPolicy(
  profile: SelfEvolutionProfile | null | undefined,
): DurableMemoryApprovalPolicy {
  const raw = profile?.durable_memory_approval_policy
  if (!raw) return { ...STRICT_DURABLE_MEMORY_POLICY }
  return {
    activation_mode: raw.activation_mode,
    four_eyes_required: raw.four_eyes_required,
  }
}

export function assertValidDurableMemoryPolicy(policy: DurableMemoryApprovalPolicy): void {
  if (policy.four_eyes_required && policy.activation_mode === 'operator_can_activate') {
    throw new Error(INVALID_FOUR_EYES_WITH_OPERATOR_ACTIVATE)
  }
}

export function hasTrainingProposeRight(role: UserRole): boolean {
  return hasMinimumRole(role, 'operator')
}

export function hasTrainingRejectRight(role: UserRole): boolean {
  return hasMinimumRole(role, 'approver')
}

export function hasTrainingRollbackRight(role: UserRole): boolean {
  return hasMinimumRole(role, 'approver')
}

export function hasTrainingConfigureRight(role: UserRole): boolean {
  return hasMinimumRole(role, 'admin')
}

/**
 * Aktiválási jog: RBAC ∩ agent policy. A policy nem emel szerepet —
 * `operator_can_activate` csak az operátor számára nyitja a kaput, viewert nem.
 */
export function hasTrainingActivationRight(
  role: UserRole,
  policy: DurableMemoryApprovalPolicy,
): boolean {
  if (policy.activation_mode === 'operator_can_activate') {
    return hasMinimumRole(role, 'operator')
  }
  return hasMinimumRole(role, 'approver')
}

export function fourEyesBlocksActor(params: {
  policy: DurableMemoryApprovalPolicy
  actorId: string
  revisionCreatedById: string | null | undefined
}): boolean {
  if (!params.policy.four_eyes_required) return false
  if (!params.revisionCreatedById) return false
  return params.actorId === params.revisionCreatedById
}

export function computeTrainingAllowedActions(params: {
  role: UserRole
  policy: DurableMemoryApprovalPolicy
  actorId: string
  pending: { createdById: string } | null
}): TrainingAllowedAction[] {
  const actions = new Set<TrainingAllowedAction>()
  const canPropose = hasTrainingProposeRight(params.role)
  const canActivateRole = hasTrainingActivationRight(params.role, params.policy)

  if (canPropose) {
    actions.add('preview')
    if (params.policy.activation_mode === 'approver_required') {
      actions.add('submit_for_approval')
    }
    if (params.pending) {
      actions.add('build_on_pending')
      const ownPending = params.pending.createdById === params.actorId
      if (ownPending || hasTrainingRejectRight(params.role)) {
        actions.add('replace_pending')
      }
    }
  }

  const pendingBlocksFourEyes =
    params.pending != null &&
    fourEyesBlocksActor({
      policy: params.policy,
      actorId: params.actorId,
      revisionCreatedById: params.pending.createdById,
    })

  if (canActivateRole && !pendingBlocksFourEyes) {
    if (params.pending || params.policy.activation_mode === 'operator_can_activate') {
      actions.add('activate')
    }
  }

  if (params.pending && hasTrainingRejectRight(params.role)) {
    actions.add('reject')
  }

  if (hasTrainingRollbackRight(params.role)) actions.add('rollback')
  if (hasTrainingConfigureRight(params.role)) actions.add('configure_policy')

  return [...actions]
}

export function nextStepLabel(params: {
  allowedActions: TrainingAllowedAction[]
  pending: boolean
  fourEyesWaiting: boolean
}): string | null {
  if (params.fourEyesWaiting) return 'Másik jóváhagyóra vár'
  if (params.pending && params.allowedActions.includes('activate')) return null
  if (params.pending) return 'Approver jóváhagyására vár'
  return null
}
