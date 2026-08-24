/**
 * RA-08 — Futás-elemző belépési pont: prefill szöveg és deep-link href.
 *
 * Futtatás: npm run test:run-analysis-entry
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildRunAnalysisAgentHref,
  buildRunAnalysisPrefill,
  mergeRunAnalystIntoCatalogIds,
} from '../src/lib/run-analysis-shared'

assert.match(
  buildRunAnalysisPrefill({ kind: 'ticket', ticketId: 't-1', title: 'Hiba a lépésben' }),
  /ticketId: t-1/,
  'ticket prefill tartalmazza az azonosítót',
)
assert.match(
  buildRunAnalysisPrefill({ kind: 'ticket', ticketId: 't-1', title: 'Hiba a lépésben' }),
  /Hiba a lépésben/,
  'ticket prefill tartalmazza a címet',
)

assert.match(
  buildRunAnalysisPrefill({ kind: 'conversation', conversationId: 'c-1' }),
  /conversationId: c-1/,
)

assert.match(
  buildRunAnalysisPrefill({
    kind: 'process',
    processInstanceId: 'p-1',
    processType: 'Onboarding',
  }),
  /processInstanceId: p-1/,
)
assert.match(
  buildRunAnalysisPrefill({
    kind: 'process',
    processInstanceId: 'p-1',
    processType: 'Onboarding',
  }),
  /Onboarding/,
)

const href = buildRunAnalysisAgentHref('agent-ra', 'Elemezd a ticketet.')
assert.equal(
  href,
  '/control-plane/agents/agent-ra/chat?prefill=Elemezd+a+ticketet.',
  'href workspace chat + prefill query param',
)

const entrySrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/lib/run-analysis-entry.ts'),
  'utf8',
)
assert.match(
  entrySrc,
  /input\.userId\s*\n\s*\? await ensureTenantRunAnalystAgent/,
  'admin belépéskor meglévő példányt is újramaterializál (board connector, capability)',
)

assert.deepEqual(
  mergeRunAnalystIntoCatalogIds(['a'], {
    canRunAnalysis: true,
    runAnalystAgentId: 'run-analyst',
  }),
  ['a', 'run-analyst'],
  'analysis.run: a Futás-elemző bekerül a sín/katalógus azonosítói közé',
)
assert.deepEqual(
  mergeRunAnalystIntoCatalogIds(['a', 'run-analyst'], {
    canRunAnalysis: true,
    runAnalystAgentId: 'run-analyst',
  }),
  ['a', 'run-analyst'],
  'már benne lévő azonosítót nem dupláz',
)
assert.deepEqual(
  mergeRunAnalystIntoCatalogIds(['a'], {
    canRunAnalysis: false,
    runAnalystAgentId: 'run-analyst',
  }),
  ['a'],
  'operator / nincs analysis.run: kimarad',
)
assert.deepEqual(
  mergeRunAnalystIntoCatalogIds(['a'], { canRunAnalysis: true, runAnalystAgentId: null }),
  ['a'],
  'nincs materializált példány: kimarad',
)

const platformSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/app/actions/platform.ts'),
  'utf8',
)
assert.match(
  platformSrc,
  /mergeRunAnalystIntoCatalogIds/,
  'listAgents a sín/katalógusba teszi a Futás-elemzőt',
)
assert.match(
  platformSrc,
  /resolveRunAnalysisEntry\(\{\s*tenantId: user\.activeTenantId,\s*role: user\.activeTenantRole,\s*\}\)/,
  'a sín poll nem materializál (nincs userId) — csak analysis.run + meglévő példány',
)

console.log('run-analysis-entry.test.ts: ok')
