import type { Prisma, RecipeScope, RecipeTicketType } from '@prisma/client'
import type { AuditRepository, RecipeRepository } from '@/repositories/interfaces'

/**
 * Recipe-katalógus (§4.3, §6). A recipe a tickettípus szintű „hogyan végezd"
 * utasítás hordozója. A módosítás — a memóriához hasonlóan — jóváhagyás-köteles
 * és auditesemény (§6 governance).
 *
 * Több-bérlős kapu: minden bérlő-belépőpont (list/create/proposeVersion/
 * approveVersion) `tenantId`-t kap, és azt átadja a repository bérlő-szűrőjének
 * ÉS az audit-eseménynek. A globális, platform-szintű seed-receptek (tenant_id
 * IS NULL) minden bérlő számára láthatók maradnak. A `tenantId` elhagyása kizárólag
 * a rendszer-/seed-út (nincs bérlő-kontextus) — bérlő-belépőpont sose hívja így.
 */
export class RecipeService {
  constructor(
    private recipes: RecipeRepository,
    private audit: AuditRepository,
  ) {}

  list(tenantId: string) {
    return this.recipes.list({ tenantId })
  }

  getActiveVersion(recipeId: string, tenantId: string) {
    return this.recipes.getActiveVersion(recipeId, tenantId)
  }

  async createRecipe(input: {
    tenantId: string
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
      tenantId: input.tenantId,
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
      tenantId: input.tenantId,
      metadata: { ticketType: recipe.ticketType, scope: recipe.scope },
    })

    return { recipe, version }
  }

  async proposeVersion(input: {
    tenantId: string
    recipeId: string
    content: Prisma.JsonValue
    actorId?: string
  }) {
    const version = await this.recipes.addVersion(input.recipeId, input.content, input.tenantId)

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
      tenantId: input.tenantId,
      metadata: { recipeVersionId: version.id },
    })

    return version
  }

  async approveVersion(input: { tenantId: string; versionId: string; approverId: string }) {
    const version = await this.recipes.approveVersion(
      input.versionId,
      input.approverId,
      input.tenantId,
    )

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
      tenantId: input.tenantId,
      metadata: { recipeVersionId: version.id },
    })

    return version
  }
}
