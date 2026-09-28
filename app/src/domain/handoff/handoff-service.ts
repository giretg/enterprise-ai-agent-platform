import type { HandoffStatus } from '@prisma/client'
import { GENERAL_WORK_PROJECT_KEY } from '@/lib/work-project'

export const HANDOFF_TITLE_MAX = 200
export const HANDOFF_SUMMARY_MAX = 8_000
export const HANDOFF_LINKS_MAX = 2_000

export type HandoffRecord = {
  id: string
  tenantId: string
  fromAgentId: string
  fromDefinitionId: string
  toAgentId: string | null
  toUserId: string | null
  projectKey: string
  title: string
  summary: string
  links: string | null
  status: HandoffStatus
  memoryId: string | null
  createdById: string
  decidedById: string | null
  decidedAt: Date | null
  createdAt: Date
}

export interface HandoffStore {
  insert(input: {
    tenantId: string
    fromAgentId: string
    fromDefinitionId: string
    toAgentId: string | null
    toUserId: string | null
    projectKey: string
    title: string
    summary: string
    links: string | null
    createdById: string
  }): Promise<HandoffRecord>
  findById(id: string): Promise<HandoffRecord | null>
  listOpenForAgent(tenantId: string, agentId: string, limit?: number): Promise<HandoffRecord[]>
  listOpenForUser(tenantId: string, userId: string): Promise<HandoffRecord[]>
  attachMemory(id: string, memoryId: string): Promise<void>
  decide(input: {
    id: string
    expectedStatus: Extract<HandoffStatus, 'open' | 'accepted'>
    status: Extract<HandoffStatus, 'accepted' | 'done' | 'rejected'>
    decidedById: string
  }): Promise<HandoffRecord | null>
}

export function normalizeHandoffProjectKey(value: unknown): string {
  const key = typeof value === 'string' && value.trim() ? value.trim() : GENERAL_WORK_PROJECT_KEY
  return key.slice(0, 120)
}

/** ponytail: vesszővel elválasztott string, nem tömb — a Claude.ai a tömb-mezős tool-sémát eldobja. */
export function validateHandoffInput(input: { toAgentId?: unknown; toUserId?: unknown; title?: unknown; summary?: unknown; links?: unknown }): { ok: true; title: string; summary: string; links: string | null } | { ok: false; code: string } {
  const toAgent = typeof input.toAgentId === 'string' && input.toAgentId.trim() ? input.toAgentId.trim() : null
  const toUser = typeof input.toUserId === 'string' && input.toUserId.trim() ? input.toUserId.trim() : null
  if (Boolean(toAgent) === Boolean(toUser)) return { ok: false, code: 'handoff_target_required' }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if ((toAgent && !uuid.test(toAgent)) || (toUser && !uuid.test(toUser))) return { ok: false, code: 'invalid_args' }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  if (!title || title.length > HANDOFF_TITLE_MAX) return { ok: false, code: 'invalid_args' }
  if (!summary || summary.length > HANDOFF_SUMMARY_MAX) return { ok: false, code: 'invalid_args' }
  const links = typeof input.links === 'string' && input.links.trim() ? input.links.trim() : null
  if (links && links.length > HANDOFF_LINKS_MAX) return { ok: false, code: 'invalid_args' }
  return { ok: true, title, summary, links }
}

export function formatHandoffMemoryBody(input: { fromAgentName: string; summary: string; links: string | null; handoffId: string }): string {
  const linksLine = input.links ? `\nLinks: ${input.links}` : ''
  return `[átadás innen: ${input.fromAgentName}]\n${input.summary}${linksLine}\n(handoffId: ${input.handoffId})`
}

export type ParsedHandoffLink = { label: string; href: string; kind: 'url' | 'work_file' | 'other' }

/** `"címke | https://…, terv | work_file:/path"` → kattintható elemek. */
export function parseHandoffLinks(links: string | null): ParsedHandoffLink[] {
  if (!links) return []
  const parts = links
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.flatMap((part) => {
    const sep = part.indexOf('|')
    const label = (sep >= 0 ? part.slice(0, sep) : part).trim()
    const href = (sep >= 0 ? part.slice(sep + 1) : part).trim()
    if (!label && !href) return []
    const target = href || label
    const kind: ParsedHandoffLink['kind'] = /^https?:\/\//i.test(target)
      ? 'url'
      : target.startsWith('work_file:')
        ? 'work_file'
        : 'other'
    return [{ label: label || target, href: target, kind }]
  })
}

export function handoffHeadline(row: Pick<HandoffRecord, 'id' | 'title' | 'projectKey' | 'createdAt'> & { fromAgentName?: string | null }): { id: string; title: string; projectKey: string; createdAt: string; fromAgentName: string | null } {
  return {
    id: row.id,
    title: row.title,
    projectKey: row.projectKey,
    createdAt: row.createdAt.toISOString(),
    fromAgentName: row.fromAgentName ?? null,
  }
}
