import assert from 'node:assert/strict'
import { defaultTenantWebSearchConfig } from '../src/domain/web-search/web-search-connector-service'
import { updateWebSearchPolicySchema } from '../src/lib/validators/actions'
import {
  isWebSearchProviderAllowedForScope,
  isWebSearchScopeEnabled,
} from '../src/domain/web-search/web-search-types'

const validTenantPolicy = {
  connectorId: '11111111-1111-4111-8111-111111111111',
  provider: 'custom_search_api',
  providerApiUrl: 'https://api.search.brave.com/res/v1/web/search',
  apiKey: 'secret',
  allowedDomains: [],
  deniedDomains: [],
  allowGeneralWeb: true,
  defaultLocale: 'hu-HU',
  defaultRegion: 'HU',
  defaultMaxResults: 5,
  hardMaxResults: 10,
  maxQueryLength: 500,
  maxQueriesPerTicket: 10,
  maxQueriesPerAgentDay: 100,
  safeSearch: 'strict',
  logRawQuery: false,
  retentionDays: 90,
  requireHumanApprovalForSensitiveQuery: false,
} as const

const tenantDefault = defaultTenantWebSearchConfig()
assert.equal(tenantDefault.provider, 'custom_search_api')
assert.equal(tenantDefault.providerApiUrl, undefined)

const attemptedPlatformOverride = defaultTenantWebSearchConfig({
  provider: 'platform_hosted_search',
})
assert.equal(attemptedPlatformOverride.provider, 'custom_search_api')

assert.equal(updateWebSearchPolicySchema.safeParse(validTenantPolicy).success, true)
assert.equal(
  updateWebSearchPolicySchema.safeParse({
    ...validTenantPolicy,
    provider: 'platform_hosted_search',
  }).success,
  false,
)
assert.equal(
  updateWebSearchPolicySchema.safeParse({ ...validTenantPolicy, provider: 'stub' }).success,
  false,
)

assert.equal(
  isWebSearchScopeEnabled({
    tenantId: null,
    platformKillSwitch: true,
    tenantKillSwitch: false,
  }),
  false,
)
assert.equal(
  isWebSearchProviderAllowedForScope('tenant-1', 'platform_hosted_search'),
  false,
)
assert.equal(isWebSearchProviderAllowedForScope('tenant-1', 'custom_search_api'), true)
assert.equal(isWebSearchProviderAllowedForScope(null, 'custom_search_api'), true)
assert.equal(
  isWebSearchScopeEnabled({
    tenantId: 'tenant-1',
    platformKillSwitch: true,
    tenantKillSwitch: false,
  }),
  true,
)
assert.equal(
  isWebSearchScopeEnabled({
    tenantId: 'tenant-1',
    platformKillSwitch: false,
    tenantKillSwitch: true,
  }),
  false,
)

console.log('web-search scope separation: ok')
