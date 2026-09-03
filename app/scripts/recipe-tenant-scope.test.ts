/**
 * Recept-katalógus több-bérlős kapu regressziói (DB nélkül).
 * Futtatás: npm run test:recipe-tenant-scope
 *
 * Két szint:
 *  1) Pure reachability-helper (globális NULL sablon mindenkinek; bérlő-recept csak a sajátjának).
 *  2) RecipeService: minden bérlő-belépőpont átadja a tenantId-t a repositorynak ÉS az auditnak.
 */
import assert from 'node:assert/strict'
import {
  isRecipeReachableByTenant,
  isRecipeWritableByTenant,
  recipeTenantVisibilityWhere,
} from '../src/domain/recipe/recipe-tenant-scope'
import { RecipeService } from '../src/domain/recipe/recipe-service'
import type { AuditRepository, RecipeRepository } from '../src/repositories/interfaces'

let passed = 0
let failed = 0

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (error) {
    console.error(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}

// --- 1) Pure helper ----------------------------------------------------------

function helperTests() {
  // OLVASÁS: globális (NULL) sablon minden bérlőnek elérhető.
  assert.equal(isRecipeReachableByTenant(null, 'tenant-a'), true)
  assert.equal(isRecipeReachableByTenant(undefined, 'tenant-a'), true)
  // Saját bérlő receptje elérhető.
  assert.equal(isRecipeReachableByTenant('tenant-a', 'tenant-a'), true)
  // Idegen bérlő receptje NEM elérhető.
  assert.equal(isRecipeReachableByTenant('tenant-b', 'tenant-a'), false)

  // ÍRÁS: szigorúbb — bérlő csak a SAJÁT receptjét módosíthatja.
  // Globális (NULL) sablonhoz bérlő NEM írhat (különben minden bérlő promptját mérgezné).
  assert.equal(isRecipeWritableByTenant(null, 'tenant-a'), false)
  assert.equal(isRecipeWritableByTenant(undefined, 'tenant-a'), false)
  // Saját recept írható.
  assert.equal(isRecipeWritableByTenant('tenant-a', 'tenant-a'), true)
  // Idegen recept NEM írható.
  assert.equal(isRecipeWritableByTenant('tenant-b', 'tenant-a'), false)

  const where = recipeTenantVisibilityWhere('tenant-a')
  assert.deepEqual(where, { OR: [{ tenantId: null }, { tenantId: 'tenant-a' }] })
}

// --- 2) Service tenant-threading (fake repo + audit) -------------------------

type Call = { method: string; args: Record<string, unknown> }

function fakeRepo(calls: Call[]): RecipeRepository {
  return {
    async list(opts) {
      calls.push({ method: 'list', args: { tenantId: opts?.tenantId } })
      return []
    },
    async findById(id, tenantId) {
      calls.push({ method: 'findById', args: { id, tenantId } })
      return null
    },
    async createRecipe(input) {
      calls.push({ method: 'createRecipe', args: { tenantId: input.tenantId } })
      return {
        recipe: {
          id: 'recipe-1',
          tenantId: input.tenantId ?? null,
          name: input.name,
          ticketType: input.ticketType,
          scope: input.scope,
          createdAt: new Date(),
        },
        version: {
          id: 'ver-1',
          recipeId: 'recipe-1',
          version: 1,
          content: input.content,
          status: 'proposed',
          approvedById: null,
          createdAt: new Date(),
        },
      } as Awaited<ReturnType<RecipeRepository['createRecipe']>>
    },
    async addVersion(recipeId, _content, tenantId) {
      calls.push({ method: 'addVersion', args: { recipeId, tenantId } })
      return {
        id: 'ver-2',
        recipeId,
        version: 2,
        content: {},
        status: 'proposed',
        approvedById: null,
        createdAt: new Date(),
      } as Awaited<ReturnType<RecipeRepository['addVersion']>>
    },
    async approveVersion(versionId, approverId, tenantId) {
      calls.push({ method: 'approveVersion', args: { versionId, approverId, tenantId } })
      return {
        id: versionId,
        recipeId: 'recipe-1',
        version: 3,
        content: {},
        status: 'active',
        approvedById: approverId,
        createdAt: new Date(),
      } as Awaited<ReturnType<RecipeRepository['approveVersion']>>
    },
    async getActiveVersion(recipeId, tenantId) {
      calls.push({ method: 'getActiveVersion', args: { recipeId, tenantId } })
      return null
    },
  }
}

function fakeAudit(events: Array<Record<string, unknown>>): AuditRepository {
  return {
    async append(data: Parameters<AuditRepository['append']>[0]) {
      events.push(data as unknown as Record<string, unknown>)
      return { id: 'audit-1' } as Awaited<ReturnType<AuditRepository['append']>>
    },
    // A szolgáltatás csak az append()-et használja; a többi metódust nem hívja a teszt.
  } as unknown as AuditRepository
}

async function serviceTests() {
  const TENANT = 'tenant-a'

  await check('list átadja a tenantId-t a repositorynak', async () => {
    const calls: Call[] = []
    const svc = new RecipeService(fakeRepo(calls), fakeAudit([]))
    await svc.list(TENANT)
    assert.deepEqual(calls[0], { method: 'list', args: { tenantId: TENANT } })
  })

  await check('createRecipe bélyegzi a tenantId-t a receptre ÉS az auditra', async () => {
    const calls: Call[] = []
    const events: Array<Record<string, unknown>> = []
    const svc = new RecipeService(fakeRepo(calls), fakeAudit(events))
    await svc.createRecipe({
      tenantId: TENANT,
      name: 'r',
      ticketType: 'single' as never,
      scope: 'single' as never,
      content: {},
      createdById: 'user-1',
    })
    assert.equal(calls[0].args.tenantId, TENANT)
    assert.equal(events[0].action, 'recipe.create')
    assert.equal(events[0].tenantId, TENANT)
  })

  await check('proposeVersion fail-closed tenant-kaput ad a repositorynak + auditra', async () => {
    const calls: Call[] = []
    const events: Array<Record<string, unknown>> = []
    const svc = new RecipeService(fakeRepo(calls), fakeAudit(events))
    await svc.proposeVersion({ tenantId: TENANT, recipeId: 'recipe-1', content: {}, actorId: 'u' })
    assert.equal(calls[0].args.tenantId, TENANT)
    assert.equal(events[0].tenantId, TENANT)
  })

  await check('approveVersion továbbadja a tenantId-t (fail-closed) + auditra', async () => {
    const calls: Call[] = []
    const events: Array<Record<string, unknown>> = []
    const svc = new RecipeService(fakeRepo(calls), fakeAudit(events))
    await svc.approveVersion({ tenantId: TENANT, versionId: 'ver-1', approverId: 'approver-1' })
    assert.equal(calls[0].args.tenantId, TENANT)
    assert.equal(events[0].action, 'recipe.approve')
    assert.equal(events[0].tenantId, TENANT)
  })
}

async function main() {
  await check('reachability + írás-kapu helper: olvasás globális+saját, írás csak saját', helperTests)
  await serviceTests()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
