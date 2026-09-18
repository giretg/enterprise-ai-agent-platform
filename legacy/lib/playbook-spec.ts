import type { TicketState, TicketType } from '@prisma/client'
import { z } from 'zod'

const gateBlockSchema = z.object({
  from: z.string(),
  to: z.string(),
})

const requiredGateSchema = z.object({
  gate: z.enum(['human_approval', 'eval_approval']),
  blocks: z.array(gateBlockSchema).optional(),
  unless_payload: z
    .object({
      field: z.string(),
      equals: z.union([z.string(), z.number(), z.boolean()]),
    })
    .optional(),
})

export const playbookStepSpecSchema = z.object({
  ticket_type: z.enum(['interaction', 'training']),
  role: z.enum(['worker', 'orchestrator']),
  transitions: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        allowed: z.string().optional(),
      }),
    )
    .optional(),
  required_gates: z.array(requiredGateSchema).optional(),
})

export const playbookSpecSchema = z.array(playbookStepSpecSchema)

export type PlaybookStepSpec = z.infer<typeof playbookStepSpecSchema>
export type PlaybookSpec = z.infer<typeof playbookSpecSchema>

export function parsePlaybookSpec(raw: unknown): PlaybookSpec {
  return playbookSpecSchema.parse(raw)
}

export function formatPlaybookRef(name: string, version: number): string {
  return `playbook:${name}@v${version}`
}

export function parsePlaybookRef(ref: string): { name: string; version: number } | null {
  const match = /^playbook:(.+)@v(\d+)$/.exec(ref)
  if (!match) return null
  return { name: match[1], version: Number.parseInt(match[2], 10) }
}

export function findStepForTicket(
  spec: PlaybookSpec,
  ticketType: TicketType,
  role: 'worker' | 'orchestrator',
): PlaybookStepSpec | null {
  return spec.find((step) => step.ticket_type === ticketType && step.role === role) ?? null
}

export function isPlaybookTransitionBlocked(params: {
  spec: PlaybookSpec
  ticketType: TicketType
  role: 'worker' | 'orchestrator'
  from: TicketState
  to: TicketState
  payload: Record<string, unknown>
}): { blocked: boolean; gate?: string; reason?: string } {
  const step = findStepForTicket(params.spec, params.ticketType, params.role)
  if (!step?.required_gates?.length) return { blocked: false }

  for (const gate of step.required_gates) {
    const blocks = gate.blocks ?? []
    const applies = blocks.some((b) => b.from === params.from && b.to === params.to)
    if (!applies) continue

    if (gate.unless_payload) {
      const value = params.payload[gate.unless_payload.field]
      if (value === gate.unless_payload.equals) {
        continue
      }
    }

    return {
      blocked: true,
      gate: gate.gate,
      reason: `playbook_gate:${gate.gate}`,
    }
  }

  return { blocked: false }
}
