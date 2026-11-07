import type { FeatureFlagReader, FeatureFlagScope } from './evaluator'

/**
 * A hibaszöveg a böngészőig eljuthat (`fail(e.message)`), ezért nem nevezi meg a flaget: egy kiadatlan
 * funkció neve idegen cégnek nem derülhet ki.
 */
export class FeatureNotEnabledError extends Error {
  readonly code = 'feature_not_enabled'
  constructor() {
    super('Ez a funkció ennél a cégnél most nem érhető el.')
    this.name = 'FeatureNotEnabledError'
  }
}

/** Szerveroldali kapuk: a gomb elrejtése nem védelem, a művelet és az API mindig itt ellenőriz. */
export function createFeatureGates<K extends string>(reader: FeatureFlagReader<K>) {
  return {
    isFeatureEnabled: (key: K, scope: FeatureFlagScope) => reader.isEnabled(key, scope),
    /** Szerverművelethez: a szokásos `try/catch` + `fail(e.message)` kezeli. */
    async requireFeature(key: K, scope: FeatureFlagScope): Promise<void> {
      if (!(await reader.isEnabled(key, scope))) throw new FeatureNotEnabledError()
    },
    /** API-hoz: `null`, ha mehet tovább; különben 404, mintha az útvonal nem is létezne. */
    async featureGuardResponse(key: K, scope: FeatureFlagScope): Promise<Response | null> {
      if (await reader.isEnabled(key, scope)) return null
      return Response.json({ error: 'not_found' }, { status: 404 })
    },
  }
}

/** Ez a megfeleltetés dönti el az MCP-listát és a hívást is; a kapu a kettőt egyszerre kezeli. */
export type ToolFeatureGate = {
  /** A cégnél nem elérhető eszközök; a `tools/list` ezeket nem mutatja. */
  disabledTools(tenantId: string): Promise<ReadonlySet<string>>
  /** A hívás a döntő, mert a kliensek gyorsítótárazhatják a listát. */
  blocksTool(toolName: string, tenantId: string): Promise<boolean>
}

export function createToolFeatureGate<K extends string>(
  toolFlags: Readonly<Record<string, K>>,
  reader: FeatureFlagReader<K>,
): ToolFeatureGate {
  const entries = Object.entries(toolFlags) as Array<[string, K]>
  return {
    async disabledTools(tenantId) {
      const decisions = await Promise.all(
        entries.map(async ([tool, key]) => [tool, await reader.isEnabled(key, { tenantId })] as const),
      )
      return new Set(decisions.filter(([, enabled]) => !enabled).map(([tool]) => tool))
    },
    async blocksTool(toolName, tenantId) {
      if (!Object.hasOwn(toolFlags, toolName)) return false
      return !(await reader.isEnabled(toolFlags[toolName], { tenantId }))
    },
  }
}

/** Kiértékelő nélküli környezetben a flag mögötti eszköz tiltott: a régi működés fut. */
export function createFeatureFlagGateClosed(toolFlags: Readonly<Record<string, string>>): ToolFeatureGate {
  return createToolFeatureGate(toolFlags, { isEnabled: async () => false })
}

type ToolRegisteringServer = { registerTool: (...args: never[]) => unknown }

/**
 * A letiltott eszköz fel sem kerül a szerverre, így a listában sem látszik. A `tools/call` kezelő
 * külön tilt és naplóz, mert a szerverre nem került eszköz hívása az SDK-ban naplózás nélkül bukna el.
 */
export function hideDisabledTools(server: ToolRegisteringServer, disabled: ReadonlySet<string>): void {
  if (disabled.size === 0) return
  const register = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown
  const filtered = (name: string, ...rest: unknown[]) => (disabled.has(name) ? undefined : register(name, ...rest))
  server.registerTool = filtered as unknown as typeof server.registerTool
}
