import { PlaybookValidator } from '@/domain/playbook/playbook-validator'
import type { RawGate, RawStep } from '@/components/playbooks/playbook-flow-graph'
import { syncInputSlotsWithTemplate } from '@/lib/playbook-v2/input-slots-sync'
import type { PlaybookInputSlot, PlaybookRole } from '@/lib/playbook-v2/spec'

const playbookValidator = new PlaybookValidator()

export type PlaybookDraftSpec = {
  key?: string
  name?: string
  processType?: string
  roles?: PlaybookRole[]
  steps?: RawStep[]
  gates?: RawGate[]
  [k: string]: unknown
}

export type PlaybookValidationResult = {
  valid: boolean
  errors: Array<{ code: string; path: string; message: string }>
  warnings: Array<{ code: string; path: string; message: string }>
}

export function validatePlaybookDraftSpec(spec: PlaybookDraftSpec): PlaybookValidationResult {
  return playbookValidator.validateSpec(spec)
}

export function syncPlaybookSpecInputSlots(spec: PlaybookDraftSpec): PlaybookDraftSpec {
  const steps = (spec.steps ?? []).map((step) => {
    const instructionTemplate = step.instructionTemplate
    const inputSlots = syncInputSlotsWithTemplate(
      instructionTemplate,
      step.inputSlots as PlaybookInputSlot[] | undefined,
    )
    return { ...step, inputSlots }
  })
  return { ...spec, steps }
}
