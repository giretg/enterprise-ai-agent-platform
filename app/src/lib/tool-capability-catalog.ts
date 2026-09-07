import type { ToolName } from '@/domain/tool-broker/tool-broker-types'
import { TOOL_GROUP_ORDER, TOOL_NAMES, TOOL_REGISTRY } from '@/domain/tool-broker/tool-registry'

export type ToolCapabilityGroup = {
  label: string
  tools: readonly string[]
}

/**
 * A grantolható broker-eszközök csoportjai — a kanonikus `TOOL_REGISTRY`-ből
 * GENERÁLVA (issue #194, D6). Korábban ez egy kézzel karbantartott lista volt,
 * ami külön tudott elsodródni a valóságtól: egy új tool működhetett úgy, hogy
 * a tenant-admin sosem látta a jogosultság-szerkesztőben, tehát sosem tudta
 * megadni rá a jogot. Az ilyen tool a felhasználó felé „nem működik, és nem
 * mondja meg, miért" tünettel jelent meg.
 */
export const NORMAL_TOOL_CAPABILITY_GROUPS: readonly ToolCapabilityGroup[] = TOOL_GROUP_ORDER.flatMap(
  (label) => {
    const tools = TOOL_NAMES.filter(
      (name) =>
        TOOL_REGISTRY[name].capabilityGroup === label &&
        TOOL_REGISTRY[name].requiredSystemRole === undefined,
    ).map((name) => TOOL_REGISTRY[name].capability)
    return tools.length > 0 ? [{ label, tools }] : []
  },
)

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

export const PLAYBOOK_CAPABILITY_GROUPS: readonly ToolCapabilityGroup[] = [
  ...NORMAL_TOOL_CAPABILITY_GROUPS,
  ...CLOSED_ROLE_CAPABILITY_GROUPS,
]

export function flattenToolCapabilityGroups(groups: readonly ToolCapabilityGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => group.tools))]
}

function isChatCapability(capability: string): boolean {
  const descriptor = TOOL_REGISTRY[capability as ToolName]
  return descriptor?.surfaces.includes('chat') ?? false
}

/** A szerkesztőben: beszélgetés-eszközök vs. MCP / monitor / háttér. */
export function splitToolGroupsByChatSurface(groups: readonly ToolCapabilityGroup[]): {
  chat: ToolCapabilityGroup[]
  other: ToolCapabilityGroup[]
} {
  const chat: ToolCapabilityGroup[] = []
  const other: ToolCapabilityGroup[] = []
  for (const group of groups) {
    const chatTools = group.tools.filter(isChatCapability)
    const otherTools = group.tools.filter((tool) => !isChatCapability(tool))
    if (chatTools.length > 0) chat.push({ label: group.label, tools: chatTools })
    if (otherTools.length > 0) other.push({ label: group.label, tools: otherTools })
  }
  return { chat, other }
}

export const NORMAL_TOOL_CAPABILITY_NAMES = flattenToolCapabilityGroups(NORMAL_TOOL_CAPABILITY_GROUPS)
export const PLAYBOOK_CAPABILITY_NAMES = flattenToolCapabilityGroups(PLAYBOOK_CAPABILITY_GROUPS)
