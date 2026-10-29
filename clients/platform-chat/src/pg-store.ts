/** A `Store` Postgres-implementációja — csak a `platform_chat` sémát éri el (D8, külön DB-szerep). */
import pg from 'pg'
import type {
  Attachment,
  Conversation,
  EventType,
  Message,
  Step,
  Store,
  Turn,
  TurnEvent,
  TurnStatus,
} from './store.ts'

type Row = Record<string, unknown>

const conv = (r: Row): Conversation => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  tenantSlug: r.tenant_slug as string,
  userId: r.user_id as string,
  agentId: r.agent_id as string,
  agentName: r.agent_name as string,
  title: r.title as string,
  titleSetByUser: r.title_set_by_user as boolean,
  createdAt: r.created_at as Date,
  lastActivityAt: r.last_activity_at as Date,
})

const msg = (r: Row): Message => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  turnId: (r.turn_id as string | null) ?? null,
  role: r.role as Message['role'],
  content: r.content as string,
  attachments: (r.attachments as Message['attachments']) ?? [],
  createdAt: r.created_at as Date,
})

const turnOf = (r: Row): Turn => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  tenantId: r.tenant_id as string,
  userId: r.user_id as string,
  agentId: r.agent_id as string,
  status: r.status as TurnStatus,
  stepCount: r.step_count as number,
  tokenUsage: (r.token_usage as Turn['tokenUsage']) ?? {},
  error: (r.error as string | null) ?? null,
  continuationToken: (r.continuation_token as string | null) ?? null,
  context: (r.context as Turn['context']) ?? null,
  pendingApproval: (r.pending_approval as Turn['pendingApproval']) ?? null,
  createdAt: r.created_at as Date,
  finishedAt: (r.finished_at as Date | null) ?? null,
})

const stepOf = (r: Row): Step => ({
  turnId: r.turn_id as string,
  seq: r.seq as number,
  kind: r.kind as Step['kind'],
  inputHash: r.input_hash as string,
  output: (r.output as Step['output']) ?? null,
  status: r.status as Step['status'],
  attempts: r.attempts as number,
  idempotencyKey: (r.idempotency_key as string | null) ?? null,
})

const attOf = (r: Row): Attachment => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  storagePath: r.storage_path as string,
  name: r.name as string,
  mime: r.mime as string,
  size: r.size as number,
  extractedText: (r.extracted_text as string | null) ?? null,
})

const TURN_COLUMNS: Record<string, string> = {
  status: 'status',
  stepCount: 'step_count',
  tokenUsage: 'token_usage',
  error: 'error',
  continuationToken: 'continuation_token',
  context: 'context',
  pendingApproval: 'pending_approval',
  finishedAt: 'finished_at',
}
const JSON_COLUMNS = new Set(['token_usage', 'context', 'pending_approval'])

function setClause(patch: Record<string, unknown>, offset: number): { sql: string; values: unknown[] } {
  const parts: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    const column = TURN_COLUMNS[key]
    if (!column || value === undefined) continue
    values.push(JSON_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value)
    parts.push(`${column} = $${offset + values.length}`)
  }
  return { sql: parts.join(', '), values }
}

