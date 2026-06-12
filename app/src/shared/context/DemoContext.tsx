import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  dashboardStats,
  demoProposalTemplate,
  initialAgentDetails,
  initialAuditLog,
  initialTickets,
} from '../mock-data'
import type {
  Agent,
  AgentDetail,
  AuditEntry,
  InvoiceProposal,
  MemoryVersion,
  ProcessingJob,
  Ticket,
  TicketStatus,
} from '../types'

interface DemoContextValue {
  tickets: Ticket[]
  auditLog: AuditEntry[]
  stats: typeof dashboardStats
  agents: Agent[]
  agentDetails: Record<string, AgentDetail>
  processingJobs: ProcessingJob[]
  currentProposal: InvoiceProposal | null
  uploadInvoice: (fileName: string) => string
  completeProcessing: (jobId: string) => InvoiceProposal
  sendForApproval: (proposal: InvoiceProposal) => string
  approveTicket: (ticketId: string) => void
  rejectTicket: (ticketId: string) => void
  approveTrainingTicket: (ticketId: string) => void
  rollbackMemory: (agentId: string, memoryVersionId: string) => void
  getTicket: (ticketId: string) => Ticket | undefined
  getAgentDetail: (agentId: string) => AgentDetail | undefined
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
  const [agentDetails, setAgentDetails] =
    useState<Record<string, AgentDetail>>(initialAgentDetails)
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

  const approveTrainingTicket = useCallback(
    (ticketId: string) => {
      const ticket = tickets.find((t) => t.id === ticketId)
      if (!ticket?.trainingDiff || !ticket.agentId) return

      const agentId = ticket.agentId
      const newMemId = nextId('mem-bk')
      const newVersion = '2.2.0'

      setAgentDetails((prev) => {
        const agent = prev[agentId]
        if (!agent) return prev

        const newMemory: MemoryVersion = {
          id: newMemId,
          version: newVersion,
          label: 'Éles — jóváhagyott tanítás',
          content: agent.memoryVersions
            .find((m) => m.isActive)
            ?.content.replace(
              ticket.trainingDiff!.before,
              ticket.trainingDiff!.after,
            ) ?? ticket.trainingDiff!.after,
          createdAt: nowIso(),
          isActive: true,
        }

        return {
          ...prev,
          [agentId]: {
            ...agent,
            version: newVersion,
            memoryVersions: [
              newMemory,
              ...agent.memoryVersions.map((m) => ({ ...m, isActive: false })),
            ],
            activeMemoryVersionId: newMemId,
          },
        }
      })

      moveTicket(ticketId, 'done')
      appendAudit({
        actor: 'Kovács Anna',
        actorType: 'human',
        action: 'memory.promoted',
        resource: `${agentId} → mem v${newVersion}`,
        agentVersion: newVersion,
      })
      appendAudit({
        actor: 'system',
        actorType: 'system',
        action: 'write_gate.consumed',
        resource: ticket.trainingDiff.writeGateToken,
        agentVersion: newVersion,
      })
    },
    [appendAudit, moveTicket, tickets],
  )

  const rollbackMemory = useCallback(
    (agentId: string, memoryVersionId: string) => {
      setAgentDetails((prev) => {
        const agent = prev[agentId]
        if (!agent) return prev

        const target = agent.memoryVersions.find((m) => m.id === memoryVersionId)
        if (!target || target.isActive) return prev

        return {
          ...prev,
          [agentId]: {
            ...agent,
            version: target.version,
            activeMemoryVersionId: memoryVersionId,
            memoryVersions: agent.memoryVersions.map((m) => ({
              ...m,
              isActive: m.id === memoryVersionId,
              label:
                m.id === memoryVersionId
                  ? 'Éles — rollback után'
                  : m.label.replace(' — jelenlegi', '').replace(' — rollback után', ''),
            })),
          },
        }
      })

      appendAudit({
        actor: 'Kovács Anna',
        actorType: 'human',
        action: 'memory.rollback',
        resource: `${agentId} → ${memoryVersionId}`,
      })
    },
    [appendAudit],
  )

  const getTicket = useCallback(
    (ticketId: string) => tickets.find((t) => t.id === ticketId),
    [tickets],
  )

  const getAgentDetail = useCallback(
    (agentId: string) => agentDetails[agentId],
    [agentDetails],
  )

  const openTicketCount = tickets.filter((t) => t.status !== 'done').length
  const activeAgentCount = Object.values(agentDetails).filter(
    (a) => a.status === 'active',
  ).length

  const agentsList = useMemo(
    () =>
      Object.values(agentDetails).map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        model: a.modelConfig.model,
        status: a.status,
        version: a.version,
      })),
    [agentDetails],
  )

  const stats = useMemo(
    () => ({
      ...dashboardStats,
      openTickets: openTicketCount,
      activeAgents: activeAgentCount,
    }),
    [openTicketCount, activeAgentCount],
  )

  const value = useMemo(
    () => ({
      tickets,
      auditLog,
      stats,
      agents: agentsList,
      agentDetails,
      processingJobs,
      currentProposal,
      uploadInvoice,
      completeProcessing,
      sendForApproval,
      approveTicket,
      rejectTicket,
      approveTrainingTicket,
      rollbackMemory,
      getTicket,
      getAgentDetail,
      moveTicket,
    }),
    [
      tickets,
      auditLog,
      stats,
      agentsList,
      agentDetails,
      processingJobs,
      currentProposal,
      uploadInvoice,
      completeProcessing,
      sendForApproval,
      approveTicket,
      rejectTicket,
      approveTrainingTicket,
      rollbackMemory,
      getTicket,
      getAgentDetail,
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
