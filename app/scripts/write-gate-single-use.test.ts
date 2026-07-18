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
import type { WriteGateToken } from '@prisma/client'
import {
  WriteGateService,
  type WriteGateTokenClient,
} from '../src/domain/writegate/write-gate-service'

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

const CONTENT = 'memória-diff: az ügyfél neve Excellence Kft.'

async function issueValid(service: WriteGateService) {
  return service.issue({
    memoryCandidateId: 'cand-1',
    agentId: 'agent-1',
    targetMemoryId: 'mem-1',
    proposedContent: CONTENT,
  })
}

async function main() {
  await check('happy path — issue → consume egyszer sikeres, státusz consumed', async () => {
    const { db, rows } = makeFakeDb()
    const service = new WriteGateService(db)
    const token = await issueValid(service)
    assert.equal(token.status, 'issued')
    const consumed = await service.consume({ tokenId: token.id, actualProposedContent: CONTENT })
    assert.equal(consumed.status, 'consumed')
    assert.ok(consumed.consumedAt)
    assert.equal(rows.get(token.id)!.status, 'consumed')
  })

  await check('szekvenciális visszajátszás — a második consume elutasít', async () => {
    const { db } = makeFakeDb()
    const service = new WriteGateService(db)
    const token = await issueValid(service)
    await service.consume({ tokenId: token.id, actualProposedContent: CONTENT })
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT }),
      /already consumed/,
    )
  })

  await check('TOCTOU verseny — két „issued”-ot látó fogyasztóból csak egy nyer', async () => {
    const { db, state, rows } = makeFakeDb()
    const service = new WriteGateService(db)
    const token = await issueValid(service)

    // Az első fogyasztó rendes úton nyer: a token consumed lesz.
    const first = await service.consume({ tokenId: token.id, actualProposedContent: CONTENT })
    assert.equal(first.status, 'consumed')

    // A második fogyasztó a TOCTOU-versenyt szimulálja: mintha még az első ÍRÁSA
    // ELŐTT olvasta volna ki a sort — a findUnique `issued`-ot ad vissza, így átjut
    // a korai status-ellenőrzésen ÉS a hash/aláírás-verifikáción. A védelmet
    // egyedül az atomikus updateMany where status='issued' adja: a tábla már
    // consumed, ezért 0 sort érint → fail-closed elutasítás.
    state.freezeFindUniqueToIssued = true
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT }),
      /already consumed — concurrent use rejected/,
    )
    // A tábla EGYSZER lett consumed; nincs második írás.
    assert.equal(rows.get(token.id)!.status, 'consumed')
  })

  await check('tartalom-hash eltérés — elutasít, a token issued marad', async () => {
    const { db, rows } = makeFakeDb()
    const service = new WriteGateService(db)
    const token = await issueValid(service)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT + ' HAMISÍTVA' }),
      /content hash mismatch/,
    )
    assert.equal(rows.get(token.id)!.status, 'issued')
  })

  await check('hamisított aláírás — elutasít, a token issued marad', async () => {
    const { db, rows } = makeFakeDb()
    const service = new WriteGateService(db)
    const token = await issueValid(service)
    rows.get(token.id)!.signature = 'deadbeef'.repeat(8)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT }),
      /signature invalid/,
    )
    assert.equal(rows.get(token.id)!.status, 'issued')
  })

  await check('lejárt token — elutasít és expired-re állít (CAS csak issued-ról)', async () => {
    const { db, rows } = makeFakeDb()
    const service = new WriteGateService(db)
    const token = await issueValid(service)
    rows.get(token.id)!.expiresAt = new Date(Date.now() - 1000)
    await assert.rejects(
      () => service.consume({ tokenId: token.id, actualProposedContent: CONTENT }),
      /token expired/,
    )
    assert.equal(rows.get(token.id)!.status, 'expired')
  })

  await check('issue invariáns — pontosan egy horgony kell (egyik sem → dob)', async () => {
    const { db } = makeFakeDb()
    const service = new WriteGateService(db)
    await assert.rejects(
      () =>
        service.issue({
          agentId: 'agent-1',
          targetMemoryId: 'mem-1',
          proposedContent: CONTENT,
        }),
      /exactly one of/,
    )
  })

  await check('issue invariáns — mindkét horgony → dob', async () => {
    const { db } = makeFakeDb()
    const service = new WriteGateService(db)
    await assert.rejects(
      () =>
        service.issue({
          trainingTicketId: 'tt-1',
          memoryCandidateId: 'cand-1',
          agentId: 'agent-1',
          targetMemoryId: 'mem-1',
          proposedContent: CONTENT,
        }),
      /exactly one of/,
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
