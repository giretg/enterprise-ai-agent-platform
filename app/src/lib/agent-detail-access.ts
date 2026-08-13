/**
 * Agent-detail feloldás — a lista és a közvetlen URL közös döntése.
 *
 * A detail oldal korábban MINDEN hibát 404-nek hazudott (loader-timeout,
 * rossz tenant, hiányzó grant). Ettől a felhasználó egy létező, a listában
 * látott agentre kattintva a gyökér 404-et kapta — fejléc és tenant-váltó nélkül.
 */

export type AgentDetailAccessDecision =
  | { status: 'found' }
  | { status: 'not_found' }
  | { status: 'wrong_tenant'; agentTenantId: string; agentName: string }

export type AgentDetailLoadCode = 'NOT_FOUND' | 'NO_VIEW' | 'WRONG_TENANT' | 'LOAD_FAILED'

export class AgentDetailLoadError extends Error {
  constructor(
    public readonly code: AgentDetailLoadCode,
    message: string,
    public readonly meta: {
      agentTenantId?: string
      agentName?: string
    } = {},
  ) {
    super(message)
    this.name = 'AgentDetailLoadError'
  }

  static notFound(): AgentDetailLoadError {
    return new AgentDetailLoadError('NOT_FOUND', 'Agent not found')
  }

  static noView(): AgentDetailLoadError {
    return new AgentDetailLoadError('NO_VIEW', 'Agent not found')
  }

  static wrongTenant(agentTenantId: string, agentName: string): AgentDetailLoadError {
    return new AgentDetailLoadError('WRONG_TENANT', 'Agent belongs to another tenant', {
      agentTenantId,
      agentName,
    })
  }

  static loadFailed(cause: unknown): AgentDetailLoadError {
    const message = cause instanceof Error ? cause.message : 'Failed to load agent detail page'
    return new AgentDetailLoadError('LOAD_FAILED', message)
  }
}

export function isAgentDetailLoadError(e: unknown): e is AgentDetailLoadError {
  return e instanceof AgentDetailLoadError
}

/**
 * A tenant-szűrt display-találat és a szűretlen rekord alapján eldönti, hogy
 * az agent a jelenlegi tenantban van, másik saját tenantban, vagy nem létezik
 * (illetve a hívó elől el kell fedni).
 */
export function classifyAgentDetailLookup(input: {
  displayed: { tenantId: string | null } | null
  unrestricted: { tenantId: string | null; name: string } | null
  activeTenantId: string
  membershipTenantIds: ReadonlySet<string>
}): AgentDetailAccessDecision {
  if (input.displayed) return { status: 'found' }
  if (!input.unrestricted) return { status: 'not_found' }

  const home = input.unrestricted.tenantId
  if (home === input.activeTenantId) return { status: 'found' }
  if (home && input.membershipTenantIds.has(home)) {
    return {
      status: 'wrong_tenant',
      agentTenantId: home,
      agentName: input.unrestricted.name,
    }
  }
  return { status: 'not_found' }
}
