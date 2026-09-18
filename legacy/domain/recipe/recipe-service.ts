import type { Prisma, RecipeScope, RecipeTicketType } from '@prisma/client'
import type { AuditRepository, RecipeRepository } from '@/repositories/interfaces'

/**
 * Recipe-katalógus (§4.3, §6). A recipe a tickettípus szintű „hogyan végezd"
 * utasítás hordozója. A módosítás — a memóriához hasonlóan — jóváhagyás-köteles
 * és auditesemény (§6 governance).
 */
export class RecipeService {
  constructor(
    private recipes: RecipeRepository,
    private audit: AuditRepository,
  ) {}

  list() {
    return this.recipes.list()
  }

  getActiveVersion(recipeId: string) {
    return this.recipes.getActiveVersion(recipeId)
  }

  async createRecipe(input: {
    name: string
    ticketType: RecipeTicketType
    scope: RecipeScope
    content: Prisma.JsonValue
    createdById?: string
  }) {
    const { recipe, version } = await this.recipes.createRecipe({
      name: input.name,
      ticketType: input.ticketType,
      scope: input.scope,
      content: input.content,
    })

    await this.audit.append({
      actorType: input.createdById ? 'human' : 'system',
      actorId: input.createdById ?? null,
      agentVersion: null,
      action: 'recipe.create',
      targetType: 'recipe',
      targetId: recipe.id,
      modelUsed: null,
      inputRef: recipe.name,
      outputRef: `v${version.version}`,
      policyDecision: 'proposed',
      metadata: { ticketType: recipe.ticketType, scope: recipe.scope },
    })

    return { recipe, version }
  }

  async proposeVersion(input: { recipeId: string; content: Prisma.JsonValue; actorId?: string }) {
    const version = await this.recipes.addVersion(input.recipeId, input.content)

    await this.audit.append({
      actorType: input.actorId ? 'human' : 'system',
      actorId: input.actorId ?? null,
      agentVersion: null,
      action: 'recipe.version',
      targetType: 'recipe',
      targetId: input.recipeId,
      modelUsed: null,
      inputRef: null,
      outputRef: `v${version.version}`,
      policyDecision: 'proposed',
      metadata: { recipeVersionId: version.id },
    })

    return version
  }

  async approveVersion(input: { versionId: string; approverId: string }) {
    const version = await this.recipes.approveVersion(input.versionId, input.approverId)

    await this.audit.append({
      actorType: 'human',
      actorId: input.approverId,
      agentVersion: null,
      action: 'recipe.approve',
      targetType: 'recipe',
      targetId: version.recipeId,
      modelUsed: null,
      inputRef: input.versionId,
      outputRef: `v${version.version}`,
      policyDecision: 'active',
      metadata: { recipeVersionId: version.id },
    })

    return version
  }
}
