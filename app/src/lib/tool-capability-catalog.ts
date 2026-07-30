export type ToolCapabilityGroup = {
  label: string
  tools: readonly string[]
}

export const NORMAL_TOOL_CAPABILITY_GROUPS = [
  {
    label: 'Tudásbázis (KB / OKF)',
    tools: ['kb_search', 'kb_list_index', 'kb_get_page'],
  },
  {
    label: 'Fájlkezelés (Workspace)',
    tools: [
      'repo_prepare',
      'file_read', 'file_write', 'file_edit', 'file_list',
      'file_glob', 'file_search', 'file_delete',
      'reconcile_records',
    ],
  },
  {
    label: 'Excel (XLSX)',
    tools: [
      'xlsx_read_sheet', 'xlsx_write_cells', 'xlsx_append_rows',
      'xlsx_create', 'xlsx_format_range', 'xlsx_layout',
    ],
  },
  {
    label: 'PowerPoint (PPTX)',
    tools: ['pptx_create'],
  },
  {
    label: 'Dokumentumok',
    tools: ['docx_read', 'docx_create', 'pdf_read', 'pdf_create', 'create_html', 'document_read'],
  },
  {
    label: 'Ingatlan-nyilvántartás',
    tools: ['tulajdoni_lap_parse', 'tulajdoni_lap_egyeztetes'],
  },
  {
    label: 'Mini-app',
    tools: [
      'sandbox_app.create', 'sandbox_app.update_artifact',
      'sandbox_app.preview', 'sandbox_app.export',
      'sandbox_app.list', 'sandbox_app.get',
    ],
  },
  {
    label: 'Sandbox verziókezelés',
    tools: ['sandbox.commit', 'sandbox.request_promotion', 'sandbox.snapshot'],
  },
  {
    label: 'Email (Gmail)',
    tools: [
      'gmail_search', 'gmail_get_message', 'mailbox_count',
      'gmail_create_draft', 'gmail_send',
    ],
  },
  {
    label: 'Agent együttműködés',
    tools: [
      'agent_catalog', 'agent_resolve', 'user_directory',
      'agent_ask', 'ticket_create', 'board_write',
    ],
  },
  {
    label: 'HTTP API',
    tools: ['http_api_get', 'http_api_get_all', 'http_api_request'],
  },
  {
    label: 'Webes kutatás',
    tools: ['web_search', 'web_research_request'],
  },
  {
    label: 'Projektmemória',
    tools: ['memory_propose'],
  },
] as const satisfies readonly ToolCapabilityGroup[]

export const CLOSED_ROLE_CAPABILITY_GROUPS = [
  {
    label: 'Provisioning asszisztens (zárt)',
    tools: [
      'provisioning.catalog.read',
      'provisioning.draft.create',
      'provisioning.draft.validate',
    ],
  },
  {
    label: 'Provisioning web discovery (zárt)',
    tools: [
      'provisioning.discover.search',
      'provisioning.discover.fetch',
      'provisioning.discover.draft',
    ],
  },
  {
    label: 'Web-egress szerep (zárt)',
    tools: ['web_fetch', 'web.research.serve'],
  },
] as const satisfies readonly ToolCapabilityGroup[]

export const PLAYBOOK_CAPABILITY_GROUPS = [
  ...NORMAL_TOOL_CAPABILITY_GROUPS,
  ...CLOSED_ROLE_CAPABILITY_GROUPS,
] as const satisfies readonly ToolCapabilityGroup[]

export function flattenToolCapabilityGroups(groups: readonly ToolCapabilityGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => group.tools))]
}

export const NORMAL_TOOL_CAPABILITY_NAMES = flattenToolCapabilityGroups(NORMAL_TOOL_CAPABILITY_GROUPS)
export const PLAYBOOK_CAPABILITY_NAMES = flattenToolCapabilityGroups(PLAYBOOK_CAPABILITY_GROUPS)
