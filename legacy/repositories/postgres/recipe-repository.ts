import type { Prisma, Recipe, RecipeScope, RecipeTicketType, RecipeVersion } from '@prisma/client'
import { prisma } from '@/lib/db'
import { prismaPageArgs, toListPage } from '@/lib/list-pagination'
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

  async findById(id: string): Promise<RecipeWithVersions | null> {
    return prisma.recipe.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    })
  }

  async createRecipe(input: {
    name: string
    ticketType: RecipeTicketType
    scope: RecipeScope
    content: Prisma.JsonValue
  }): Promise<{ recipe: Recipe; version: RecipeVersion }> {
    return prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.create({
        data: { name: input.name, ticketType: input.ticketType, scope: input.scope },
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

  async addVersion(recipeId: string, content: Prisma.JsonValue): Promise<RecipeVersion> {
    return prisma.$transaction(async (tx) => {
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

  async approveVersion(versionId: string, approverId: string): Promise<RecipeVersion> {
    return prisma.$transaction(async (tx) => {
      const target = await tx.recipeVersion.findUnique({ where: { id: versionId } })
      if (!target) throw new Error('Recipe version not found')

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

  async getActiveVersion(recipeId: string): Promise<RecipeVersion | null> {
    return prisma.recipeVersion.findFirst({
      where: { recipeId, status: 'active' },
      orderBy: { version: 'desc' },
    })
  }
}
