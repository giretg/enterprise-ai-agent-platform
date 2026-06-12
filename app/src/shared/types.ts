export type TicketStatus =
  | 'backlog'
  | 'in_review'
  | 'approved'
  | 'in_progress'
  | 'awaiting_human'
  | 'done'

export type TicketType = 'work' | 'training'

export interface Agent {
  id: string
  name: string
  role: string
  model: string
  status: 'active' | 'paused' | 'retired'
  version: string
}

export interface MemoryVersion {
  id: string
  version: string
  label: string
  content: string
  createdAt: string
  isActive: boolean
}

export interface AgentResource {
  id: string
  type: 'policy' | 'secret' | 'file' | 'connector' | 'tool' | 'dataset'
  name: string
  scope: string
  version: string
}

export interface CatalogResource {
  id: string
  type: AgentResource['type']
  name: string
  scope: 'org' | 'sandbox' | 'agent'
  version: string
  description: string
  boundAgentIds: string[]
}

export interface CreateAgentInput {
  name: string
  role: string
  systemPrompt: string
  resourceIds: string[]
  provider: string
  model: string
  temperature: number
  permissions: string[]
}

export interface ModelUsageDay {
  date: string
  tokens: number
  costEur: number
}

export interface AgentModelUsage {
  agentId: string
  agentName: string
  model: string
  tokensToday: number
  costTodayEur: number
  tokensMonth: number
  costMonthEur: number
}

export interface GuardrailViolation {
  id: string
  timestamp: string
  agentName: string
  rule: string
  severity: 'low' | 'medium' | 'high'
  action: string
}

export interface PlaybookStep {
  id: string
  order: number
  label: string
  actor: 'agent' | 'human' | 'system'
  description: string
}

export interface PlaybookActualStep {
  id: string
  order: number
  label: string
  auditAction: string
  timestamp: string
  matched: boolean
}

export interface AgentTool {
  id: string
  name: string
  description: string
  scope: string
}

export interface ModelConfig {
  provider: string
  model: string
  temperature: number
  maxTokens: number
  guardrails: string[]
}

export interface AgentDetail {
  id: string
  name: string
  role: string
  status: Agent['status']
  version: string
  lifecycle: string
  serviceAccount: string
  apiKeyPreview: string
  systemPrompt: string
  memoryVersions: MemoryVersion[]
  activeMemoryVersionId: string
  resources: AgentResource[]
  tools: AgentTool[]
  modelConfig: ModelConfig
  permissions: string[]
}

export interface TrainingDiff {
  summary: string
  before: string
  after: string
  evalGatePassed: boolean
  writeGateToken: string
  approvalChain: string[]
}

export interface InvoiceProposal {
  id: string
  supplier: string
  invoiceNumber: string
  date: string
  netAmount: number
  vatAmount: number
  grossAmount: number
  suggestedAccount: string
  suggestedAccountName: string
  costCenter: string
  reasoning: string
  agentId: string
  agentVersion: string
  model: string
  sourceFileName: string
}

export interface Ticket {
  id: string
  title: string
  type: TicketType
  status: TicketStatus
  assignee: string
  assigneeType: 'human' | 'agent'
  agentId?: string
  agentVersion?: string
  model?: string
  proposal?: InvoiceProposal
  trainingDiff?: TrainingDiff
  createdAt: string
  updatedAt: string
}

export interface AuditEntry {
  id: string
  timestamp: string
  actor: string
  actorType: 'human' | 'agent' | 'system'
  action: string
  resource: string
  agentVersion?: string
  model?: string
  hash: string
  previousHash: string
}

export interface DashboardStats {
  activeAgents: number
  openTickets: number
  tokensToday: number
  costTodayEur: number
  guardrailStatus: 'ok' | 'warning' | 'blocked'
}

export interface ProcessingJob {
  id: string
  fileName: string
  status: 'processing' | 'complete'
  startedAt: string
}

export type HumanRole =
  | 'platform_admin'
  | 'agent_admin'
  | 'approver'
  | 'operator'
  | 'auditor'

export interface HumanUser {
  id: string
  name: string
  email: string
  role: HumanRole
  authProvider: 'Clerk SSO' | 'Keycloak' | 'Local (demo)'
  lastLogin: string
  permissions: string[]
  status: 'active' | 'invited' | 'disabled'
}

export interface AgentServiceAccount {
  id: string
  agentId: string
  agentName: string
  serviceAccount: string
  apiKeyPreview: string
  keyExpiresAt: string
  runtime: 'trusted_internal' | 'untrusted_external'
  permissions: string[]
  status: 'active' | 'rotating' | 'revoked'
}

export interface RoleDefinition {
  id: HumanRole
  label: string
  description: string
  permissions: string[]
}

export interface TicketTransition {
  from: TicketStatus | '*'
  to: TicketStatus
  allowedRoles: HumanRole[]
  requiresApproval?: boolean
}

export interface ApprovalChainStep {
  order: number
  role: HumanRole | 'any_approver'
  label: string
}

export interface TicketTypeConfig {
  id: string
  type: TicketType
  label: string
  description: string
  allowedStatuses: TicketStatus[]
  transitions: TicketTransition[]
  defaultAssignee: string
  approvalChain: ApprovalChainStep[]
  writeGateRequired: boolean
}

export const TICKET_COLUMNS: { key: TicketStatus; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'in_review', label: 'In Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'awaiting_human', label: 'Awaiting Human' },
  { key: 'done', label: 'Done' },
]
