import type { Prisma, Recipe, RecipeScope, RecipeTicketType, RecipeVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import { prismaPageArgs, toListPage } from '@/lib/list-pagination'
import {
  isRecipeReachableByTenant,
  isRecipeWritableByTenant,
  recipeTenantVisibilityWhere,
} from '@/domain/recipe/recipe-tenant-scope'
import type { RecipeListOpts, RecipeRepository, RecipeWithVersions } from '../interfaces'

export class PostgresRecipeRepository implements RecipeRepository {
  async list(opts?: RecipeListOpts): Promise<RecipeWithVersions[]> {
    const versionsMode = opts?.versions ?? 'latest'
    // Alap: limitált lista + legújabb verzió. Full dump: `unbounded: true` (+ opcionálisan versions:'all').
    const { take, skip, pageLimit } = prismaPageArgs(
      opts?.unbounded ? { unbounded: true } : { limit: opts?.limit, offset: opts?.offset },
    )
    const offset = skip ?? 0
    const rows = await prisma.recipe.findMany({
      // Bérlő-kapu: a hívó bérlője a globális sablonokat (NULL) ÉS a saját receptjeit látja.
      where: opts?.tenantId ? recipeTenantVisibilityWhere(opts.tenantId) : undefined,
      orderBy: { createdAt: 'desc' },
      ...(take !== undefined ? { take, skip: offset } : {}),
      include: {
        versions: {
          orderBy: { version: 'desc' },
          ...(versionsMode === 'latest' ? { take: 1 } : {}),
        },
      },
    })
    return toListPage(rows, pageLimit, offset).items
  }

  async findById(id: string, tenantId?: string | null): Promise<RecipeWithVersions | null> {
    const row = await prisma.recipe.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
    if (!row) return null
    // Bérlő-kapu: más bérlő receptje nem létezőként viselkedik (nincs létezés-orákulum).
    if (tenantId && !isRecipeReachableByTenant(row.tenantId, tenantId)) return null
    return row
  }

  async createRecipe(input: {
    name: string
    ticketType: RecipeTicketType
    scope: RecipeScope
    content: Prisma.JsonValue
    tenantId?: string | null
  }): Promise<{ recipe: Recipe; version: RecipeVersion }> {
    return prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.create({
        data: {
          name: input.name,
          ticketType: input.ticketType,
          scope: input.scope,
          tenantId: input.tenantId ?? null,
        },
      })
      const version = await tx.recipeVersion.create({
        data: {
          recipeId: recipe.id,
          version: 1,
          content: input.content as Prisma.InputJsonValue,
          status: 'proposed',
        },
      })
      return { recipe, version }
    })
  }

  async addVersion(
    recipeId: string,
    content: Prisma.JsonValue,
    tenantId?: string | null,
  ): Promise<RecipeVersion> {
    return prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.findUnique({
        where: { id: recipeId },
        select: { tenantId: true },
      })
      if (!recipe) throw new Error('Recipe not found')
      // Fail-closed ÍRÁS-kapu: bérlő csak a SAJÁT receptjéhez adhat verziót — globális
      // sablonhoz nem (annak tartalma minden bérlő promptjába folyik).
      if (tenantId && !isRecipeWritableByTenant(recipe.tenantId, tenantId)) {
        throw new Error('Recipe not found')
      }
      const latest = await tx.recipeVersion.findFirst({
        where: { recipeId },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      return tx.recipeVersion.create({
        data: {
          recipeId,
          version: (latest?.version ?? 0) + 1,
          content: content as Prisma.InputJsonValue,
          status: 'proposed',
        },
      })
    })
  }

  async approveVersion(
    versionId: string,
    approverId: string,
    tenantId?: string | null,
  ): Promise<RecipeVersion> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.recipeVersion.findUnique({
        where: { id: versionId },
        include: { recipe: { select: { tenantId: true } } },
      })
      if (!target) throw new Error('Recipe version not found')
      // Fail-closed ÍRÁS-kapu: bérlő csak a SAJÁT receptjének verzióját hagyhatja jóvá —
      // globális sablonét nem (az minden bérlő agent-promptját érintené).
      if (tenantId && !isRecipeWritableByTenant(target.recipe.tenantId, tenantId)) {
        throw new Error('Recipe version not found')
      }

      // Retire the currently active version of the same recipe.
      await tx.recipeVersion.updateMany({
        where: { recipeId: target.recipeId, status: 'active' },
        data: { status: 'retired' },
      })

      return tx.recipeVersion.update({
        where: { id: versionId },
        data: { status: 'active', approvedById: approverId },
      })
    })
  }

  async getActiveVersion(recipeId: string, tenantId?: string | null): Promise<RecipeVersion | null> {
    if (tenantId) {
      const recipe = await prisma.recipe.findUnique({
        where: { id: recipeId },
        select: { tenantId: true },
      })
      if (!recipe) return null
      if (!isRecipeReachableByTenant(recipe.tenantId, tenantId)) return null
    }
    return prisma.recipeVersion.findFirst({
      where: { recipeId, status: 'active' },
      orderBy: { version: 'desc' },
    })
  }
}
