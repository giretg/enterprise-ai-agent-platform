/**
 * Write-gate token — egyszer-használatos (single-use) atomikus fogyasztás.
 *
 * A WriteGateToken a governance-kapu kriptográfiai bizonyítéka: EGY jóváhagyás
 * pontosan EGY írást hitelesít, nem visszajátszható. A `consume` régen
 * read-check-then-update volt (TOCTOU): két, a státusz-olvasáson egyszerre
 * átjutó fogyasztó MINDKETTEN írhatott. A javítás atomikus compare-and-set-re
 * (`updateMany where status='issued'`) váltott. Ez a teszt determinisztikusan
 * kikényszeríti a versenyt: még ha két fogyasztó `issued`-nak is látja a tokent,
 * csak az EGYIK nyerhet, a másik fail-closed elutasításba fut.
 *
 * DB nélkül fut: injektált, in-memory `writeGateToken` kliens, ami hűen modellezi
 * az updateMany CAS-szemantikáját (a where-feltétellel nem egyező sort NEM írja).
 * A kriptográfia (aláírás + diff-hash) a VALÓDI WriteGateService-é.
 *
 * Futtatás: npm run test:write-gate-single-use
 */
import assert from 'node:assert/strict'
import type { AuditLog, WriteGateToken } from '@prisma/client'
import {
  WriteGateService,
  type WriteGateTokenClient,
} from '../src/domain/writegate/write-gate-service'
import type { AuditRepository } from '../src/repositories/interfaces'
import { REGISTERED_AUDIT_ACTIONS } from '../src/lib/audit/event-catalog'
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'

let passed = 0
let failed = 0

