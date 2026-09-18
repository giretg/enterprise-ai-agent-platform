import type { MemoryVersionStatus } from '@prisma/client'
import type { DurableMemoryApprovalPolicy, TrainingAllowedAction } from './durable-memory-policy'
import type { ChangeSummary, ImpactResult } from './training-composition'

export type TrainingWorkspaceView<DateValue = Date> = {
  agentId: string
  agentName: string
  activeVersion: {
    id: string
    version: number
    content: string
    createdAt: DateValue
    source: string | null
  } | null
  pendingProposal: {
    ticketId: string
    revisionId: string
    revision: number
    proposedVersion: string
    changeSummary: ChangeSummary
    impactResult: ImpactResult
    createdById: string
    targetMemoryVersion: number
    fourEyesWaiting: boolean
    nextStep: string | null
  } | null
  allowedActions: TrainingAllowedAction[]
  timeline: Array<{
    id: string
    version: number
    status: MemoryVersionStatus
    source: string | null
    approvedBy: string | null
    createdAt: DateValue
    content: string | null
  }>
  policy: DurableMemoryApprovalPolicy
}
