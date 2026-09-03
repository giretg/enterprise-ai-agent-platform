/**
 * Recept-katalógus bérlő-kapuja (pure, DB nélkül tesztelhető).
 *
 * A `recipes.tenant_id` kétféle lehet:
 *  - NULL     → platform-szintű, globális sablon (seed: key-ceremony, wiki-answer).
 *               Minden bérlő agentje köthető hozzá, ezért mindenki számára elérhető.
 *  - <uuid>   → bérlő-tulajdonú recept. Csak a saját bérlője láthatja/módosíthatja.
 *
 * A szolgáltatás- és repository-réteg EGYETLEN közös szabályt használ, hogy a
 * listázás, olvasás és írás (verzió-javaslat/jóváhagyás) ne térhessen el egymástól.
 */

/**
 * OLVASÁS-láthatóság: egy recept elérhető-e a hívó bérlőjének. A globális (NULL)
 * sablon minden bérlőnek látható (a runtime FK-feloldás miatt is), a bérlő-recept
 * csak a sajátjának.
 */
export function isRecipeReachableByTenant(
  recipeTenantId: string | null | undefined,
  callerTenantId: string,
): boolean {
  if (!recipeTenantId) return true
  return recipeTenantId === callerTenantId
}

/**
 * ÍRÁS-jogosultság (verzió-javaslat/jóváhagyás): SZIGORÚBB az olvasásnál. Egy bérlő
 * KIZÁRÓLAG a SAJÁT receptjét módosíthatja — a platform-szintű, globális (NULL)
 * sablont NEM, mert annak jóváhagyott tartalma MINDEN bérlő agent-promptjába
 * bekerül (cross-tenant prompt-poisoning volna). Globális sablont csak a rendszer-út
 * (bérlő-kontextus nélkül) kezel.
 */
export function isRecipeWritableByTenant(
  recipeTenantId: string | null | undefined,
  callerTenantId: string,
): boolean {
  return Boolean(recipeTenantId) && recipeTenantId === callerTenantId
}

/**
 * Prisma `where` a bérlő számára látható receptekre: a globális sablonok (NULL)
 * ÉS a saját bérlő receptjei. A listázás és a reachability-guard ugyanezt a
 * halmazt használja.
 */
export function recipeTenantVisibilityWhere(callerTenantId: string): {
  OR: Array<{ tenantId: null } | { tenantId: string }>
} {
  return { OR: [{ tenantId: null }, { tenantId: callerTenantId }] }
}
