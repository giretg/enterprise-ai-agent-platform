import type {
  Agent,
  AgentDetail,
  AgentModelUsage,
  AgentServiceAccount,
  AuditEntry,
  CatalogResource,
  DashboardStats,
  GuardrailViolation,
  HumanUser,
  ModelUsageDay,
  PlaybookStep,
  RoleDefinition,
  Ticket,
  TicketTypeConfig,
  TrainingDiff,
} from '../types'

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

export const trainingDiffAgroParts: TrainingDiff = {
  summary:
    'AgroParts Kft. számláinál mindig az 5111 főkönyvi szám (anyagköltség — mezőgazdasági input) legyen az alapértelmezett.',
  before:
    'AgroParts Kft.: alapértelmezett főkönyvi szám 5120 (karbantartási költség), kivéve ha a számla tartalma egyértelműen input anyag.',
  after:
    'AgroParts Kft.: minden számla esetén alapértelmezett főkönyvi szám 5111 (anyagköltség — mezőgazdasági input), költséghely MG-001.',
  evalGatePassed: true,
  writeGateToken: 'wg-TKT1030-mem-v2.2.0-a8f3…',
  approvalChain: ['Kovács Anna (könyvelő)', 'Nagy Péter (controlling)'],
}

export const initialAgentDetails: Record<string, AgentDetail> = {
  'agent-bookkeeper-01': {
    id: 'agent-bookkeeper-01',
    name: 'Könyvelő Agent',
    role: 'Beszállítói számlák feldolgozása és könyvelési javaslat',
    status: 'active',
    version: '2.1.0',
    lifecycle: 'Monitorozás',
    serviceAccount: 'sa-bookkeeper@ostoros-novaj.internal',
    apiKeyPreview: 'cp_sk_••••••••4f2a (scoped: sandbox.invoice, board.ticket)',
    systemPrompt: `Te a Ostoros-Novaj Agrár Kft. könyvelő asszisztense vagy.
Feladatod beszállítói számlák feldolgozása: mezők kinyerése, főkönyvi szám és költséghely javaslata.
Soha ne könyvelj automatikusan — mindig hozz létre jóváhagyási tickettet.
A memóriában szereplő szállító-specifikus szabályokat kötelezően alkalmazd.`,
    memoryVersions: [
      {
        id: 'mem-bk-210',
        version: '2.1.0',
        label: 'Éles — jelenlegi',
        content: `Szállítói szabályok:
- AgroParts Kft.: alapértelmezett főkönyvi szám 5120 (karbantartási költség), kivéve ha a számla tartalma egyértelműen input anyag.
- Vetőmag Kft.: 5111, költséghely MG-001.
- ÁFA kulcsok: 27% (általános), 5% (mezőgazdasági input).`,
        createdAt: '2026-06-01T10:00:00Z',
        isActive: true,
      },
      {
        id: 'mem-bk-203',
        version: '2.0.3',
        label: 'Előző éles',
        content: `Szállítói szabályok:
- AgroParts Kft.: 5120 alapértelmezett.
- Vetőmag Kft.: 5111, költséghely MG-001.`,
        createdAt: '2026-05-15T08:00:00Z',
        isActive: false,
      },
      {
        id: 'mem-bk-200',
        version: '2.0.0',
        label: 'Kezdeti verzió',
        content: 'Általános könyvelési szabályok, nincs szállító-specifikus override.',
        createdAt: '2026-04-01T09:00:00Z',
        isActive: false,
      },
    ],
    activeMemoryVersionId: 'mem-bk-210',
    resources: [
      {
        id: 'res-pol-01',
        type: 'policy',
        name: 'Könyvelési policy v3.2',
        scope: 'org',
        version: '3.2',
      },
      {
        id: 'res-file-01',
        type: 'file',
        name: 'Szállítói lista — jóváhagyott',
        scope: 'org',
        version: '2026-Q2',
      },
      {
        id: 'res-conn-01',
        type: 'connector',
        name: 'Könyvelő szoftver API (read-only)',
        scope: 'sandbox',
        version: '1.0',
      },
    ],
    tools: [
      {
        id: 'tool-01',
        name: 'extract_invoice_fields',
        description: 'PDF számla mezők kinyerése',
        scope: 'sandbox',
      },
      {
        id: 'tool-02',
        name: 'create_approval_ticket',
        description: 'Jóváhagyási ticket létrehozása a boardon',
        scope: 'control-plane',
      },
    ],
    modelConfig: {
      provider: 'OpenAI (via Model Gateway)',
      model: 'gpt-4.1-mini',
      temperature: 0.1,
      maxTokens: 4096,
      guardrails: ['PII-redaction', 'output-schema-validation', 'prompt-injection-scan'],
    },
    permissions: [
      'board.ticket.create',
      'board.ticket.read',
      'sandbox.invoice.upload',
      'sandbox.invoice.read',
    ],
  },
  'agent-recon-01': {
    id: 'agent-recon-01',
    name: 'Reconciliation Agent',
    role: 'PSP tranzakció-egyeztetés és eltérés-jelzés',
    status: 'active',
    version: '1.4.2',
    lifecycle: 'Monitorozás',
    serviceAccount: 'sa-recon@ostoros-novaj.internal',
    apiKeyPreview: 'cp_sk_••••••••9b1c (scoped: psp.read, board.ticket)',
    systemPrompt: `PSP tranzakciók egyeztetése a belső naplóval.
Eltérés esetén ticketet hozol létre emberi felülvizsgálatra.`,
    memoryVersions: [
      {
        id: 'mem-rc-142',
        version: '1.4.2',
        label: 'Éles — jelenlegi',
        content: 'PSP: Stripe + SimplePay; tolerancia: ±0.01 EUR; napi batch 06:00.',
        createdAt: '2026-05-20T12:00:00Z',
        isActive: true,
      },
    ],
    activeMemoryVersionId: 'mem-rc-142',
    resources: [
      {
        id: 'res-conn-02',
        type: 'connector',
        name: 'Stripe Settlement API',
        scope: 'org',
        version: '2024-11',
      },
    ],
    tools: [
      {
        id: 'tool-03',
        name: 'fetch_settlement_batch',
        description: 'Napi elszámolási batch lekérése',
        scope: 'org',
      },
    ],
    modelConfig: {
      provider: 'OpenAI (via Model Gateway)',
      model: 'gpt-4.1',
      temperature: 0,
      maxTokens: 8192,
      guardrails: ['PII-redaction', 'financial-data-scope'],
    },
    permissions: ['board.ticket.create', 'psp.settlement.read'],
  },
  'agent-doc-01': {
    id: 'agent-doc-01',
    name: 'Dokumentum Agent',
    role: 'Szerződés- és szabályzat-kivonatolás',
    status: 'paused',
    version: '0.9.1',
    lifecycle: 'Teszt / Eval',
    serviceAccount: 'sa-doc@ostoros-novaj.internal',
    apiKeyPreview: 'cp_sk_••••••••7d4e (scoped: docs.read)',
    systemPrompt: 'Szerződések és szabályzatok strukturált kivonatolása.',
    memoryVersions: [
      {
        id: 'mem-doc-091',
        version: '0.9.1',
        label: 'Teszt verzió',
        content: 'GDPR és adatfeldolgozási szerződés sablonok ismert mezői.',
        createdAt: '2026-05-01T09:00:00Z',
        isActive: true,
      },
    ],
    activeMemoryVersionId: 'mem-doc-091',
    resources: [],
    tools: [],
    modelConfig: {
      provider: 'Anthropic (via Model Gateway)',
      model: 'claude-sonnet-4',
      temperature: 0.2,
      maxTokens: 8192,
      guardrails: ['PII-redaction'],
    },
    permissions: ['docs.read', 'board.ticket.create'],
  },
}

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
    status: 'in_review',
    assignee: 'Kovács Anna',
    assigneeType: 'human',
    agentId: 'agent-bookkeeper-01',
    agentVersion: '2.1.0',
    trainingDiff: trainingDiffAgroParts,
    createdAt: '2026-06-10T11:00:00Z',
    updatedAt: '2026-06-11T09:00:00Z',
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
  {
    id: 'AUD-8998',
    timestamp: '2026-06-11T09:00:00Z',
    actor: 'system',
    actorType: 'system',
    action: 'training.ticket_created',
    resource: 'TKT-1030',
    agentVersion: '2.1.0',
    previousHash: makeHash('8997'),
    hash: makeHash('8998'),
  },
  {
    id: 'AUD-8997',
    timestamp: '2026-06-10T11:00:00Z',
    actor: 'Könyvelő Agent v2.1.0',
    actorType: 'agent',
    action: 'memory.correction_proposed',
    resource: 'AgroParts főkönyvi szám',
    agentVersion: '2.1.0',
    model: 'gpt-4.1-mini',
    previousHash: makeHash('8996'),
    hash: makeHash('8997'),
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

export const catalogResources: CatalogResource[] = [
  {
    id: 'res-pol-01',
    type: 'policy' as const,
    name: 'Könyvelési policy',
    scope: 'org' as const,
    version: '3.2',
    description: 'Szervezeti könyvelési szabályok és jóváhagyási küszöbök',
    boundAgentIds: ['agent-bookkeeper-01'],
  },
  {
    id: 'res-file-01',
    type: 'file' as const,
    name: 'Szállítói lista — jóváhagyott',
    scope: 'org' as const,
    version: '2026-Q2',
    description: 'Jóváhagyott beszállítók és alapértelmezett főkönyvi számok',
    boundAgentIds: ['agent-bookkeeper-01'],
  },
  {
    id: 'res-conn-01',
    type: 'connector' as const,
    name: 'Könyvelő szoftver API',
    scope: 'sandbox' as const,
    version: '1.0',
    description: 'Read-only kapcsolat a könyvelő rendszerhez',
    boundAgentIds: ['agent-bookkeeper-01'],
  },
  {
    id: 'res-conn-02',
    type: 'connector' as const,
    name: 'Stripe Settlement API',
    scope: 'org' as const,
    version: '2024-11',
    description: 'PSP elszámolási batch lekérés',
    boundAgentIds: ['agent-recon-01'],
  },
  {
    id: 'res-sec-01',
    type: 'secret' as const,
    name: 'PSP API kulcs (scoped)',
    scope: 'org' as const,
    version: 'rot-2026-05',
    description: 'Rotálható, agent-scoped API hitelesítő',
    boundAgentIds: ['agent-recon-01'],
  },
  {
    id: 'res-ds-01',
    type: 'dataset' as const,
    name: 'Számla minták (eval)',
    scope: 'org' as const,
    version: '1.2',
    description: 'Tanítási és eval tesztkészlet — 120 annotált számla',
    boundAgentIds: ['agent-bookkeeper-01'],
  },
  {
    id: 'res-tool-shared',
    type: 'tool' as const,
    name: 'create_approval_ticket',
    scope: 'org' as const,
    version: '2.0',
    description: 'Board ticket létrehozás human-in-the-loop kapuval',
    boundAgentIds: ['agent-bookkeeper-01', 'agent-recon-01', 'agent-doc-01'],
  },
]

export const modelUsageByDay: ModelUsageDay[] = [
  { date: '06-06', tokens: 38200, costEur: 9.8 },
  { date: '06-07', tokens: 42100, costEur: 10.5 },
  { date: '06-08', tokens: 39500, costEur: 9.9 },
  { date: '06-09', tokens: 44800, costEur: 11.2 },
  { date: '06-10', tokens: 51200, costEur: 12.9 },
  { date: '06-11', tokens: 46900, costEur: 11.8 },
  { date: '06-12', tokens: 48200, costEur: 12.4 },
]

export const agentModelUsage: AgentModelUsage[] = [
  {
    agentId: 'agent-bookkeeper-01',
    agentName: 'Könyvelő Agent',
    model: 'gpt-4.1-mini',
    tokensToday: 28400,
    costTodayEur: 7.1,
    tokensMonth: 186000,
    costMonthEur: 46.5,
  },
  {
    agentId: 'agent-recon-01',
    agentName: 'Reconciliation Agent',
    model: 'gpt-4.1',
    tokensToday: 15200,
    costTodayEur: 4.2,
    tokensMonth: 98000,
    costMonthEur: 27.4,
  },
  {
    agentId: 'agent-doc-01',
    agentName: 'Dokumentum Agent',
    model: 'claude-sonnet-4',
    tokensToday: 4600,
    costTodayEur: 1.1,
    tokensMonth: 32000,
    costMonthEur: 7.8,
  },
]

export const guardrailViolations: GuardrailViolation[] = [
  {
    id: 'GR-001',
    timestamp: '2026-06-11T14:22:00Z',
    agentName: 'Dokumentum Agent',
    rule: 'PII-redaction',
    severity: 'low',
    action: 'blocked_output — emberi felülvizsgálat kért',
  },
  {
    id: 'GR-002',
    timestamp: '2026-06-09T09:15:00Z',
    agentName: 'Könyvelő Agent',
    rule: 'prompt-injection-scan',
    severity: 'medium',
    action: 'sanitized — rejtett utasítás eltávolítva a PDF-ből',
  },
]

export const invoicePlaybookIntended: PlaybookStep[] = [
  {
    id: 'pb-1',
    order: 1,
    label: 'Dokumentum feltöltés',
    actor: 'human',
    description: 'Felhasználó feltölt egy beszállítói számlát a Sandboxban',
  },
  {
    id: 'pb-2',
    order: 2,
    label: 'Mezőkinyerés',
    actor: 'agent',
    description: 'Könyvelő Agent kinyeri a számla mezőit',
  },
  {
    id: 'pb-3',
    order: 3,
    label: 'Könyvelési javaslat',
    actor: 'agent',
    description: 'Agent javaslatot készít főkönyvi számra és költséghelyre',
  },
  {
    id: 'pb-4',
    order: 4,
    label: 'Jóváhagyási ticket',
    actor: 'agent',
    description: 'Ticket létrejön Awaiting Human állapotban',
  },
  {
    id: 'pb-5',
    order: 5,
    label: 'Emberi jóváhagyás',
    actor: 'human',
    description: 'Könyvelő ellenőrzi és jóváhagyja',
  },
  {
    id: 'pb-6',
    order: 6,
    label: 'Audit naplózás',
    actor: 'system',
    description: 'Minden lépés append-only audit logba kerül',
  },
]

export const availablePermissions = [
  'board.ticket.create',
  'board.ticket.read',
  'sandbox.invoice.upload',
  'sandbox.invoice.read',
  'docs.read',
  'psp.settlement.read',
]

export const availableModels = [
  { provider: 'OpenAI (via Model Gateway)', model: 'gpt-4.1-mini' },
  { provider: 'OpenAI (via Model Gateway)', model: 'gpt-4.1' },
  { provider: 'Anthropic (via Model Gateway)', model: 'claude-sonnet-4' },
]

export const humanUsers: HumanUser[] = [
  {
    id: 'usr-001',
    name: 'Kovács Anna',
    email: 'kovacs.anna@ostoros-novaj.hu',
    role: 'approver',
    authProvider: 'Clerk SSO',
    lastLogin: '2026-06-12T08:42:00Z',
    permissions: [
      'board.ticket.approve',
      'board.ticket.read',
      'training.approve',
      'audit.read',
    ],
    status: 'active',
  },
  {
    id: 'usr-002',
    name: 'Nagy Péter',
    email: 'nagy.peter@ostoros-novaj.hu',
    role: 'approver',
    authProvider: 'Clerk SSO',
    lastLogin: '2026-06-11T16:10:00Z',
    permissions: [
      'board.ticket.approve',
      'training.approve',
      'audit.read',
      'resources.policy.approve',
    ],
    status: 'active',
  },
  {
    id: 'usr-003',
    name: 'Excellence Pay Admin',
    email: 'admin@excellencepay.hu',
    role: 'platform_admin',
    authProvider: 'Clerk SSO',
    lastLogin: '2026-06-12T07:00:00Z',
    permissions: [
      'admin.config',
      'iam.manage',
      'agent.create',
      'agent.retire',
      'audit.export',
    ],
    status: 'active',
  },
  {
    id: 'usr-004',
    name: 'Szabó Gábor',
    email: 'szabo.gabor@ostoros-novaj.hu',
    role: 'operator',
    authProvider: 'Clerk SSO',
    lastLogin: '2026-06-10T11:30:00Z',
    permissions: ['board.ticket.create', 'sandbox.invoice.upload', 'board.ticket.read'],
    status: 'active',
  },
  {
    id: 'usr-005',
    name: 'Belső auditor',
    email: 'audit@ostoros-novaj.hu',
    role: 'auditor',
    authProvider: 'Clerk SSO',
    lastLogin: '2026-06-09T14:00:00Z',
    permissions: ['audit.read', 'audit.export', 'playbook.read'],
    status: 'active',
  },
]

export const agentServiceAccounts: AgentServiceAccount[] = [
  {
    id: 'sa-001',
    agentId: 'agent-bookkeeper-01',
    agentName: 'Könyvelő Agent',
    serviceAccount: 'sa-bookkeeper@ostoros-novaj.internal',
    apiKeyPreview: 'cp_sk_••••••••4f2a',
    keyExpiresAt: '2026-09-01T00:00:00Z',
    runtime: 'trusted_internal',
    permissions: [
      'board.ticket.create',
      'board.ticket.read',
      'sandbox.invoice.upload',
      'sandbox.invoice.read',
    ],
    status: 'active',
  },
  {
    id: 'sa-002',
    agentId: 'agent-recon-01',
    agentName: 'Reconciliation Agent',
    serviceAccount: 'sa-recon@ostoros-novaj.internal',
    apiKeyPreview: 'cp_sk_••••••••9b1c',
    keyExpiresAt: '2026-08-15T00:00:00Z',
    runtime: 'trusted_internal',
    permissions: ['board.ticket.create', 'psp.settlement.read'],
    status: 'active',
  },
  {
    id: 'sa-003',
    agentId: 'agent-doc-01',
    agentName: 'Dokumentum Agent',
    serviceAccount: 'sa-doc@ostoros-novaj.internal',
    apiKeyPreview: 'cp_sk_••••••••7d4e',
    keyExpiresAt: '2026-07-01T00:00:00Z',
    runtime: 'trusted_internal',
    permissions: ['docs.read', 'board.ticket.create'],
    status: 'active',
  },
  {
    id: 'sa-004',
    agentId: 'agent-cowork-demo',
    agentName: 'Cowork Demo (külső runtime)',
    serviceAccount: 'sa-cowork-demo@external.local',
    apiKeyPreview: 'cp_sk_••••••••demo',
    keyExpiresAt: '2026-06-20T00:00:00Z',
    runtime: 'untrusted_external',
    permissions: ['board.ticket.read', 'board.ticket.create'],
    status: 'active',
  },
]

export const roleDefinitions: RoleDefinition[] = [
  {
    id: 'platform_admin',
    label: 'Platform admin',
    description: 'Control plane konfiguráció — kizárólag szállítói csapat',
    permissions: ['admin.config', 'iam.manage', 'agent.create', 'agent.retire', 'audit.export'],
  },
  {
    id: 'agent_admin',
    label: 'Agent admin',
    description: 'Agent életciklus, erőforrás-kötés, modell-konfig',
    permissions: ['agent.create', 'agent.configure', 'resources.bind', 'training.propose'],
  },
  {
    id: 'approver',
    label: 'Jóváhagyó',
    description: 'Human-in-the-loop kapuk — munka- és tanítási ticketek',
    permissions: ['board.ticket.approve', 'training.approve', 'resources.policy.approve'],
  },
  {
    id: 'operator',
    label: 'Operátor',
    description: 'Sandbox munka, ticket létrehozás, napi üzem',
    permissions: ['board.ticket.create', 'sandbox.invoice.upload', 'board.ticket.read'],
  },
  {
    id: 'auditor',
    label: 'Auditor',
    description: 'Csak olvasás — audit, playbook, compliance export',
    permissions: ['audit.read', 'audit.export', 'playbook.read'],
  },
]

export const ticketTypeConfigs: TicketTypeConfig[] = [
  {
    id: 'tt-work',
    type: 'work',
    label: 'Interakciós (munka-) ticket',
    description:
      'Agent végrehajt egy feladatot — nem módosíthatja önmagát. Olvas → cselekedj → naplózz.',
    allowedStatuses: [
      'backlog',
      'in_review',
      'approved',
      'in_progress',
      'awaiting_human',
      'done',
    ],
    transitions: [
      { from: 'backlog', to: 'in_review', allowedRoles: ['operator', 'agent_admin'] },
      { from: 'in_review', to: 'approved', allowedRoles: ['approver'], requiresApproval: true },
      { from: 'approved', to: 'in_progress', allowedRoles: ['operator', 'agent_admin'] },
      { from: 'in_progress', to: 'awaiting_human', allowedRoles: ['operator', 'agent_admin'] },
      { from: 'awaiting_human', to: 'done', allowedRoles: ['approver'], requiresApproval: true },
      { from: 'awaiting_human', to: 'in_review', allowedRoles: ['approver'] },
    ],
    defaultAssignee: 'Könyvelő Agent / emberi jóváhagyó',
    approvalChain: [
      { order: 1, role: 'approver', label: 'Szakmai ellenőrzés (könyvelő)' },
    ],
    writeGateRequired: false,
  },
  {
    id: 'tt-training',
    type: 'training',
    label: 'Tanítási ticket',
    description:
      'Kizárólag ez frissítheti az agent memóriáját. Write-gate token + eval-kapu kötelező.',
    allowedStatuses: ['backlog', 'in_review', 'approved', 'done'],
    transitions: [
      { from: 'backlog', to: 'in_review', allowedRoles: ['agent_admin'] },
      {
        from: 'in_review',
        to: 'approved',
        allowedRoles: ['approver'],
        requiresApproval: true,
      },
      { from: 'approved', to: 'done', allowedRoles: ['platform_admin', 'approver'] },
    ],
    defaultAssignee: 'Controlling / könyvelő jóváhagyó',
    approvalChain: [
      { order: 1, role: 'approver', label: 'Kovács Anna (könyvelő)' },
      { order: 2, role: 'approver', label: 'Nagy Péter (controlling)' },
    ],
    writeGateRequired: true,
  },
]