export function createPgStore(pool: pg.Pool): Store {
  const q = async (sql: string, values: unknown[] = []) => (await pool.query(sql, values)).rows as Row[]
  const one = async (sql: string, values: unknown[] = []) => (await q(sql, values))[0] ?? null

  return {
    async createConversation(input) {
      const r = await one(
        `INSERT INTO platform_chat.conversations (tenant_id, tenant_slug, user_id, agent_id, agent_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.tenantId, input.tenantSlug, input.userId, input.agentId, input.agentName],
      )
      return conv(r!)
    },
    async getConversation(id) {
      const r = await one(`SELECT * FROM platform_chat.conversations WHERE id = $1 AND archived_at IS NULL`, [id])
      return r ? conv(r) : null
    },
    async listConversations({ tenantId, userId, agentId, query, limit }) {
      const values: unknown[] = [tenantId]
      const where = ['c.tenant_id = $1', 'c.archived_at IS NULL']
      if (userId) {
        values.push(userId)
        where.push(`c.user_id = $${values.length}`)
      }
      if (agentId) {
        values.push(agentId)
        where.push(`c.agent_id = $${values.length}`)
      }
      if (query?.trim()) {
        // D13: cím + üzenet-tartalom, Postgres full-text (`simple`, előtag-illesztéssel).
        const terms = query.trim().split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean)
        if (terms.length) {
          values.push(terms.map((t) => `${t}:*`).join(' & '))
          const p = `$${values.length}`
          where.push(`(c.title_search @@ to_tsquery('simple', ${p}) OR EXISTS (
            SELECT 1 FROM platform_chat.messages m WHERE m.conversation_id = c.id AND m.search @@ to_tsquery('simple', ${p})))`)
        }
      }
      values.push(Math.min(Math.max(limit, 1), 200))
      const rows = await q(
        `SELECT c.* FROM platform_chat.conversations c WHERE ${where.join(' AND ')}
         ORDER BY c.last_activity_at DESC LIMIT $${values.length}`,
        values,
      )
      return rows.map(conv)
    },
    async renameConversation(id, title, byUser) {
      await q(
        `UPDATE platform_chat.conversations SET title = $2, title_set_by_user = title_set_by_user OR $3::boolean WHERE id = $1`,
        [id, title.slice(0, 200), byUser],
      )
    },
    async deleteConversation(id) {
      await q(`DELETE FROM platform_chat.conversations WHERE id = $1`, [id])
    },
    async touchConversation(id) {
      await q(`UPDATE platform_chat.conversations SET last_activity_at = now() WHERE id = $1`, [id])
    },

    async addMessage(input) {
      const r = await one(
        `INSERT INTO platform_chat.messages (conversation_id, turn_id, role, content, attachments)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.conversationId, input.turnId, input.role, input.content, JSON.stringify(input.attachments)],
      )
      return msg(r!)
    },
    async listMessages(conversationId, limit = 500) {
      const rows = await q(
        `SELECT * FROM (SELECT * FROM platform_chat.messages WHERE conversation_id = $1
           ORDER BY created_at DESC LIMIT $2) t ORDER BY created_at ASC`,
        [conversationId, limit],
      )
      return rows.map(msg)
    },

    async createTurn(input) {
      try {
        const r = await one(
          `INSERT INTO platform_chat.turns (conversation_id, tenant_id, user_id, agent_id, status)
           VALUES ($1, $2, $3, $4, 'queued') RETURNING *`,
          [input.conversationId, input.tenantId, input.userId, input.agentId],
        )
        return turnOf(r!)
      } catch (error) {
        if ((error as { code?: string }).code === '23505') return null // turns_one_active_per_conversation
        throw error
      }
    },
    async getTurn(id) {
      const r = await one(`SELECT * FROM platform_chat.turns WHERE id = $1`, [id])
      return r ? turnOf(r) : null
    },
    async activeTurn(conversationId) {
      const r = await one(
        `SELECT * FROM platform_chat.turns WHERE conversation_id = $1 AND status IN ('queued','running','awaiting_approval') LIMIT 1`,
        [conversationId],
      )
      return r ? turnOf(r) : null
    },
    async updateTurn(id, patch) {
      const { sql, values } = setClause(patch, 1)
      if (!sql) return
      await q(`UPDATE platform_chat.turns SET ${sql} WHERE id = $1`, [id, ...values])
    },
    async transitionTurn(id, from, to, patch = {}) {
      // $1 = id, $2 = új állapot, $3.. = patch, utolsó = megengedett kiinduló állapotok
      const { sql, values } = setClause(patch, 2)
      const rows = await q(
        `UPDATE platform_chat.turns SET status = $2${sql ? `, ${sql}` : ''}
         WHERE id = $1 AND status = ANY($${3 + values.length}::text[]) RETURNING id`,
        [id, to, ...values, [...from]],
      )
      return rows.length > 0
    },
    async claimTurn(id, leaseSeconds) {
      const rows = await q(
        `UPDATE platform_chat.turns SET lease_until = now() + make_interval(secs => $2::int)
         WHERE id = $1 AND (lease_until IS NULL OR lease_until < now()) RETURNING id`,
        [id, leaseSeconds],
      )
      return rows.length > 0
    },
    async releaseTurn(id) {
      await q(`UPDATE platform_chat.turns SET lease_until = NULL WHERE id = $1`, [id])
    },

    async listSteps(turnId) {
      return (await q(`SELECT * FROM platform_chat.turn_steps WHERE turn_id = $1 ORDER BY seq`, [turnId])).map(stepOf)
    },
    async beginStep(input) {
      const r = await one(
        `INSERT INTO platform_chat.turn_steps (turn_id, seq, kind, input_hash, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'running', $5)
         ON CONFLICT (turn_id, seq) DO UPDATE SET
           attempts = platform_chat.turn_steps.attempts + 1,
           status = 'running', input_hash = EXCLUDED.input_hash, updated_at = now()
         WHERE platform_chat.turn_steps.status <> 'done'
         RETURNING *`,
        [input.turnId, input.seq, input.kind, input.inputHash, input.idempotencyKey],
      )
      if (!r) throw new Error(`step ${input.turnId}/${input.seq} already done`)
      return stepOf(r)
    },
    async finishStep(turnId, seq, status, output) {
      await q(
        `UPDATE platform_chat.turn_steps SET status = $3, output = $4, updated_at = now() WHERE turn_id = $1 AND seq = $2`,
        [turnId, seq, status, output === null ? null : JSON.stringify(output)],
      )
    },

    async appendEvent(turnId, type: EventType, payload) {
      // A seq monoton a fordulón belül. Ritka ütközés (Stop gomb a futó lépés közben) → újra.
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await one(
            `INSERT INTO platform_chat.turn_events (turn_id, seq, type, payload)
             SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1, $2::text, $3::jsonb FROM platform_chat.turn_events WHERE turn_id = $1::uuid
             RETURNING seq`,
            [turnId, type, JSON.stringify(payload)],
          )
          return Number(r!.seq)
        } catch (error) {
          if ((error as { code?: string }).code !== '23505' || attempt >= 4) throw error
        }
      }
    },
    async eventsAfter(turnId, afterSeq, limit = 500) {
      const rows = await q(
        `SELECT * FROM platform_chat.turn_events WHERE turn_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [turnId, afterSeq, limit],
      )
      return rows.map(
        (r): TurnEvent => ({
          turnId: r.turn_id as string,
          seq: Number(r.seq),
          type: r.type as EventType,
          payload: r.payload as Record<string, unknown>,
          createdAt: r.created_at as Date,
        }),
      )
    },
    async pruneOldEvents(olderThanDays) {
      await q(
        `DELETE FROM platform_chat.turn_events WHERE turn_id IN (
           SELECT id FROM platform_chat.turns WHERE finished_at < now() - make_interval(days => $1::int) LIMIT 50)`,
        [olderThanDays],
      )
    },

    async addAttachment(input) {
      const r = await one(
        `INSERT INTO platform_chat.attachments (conversation_id, storage_path, name, mime, size, extracted_text)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [input.conversationId, input.storagePath, input.name, input.mime, input.size, input.extractedText],
      )
      return attOf(r!)
    },
    async getAttachments(conversationId, ids) {
      const rows = await q(
        `SELECT * FROM platform_chat.attachments WHERE conversation_id = $1 AND id = ANY($2::uuid[])`,
        [conversationId, ids],
      )
      return rows.map(attOf)
    },
    async listAttachmentPaths(conversationId) {
      return (await q(`SELECT storage_path FROM platform_chat.attachments WHERE conversation_id = $1`, [conversationId])).map(
        (r) => r.storage_path as string,
      )
    },

    async logAdminView(input) {
      await q(
        `INSERT INTO platform_chat.admin_views (tenant_id, admin_user_id, conversation_id) VALUES ($1, $2, $3)`,
        [input.tenantId, input.adminUserId, input.conversationId],
      )
    },
  }
}
