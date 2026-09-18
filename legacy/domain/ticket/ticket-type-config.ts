import type { TicketState, TicketType } from '@prisma/client'

export type TransitionAllowedActor =
  | 'system'
  | 'agent'
  | 'approver'
  | 'operator'
  | 'admin'
  | 'system_or_operator'
  | 'system_or_approver'
  | 'creator_or_operator'

export type TicketTransitionConfigRule = {
  from: TicketState
  to: TicketState
  allowed: TransitionAllowedActor
}

export type TicketTypeConfig = {
  type: TicketType
  allowedTransitions: TicketTransitionConfigRule[]
  updatedById: string | null
  updatedAt: string | null
}

export const TICKET_STATES: TicketState[] = [
  'backlog',
  'ready',
  'approved',
  'in_progress',
  'awaiting_human',
  'needs_info',
  'done',
  'rejected',
]

export const TICKET_TYPES: TicketType[] = ['interaction', 'training', 'monitor_alert']

export const TRANSITION_ALLOWED_ACTORS: TransitionAllowedActor[] = [
  'system',
  'agent',
  'approver',
  'operator',
  'admin',
  'system_or_operator',
  'system_or_approver',
  'creator_or_operator',
]

export const DEFAULT_TICKET_TRANSITIONS: TicketTransitionConfigRule[] = [
  { from: 'backlog', to: 'ready', allowed: 'system_or_operator' },
  { from: 'ready', to: 'in_progress', allowed: 'system' },
  { from: 'ready', to: 'rejected', allowed: 'operator' },
  { from: 'in_progress', to: 'awaiting_human', allowed: 'system' },
  { from: 'in_progress', to: 'done', allowed: 'system' },
  { from: 'in_progress', to: 'rejected', allowed: 'operator' },
  { from: 'awaiting_human', to: 'approved', allowed: 'system_or_approver' },
  { from: 'awaiting_human', to: 'needs_info', allowed: 'creator_or_operator' },
  // Kötelező eval bukásakor a TrainingService rendszer-aktorral zárja le a
  // ticketet (MemoryTraining §4.1/T7); manuális elutasítás továbbra is operator.
  { from: 'awaiting_human', to: 'rejected', allowed: 'system_or_operator' },
  { from: 'approved', to: 'done', allowed: 'system' },
  { from: 'done', to: 'needs_info', allowed: 'creator_or_operator' },
  { from: 'done', to: 'rejected', allowed: 'operator' },
  { from: 'needs_info', to: 'ready', allowed: 'system_or_operator' },
  { from: 'needs_info', to: 'rejected', allowed: 'operator' },
  { from: 'rejected', to: 'ready', allowed: 'operator' },
]

/**
 * Ezek nem admin-hangolható üzleti lépések: a rendszer által bizonyított hard
 * governance-döntésekhez a system actor útja mindig megmarad. Jelenleg a
 * kötelező eval-bukás zárja így a training ticketet (MemoryTraining §4.1/T7).
 */
const SYSTEM_REQUIRED_TRANSITION_ALLOWANCES = new Map<string, TransitionAllowedActor>([
  ['awaiting_human:rejected', 'system_or_operator'],
  ['awaiting_human:approved', 'system_or_approver'],
])

function transitionKey(rule: Pick<TicketTransitionConfigRule, 'from' | 'to'>): string {
  return `${rule.from}:${rule.to}`
}

export function defaultTicketTypeConfig(type: TicketType): TicketTypeConfig {
  return {
    type,
    allowedTransitions: DEFAULT_TICKET_TRANSITIONS.map((rule) => ({ ...rule })),
    updatedById: null,
    updatedAt: null,
  }
}

export function defaultTicketTypeConfigs(): TicketTypeConfig[] {
  return TICKET_TYPES.map(defaultTicketTypeConfig)
}

export function normalizeTicketTypeConfig(raw: unknown, type: TicketType): TicketTypeConfig {
  if (!raw || typeof raw !== 'object') return defaultTicketTypeConfig(type)

  const value = raw as Partial<TicketTypeConfig>
  const seen = new Set<string>()
  const allowedTransitions = Array.isArray(value.allowedTransitions)
    ? value.allowedTransitions.flatMap((rule) => {
        if (!rule || typeof rule !== 'object') return []
        const candidate = rule as Partial<TicketTransitionConfigRule>
        if (
          !candidate.from ||
          !candidate.to ||
          !candidate.allowed ||
          !TICKET_STATES.includes(candidate.from) ||
          !TICKET_STATES.includes(candidate.to) ||
          !TRANSITION_ALLOWED_ACTORS.includes(candidate.allowed)
        ) {
          return []
        }
        const key = `${candidate.from}:${candidate.to}`
        if (seen.has(key)) return []
        seen.add(key)
        return [{ from: candidate.from, to: candidate.to, allowed: candidate.allowed }]
      })
    : []

  const mergedTransitions =
    allowedTransitions.length > 0
      ? [...allowedTransitions]
      : defaultTicketTypeConfig(type).allowedTransitions
  for (const rule of DEFAULT_TICKET_TRANSITIONS) {
    const key = transitionKey(rule)
    const existing = mergedTransitions.find((candidate) => transitionKey(candidate) === key)
    const requiredAllowance = SYSTEM_REQUIRED_TRANSITION_ALLOWANCES.get(key)
    if (existing && requiredAllowance) {
      existing.allowed = requiredAllowance
    } else if (!seen.has(key) && !existing) {
      mergedTransitions.push({ ...rule })
    }
  }

  return {
    type,
    allowedTransitions: mergedTransitions,
    updatedById: typeof value.updatedById === 'string' ? value.updatedById : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  }
}

export function normalizeTicketTypeConfigs(raw: unknown): TicketTypeConfig[] {
  const byType =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<Record<TicketType, unknown>>)
      : {}

  return TICKET_TYPES.map((type) => normalizeTicketTypeConfig(byType[type], type))
}
