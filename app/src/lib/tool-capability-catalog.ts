export type ToolCapabilityGroup = {
  label: string
  tools: readonly string[]
}

export const NORMAL_TOOL_CAPABILITY_GROUPS: readonly ToolCapabilityGroup[] = [
  { label: 'Google Drive', tools: ['google_drive_search', 'google_drive_read_file'] },
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
