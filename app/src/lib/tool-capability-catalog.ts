export type ToolCapabilityGroup = {
  label: string
  tools: readonly string[]
}

export const NORMAL_TOOL_CAPABILITY_GROUPS: readonly ToolCapabilityGroup[] = [
  {
    label: 'Google Drive',
    tools: [
      'google_drive_search',
      'google_drive_read_file',
      'google_drive_create_folder',
      'google_drive_upload_file',
      'google_sheets_write_range',
    ],
  },
  { label: 'Gmail', tools: ['gmail_search', 'gmail_get_message'] },
  { label: 'Céges API', tools: ['http_api_get', 'http_api_get_all', 'http_api_request'] },
  {
    label: 'Tudásbázis',
    tools: ['kb_search', 'kb_list_index', 'kb_get_page', 'kb_ingest'],
  },
]

export const CLOSED_ROLE_CAPABILITY_GROUPS: readonly ToolCapabilityGroup[] = []

export const PLAYBOOK_CAPABILITY_GROUPS: readonly ToolCapabilityGroup[] = NORMAL_TOOL_CAPABILITY_GROUPS

export function flattenToolCapabilityGroups(groups: readonly ToolCapabilityGroup[]): string[] {
  return groups.flatMap((group) => [...group.tools])
}

export function splitToolGroupsByChatSurface(groups: readonly ToolCapabilityGroup[]): {
  chat: readonly ToolCapabilityGroup[]
  closed: readonly ToolCapabilityGroup[]
  other: readonly ToolCapabilityGroup[]
} {
  return { chat: groups, closed: CLOSED_ROLE_CAPABILITY_GROUPS, other: [] }
}

export const NORMAL_TOOL_CAPABILITY_NAMES = flattenToolCapabilityGroups(NORMAL_TOOL_CAPABILITY_GROUPS)
export const PLAYBOOK_CAPABILITY_NAMES = flattenToolCapabilityGroups(PLAYBOOK_CAPABILITY_GROUPS)
