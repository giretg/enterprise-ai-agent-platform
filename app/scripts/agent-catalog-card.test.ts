/**
 * Munkatárs-kártya: arckép + unpublished jelzés a listán, feltöltés a profilon.
 *
 * Futtatás: npm run test:agent-catalog-card
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AGENT_AVATAR_MAX_CHARS,
  updateAgentAvatarSchema,
} from '../src/lib/validators/actions'

const root = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const card = read('src/components/agents/agent-catalog-card.tsx')
const agentsPage = read('src/app/control-plane/agents/page.tsx')
const dashboard = read('src/app/control-plane/dashboard/page.tsx')
const detail = read('src/app/control-plane/agents/[agentId]/page.tsx')
const upload = read('src/components/agents/agent-avatar-upload.tsx')
const action = read('src/app/actions/platform.ts')

assert.match(card, /AgentAvatar/)
assert.match(card, /unpublished/)
assert.match(card, /section=elesites/)
assert.match(agentsPage, /listAgentsForCatalog/)
assert.match(agentsPage, /AgentCatalogCard/)
assert.match(dashboard, /listAgentsForCatalog/)
assert.match(dashboard, /AgentCatalogCard/)
assert.match(detail, /AgentAvatarUpload/)
assert.match(upload, /updateAgentAvatar/)
assert.match(action, /listAgentsForCatalog/)
assert.match(action, /getPublishStatus/)
assert.match(action, /nextAvatar/)

const agentId = '11111111-1111-4111-8111-111111111111'
assert.equal(
  updateAgentAvatarSchema.safeParse({ agentId, avatarUrl: '' }).success,
  true,
  'üres string törli a képet',
)
assert.equal(
  updateAgentAvatarSchema.safeParse({
    agentId,
    avatarUrl: `data:image/webp;base64,${'A'.repeat(8000)}`,
  }).success,
  true,
  '256px webp data URL belefér',
)
assert.equal(
  updateAgentAvatarSchema.safeParse({
    agentId,
    avatarUrl: 'javascript:alert(1)',
  }).success,
  false,
  'javascript URL tiltott',
)
assert.equal(
  updateAgentAvatarSchema.safeParse({
    agentId,
    avatarUrl: 'data:text/html;base64,PHNjcmlwdD4=',
  }).success,
  false,
  'nem kép data URL tiltott',
)
assert.ok(AGENT_AVATAR_MAX_CHARS > 2000, 'a régi 2000 karakteres korlát a tömörített portrét is elutasította')

console.log('agent-catalog-card.test.ts: ok')
