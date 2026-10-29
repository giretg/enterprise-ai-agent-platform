/**
 * #942 LLM Wiki 1/6: jogosultság-feloldás, privát tudásbázis, `wiki` write-kind,
 * jóváhagyó-feloldás, tartalommentes audit, kb_ingest agent-actor.
 * Futtatás: npm run test:wiki-foundation
 */
import assert from 'node:assert/strict'
import type { Connector, Document } from '@prisma/client'
import {
  AgentDefinitionService,
  hashSnapshot,
  type AgentDefinition,
  type AgentDefinitionSnapshot,
} from '../src/domain/agent-definition'
import { authorizeToolCall } from '../src/domain/enterprise-tools/authorize-tool-call'
import { executeKnowledgeBaseTool } from '../src/domain/enterprise-tools/handlers/knowledge-base'
import { KnowledgeBaseService } from '../src/domain/knowledge-base/knowledge-base-service'
import { WikiAccessError, WikiAccessService } from '../src/domain/knowledge-base/wiki-access-service'
import { redactKbAuditForVisibility } from '../src/lib/audit/kb-private-redaction'
import { REGISTERED_AUDIT_ACTIONS } from '../src/lib/audit/event-catalog'
import type { AuditAppendInput } from '../src/lib/audit/types'
import { skipsWriteApproval, writeKindForTool } from '../src/lib/write-approval-modes'
import {
  canDecideWikiChange,
  canManageKnowledgeBaseLink,
  defaultWikiWriteMode,
  effectiveInboxStatus,
  effectiveWikiAccess,
  ownerAgentIdForKnowledgeBase,
  resolveWikiApprover,
  resolveWikiScopes,
  resolveWikiTarget,
  scopeSnapshotToUser,
  type WikiAccessLevel,
  type WikiSnapshotConnector,
} from '../src/lib/wiki-access'
import type {
  AgentConnectorBinding,
  PrivateKnowledgeBasePurgeCounts,
  PrivateKnowledgeBaseRow,
} from '../src/repositories/interfaces'

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const OTHER_AGENT = '44444444-4444-4444-8444-444444444444'
const OWN_KB = '55555555-5555-4555-8555-555555555555'
const SHARED_KB = '66666666-6666-4666-8666-666666666666'
const CATALOG_KB = '77777777-7777-4777-8777-777777777777'
const PRIVATE_KB = '88888888-8888-4888-8888-888888888888'
const WIKI_PRIVATE = '99999999-9999-4999-8999-999999999999'
const WIKI_OWN = 'abababab-abab-4bab-8bab-abababababab'
const SENSITIVE = 'conditions/cukorbetegseg.md'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

type Live = {
  id: string
  tenantId: string
  type: string
  authMode: string
  lifecycleState: string
  name: string
  visibility: 'shared' | 'private_to_user'
  ownerUserId: string | null
  approverUserId?: string | null
}

const LIVE: Record<string, Live> = {
  [OWN_KB]: {
    id: OWN_KB,
    tenantId: TENANT,
    type: 'knowledge_base',
    authMode: 'agent_owned',
    lifecycleState: 'active',
    name: `kb:${AGENT}`,
    visibility: 'shared',
    ownerUserId: null,
  },
  [SHARED_KB]: {
    id: SHARED_KB,
    tenantId: TENANT,
    type: 'knowledge_base',
    authMode: 'agent_owned',
    lifecycleState: 'active',
    name: `kb:${OTHER_AGENT}`,
    visibility: 'shared',
    ownerUserId: null,
  },
  [CATALOG_KB]: {
    id: CATALOG_KB,
    tenantId: TENANT,
    type: 'knowledge_base',
    authMode: 'agent_owned',
    lifecycleState: 'active',
    name: 'kb:catalog',
    visibility: 'shared',
    ownerUserId: null,
  },
  [PRIVATE_KB]: {
    id: PRIVATE_KB,
    tenantId: TENANT,
    type: 'knowledge_base',
    authMode: 'agent_owned',
    lifecycleState: 'active',
    name: 'kb:private:x',
    visibility: 'private_to_user',
    ownerUserId: OWNER,
  },
}

const WIKIS: Record<string, { id: string; connectorId: string }> = {
  [WIKI_PRIVATE]: { id: WIKI_PRIVATE, connectorId: PRIVATE_KB },
  [WIKI_OWN]: { id: WIKI_OWN, connectorId: OWN_KB },
}

function kbRow(
  connectorId: string,
  access: WikiAccessLevel,
  extra: Partial<WikiSnapshotConnector> = {},
): WikiSnapshotConnector {
  const live = LIVE[connectorId]
  return {
    connectorId,
    name: live.name,
    type: 'knowledge_base',
    accessMode: access === 'write' ? 'write' : 'read',
    ...(access !== 'read' ? { wikiAccess: access } : {}),
    ...(live.visibility === 'private_to_user'
      ? {
          visibility: 'private_to_user' as const,
          ownerUserId: live.ownerUserId!,
        }
      : {}),
    ...extra,
  }
}

function snapshotWith(
  connectors: WikiSnapshotConnector[],
  tools: string[] = ['kb_search', 'kb_ingest'],
): AgentDefinitionSnapshot {
  return {
    name: 'Wiki agent',
    roleInstruction: 'x',
    skills: [],
    connectors,
    capabilities: tools.map((toolName) => ({ toolName, allowed: true })),
  }
}