function check(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  OK  ${name}`)
      passed += 1
    })
    .catch((e) => {
      console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
      failed += 1
    })
}

/**
 * Minimál in-memory `writeGateToken` tábla. Az updateMany a valódi Prisma-hoz
 * hasonlóan CSAK azokat a sorokat írja, amelyekre a teljes `where` illeszkedik
 * (itt: id + opcionális status) — így a compare-and-set szemantika valósághű.
 * A `freezeFindUniqueToIssued` kapcsoló szimulálja a TOCTOU-versenyt: mintha egy
 * második fogyasztó még a consume-írás ELŐTT olvasta volna ki a sort (`issued`).
 */
function makeFakeDb() {
  const rows = new Map<string, WriteGateToken>()
  let idSeq = 0
  const state = { freezeFindUniqueToIssued: false }

  const db = {
    writeGateToken: {
      async create(args: { data: Record<string, unknown> }) {
        const id = `wgt-${++idSeq}`
        const row = {
          id,
          issuedAt: new Date(),
          consumedAt: null,
          ...args.data,
        } as unknown as WriteGateToken
        rows.set(id, row)
        return structuredClone(row)
      },
      async findUnique(args: { where: { id?: string } }) {
        const id = args.where.id
        if (!id) return null
        const row = rows.get(id)
        if (!row) return null
        const copy = structuredClone(row)
        if (state.freezeFindUniqueToIssued) {
          copy.status = 'issued'
          copy.consumedAt = null
        }
        return copy
      },
      async updateMany(args: {
        where: { id?: string; status?: string }
        data: Record<string, unknown>
      }) {
        const { id, status } = args.where
        let count = 0
        for (const row of rows.values()) {
          if (id && row.id !== id) continue
          if (status && row.status !== status) continue
          Object.assign(row, args.data)
          count += 1
        }
        return { count }
      },
    },
  }
  return { db: db as unknown as WriteGateTokenClient, rows, state }
}

/**
 * Minimál audit-repository. A valódi `append()` két dolgot kényszerít ki, amit itt is
 * lemodellezünk, hogy a teszt ne csak "elhangzott-e az esemény"-t nézze: az action a
 * katalógusban regisztrált kell legyen, a metadata pedig át kell menjen a content-guardon.
 */
function makeFakeAudit() {
  const entries: Array<Record<string, unknown>> = []
  const audit = {
    async append(data: Record<string, unknown>) {
      assert.ok(
        REGISTERED_AUDIT_ACTIONS.has(String(data.action)),
        `unregistered audit action: ${String(data.action)}`,
      )
      assertAuditMetadataSafe(data.metadata)
      entries.push(data)
      return {} as AuditLog
    },
  }
  return { audit: audit as unknown as AuditRepository, entries }
}

function makeService(db: WriteGateTokenClient) {
  const { audit, entries } = makeFakeAudit()
  return { service: new WriteGateService(audit, db), auditEntries: entries }
}

const CONTENT = 'memória-diff: az ügyfél neve Excellence Kft.'

const CTX = {
  tenantId: 'tenant-1',
  actorType: 'human' as const,
  actorId: 'user-1',
}

async function issueValid(service: WriteGateService) {
  return service.issue({
    memoryCandidateId: 'cand-1',
    agentId: 'agent-1',
    targetMemoryId: 'mem-1',
    proposedContent: CONTENT,
    context: CTX,
  })
}

async function main() {
  await check('happy path — issue → consume egyszer sikeres, státusz consumed', async () => {
    const { db, rows } = makeFakeDb()
    const { service } = makeService(db)
    const token = await issueValid(service)
    assert.equal(token.status, 'issued')
    const consumed = await service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX })
    assert.equal(consumed.status, 'consumed')
    assert.ok(consumed.consumedAt)
    assert.equal(rows.get(token.id)!.status, 'consumed')
  })

  await check('szekvenciális visszajátszás — a második consume elutasít', async () => {
    const { db } = makeFakeDb()
    const { service } = makeService(db)
    const token = await issueValid(service)
    await service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX })
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /already consumed/,
    )
  })

  await check('TOCTOU verseny — két „issued”-ot látó fogyasztóból csak egy nyer', async () => {
    const { db, state, rows } = makeFakeDb()
    const { service } = makeService(db)
    const token = await issueValid(service)

    // Az első fogyasztó rendes úton nyer: a token consumed lesz.
    const first = await service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX })
    assert.equal(first.status, 'consumed')

    // A második fogyasztó a TOCTOU-versenyt szimulálja: mintha még az első ÍRÁSA
    // ELŐTT olvasta volna ki a sort — a findUnique `issued`-ot ad vissza, így átjut
    // a korai status-ellenőrzésen ÉS a hash/aláírás-verifikáción. A védelmet
    // egyedül az atomikus updateMany where status='issued' adja: a tábla már
    // consumed, ezért 0 sort érint → fail-closed elutasítás.
    state.freezeFindUniqueToIssued = true
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /already consumed — concurrent use rejected/,
    )
    // A tábla EGYSZER lett consumed; nincs második írás.
    assert.equal(rows.get(token.id)!.status, 'consumed')
  })

  await check('tartalom-hash eltérés — elutasít, a token issued marad', async () => {
    const { db, rows } = makeFakeDb()
    const { service } = makeService(db)
    const token = await issueValid(service)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT + ' HAMISÍTVA', context: CTX }),
      /content hash mismatch/,
    )
    assert.equal(rows.get(token.id)!.status, 'issued')
  })

  await check('hamisított aláírás — elutasít, a token issued marad', async () => {
    const { db, rows } = makeFakeDb()
    const { service } = makeService(db)
    const token = await issueValid(service)
    rows.get(token.id)!.signature = 'deadbeef'.repeat(8)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /signature invalid/,
    )
    assert.equal(rows.get(token.id)!.status, 'issued')
  })

  await check('lejárt token — elutasít és expired-re állít (CAS csak issued-ról)', async () => {
    const { db, rows } = makeFakeDb()
    const { service } = makeService(db)
    const token = await issueValid(service)
    rows.get(token.id)!.expiresAt = new Date(Date.now() - 1000)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /token expired/,
    )
    assert.equal(rows.get(token.id)!.status, 'expired')
  })

  await check('issue invariáns — pontosan egy horgony kell (egyik sem → dob)', async () => {
    const { db } = makeFakeDb()
    const { service } = makeService(db)
    await assert.rejects(
      () =>
        service.issue({
          agentId: 'agent-1',
          targetMemoryId: 'mem-1',
          proposedContent: CONTENT,
          context: CTX,
        }),
      /exactly one of/,
    )
  })

  await check('issue invariáns — mindkét horgony → dob', async () => {
    const { db } = makeFakeDb()
    const { service } = makeService(db)
    await assert.rejects(
      () =>
        service.issue({
          trainingTicketId: 'tt-1',
          memoryCandidateId: 'cand-1',
          agentId: 'agent-1',
          targetMemoryId: 'mem-1',
          proposedContent: CONTENT,
          context: CTX,
        }),
      /exactly one of/,
    )
  })

  // ── Audit-lánc lefedettség (WP-A4) ───────────────────────────────────────
  // A write-gate a governance-lánc kapuja: az írás-engedély kiadása és
  // felhasználása nem maradhat kizárólag a token-táblában, mert onnan csak
  // pont-lekérdezéssel derül ki — a hash-láncból hiányzó esemény vakfolt.

  await check('audit pozitív — issue + sikeres consume auditált, token-érték nélkül', async () => {
    const { db } = makeFakeDb()
    const { service, auditEntries } = makeService(db)
    const token = await issueValid(service)
    await service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX })

    assert.deepEqual(
      auditEntries.map((e) => e.action),
      ['write_gate.issued', 'write_gate.consumed'],
    )
    for (const entry of auditEntries) {
      assert.equal(entry.tenantId, CTX.tenantId, 'a tenant a soron van')
      assert.equal(entry.actorType, CTX.actorType)
      assert.equal(entry.actorId, CTX.actorId, 'a kérő aktor a soron van')
      assert.equal(entry.targetType, 'write_gate_token')
      assert.equal(entry.targetId, token.id, 'a token azonosítója a soron van')
      const metadata = entry.metadata as Record<string, unknown>
      assert.equal(metadata.writeGateTokenId, token.id)
      assert.equal(metadata.targetMemoryId, 'mem-1', 'a cél-erőforrás a metaadatban van')
      assert.equal(metadata.memoryCandidateId, 'cand-1')

      // A nyers token-érték SOHA nem szivároghat auditba. A `tokenHash`/`signature`
      // sem: azok a kapu kriptográfiai anyagai, az audit-sornak nincs rájuk szüksége.
      const serialized = JSON.stringify(entry)
      assert.ok(!serialized.includes(token.tokenHash), 'a tokenHash nem kerül auditba')
      assert.ok(!serialized.includes(token.signature), 'az aláírás nem kerül auditba')
    }
  })

  await check('audit negatív — dupla felhasználás write_gate.replay_denied-ot auditál', async () => {
    const { db } = makeFakeDb()
    const { service, auditEntries } = makeService(db)
    const token = await issueValid(service)
    await service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX })
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /already consumed/,
    )

    assert.deepEqual(
      auditEntries.map((e) => e.action),
      ['write_gate.issued', 'write_gate.consumed', 'write_gate.replay_denied'],
    )
    const denied = auditEntries.at(-1)!
    assert.equal(denied.targetId, token.id)
    assert.equal(denied.policyDecision, 'write_gate_replay_denied:consumed')
  })

  await check('audit negatív — a CAS-versenyben vesztes fogyasztó is replay_denied', async () => {
    const { db, state } = makeFakeDb()
    const { service, auditEntries } = makeService(db)
    const token = await issueValid(service)
    await service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX })

    // A vesztes átjut a korai státusz-ellenőrzésen (issued-ot lát), így csak a CAS
    // fogja meg — ez az ág külön audit-kibocsátási pont.
    state.freezeFindUniqueToIssued = true
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /concurrent use rejected/,
    )
    const denied = auditEntries.at(-1)!
    assert.equal(denied.action, 'write_gate.replay_denied')
    assert.equal(denied.policyDecision, 'write_gate_replay_denied:concurrent')
  })

  await check('audit — lejárt token write_gate.expired-ot auditál', async () => {
    const { db, rows } = makeFakeDb()
    const { service, auditEntries } = makeService(db)
    const token = await issueValid(service)
    rows.get(token.id)!.expiresAt = new Date(Date.now() - 1000)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /token expired/,
    )
    assert.deepEqual(
      auditEntries.map((e) => e.action),
      ['write_gate.issued', 'write_gate.expired'],
    )
  })

  // A §9.4 invariáns két fele — "nem ismételhető" ÉS "nem hamisítható". A replay-ágak
  // fentebb; itt a hamisítás-jelzések, amelyek a legbeszédesebb támadás-nyomok.

  await check('audit — tartalom-hash eltérés write_gate.rejected-et auditál', async () => {
    const { db } = makeFakeDb()
    const { service, auditEntries } = makeService(db)
    const token = await issueValid(service)
    await assert.rejects(
      () =>
        service.consume({
          tokenId: token.id,
          actualProposedContent: CONTENT + ' HAMISÍTVA',
          context: CTX,
        }),
      /content hash mismatch/,
    )
    const denied = auditEntries.at(-1)!
    assert.equal(denied.action, 'write_gate.rejected')
    assert.equal(denied.policyDecision, 'write_gate_rejected:content_hash_mismatch')
    assert.equal(denied.targetId, token.id)
  })

  await check('audit — hamisított aláírás write_gate.rejected-et auditál', async () => {
    const { db, rows } = makeFakeDb()
    const { service, auditEntries } = makeService(db)
    const token = await issueValid(service)
    rows.get(token.id)!.signature = 'deadbeef'.repeat(8)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /signature invalid/,
    )
    const denied = auditEntries.at(-1)!
    assert.equal(denied.action, 'write_gate.rejected')
    assert.equal(denied.policyDecision, 'write_gate_rejected:signature_invalid')
  })

  await check('lejárt token CAS-vesztesként nem ír hamis expired láncsort', async () => {
    const { db, rows, state } = makeFakeDb()
    const { service, auditEntries } = makeService(db)
    const token = await issueValid(service)
    // A token lejárt, de egy párhuzamos fogyasztó már elvitte: a valós terminál
    // státusz `consumed`. Az expiry-CAS 0 sort érint → replay, NEM expired.
    await service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX })
    rows.get(token.id)!.expiresAt = new Date(Date.now() - 1000)
    state.freezeFindUniqueToIssued = true
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /concurrent use rejected/,
    )
    assert.equal(rows.get(token.id)!.status, 'consumed', 'a consumed státusz nem íródik felül')
    assert.ok(
      !auditEntries.some((e) => e.action === 'write_gate.expired'),
      'nem születik hamis expired láncsor egy már felhasznált tokenre',
    )
    assert.equal(auditEntries.at(-1)!.action, 'write_gate.replay_denied')
  })

  await check('elutasítási ágon az audit-hiba NEM nyomja el a biztonsági hibaokot', async () => {
    const { db, rows } = makeFakeDb()
    const brokenAudit = {
      async append() {
        throw new Error('audit chain unavailable')
      },
    } as unknown as AuditRepository
    // Az issue-hoz még ép audit kell, utána rontjuk el.
    const { audit } = makeFakeAudit()
    const service = new WriteGateService(audit, db)
    const token = await issueValid(service)
    const denyingService = new WriteGateService(brokenAudit, db)
    rows.get(token.id)!.signature = 'deadbeef'.repeat(8)
    // A hívónak a hamisítást kell látnia, nem az audit-alrendszer hibáját.
    await assert.rejects(
      () =>
        denyingService.consume({ tokenId: token.id, actualProposedContent: CONTENT, context: CTX }),
      /signature invalid/,
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
