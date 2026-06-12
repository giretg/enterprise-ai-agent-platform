import type { Agent, AuditEntry, DashboardStats, Ticket } from '../types'

export const agents: Agent[] = [
  {
    id: 'agent-bookkeeper-01',
    name: 'Könyvelő Agent',
    role: 'Beszállítói számlák feldolgozása és könyvelési javaslat',
    model: 'gpt-4.1-mini',
    status: 'active',
    version: '2.1.0',
  },
  {
    id: 'agent-recon-01',
    name: 'Reconciliation Agent',
    role: 'PSP tranzakció-egyeztetés és eltérés-jelzés',
    model: 'gpt-4.1',
    status: 'active',
    version: '1.4.2',
  },
  {
    id: 'agent-doc-01',
    name: 'Dokumentum Agent',
    role: 'Szerződés- és szabályzat-kivonatolás',
    model: 'claude-sonnet-4',
    status: 'paused',
    version: '0.9.1',
  },
]

export const dashboardStats: DashboardStats = {
  activeAgents: 2,
  openTickets: 7,
  tokensToday: 48200,
  costTodayEur: 12.4,
  guardrailStatus: 'ok',
}

export const initialTickets: Ticket[] = [
  {
    id: 'TKT-1041',
    title: 'Havi banki kivonat egyeztetés — május',
    type: 'work',
    status: 'in_progress',
    assignee: 'Reconciliation Agent',
    assigneeType: 'agent',
    agentId: 'agent-recon-01',
    agentVersion: '1.4.2',
    model: 'gpt-4.1',
    createdAt: '2026-06-12T08:15:00Z',
    updatedAt: '2026-06-12T09:30:00Z',
  },
  {
    id: 'TKT-1038',
    title: 'GDPR adatfeldolgozási szerződés kivonatolás',
    type: 'work',
    status: 'in_review',
    assignee: 'Dokumentum Agent',
    assigneeType: 'agent',
    agentId: 'agent-doc-01',
    agentVersion: '0.9.1',
    model: 'claude-sonnet-4',
    createdAt: '2026-06-11T14:20:00Z',
    updatedAt: '2026-06-12T07:45:00Z',
  },
  {
    id: 'TKT-1035',
    title: 'Q2 költségelszámolás jóváhagyása',
    type: 'work',
    status: 'awaiting_human',
    assignee: 'Kovács Anna',
    assigneeType: 'human',
    createdAt: '2026-06-11T10:00:00Z',
    updatedAt: '2026-06-11T16:30:00Z',
  },
  {
    id: 'TKT-1030',
    title: 'Új szállítói szabály: AgroParts főkönyvi szám',
    type: 'training',
    status: 'backlog',
    assignee: 'Könyvelő Agent',
    assigneeType: 'agent',
    agentId: 'agent-bookkeeper-01',
    agentVersion: '2.1.0',
    createdAt: '2026-06-10T11:00:00Z',
    updatedAt: '2026-06-10T11:00:00Z',
  },
  {
    id: 'TKT-1025',
    title: 'ÁFA bevallás előkészítés — 2026 Q1',
    type: 'work',
    status: 'done',
    assignee: 'Könyvelő Agent',
    assigneeType: 'agent',
    agentId: 'agent-bookkeeper-01',
    agentVersion: '2.0.3',
    model: 'gpt-4.1-mini',
    createdAt: '2026-06-05T09:00:00Z',
    updatedAt: '2026-06-08T15:20:00Z',
  },
]

function makeHash(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(16).padStart(8, '0') + '…a3f2'
}

export const initialAuditLog: AuditEntry[] = [
  {
    id: 'AUD-9001',
    timestamp: '2026-06-12T09:30:00Z',
    actor: 'Reconciliation Agent v1.4.2',
    actorType: 'agent',
    action: 'ticket.updated',
    resource: 'TKT-1041',
    agentVersion: '1.4.2',
    model: 'gpt-4.1',
    previousHash: '00000000…genesis',
    hash: makeHash('9001'),
  },
  {
    id: 'AUD-9000',
    timestamp: '2026-06-12T08:15:00Z',
    actor: 'system',
    actorType: 'system',
    action: 'ticket.created',
    resource: 'TKT-1041',
    previousHash: makeHash('8999'),
    hash: makeHash('9000'),
  },
  {
    id: 'AUD-8999',
    timestamp: '2026-06-11T16:30:00Z',
    actor: 'Kovács Anna',
    actorType: 'human',
    action: 'ticket.status_changed',
    resource: 'TKT-1035 → awaiting_human',
    previousHash: makeHash('8998'),
    hash: makeHash('8999'),
  },
]

export const demoInvoiceFileName = 'AgroParts_Kft_SZ-2026-0342.pdf'

export const demoProposalTemplate = {
  supplier: 'AgroParts Kft.',
  invoiceNumber: 'SZ-2026-0342',
  date: '2026-06-08',
  netAmount: 485000,
  vatAmount: 130950,
  grossAmount: 615950,
  suggestedAccount: '5111',
  suggestedAccountName: 'Anyagköltség — mezőgazdasági input',
  costCenter: 'MG-001 — Mezőgazdasági üzem',
  reasoning:
    'A számla mezőgazdasági input anyagokat (trágya, vetőmag) tartalmaz. A szállító AgroParts Kft. a jóváhagyott szállítói listán szerepel. A memória v2.1.0 szerint az AgroParts számláknál az 5111 főkönyvi szám az alapértelmezett. ÁFA kulcs 27%, költséghely MG-001.',
  agentId: 'agent-bookkeeper-01',
  agentVersion: '2.1.0',
  model: 'gpt-4.1-mini',
  sourceFileName: demoInvoiceFileName,
}