function definition(snapshot: AgentDefinitionSnapshot): AgentDefinition {
  return {
    definitionId: 'def-1',
    agentId: AGENT,
    version: 1,
    tenantId: TENANT,
    status: 'active',
    publishedAt: new Date(0).toISOString(),
    snapshot,
  }
}

const targetDeps = {
  findWikiById: async (id: string) => WIKIS[id] ?? null,
  findWikiByConnectorId: async (connectorId: string) =>
    Object.values(WIKIS).find((wiki) => wiki.connectorId === connectorId) ?? null,
  findConnector: async (id: string) => LIVE[id] ?? null,
}

const authDeps = {
  findConnector: async (id: string) => LIVE[id] ?? null,
  findActiveGrant: async () => null,
}

async function main() {
  console.log('=== #942 LLM Wiki alapok ===')

  // --- 2. Jogosultság-feloldó: 4 szint × saját / megosztott / katalógus / privát ---
  const LEVELS: WikiAccessLevel[] = ['none', 'read', 'submit', 'write']
  const KBS = [
    ['saját', OWN_KB],
    ['megosztott', SHARED_KB],
    ['katalógus', CATALOG_KB],
    ['privát', PRIVATE_KB],
  ] as const

  for (const [label, kb] of KBS) {
    for (const level of LEVELS) {
      await check(`feloldó: ${label} KB, ${level} → olvas/beküld/ír a tulajdonosnak`, () => {
        const scopes = resolveWikiScopes(snapshotWith([kbRow(kb, level)]), OWNER)
        assert.equal(
          scopes.readable.some((s) => s.connectorId === kb),
          level !== 'none',
        )
        assert.equal(
          scopes.submittable.some((s) => s.connectorId === kb),
          level === 'submit' || level === 'write',
        )
        assert.equal(
          scopes.writable.some((s) => s.connectorId === kb),
          level === 'write',
        )
      })
      await check(`feloldó: ${label} KB, ${level} → másik felhasználó`, () => {
        const scopes = resolveWikiScopes(snapshotWith([kbRow(kb, level)]), OTHER_USER)
        const visible = kb !== PRIVATE_KB && level !== 'none'
        assert.equal(
          scopes.readable.some((s) => s.connectorId === kb),
          visible,
        )
        assert.equal(
          scopes.writable.some((s) => s.connectorId === kb),
          visible && level === 'write',
        )
      })
    }
  }

  await check('write jog csak accessMode: write linken él (fail-closed → read)', () => {
    assert.equal(effectiveWikiAccess({ accessMode: 'read', wikiAccess: 'write' }), 'read')
    assert.equal(effectiveWikiAccess({ accessMode: 'write', wikiAccess: 'write' }), 'write')
    assert.equal(effectiveWikiAccess({ accessMode: 'write' }), 'read')
    assert.equal(effectiveWikiAccess({ accessMode: 'write', wikiAccess: 'bogus' }), 'read')
  })

  await check('resolveWikiTarget: privát wikiId másik felhasználónak not_found', async () => {
    const snap = snapshotWith([kbRow(PRIVATE_KB, 'write')])
    const other = await resolveWikiTarget(targetDeps, {
      snapshot: snap,
      principal: { userId: OTHER_USER, tenantId: TENANT },
      wikiId: WIKI_PRIVATE,
      need: 'read',
    })
    assert.deepEqual(other, { ok: false, reason: 'not_found' })
    const owner = await resolveWikiTarget(targetDeps, {
      snapshot: snap,
      principal: { userId: OWNER, tenantId: TENANT },
      wikiId: WIKI_PRIVATE,
      need: 'write',
    })
    assert.equal(owner.ok, true)
    assert.equal(owner.ok && owner.connectorId, PRIVATE_KB)
  })

  await check(
    'resolveWikiTarget: snapshotban privátként nem jelölt, élőben privát KB is not_found',
    async () => {
      // Régi snapshot visibility nélkül — az élő sor dönt.
      const snap = snapshotWith([{ connectorId: PRIVATE_KB, type: 'knowledge_base', accessMode: 'read' }])
      const result = await resolveWikiTarget(targetDeps, {
        snapshot: snap,
        principal: { userId: OTHER_USER, tenantId: TENANT },
        wikiId: WIKI_PRIVATE,
        need: 'read',
      })
      assert.deepEqual(result, { ok: false, reason: 'not_found' })
    },
  )

  await check(
    'resolveWikiTarget: olvasási jogú wikire írás wiki_write_not_allowed; submit-re wiki_write_not_allowed',
    async () => {
      for (const level of ['read', 'submit'] as const) {
        const result = await resolveWikiTarget(targetDeps, {
          snapshot: snapshotWith([kbRow(OWN_KB, level)]),
          principal: { userId: OWNER, tenantId: TENANT },
          wikiId: WIKI_OWN,
          need: 'write',
        })
        assert.deepEqual(result, {
          ok: false,
          reason: 'wiki_write_not_allowed',
        })
      }
    },
  )

  await check(
    'resolveWikiTarget: wikiId nélkül egy írható wiki automatikus, több → wiki_id_required',
    async () => {
      const one = await resolveWikiTarget(targetDeps, {
        snapshot: snapshotWith([kbRow(OWN_KB, 'write'), kbRow(CATALOG_KB, 'read')]),
        principal: { userId: OWNER, tenantId: TENANT },
        need: 'write',
      })
      assert.equal(one.ok && one.connectorId, OWN_KB)
      assert.equal(one.ok && one.wikiId, WIKI_OWN)
      const many = await resolveWikiTarget(targetDeps, {
        snapshot: snapshotWith([kbRow(OWN_KB, 'write'), kbRow(CATALOG_KB, 'write')]),
        principal: { userId: OWNER, tenantId: TENANT },
        need: 'write',
      })
      assert.deepEqual(many, { ok: false, reason: 'wiki_id_required' })
    },
  )

  await check('resolveWikiTarget: más tenant connectora not_found', async () => {
    const result = await resolveWikiTarget(
      {
        ...targetDeps,
        findConnector: async (id: string) => ({
          ...LIVE[id],
          tenantId: OTHER_TENANT,
        }),
      },
      {
        snapshot: snapshotWith([kbRow(OWN_KB, 'write')]),
        principal: { userId: OWNER, tenantId: TENANT },
        wikiId: WIKI_OWN,
        need: 'read',
      },
    )
    assert.deepEqual(result, { ok: false, reason: 'not_found' })
  })

  // --- Privát szűrés a mai KB-toolokon (authorizeToolCall) ---
  await check(
    'kb_search: privát KB más felhasználónak nem jelenik meg, közvetlen connectorId → not_found',
    async () => {
      const def = definition(snapshotWith([kbRow(OWN_KB, 'read'), kbRow(PRIVATE_KB, 'write')]))
      const implicit = await authorizeToolCall(authDeps, {
        principal: {
          userId: OTHER_USER,
          tenantId: TENANT,
          role: 'operator',
          assumed: false,
        },
        definition: def,
        toolName: 'kb_search',
        args: { query: 'x' },
      })
      // Egyetlen látható KB marad → nem kell connectorId, és nem a privátra old.
      assert.equal(implicit.allowed && implicit.connectorId, OWN_KB)
      const direct = await authorizeToolCall(authDeps, {
        principal: {
          userId: OTHER_USER,
          tenantId: TENANT,
          role: 'admin',
          assumed: false,
        },
        definition: def,
        toolName: 'kb_search',
        args: { query: 'x', connectorId: PRIVATE_KB },
      })
      assert.deepEqual(direct, { allowed: false, reason: 'not_found' })
    },
  )

  await check('kb_search: a tulajdonos eléri a privát KB-t', async () => {
    const result = await authorizeToolCall(authDeps, {
      principal: {
        userId: OWNER,
        tenantId: TENANT,
        role: 'operator',
        assumed: false,
      },
      definition: definition(snapshotWith([kbRow(OWN_KB, 'read'), kbRow(PRIVATE_KB, 'write')])),
      toolName: 'kb_search',
      args: { query: 'x', connectorId: PRIVATE_KB },
    })
    assert.equal(result.allowed && result.connectorId, PRIVATE_KB)
  })

  await check('kb_get_page: élőben privát (snapshot régi) KB másnak not_found', async () => {
    const result = await authorizeToolCall(authDeps, {
      principal: {
        userId: OTHER_USER,
        tenantId: TENANT,
        role: 'operator',
        assumed: false,
      },
      definition: definition(
        snapshotWith(
          [
            {
              connectorId: PRIVATE_KB,
              type: 'knowledge_base',
              accessMode: 'read',
            },
          ],
          ['kb_get_page'],
        ),
      ),
      toolName: 'kb_get_page',
      args: { path: 'index.md' },
    })
    assert.deepEqual(result, { allowed: false, reason: 'not_found' })
  })

  await check('wikiAccess none: a KB nem látszik (not_found)', async () => {
    const result = await authorizeToolCall(authDeps, {
      principal: {
        userId: OWNER,
        tenantId: TENANT,
        role: 'admin',
        assumed: false,
      },
      definition: definition(snapshotWith([kbRow(SHARED_KB, 'none')])),
      toolName: 'kb_search',
      args: { query: 'x', connectorId: SHARED_KB },
    })
    assert.deepEqual(result, { allowed: false, reason: 'not_found' })
  })

  await check('get_definition snapshot: más felhasználónak a privát kötés kimarad', () => {
    const snap = snapshotWith([kbRow(OWN_KB, 'read'), kbRow(PRIVATE_KB, 'write')])
    assert.deepEqual(
      scopeSnapshotToUser(snap, OTHER_USER).connectors.map((c) => c.connectorId),
      [OWN_KB],
    )
    assert.equal(scopeSnapshotToUser(snap, OWNER), snap)
  })

  // --- 3. skipsWriteApproval a wiki kindnál ---
  await check('wiki write-kind: a cél-kapcsolat módja dönt, hiányzó/ismeretlen → jóváhagyás', () => {
    const allDirect = {
      memory: 'direct',
      httpApi: 'direct',
      gmail: 'direct',
      drive: 'direct',
    } as const
    assert.equal(writeKindForTool('kb_wiki_write'), 'wiki')
    assert.equal(skipsWriteApproval('kb_wiki_write', allDirect), false)
    assert.equal(skipsWriteApproval('kb_wiki_write', allDirect, null), false)
    assert.equal(skipsWriteApproval('kb_wiki_write', allDirect, {}), false)
    assert.equal(
      skipsWriteApproval('kb_wiki_write', allDirect, {
        wikiWriteMode: 'approval',
      }),
      false,
    )
    assert.equal(
      skipsWriteApproval('kb_wiki_write', allDirect, {
        wikiWriteMode: 'DIRECT',
      }),
      false,
    )
    assert.equal(skipsWriteApproval('kb_wiki_write', null, { wikiWriteMode: 'direct' }), true)
    // A wiki mód nem szivárog át más kindra.
    assert.equal(skipsWriteApproval('gmail_send', null, { wikiWriteMode: 'direct' }), false)
  })

  await check('D14: privát wikinél új kapcsolat alapból direct, közösnél approval', () => {
    assert.equal(defaultWikiWriteMode('private_to_user'), 'direct')
    assert.equal(defaultWikiWriteMode('shared'), 'approval')
    assert.equal(defaultWikiWriteMode(undefined), 'approval')
  })

  // --- 4. Jóváhagyó-feloldás ---
  await check('jóváhagyó: saját wiki → a tulajdonos agent jóváhagyója', () => {
    const scope = resolveWikiApprover({
      connector: {
        name: `kb:${AGENT}`,
        visibility: 'shared',
        approverUserId: null,
      },
      ownerAgent: { id: AGENT, approverUserId: OTHER_USER },
    })
    assert.deepEqual(scope, {
      kind: 'agent_owner',
      agentId: AGENT,
      approverUserId: OTHER_USER,
    })
    assert.equal(canDecideWikiChange({ userId: OTHER_USER, role: 'viewer' }, scope), true)
    assert.equal(canDecideWikiChange({ userId: OWNER, role: 'operator' }, scope), false)
    assert.equal(canDecideWikiChange({ userId: OWNER, role: 'admin' }, scope), true)
    assert.equal(ownerAgentIdForKnowledgeBase('kb:catalog'), null)
  })

  await check(
    'jóváhagyó: közös katalógus-KB → tenant admin (vagy a connector megnevezett jóváhagyója)',
    () => {
      const scope = resolveWikiApprover({
        connector: { name: 'kb:catalog', visibility: 'shared' },
      })
      assert.deepEqual(scope, { kind: 'tenant_admin', approverUserId: null })
      assert.equal(canDecideWikiChange({ userId: OWNER, role: 'admin' }, scope), true)
      assert.equal(canDecideWikiChange({ userId: OWNER, role: 'approver' }, scope), false)
      // Más agent saját wikijébe író agent: nem az író agent jóváhagyója dönt.
      const foreign = resolveWikiApprover({
        connector: { name: `kb:${OTHER_AGENT}`, visibility: 'shared' },
        ownerAgent: { id: OTHER_AGENT, approverUserId: OWNER },
      })
      assert.deepEqual(foreign, {
        kind: 'agent_owner',
        agentId: OTHER_AGENT,
        approverUserId: OWNER,
      })
    },
  )

  await check('jóváhagyó: privát → csak a tulajdonos, admin/superadmin sem', () => {
    const scope = resolveWikiApprover({
      connector: {
        name: 'kb:private:x',
        visibility: 'private_to_user',
        ownerUserId: OWNER,
        approverUserId: OTHER_USER,
      },
    })
    assert.deepEqual(scope, { kind: 'owner_user', userId: OWNER })
    assert.equal(canDecideWikiChange({ userId: OWNER, role: 'viewer' }, scope), true)
    assert.equal(canDecideWikiChange({ userId: OTHER_USER, role: 'admin', assumed: true }, scope), false)
  })

  await check('privát KB-t csak a tulajdonos kapcsolhat, közöset az admin', () => {
    const priv = { visibility: 'private_to_user', ownerUserId: OWNER }
    assert.equal(canManageKnowledgeBaseLink(priv, { userId: OWNER, role: 'viewer' }), true)
    assert.equal(canManageKnowledgeBaseLink(priv, { userId: OTHER_USER, role: 'admin' }), false)
    assert.equal(
      canManageKnowledgeBaseLink({ visibility: 'shared' }, { userId: OTHER_USER, role: 'admin' }),
      true,
    )
    assert.equal(
      canManageKnowledgeBaseLink({ visibility: 'shared' }, { userId: OTHER_USER, role: 'operator' }),
      false,
    )
  })

  // --- Tálca: lejárt foglalás = pending ---
  await check('tálca: in_progress + lejárt foglalás olvasáskor pending', () => {
    const now = new Date('2026-10-22T12:00:00Z')
    assert.equal(
      effectiveInboxStatus(
        {
          wikiStatus: 'in_progress',
          wikiClaimExpiresAt: new Date('2026-10-22T13:00:00Z'),
        },
        now,
      ),
      'in_progress',
    )
    assert.equal(
      effectiveInboxStatus(
        {
          wikiStatus: 'in_progress',
          wikiClaimExpiresAt: new Date('2026-10-22T11:59:59Z'),
        },
        now,
      ),
      'pending',
    )
    assert.equal(
      effectiveInboxStatus({ wikiStatus: 'in_progress', wikiClaimExpiresAt: null }, now),
      'pending',
    )
    assert.equal(effectiveInboxStatus({ wikiStatus: null, wikiClaimExpiresAt: null }, now), null)
  })

  // --- 5. Privát KB audit: nincs oldalcím, path, fájlnév ---
  await check('audit: minden wiki-esemény regisztrált', () => {
    for (const action of [
      'kb.wiki.changeset.submitted',
      'kb.wiki.changeset.applied',
      'kb.wiki.changeset.approved',
      'kb.wiki.changeset.rejected',
      'kb.wiki.changeset.reverted',
      'kb.wiki.page.created',
      'kb.wiki.page.updated',
      'kb.wiki.page.archived',
      'kb.wiki.inbox.submitted',
      'kb.wiki.inbox.claimed',
      'kb.wiki.inbox.released',
      'kb.wiki.inbox.processed',
      'kb.wiki.inbox.skipped',
      'kb.wiki.lint.run',
      'kb.wiki.schema.changed',
      'kb.wiki.access.changed',
      'kb.private.deleted',
    ]) {
      assert.ok(REGISTERED_AUDIT_ACTIONS.has(action), action)
    }
  })

  await check('audit-redakció: privát KB-nál cím/path/fájlnév kiesik, id/szám/hash marad', () => {
    const entry: AuditAppendInput = {
      actorType: 'agent',
      actorId: AGENT,
      action: 'kb.wiki.page.created',
      targetType: 'wiki_page',
      targetId: WIKI_PRIVATE,
      inputRef: SENSITIVE,
      outputRef: PRIVATE_KB,
      metadata: {
        path: SENSITIVE,
        title: 'Cukorbetegség',
        filename: 'lelet-2024.pdf',
        pagePaths: [SENSITIVE],
        summary: 'HbA1c emelkedett',
        category: 'Diagnózisok',
        pageIds: [WIKI_PRIVATE],
        pageCount: 3,
        contentHash: 'a'.repeat(64),
        op: 'ingest',
        nested: { sectionTitle: 'Tények', documentId: OWN_KB },
      },
    }
    const redacted = redactKbAuditForVisibility({ visibility: 'private_to_user', ownerUserId: OWNER }, entry)
    const json = JSON.stringify(redacted)
    for (const leak of [SENSITIVE, 'Cukorbetegség', 'lelet-2024.pdf', 'HbA1c', 'Diagnózisok', 'Tények']) {
      assert.ok(!json.includes(leak), `szivárgás: ${leak}`)
    }
    const meta = redacted.metadata as Record<string, unknown>
    assert.equal(redacted.inputRef, null)
    assert.equal(redacted.outputRef, PRIVATE_KB)
    assert.deepEqual(meta.pageIds, [WIKI_PRIVATE])
    assert.equal(meta.pageCount, 3)
    assert.equal(meta.op, 'ingest')
    assert.equal(meta.privateKb, true)
    assert.deepEqual(meta.nested, { documentId: OWN_KB })
    // Közös KB-nál változatlan.
    assert.equal(redactKbAuditForVisibility({ visibility: 'shared' }, entry), entry)
  })

  // --- WikiAccessService: privát KB életciklus és kapcsolás ---
  function makeService(opts: { now?: Date } = {}) {
    const audits: AuditAppendInput[] = []
    const connectors = new Map<string, Connector>()
    const bindings = new Map<string, AgentConnectorBinding & { agentId: string }>()
    const purged: string[] = []
    const released: Array<{ agentId: string; connectorIds?: string[] }> = []
    const privateRows = () =>
      [...connectors.values()]
        .filter((c) => c.visibility === 'private_to_user')
        .map((c) => ({
          connectorId: c.id,
          tenantId: c.tenantId,
          ownerUserId: c.ownerUserId!,
        }))
    const orphans: PrivateKnowledgeBaseRow[] = []
    let lastOlderThan: Date | null = null
    const zero: PrivateKnowledgeBasePurgeCounts = {
      documents: 4,
      pages: 7,
      revisions: 9,
      chunks: 12,
      artifacts: 1,
      changeSets: 2,
      logEntries: 3,
      gatewayOperations: 0,
      agentLinks: 1,
    }
    let seq = 0
    const service = new WikiAccessService({
      connectors: {
        findById: async (id, tenantId) => {
          const row = connectors.get(id)
          return row && (!tenantId || row.tenantId === tenantId) ? row : null
        },
        create: async (input) => {
          const row = {
            id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
            type: input.type,
            name: input.name,
            authMode: input.authMode,
            scope: input.scope,
            secretAlias: null,
            version: 1,
            config: input.config ?? {},
            lifecycleState: 'active',
            tenantId: input.tenantId,
            approverUserId: null,
            kbLanguage: 'hu',
            visibility: input.visibility ?? 'shared',
            ownerUserId: input.ownerUserId ?? null,
            createdAt: new Date(),
            connectorMode: 'fixed',
            activeSpecVersionId: null,
          } as Connector
          connectors.set(row.id, row)
          return row
        },
      },
      agents: {
        findById: async (id, tenantId) =>
          id === AGENT && tenantId === TENANT ? ({ id: AGENT, tenantId: TENANT, name: 'A' } as never) : null,
        findConnectorBinding: async (agentId, connectorId) =>
          bindings.get(`${agentId}:${connectorId}`) ?? null,
        upsertConnectorBinding: async (input) => {
          const key = `${input.agentId}:${input.connectorId}`
          const existing = bindings.get(key)
          bindings.set(key, {
            agentId: input.agentId,
            connector: connectors.get(input.connectorId)!,
            accessMode: input.accessMode,
            wikiAccess: existing?.wikiAccess ?? 'read',
            wikiWriteMode: existing?.wikiWriteMode ?? input.initialWikiWriteMode ?? 'approval',
            wikiCollectFocus: existing?.wikiCollectFocus ?? null,
          })
        },
        updateWikiLink: async (input) => {
          const key = `${input.agentId}:${input.connectorId}`
          const row = bindings.get(key)
          if (!row) return null
          const next = {
            ...row,
            ...(input.accessMode ? { accessMode: input.accessMode } : {}),
            ...(input.wikiAccess ? { wikiAccess: input.wikiAccess } : {}),
            ...(input.wikiWriteMode ? { wikiWriteMode: input.wikiWriteMode } : {}),
            ...(input.wikiCollectFocus !== undefined ? { wikiCollectFocus: input.wikiCollectFocus } : {}),
          }
          bindings.set(key, next)
          return next
        },
      },
      wikis: {
        releaseClaimsForAgent: async (input) => {
          released.push(input)
          return 1
        },
      },
      privateKnowledgeBases: {
        findPrivate: async (id) => privateRows().find((row) => row.connectorId === id) ?? null,
        listPrivateForOwner: async (tenantId, owner) =>
          privateRows().filter((row) => row.tenantId === tenantId && row.ownerUserId === owner),
        listOrphaned: async ({ olderThan }) => {
          lastOlderThan = olderThan
          return orphans
        },
        purge: async (id) => {
          purged.push(id)
          connectors.delete(id)
          return zero
        },
      },
      audit: {
        append: async (entry) => {
          audits.push(entry)
          return entry
        },
      },
      now: () => opts.now ?? new Date('2026-10-22T00:00:00Z'),
    })
    const shared = {
      id: SHARED_KB,
      type: 'knowledge_base',
      name: 'kb:catalog',
      tenantId: TENANT,
      visibility: 'shared',
      ownerUserId: null,
      config: {},
    } as unknown as Connector
    connectors.set(SHARED_KB, shared)
    return {
      service,
      audits,
      connectors,
      bindings,
      purged,
      released,
      orphans,
      olderThan: () => lastOlderThan,
    }
  }

  const ownerActor = { userId: OWNER, tenantId: TENANT, role: 'viewer' }
  const adminActor = { userId: OTHER_USER, tenantId: TENANT, role: 'admin' }

  await check('privát KB: létrehozás tartalommentes névvel, tulajdonos kapcsol → direct mód', async () => {
    const { service, audits, bindings } = makeService()
    const kb = await service.createPrivateKnowledgeBase({
      actor: ownerActor,
      displayName: 'Egészség-napló',
    })
    assert.equal(kb.visibility, 'private_to_user')
    assert.equal(kb.ownerUserId, OWNER)
    assert.ok(kb.name.startsWith('kb:private:'))
    assert.ok(!kb.name.includes('Egészség'))
    const binding = await service.linkKnowledgeBase({
      actor: ownerActor,
      agentId: AGENT,
      connectorId: kb.id,
    })
    assert.equal(binding.wikiWriteMode, 'direct')
    assert.equal(binding.wikiAccess, 'read')
    assert.equal(bindings.size, 1)
    assert.ok(!JSON.stringify(audits).includes('Egészség'), 'a megjelenített név nem kerül auditba')
  })

  await check('privát KB: admin nem kapcsolhatja (not_found), nem is látja', async () => {
    const { service } = makeService()
    const kb = await service.createPrivateKnowledgeBase({
      actor: ownerActor,
      displayName: 'Leletek',
    })
    await assert.rejects(
      service.linkKnowledgeBase({
        actor: adminActor,
        agentId: AGENT,
        connectorId: kb.id,
      }),
      (e: unknown) => e instanceof WikiAccessError && e.code === 'not_found',
    )
  })

  await check('közös KB: csak admin kapcsol; saját KB-n write csak explicit beállításra', async () => {
    const { service } = makeService()
    await assert.rejects(
      service.linkKnowledgeBase({
        actor: ownerActor,
        agentId: AGENT,
        connectorId: SHARED_KB,
      }),
      (e: unknown) => e instanceof WikiAccessError && e.code === 'forbidden',
    )
    const linked = await service.linkKnowledgeBase({
      actor: adminActor,
      agentId: AGENT,
      connectorId: SHARED_KB,
      accessMode: 'write',
    })
    assert.equal(linked.wikiAccess, 'read')
    assert.equal(linked.wikiWriteMode, 'approval')
  })

  await check(
    'setWikiAccess: write → accessMode write; write visszavonása elengedi a foglalásokat (D16)',
    async () => {
      const { service, released, audits } = makeService()
      const kb = await service.createPrivateKnowledgeBase({
        actor: ownerActor,
        displayName: 'Napló',
      })
      await service.linkKnowledgeBase({
        actor: ownerActor,
        agentId: AGENT,
        connectorId: kb.id,
      })
      const up = await service.setWikiAccess({
        actor: ownerActor,
        agentId: AGENT,
        connectorId: kb.id,
        wikiAccess: 'write',
        wikiCollectFocus: 'Laborértékek és diagnózisok',
      })
      assert.equal(up.accessMode, 'write')
      assert.equal(effectiveWikiAccess(up), 'write')
      assert.equal(released.length, 0)
      const down = await service.setWikiAccess({
        actor: ownerActor,
        agentId: AGENT,
        connectorId: kb.id,
        wikiAccess: 'submit',
      })
      assert.equal(effectiveWikiAccess(down), 'submit')
      assert.deepEqual(released, [{ agentId: AGENT, connectorIds: [kb.id] }])
      const json = JSON.stringify(audits)
      assert.ok(!json.includes('Laborértékek'), 'a gyűjtési fókusz szövege nem kerül auditba')
      assert.ok(audits.some((a) => a.action === 'kb.wiki.access.changed'))
      await assert.rejects(
        service.setWikiAccess({
          actor: adminActor,
          agentId: AGENT,
          connectorId: kb.id,
          wikiAccess: 'write',
        }),
        (e: unknown) => e instanceof WikiAccessError && e.code === 'not_found',
      )
    },
  )

  await check('láthatóság nem állítható át, privát nem osztható meg', () => {
    const { service } = makeService()
    assert.throws(
      () => service.assertVisibilityChange({ visibility: 'private_to_user' }, 'shared'),
      WikiAccessError,
    )
    assert.throws(
      () => service.assertVisibilityChange({ visibility: 'shared' }, 'private_to_user'),
      WikiAccessError,
    )
    assert.throws(() => service.assertShareable({ visibility: 'private_to_user' }), WikiAccessError)
    service.assertShareable({ visibility: 'shared' })
  })

  await check(
    'végleges törlés: tulajdonos vagy admin indítja, más felhasználónak not_found, audit csak darabszám',
    async () => {
      const { service, purged, audits } = makeService()
      const kb = await service.createPrivateKnowledgeBase({
        actor: ownerActor,
        displayName: 'Leletek',
      })
      await assert.rejects(
        service.purgePrivateKnowledgeBase({
          actor: { userId: OTHER_USER, tenantId: TENANT, role: 'operator' },
          connectorId: kb.id,
        }),
        (e: unknown) => e instanceof WikiAccessError && e.code === 'not_found',
      )
      const counts = await service.purgePrivateKnowledgeBase({
        actor: adminActor,
        connectorId: kb.id,
      })
      assert.deepEqual(purged, [kb.id])
      assert.equal(counts.pages, 7)
      const row = audits.find((a) => a.action === 'kb.private.deleted')!
      assert.equal(row.policyDecision, 'deleted')
      assert.equal((row.metadata as Record<string, unknown>).trigger, 'admin')
      assert.equal((row.metadata as Record<string, unknown>).privateKb, true)
      assert.ok(!JSON.stringify(row).includes('Leletek'))
    },
  )

  await check(
    '30 napos késleltetett törlés: a sweep a now − 30 nap határt adja és minden árvát töröl',
    async () => {
      const now = new Date('2026-12-01T00:00:00Z')
      const { service, purged, orphans, olderThan, audits } = makeService({
        now,
      })
      orphans.push({
        connectorId: PRIVATE_KB,
        tenantId: TENANT,
        ownerUserId: OWNER,
      })
      const result = await service.sweepOrphanedPrivateKnowledgeBases()
      assert.equal(result.purged, 1)
      assert.deepEqual(purged, [PRIVATE_KB])
      assert.equal(olderThan()?.toISOString(), '2026-11-01T00:00:00.000Z')
      const row = audits.find((a) => a.action === 'kb.private.deleted')!
      assert.equal(row.actorType, 'system')
      assert.equal((row.metadata as Record<string, unknown>).trigger, 'owner_removed')
    },
  )

  await check('linkKnowledgeBase: meglévő írási jog visszavonása felold és auditál', async () => {
    const { service, released, audits } = makeService()
    await service.linkKnowledgeBase({ actor: adminActor, agentId: AGENT, connectorId: SHARED_KB })
    await service.setWikiAccess({ actor: adminActor, agentId: AGENT, connectorId: SHARED_KB, wikiAccess: 'write' })
    released.length = 0
    audits.length = 0
    await service.linkKnowledgeBase({ actor: adminActor, agentId: AGENT, connectorId: SHARED_KB, accessMode: 'read' })
    assert.deepEqual(released, [{ agentId: AGENT, connectorIds: [SHARED_KB] }])
    assert.equal(audits.length, 1)
    assert.equal((audits[0].metadata as Record<string, unknown>).fromAccess, 'write')
    assert.equal((audits[0].metadata as Record<string, unknown>).toAccess, 'read')
  })

  // --- Snapshot: alapértékű KB-kötés nem változtat a hash-en ---
  await check(
    'snapshot: alapértékű KB-kötés mezői kimaradnak (contentHash stabil); write/direct/privát bekerül',
    async () => {
      const kbConnector = (id: string, extra: Partial<Connector> = {}) =>
        ({
          id,
          name: `kb:${AGENT}`,
          type: 'knowledge_base',
          tenantId: TENANT,
          visibility: 'shared',
          ownerUserId: null,
          ...extra,
        }) as Connector
      const working = async (bindings: AgentConnectorBinding[]) => {
        const svc = new AgentDefinitionService({
          agents: {
            findById: async () =>
              ({
                id: AGENT,
                tenantId: TENANT,
                name: 'A',
                roleInstruction: 'x',
                status: 'active',
                currentDefinitionVersionId: null,
              }) as never,
            findConnectorsForAgent: async () => bindings,
            findCapabilitiesForAgent: async () => [],
            setCurrentDefinitionVersionId: async () => ({}) as never,
            activate: async () => ({}) as never,
          },
          versions: {} as never,
          skills: { listEnabledForAgent: async () => [] },
        })
        return (await svc.getWorkingSet({ agentId: AGENT, tenantId: TENANT })).workingSet
      }
      const legacy = await working([{ connector: kbConnector(OWN_KB), accessMode: 'write' }])
      const defaults = await working([
        {
          connector: kbConnector(OWN_KB),
          accessMode: 'write',
          wikiAccess: 'read',
          wikiWriteMode: 'approval',
          wikiCollectFocus: '  ',
        },
      ])
      assert.equal(hashSnapshot(defaults), hashSnapshot(legacy))
      assert.deepEqual(Object.keys(defaults.connectors[0]).sort(), [
        'accessMode',
        'connectorId',
        'name',
        'type',
      ])
      const rich = await working([
        {
          connector: kbConnector(PRIVATE_KB, { visibility: 'private_to_user', ownerUserId: OWNER }),
          accessMode: 'write',
          wikiAccess: 'write',
          wikiWriteMode: 'direct',
          wikiCollectFocus: 'Leletek',
        },
      ])
      assert.deepEqual(
        {
          wikiAccess: rich.connectors[0].wikiAccess,
          wikiWriteMode: rich.connectors[0].wikiWriteMode,
          wikiCollectFocus: rich.connectors[0].wikiCollectFocus,
          visibility: rich.connectors[0].visibility,
          ownerUserId: rich.connectors[0].ownerUserId,
        },
        {
          wikiAccess: 'write',
          wikiWriteMode: 'direct',
          wikiCollectFocus: 'Leletek',
          visibility: 'private_to_user',
          ownerUserId: OWNER,
        },
      )
    },
  )

  // --- 7. kb_ingest agent-hívás: actorType agent ---
  await check("kb_ingest agent-hívás audit-sora actorType: 'agent'", async () => {
    const audits: AuditAppendInput[] = []
    const ownKb = {
      id: OWN_KB,
      tenantId: TENANT,
      type: 'knowledge_base',
      name: `kb:${AGENT}`,
      visibility: 'shared',
      ownerUserId: null,
      lifecycleState: 'active',
      kbLanguage: 'hu',
    } as unknown as Connector
    const stored: Array<{ connectorId: string }> = []
    const privateKb = { ...ownKb, id: PRIVATE_KB, visibility: 'private_to_user', ownerUserId: OWNER } as Connector
    const service = new KnowledgeBaseService({
      documents: {
        createSource: async (data: { filename: string; connectorId: string }) => {
          stored.push(data)
          return { document: { id: 'doc-1', ...data } as unknown as Document, duplicate: false }
        },
      } as never,
      artifacts: {} as never,
      chunks: {} as never,
      agents: {
        findById: async () => ({ id: AGENT, tenantId: TENANT, name: 'A' }) as never,
        upsertConnectorBinding: async () => undefined,
      },
      connectors: {
        findByTenantTypeAndName: async () => ownKb,
        findById: async (id) => id === OWN_KB ? ownKb : privateKb,
        create: async () => ownKb,
      },
      audit: {
        append: async (entry) => {
          audits.push(entry)
          return entry as never
        },
      },
    })
    await executeKnowledgeBaseTool(
      service,
      'kb_ingest',
      { filename: 'jegyzet.md', content: '# Cím\nszöveg' },
      {
        connectorId: OWN_KB,
        tenantId: TENANT,
        agentId: AGENT,
        userId: OWNER,
      },
    )
    const row = audits.find((a) => a.action === 'kb.document.ingested')!
    assert.equal(row.actorType, 'agent')
    assert.equal(row.actorId, AGENT)
    assert.equal((row.metadata as Record<string, unknown>).userId, OWNER)

    await executeKnowledgeBaseTool(service, 'kb_ingest',
      { filename: 'cukorbetegseg.md', content: 'privát lelet' },
      { connectorId: PRIVATE_KB, tenantId: TENANT, agentId: AGENT, userId: OWNER })
    assert.equal(stored.at(-1)?.connectorId, PRIVATE_KB)
    assert.equal(audits.at(-1)?.inputRef, null)
    assert.equal((audits.at(-1)?.metadata as Record<string, unknown>).privateKb, true)
    await assert.rejects(() => executeKnowledgeBaseTool(service, 'kb_ingest',
      { filename: 'lelet.md', content: 'x' },
      { connectorId: PRIVATE_KB, tenantId: TENANT, agentId: AGENT, userId: OTHER_USER }), /not_found/)
    assert.equal(stored.length, 2)

    // Control Plane-feltöltés továbbra is human.
    audits.length = 0
    await service.ingest({
      tenantId: TENANT,
      agentId: AGENT,
      uploadedById: OWNER,
      filename: 'kezi.md',
      buffer: Buffer.from('x'),
      processingMode: 'raw_text_only',
    })
    assert.equal(audits[0].actorType, 'human')
    assert.equal(audits[0].actorId, OWNER)
  })

  if (failures > 0) {
    console.log(`\n❌ ${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\n✅ minden teszt zöld')
}

void main()
