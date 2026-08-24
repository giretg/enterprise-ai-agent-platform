/**
 * RA-08 — Futás-elemző belépési pont: prefill szöveg és deep-link href.
 *
 * Futtatás: npm run test:run-analysis-entry
 */
import assert from 'node:assert/strict'
import {
  buildRunAnalysisAgentHref,
  buildRunAnalysisPrefill,
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

console.log('run-analysis-entry.test.ts: ok')
