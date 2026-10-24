import type { TenantLanguage } from './tenant-language'

export type AgentWikiBriefing = {
  wikiId: string
  name: string
  access: 'read' | 'submit' | 'write'
  writeMode?: string
  collect?: string
  inbox: { pending: number; inProgress: number }
  batches?: Array<{ batchId: string; pending: number; inProgress: number; processed: number; skipped: number }>
}

export function renderAgentWikiBriefing(wikis: AgentWikiBriefing[], language: TenantLanguage): string {
  if (!wikis.length) return ''
  const en = language === 'en'
  const rows = wikis.map(wiki => {
    const access = wiki.access === 'write'
      ? `${en ? 'write mode' : 'írási mód'}: ${wiki.writeMode}; ${en ? 'Collect' : 'Mit gyűjtsön'}: ${wiki.collect || (en ? 'follow WIKI.md' : 'a WIKI.md szerint')}`
      : wiki.access === 'submit' ? (en ? 'may only submit' : 'csak beküldhet') : (en ? 'may only read' : 'csak olvashat')
    const inbox = wiki.access === 'read' ? '' : `; ${en ? 'inbox pending / in progress' : 'tálca várakozó / folyamatban'}: ${wiki.inbox.pending} / ${wiki.inbox.inProgress}`
    const batches = (wiki.access === 'read' ? [] : wiki.batches ?? []).map(batch => `${batch.batchId}: ${batch.processed}/${batch.pending + batch.inProgress + batch.processed + batch.skipped} ${en ? 'done' : 'kész'} (${batch.skipped} ${en ? 'skipped' : 'kihagyva'})`).join('; ')
    return `- ${wiki.name} (wikiId: ${wiki.wikiId}): ${access}${inbox}${batches ? `; ${batches}` : ''}`
  })
  if (wikis.some(wiki => wiki.access === 'write')) rows.push(en
    ? 'Read skill://llm-wiki-maintainer/SKILL.md. Process received sources NOW: kb_ingest processingMode:"wiki" → read source → kb_wiki_write, one source at a time; defer only on explicit request. Inbox: kb_list_index inbox:true → kb_get_document claimForWiki:true → write → finalize; report progress before stopping. Cite raw sources and wiki pages; retain and mark contradictions. Read WIKI.md (including ingest_review) and index.md first.'
    : 'Olvasd a skill://llm-wiki-maintainer/SKILL.md útmutatót. A kapott forrást AZONNAL dolgozd fel: kb_ingest processingMode:"wiki" → forrás olvasása → kb_wiki_write, egy forrás egyszerre; halasztás csak kifejezett kérésre. Tálca: kb_list_index inbox:true → kb_get_document claimForWiki:true → írás → lezárás; megálláskor állásjelentés. Hivatkozz a nyers forrásra és a wiki-oldalra; őrizd meg és jelöld az ellentmondásokat. Először WIKI.md (ingest_review is) és index.md.')
  return ['AGENT WIKI', ...rows].join('\n')
}
