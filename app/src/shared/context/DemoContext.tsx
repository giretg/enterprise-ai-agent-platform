import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  agents,
  dashboardStats,
  demoProposalTemplate,
  initialAuditLog,
  initialTickets,
} from '../mock-data'
import type {
  AuditEntry,
  InvoiceProposal,
  ProcessingJob,
  Ticket,
  TicketStatus,
} from '../types'

interface DemoContextValue {
  tickets: Ticket[]
  auditLog: AuditEntry[]
  stats: typeof dashboardStats
  agents: typeof agents
  processingJobs: ProcessingJob[]
  currentProposal: InvoiceProposal | null
  uploadInvoice: (fileName: string) => string
  completeProcessing: (jobId: string) => InvoiceProposal
  sendForApproval: (proposal: InvoiceProposal) => string
  approveTicket: (ticketId: string) => void
  rejectTicket: (ticketId: string) => void
  getTicket: (ticketId: string) => Ticket | undefined
  moveTicket: (ticketId: string, status: TicketStatus) => void
}

const DemoContext = createContext<DemoContextValue | null>(null)

let idCounter = 2000

function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function makeHash(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(16).padStart(8, '0') + '…' + seed.slice(-4)
}

function nowIso(): string {
  return new Date().toISOString()
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets)
  const [auditLog, setAuditLog] = useState<AuditEntry[]>(initialAuditLog)
  const [processingJobs, setProcessingJobs] = useState<ProcessingJob[]>([])
  const [currentProposal, setCurrentProposal] = useState<InvoiceProposal | null>(
    null,
  )

  const appendAudit = useCallback(
    (
      entry: Omit<AuditEntry, 'id' | 'hash' | 'previousHash' | 'timestamp'>,
    ) => {
      setAuditLog((prev) => {
        const id = nextId('AUD')
        const previousHash = prev[0]?.hash ?? '00000000…genesis'
        const hash = makeHash(id + entry.action + entry.resource)
        return [
          {
            ...entry,
            id,
            timestamp: nowIso(),
            previousHash,
            hash,
          },
          ...prev,
        ]
      })
    },
    [],
  )

  const uploadInvoice = useCallback(
    (fileName: string) => {
      const jobId = nextId('JOB')
      setProcessingJobs((prev) => [
        {
          id: jobId,
          fileName,
          status: 'processing',
          startedAt: nowIso(),
        },
        ...prev,
      ])
      appendAudit({
        actor: 'Könyvelő Agent v2.1.0',
        actorType: 'agent',
        action: 'document.uploaded',
        resource: fileName,
        agentVersion: '2.1.0',
        model: 'gpt-4.1-mini',
      })
      return jobId
    },
    [appendAudit],
  )

  const completeProcessing = useCallback(
    (jobId: string) => {
      const proposal: InvoiceProposal = {
        ...demoProposalTemplate,
        id: nextId('PROP'),
        sourceFileName:
          processingJobs.find((j) => j.id === jobId)?.fileName ??
          demoProposalTemplate.sourceFileName,
      }
      setProcessingJobs((prev) =>
        prev.map((j) =>
          j.id === jobId ? { ...j, status: 'complete' as const } : j,
        ),
      )
      setCurrentProposal(proposal)
      appendAudit({
        actor: 'Könyvelő Agent v2.1.0',
        actorType: 'agent',
        action: 'invoice.processed',
        resource: proposal.invoiceNumber,
        agentVersion: '2.1.0',
        model: 'gpt-4.1-mini',
      })
      return proposal
    },
    [appendAudit, processingJobs],
  )

  const sendForApproval = useCallback(
    (proposal: InvoiceProposal) => {
      const ticketId = nextId('TKT')
      const ticket: Ticket = {
        id: ticketId,
        title: `Számla jóváhagyás — ${proposal.supplier} (${proposal.invoiceNumber})`,
        type: 'work',
        status: 'awaiting_human',
        assignee: 'Kovács Anna',
        assigneeType: 'human',
        agentId: proposal.agentId,
        agentVersion: proposal.agentVersion,
        model: proposal.model,
        proposal,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      setTickets((prev) => [ticket, ...prev])
      appendAudit({
        actor: 'Könyvelő Agent v2.1.0',
        actorType: 'agent',
        action: 'ticket.created',
        resource: `${ticketId} → awaiting_human`,
        agentVersion: proposal.agentVersion,
        model: proposal.model,
      })
      return ticketId
    },
    [appendAudit],
  )

  const moveTicket = useCallback(
    (ticketId: string, status: TicketStatus) => {
      setTickets((prev) =>
        prev.map((t) =>
          t.id === ticketId ? { ...t, status, updatedAt: nowIso() } : t,
        ),
      )
    },
    [],
  )

  const approveTicket = useCallback(
    (ticketId: string) => {
      moveTicket(ticketId, 'done')
      const ticket = tickets.find((t) => t.id === ticketId)
      appendAudit({
        actor: 'Kovács Anna',
        actorType: 'human',
        action: 'ticket.approved',
        resource: ticketId,
        agentVersion: ticket?.agentVersion,
        model: ticket?.model,
      })
    },
    [appendAudit, moveTicket, tickets],
  )

  const rejectTicket = useCallback(
    (ticketId: string) => {
      moveTicket(ticketId, 'in_review')
      appendAudit({
        actor: 'Kovács Anna',
        actorType: 'human',
        action: 'ticket.rejected',
        resource: ticketId,
      })
    },
    [appendAudit, moveTicket],
  )

  const getTicket = useCallback(
    (ticketId: string) => tickets.find((t) => t.id === ticketId),
    [tickets],
  )

  const openTicketCount = tickets.filter((t) => t.status !== 'done').length

  const stats = useMemo(
    () => ({
      ...dashboardStats,
      openTickets: openTicketCount,
    }),
    [openTicketCount],
  )

  const value = useMemo(
    () => ({
      tickets,
      auditLog,
      stats,
      agents,
      processingJobs,
      currentProposal,
      uploadInvoice,
      completeProcessing,
      sendForApproval,
      approveTicket,
      rejectTicket,
      getTicket,
      moveTicket,
    }),
    [
      tickets,
      auditLog,
      stats,
      processingJobs,
      currentProposal,
      uploadInvoice,
      completeProcessing,
      sendForApproval,
      approveTicket,
      rejectTicket,
      getTicket,
      moveTicket,
    ],
  )

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>
}

export function useDemo() {
  const ctx = useContext(DemoContext)
  if (!ctx) throw new Error('useDemo must be used within DemoProvider')
  return ctx
}
