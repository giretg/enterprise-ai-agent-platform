'use server'

import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  key: z.string().max(120).optional(),
})

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
})

export async function listWorkProjects(input?: { includeArchived?: boolean }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const projects = await services.workProjects.list(ctx.activeTenantId, {
      includeArchived: input?.includeArchived === true,
    })
    return ok(projects)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a projekteket')
  }
}

export async function createWorkProject(input: {
  name: string
  description?: string
  key?: string
}) {
  try {
    const ctx = await requireTenantRole('operator')
    const parsed = createSchema.parse(input)
    const result = await services.workProjects.create({
      tenantId: ctx.activeTenantId,
      name: parsed.name,
      description: parsed.description ?? null,
      key: parsed.key ?? null,
      actorId: ctx.user.id,
    })
    if (!result.ok) return fail(result.reason)
    return ok(result.project)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült létrehozni a projektet')
  }
}

export async function updateWorkProject(input: { id: string; name: string; description?: string }) {
  try {
    const ctx = await requireTenantRole('operator')
    const parsed = updateSchema.parse(input)
    const result = await services.workProjects.update({
      tenantId: ctx.activeTenantId,
      id: parsed.id,
      name: parsed.name,
      description: parsed.description ?? null,
      actorId: ctx.user.id,
    })
    if (!result.ok) return fail(result.reason)
    return ok(result.project)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült frissíteni a projektet')
  }
}

export async function archiveWorkProject(input: { id: string; archived: boolean }) {
  try {
    const ctx = await requireTenantRole('operator')
    const parsed = z.object({ id: z.string().uuid(), archived: z.boolean() }).parse(input)
    const result = await services.workProjects.archive({
      tenantId: ctx.activeTenantId,
      id: parsed.id,
      actorId: ctx.user.id,
      archived: parsed.archived,
    })
    if (!result.ok) return fail(result.reason)
    return ok(result.project)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült archiválni a projektet')
  }
}

export async function setConversationProjectKey(input: { conversationId: string; projectKey: string }) {
  try {
    const ctx = await requireTenantRole('operator')
    const parsed = z
      .object({ conversationId: z.string().uuid(), projectKey: z.string().trim().max(120) })
      .parse(input)
    const assigned = await services.workProjects.assignableKey(ctx.activeTenantId, parsed.projectKey)
    if (!assigned.ok) return fail(assigned.reason)
    const conversation = await services.conversations.setProjectKey({
      conversationId: parsed.conversationId,
      tenantId: ctx.activeTenantId,
      projectKey: assigned.key,
    })
    return ok({ conversationId: conversation.id, projectKey: conversation.projectKey })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a beszélgetés projektjét beállítani')
  }
}

export async function setTicketProjectKey(input: { ticketId: string; projectKey: string }) {
  try {
    const ctx = await requireTenantRole('operator')
    const parsed = z
      .object({ ticketId: z.string().uuid(), projectKey: z.string().trim().max(120) })
      .parse(input)
    const ticket = await repositories.tickets.findById(parsed.ticketId)
    if (!ticket || ticket.tenantId !== ctx.activeTenantId) return fail('A feladat nem található.')
    const assigned = await services.workProjects.assignableKey(ctx.activeTenantId, parsed.projectKey)
    if (!assigned.ok) return fail(assigned.reason)
    const updated = await repositories.tickets.update(ticket.id, { projectKey: assigned.key })
    if (updated.conversationId) {
      try {
        await services.conversations.setProjectKey({
          conversationId: updated.conversationId,
          tenantId: ctx.activeTenantId,
          projectKey: assigned.key,
        })
      } catch {
        // A ticket projektje a forrás; a beszélgetés-szinkron fail-soft.
      }
    }
    return ok({ ticketId: updated.id, projectKey: updated.projectKey })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a feladat projektjét beállítani')
  }
}
