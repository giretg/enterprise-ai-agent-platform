import type {
  MemoryVersionStatus,
  TrainingOrigin,
  TrainingProposalCompositionMode,
  TrainingProposalRevisionStatus,
  TrainingProposalTokenStatus,
  TrainingScopeClass,
} from '@prisma/client'
import type { ChangeSummary, ImpactResult } from './training-composition'

export type InstructionVersionRow = {
  id: string
  memoryId: string
  version: number
  content: string | null
  status: MemoryVersionStatus
  source: string | null
  approvedById: string | null
  parentVersion: number | null
  createdAt: Date
}

export type AgentTrainingContext = {
  id: string
  tenantId: string | null
  name: string
  currentVersion: number
  selfEvolutionProfile: unknown
  memoryId: string
  currentInstruction: InstructionVersionRow | null
}

export type TrainingMetaRow = {
  ticketId: string
  proposedDiff: unknown
  writeGateTokenRef: string | null
  evalResult: unknown
  evalRequired: boolean
  origin: TrainingOrigin
  scopeClass: TrainingScopeClass
  targetMemoryVersion: number
  currentRevisionId: string | null
}

export type RevisionRow = {
  id: string
  trainingTicketId: string
  revision: number
  baseVersionId: string
  proposedVersionRef: string
  changeSummary: ChangeSummary
  impactResult: ImpactResult
  compositionMode: TrainingProposalCompositionMode
  status: TrainingProposalRevisionStatus
  targetMemoryVersion: number
  writeGateTokenRef: string | null
  tokenStatus: TrainingProposalTokenStatus
  tokenExpiresAt: Date | null
  createdById: string
  createdAt: Date
}

export interface TrainingStore {
  findAgentContext(agentId: string): Promise<AgentTrainingContext | null>
  nextInstructionVersion(memoryId: string): Promise<number>
  listInstructionVersions(memoryId: string, limit: number): Promise<InstructionVersionRow[]>
  findInstructionVersion(memoryId: string, version: number): Promise<InstructionVersionRow | null>
  findTrainingMeta(ticketId: string): Promise<TrainingMetaRow | null>
  createTrainingMeta(data: {
    ticketId: string
    proposedDiff: unknown
    targetMemoryVersion: number
    evalRequired: boolean
    origin: TrainingOrigin
    scopeClass: TrainingScopeClass
  }): Promise<void>
  updateTrainingMeta(
    ticketId: string,
    data: Partial<Pick<TrainingMetaRow, 'proposedDiff' | 'writeGateTokenRef' | 'evalResult' | 'currentRevisionId' | 'targetMemoryVersion'>>,
  ): Promise<void>
  listRevisions(ticketId: string): Promise<RevisionRow[]>
  findRevision(id: string): Promise<RevisionRow | null>
  createRevision(
    data: Omit<RevisionRow, 'id' | 'createdAt' | 'status' | 'tokenStatus' | 'writeGateTokenRef' | 'tokenExpiresAt'> &
      Partial<Pick<RevisionRow, 'id' | 'status' | 'tokenStatus' | 'writeGateTokenRef' | 'tokenExpiresAt'>>,
  ): Promise<RevisionRow>
  /** Csak még nem foglalt javaslat cserélhető le; a visszatérő darabszám CAS-jelzés. */
  supersedeCurrentRevisions(ticketId: string): Promise<number>
  updateRevision(
    id: string,
    data: Partial<Pick<RevisionRow, 'status' | 'tokenStatus' | 'writeGateTokenRef' | 'tokenExpiresAt'>>,
  ): Promise<void>
  /**
   * Egy jóváhagyási próbálkozás kizárólagos foglalása. A write-gate kiadása
   * csak a sikeres foglalás UTÁN indulhat, különben két párhuzamos kérés
   * külön tokent fogyaszthatna ugyanahhoz a revízióhoz.
   */
  claimRevisionActivation(revisionId: string): Promise<boolean>
  /** Sikertelen, még memóriaírás nélküli próbálkozás után újrapróbálhatóvá teszi a revíziót. */
  releaseRevisionActivationClaim(revisionId: string): Promise<void>
  activateInstructionVersion(data: {
    memoryId: string
    version: number
    content: string
    diffFromPrevious: unknown
    source: string | null
    approvedById: string
    parentVersion: number | null
    expectedCurrentVersionId: string | null
  }): Promise<InstructionVersionRow | null>
  restoreInstructionVersion(params: {
    memoryId: string
    targetId: string
    expectedCurrentVersionId: string | null
  }): Promise<boolean>
  findUser(id: string): Promise<{ id: string } | null>
}
