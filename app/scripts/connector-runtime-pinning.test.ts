/**
 * Self-updating connector runtime pinning.
 *
 * DoD: findById-derived row for a self_updating connector must expose the
 * approved spec version's baseUrl/auth/tools as `config`, not the raw (empty)
 * column — otherwise every http_api tool call throws "baseUrl must be an
 * absolute http(s) URL" even though the connector is listed as active.
 */
import assert from 'node:assert/strict'
import type { Connector } from '@prisma/client'
import { resolveRuntimeConnector } from '../src/repositories/postgres/connector-repository'

function baseRow(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'conn-1',
    type: 'http_api',
    name: 'Ostoros CRM auto',
    authMode: 'service',
    scope: 'tenant',
    secretAlias: 'secret-ref:conn-1',
    version: 1,
    config: {},
    lifecycleState: 'active',
    tenantId: 'tenant-1',
    createdAt: new Date(),
    connectorMode: 'self_updating',
    activeSpecVersionId: 'spec-1',
    ...overrides,
  } as Connector
}

// fixed-mode connectors pass through unchanged (their config column is authoritative)
{
  const row = { ...baseRow({ connectorMode: 'fixed', config: { baseUrl: 'https://api.github.com', auth: { scheme: 'bearer' } } }), activeSpecVersion: null }
  const resolved = resolveRuntimeConnector(row)
  assert.ok(resolved)
  assert.equal((resolved!.config as { baseUrl: string }).baseUrl, 'https://api.github.com')
}

// self_updating with an approved snapshot: config comes from capability_set, not the empty column
{
  const capabilitySet = {
    baseUrl: 'https://ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app/api/connector/v1',
    provider: 'ostorosbor-crm',
    authMode: 'service',
    auth: { type: 'api_key_header', headerName: 'X-Api-Key' },
    egressHosts: ['ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app'],
    proposedTools: [{ name: 'query_report', method: 'POST', path: '/reports/query', access: 'write', risk: 'read' }],
    capabilitySchemaVersion: 1,
  }
  const row = { ...baseRow(), activeSpecVersion: { capabilitySet } }
  const resolved = resolveRuntimeConnector(row)
  assert.ok(resolved, 'self_updating connector with an approved snapshot must resolve')
  const config = resolved!.config as { baseUrl: string; restrictToEndpoints: boolean }
  assert.equal(config.baseUrl, capabilitySet.baseUrl)
  assert.equal(config.restrictToEndpoints, true)
}

// self_updating with no approved snapshot yet: fail-closed (null), never an empty-config connector
{
  const row = { ...baseRow({ activeSpecVersionId: null }), activeSpecVersion: null }
  const resolved = resolveRuntimeConnector(row)
  assert.equal(resolved, null)
}

console.log('connector-runtime-pinning: ok')
