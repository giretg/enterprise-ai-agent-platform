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

export const TICKET_COLUMNS: { key: TicketStatus; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'in_review', label: 'In Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'awaiting_human', label: 'Awaiting Human' },
  { key: 'done', label: 'Done' },
]
