/** #945: runnable contract checks; no database or model calls. */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import { hashSnapshot } from '../src/domain/agent-definition'
import { WIKI_MAINTAINER, withWikiMaintainer, wikiMaintainerPackage } from '../src/domain/skill/llm-wiki-maintainer'
import { renderAgentBriefing, renderAgentCheckout } from '../src/lib/agent-checkout'
import { renderAgentWikiBriefing, type AgentWikiBriefing } from '../src/lib/agent-wiki-briefing'
import { detectMisplacedMemoryWrite, renderKnowledgePlacementBlock, suggestToolForPlacement } from '../src/lib/agent-knowledge-placement'
import { defaultWikiSchema, type WikiPageState, type WikiPageTypeName } from '../src/lib/kb-wiki'
import { validateWikiPages } from '../src/lib/kb-validator'
import { WIKI_TEMPLATES } from '../src/lib/wiki-templates'
import { validateSkill } from '../src/lib/skill/skill-validator'

const definition: AgentDefinition = {
  definitionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  version: 1, tenantId: 'tenant', status: 'active', publishedAt: '2026-10-23T00:00:00Z',
  snapshot: { name: 'Wiki', roleInstruction: 'Maintain knowledge.', skills: [], capabilities: [], connectors: [
    { connectorId: 'private', type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct', visibility: 'private_to_user', ownerUserId: 'owner' },
  ] },
}
const original = hashSnapshot(definition.snapshot)
assert.equal(withWikiMaintainer(definition, 'other').snapshot.skills.length, 0)
assert.equal(withWikiMaintainer(definition, 'other').snapshot.connectors.length, 0)
const writer = withWikiMaintainer(definition, 'owner')
assert.equal(writer.snapshot.skills[0].name, 'llm-wiki-maintainer')
assert.equal(withWikiMaintainer(writer, 'owner').snapshot.skills.length, 1)
assert.equal(withWikiMaintainer(writer, 'other').snapshot.skills.length, 0)
assert.equal(hashSnapshot(definition.snapshot), original, 'published definition is immutable')
for (const access of ['none', 'read', 'submit'] as const) {
  const reader = { ...definition, snapshot: { ...definition.snapshot, connectors: definition.snapshot.connectors.map(row => ({ ...row, wikiAccess: access })) } }
  assert.equal(withWikiMaintainer(reader, 'owner').snapshot.skills.length, 0)
}
const wikis: AgentWikiBriefing[] = [
  { wikiId: 'one', name: 'Health', access: 'write', writeMode: 'direct', collect: 'Labs', inbox: { pending: 117, inProgress: 0 }, batches: [{ batchId: 'Leletek 2026-10', pending: 117, inProgress: 0, processed: 23, skipped: 0 }] },
  { wikiId: 'two', name: 'Company', access: 'write', writeMode: 'approval', collect: 'Products', inbox: { pending: 2, inProgress: 1 } },
]
assert.equal(renderAgentWikiBriefing([], 'en'), '')
assert.doesNotMatch(renderAgentBriefing({ definition, skills: [] }), /AGENT WIKI/)
for (const language of ['hu', 'en'] as const) {
  const briefing = renderAgentBriefing({ definition: writer, skills: [WIKI_MAINTAINER], wikis, language })
  assert.match(briefing, /AGENT WIKI/)
  assert.match(briefing, /Health \(wikiId: one\): .*direct.*Labs/)
  assert.match(briefing, /Company \(wikiId: two\): .*approval.*Products/)
  assert.match(briefing, /117 \/ 0; Leletek 2026-10: 23\/140/)
  assert.match(briefing, language === 'en' ? /Process received sources NOW/ : /AZONNAL/)
}
const readerBlock = renderAgentWikiBriefing([{ ...wikis[0], access: 'read' }], 'en')
assert.match(readerBlock, /may only read/)
assert.doesNotMatch(readerBlock, /kb_wiki_write|inbox pending|Leletek 2026-10|23\/140/)
assert.match(renderAgentWikiBriefing([{ ...wikis[0], access: 'submit' }], 'en'), /may only submit/)
const checkout = renderAgentCheckout({ definition: writer, skills: [WIKI_MAINTAINER], wikis, language: 'en', publishedContentHash: original, mcpUrl: 'https://example.com/api/mcp/acme', harness: 'codex' })
assert.equal(checkout.pin.contentHash, original)
assert.ok(checkout.files.some(file => file.path.endsWith('/llm-wiki-maintainer/SKILL.md')))
assert.ok(checkout.files.some(file => file.content.includes('Process received sources NOW')))
const pkg = wikiMaintainerPackage()
assert.equal(pkg.files.length, 1)
assert.match(pkg.files[0].text, /ingest_review/)
assert.match(pkg.files[0].text, /kind:"note", processingMode:"wiki", wikiId/)
assert.match(pkg.files[0].text, /citing the returned documentId and marking confidence: agent_observation/)
assert.equal(validateSkill({ ...WIKI_MAINTAINER, attachmentPaths: [] }).ok, true)
for (const language of ['hu', 'en'] as const) {
  for (const template of WIKI_TEMPLATES) {
    const schema = defaultWikiSchema(language, template.id)
    assert.match(schema, /ingest_review: silent/)
    if (template.id === 'health-journal') assert.match(schema, language === 'hu' ? /## Tények/ : /## Facts/)
    // Every path/type advertised by the template must pass the real #943 validator.
    const examples: WikiPageState[] = [...schema.matchAll(/^- ([a-z<>/-]+\.md) \(type: ([a-z]+)\)/gm)].map(match => ({
      path: match[1].replace(/<[^>]+>/g, 'example'), type: match[2] as WikiPageTypeName,
      title: 'Example', summary: 'One line', category: 'Examples', frontmatter: { source_date: '2026-10-23' },
      sources: [{ documentId: 'raw', page: 1 }], body: '## Facts\nA cited fact.',
    }))
    assert.ok(examples.length >= 5)
    const validation = validateWikiPages({ pages: examples.map(state => ({ path: state.path, action: 'upsert', state })), knownSourceIds: new Set(['raw']), pathsAfterWrite: new Set(examples.map(page => page.path)) })
    assert.equal(validation.ok, true, JSON.stringify(validation.issues))
  }
}
assert.match(renderKnowledgePlacementBlock({ wikiCapable: true }), /agent wiki.*kb_ingest.*kb_wiki_write/)
assert.doesNotMatch(renderKnowledgePlacementBlock(), /kb_wiki_write/)
const document = { kind: 'finding', title: 'Reference', body: 'x'.repeat(1300) }
assert.equal(detectMisplacedMemoryWrite(document)?.suggest, 'knowledge_base')
assert.equal(detectMisplacedMemoryWrite({ ...document, wikiCapable: true })?.suggest, 'agent_wiki')
assert.equal(detectMisplacedMemoryWrite({ ...document, title: 'draft plan', wikiCapable: true })?.suggest, 'work_file')
assert.equal(suggestToolForPlacement('agent_wiki'), 'kb_wiki_write')
console.log('agent-wiki-briefing: ok')
