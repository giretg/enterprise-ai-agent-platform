import { z } from 'zod'
import type { CustomerPromise } from '@prisma/client'
import type { AuditSink } from '@/lib/audit/types'

export type CustomerPromiseRecord = CustomerPromise
export type CustomerPromiseStatus = CustomerPromiseRecord['status']
export type CustomerPromiseResult = { ok: true; row: CustomerPromiseRecord } | { ok: false; code: 'invalid_args' | 'not_found' | 'not_allowed' | 'limit_exceeded' | 'already_resolved' }
export type CustomerPromiseInsert = Pick<CustomerPromiseRecord, 'tenantId' | 'agentId' | 'ownerUserId' | 'definitionId' | 'title' | 'commitment' | 'customerName' | 'customerEmail' | 'customerRef' | 'channel' | 'dueAt' | 'timezone'>
export type CustomerPromiseListInput = { tenantId: string; ownerUserId?: string; agentId?: string; status?: CustomerPromiseStatus | 'active'; due?: 'upcoming' | 'overdue' | 'all'; limit?: number; offset?: number }
export interface CustomerPromiseStore {
  insertUnderLimit(input: CustomerPromiseInsert): Promise<CustomerPromiseRecord | null>
  findById(tenantId: string, id: string): Promise<CustomerPromiseRecord | null>
  list(input: CustomerPromiseListInput, now: Date): Promise<CustomerPromiseRecord[]>
  countUrgentForUser(tenantId: string, userId: string, until: Date): Promise<number>
  resolve(input: { tenantId: string; id: string; status: 'fulfilled' | 'cancelled'; note: string | null; now: Date }): Promise<CustomerPromiseRecord | null>
}

export class CustomerPromiseService {
  constructor(private store: CustomerPromiseStore, private audit: AuditSink) {}

  async register(input: { tenantId: string; agentId: string; ownerUserId: string; definitionId: string; title: unknown; commitment: unknown; dueAt: unknown; timezone?: unknown; customerName?: unknown; customerEmail?: unknown; customerRef?: unknown; channel?: unknown }): Promise<CustomerPromiseResult> {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const commitment = typeof input.commitment === 'string' ? input.commitment.trim() : ''
    if (!title || title.length > 200 || !commitment || commitment.length > 2000) return { ok: false, code: 'invalid_args' }
    if (!z.string().datetime({ offset: true }).safeParse(input.dueAt).success) return { ok: false, code: 'invalid_args' }
    const dueAt = new Date(input.dueAt as string)
    const now = Date.now()
    if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= now || dueAt.getTime() > now + 366 * 86400000) return { ok: false, code: 'invalid_args' }
    const timezone = input.timezone === undefined ? 'Europe/Budapest' : input.timezone
    if (typeof timezone !== 'string' || !/^[A-Za-z]/.test(timezone) || timezone.length > 100) return { ok: false, code: 'invalid_args' }
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { return { ok: false, code: 'invalid_args' } }
    const optional: Record<string, string | null> = {}
    for (const [key, max] of [['customerName', 200], ['customerEmail', 320], ['customerRef', 1000], ['channel', 100]] as const) {
      const value = input[key]
      if (value !== undefined && (typeof value !== 'string' || value.trim().length > max)) return { ok: false, code: 'invalid_args' }
      optional[key] = typeof value === 'string' && value.trim() ? value.trim() : null
    }
    if (optional.customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(optional.customerEmail)) return { ok: false, code: 'invalid_args' }
    const row = await this.store.insertUnderLimit({ tenantId: input.tenantId, agentId: input.agentId, ownerUserId: input.ownerUserId, definitionId: input.definitionId, title, commitment, dueAt, timezone, customerName: optional.customerName, customerEmail: optional.customerEmail, customerRef: optional.customerRef, channel: optional.channel })
    if (!row) return { ok: false, code: 'limit_exceeded' }
    await this.record('promise.register', input.ownerUserId, row)
    return { ok: true, row }
  }

  async get(input: { tenantId: string; userId: string; promiseId: string; manageAll?: boolean }): Promise<CustomerPromiseResult> {
    const row = await this.store.findById(input.tenantId, input.promiseId)
    if (!row) return { ok: false, code: 'not_found' }
    if (row.ownerUserId !== input.userId && !input.manageAll) return { ok: false, code: 'not_allowed' }
    return { ok: true, row }
  }

  async list(input: CustomerPromiseListInput) {
    const now = new Date()
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(Math.floor(input.limit!), 51)) : 50
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0
    const rows = await this.store.list({ ...input, limit, offset }, now)
    return rows.map((row) => ({ ...row, overdue: (row.status === 'open' || row.status === 'claimed') && row.dueAt < now }))
  }

  countUrgentForUser(tenantId: string, userId: string) {
    return this.store.countUrgentForUser(tenantId, userId, new Date(Date.now() + 86400000))
  }

  async resolve(input: { tenantId: string; promiseId: string; actorUserId: string; allowTenantScope?: boolean; status: 'fulfilled' | 'cancelled'; note?: unknown }): Promise<CustomerPromiseResult> {
    if (input.status !== 'fulfilled' && input.status !== 'cancelled') return { ok: false, code: 'invalid_args' }
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.trim().length > 500)) return { ok: false, code: 'invalid_args' }
    const found = await this.get({ tenantId: input.tenantId, promiseId: input.promiseId, userId: input.actorUserId, manageAll: input.allowTenantScope })
    if (!found.ok) return found
    const row = await this.store.resolve({ tenantId: input.tenantId, id: input.promiseId, status: input.status, note: typeof input.note === 'string' ? input.note.trim() || null : null, now: new Date() })
    if (!row) return { ok: false, code: 'already_resolved' }
    await this.record(input.status === 'fulfilled' ? 'promise.complete' : 'promise.cancel', input.actorUserId, row)
    return { ok: true, row }
  }

  private async record(action: string, actorId: string, row: CustomerPromiseRecord) {
    await this.audit.append({ action, actorType: 'human', actorId, targetType: 'customer_promise', targetId: row.id, tenantId: row.tenantId, metadata: { id: row.id, agentId: row.agentId, dueAt: row.dueAt.toISOString(), status: row.status } })
  }
}
