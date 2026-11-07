import type { TenantLanguage } from './tenant-language'

export type AgentWikiBriefing = {
  wikiId: string
  name: string
  access: 'read' | 'submit' | 'write'
  writeMode?: string
  collect?: string
  inbox: { pending: number; inProgress: number; reprocess?: number }
  batches?: Array<{ batchId: string; pending: number; inProgress: number; processed: number; skipped: number; reprocess?: number }>
  /** #978 §5.4: alkalmazott módosítások az agent legutóbbi átnézése óta. */
  changes?: { latestSeq: number; unseen: number }
  /** #1129: nyitott emberi kommentek, csak író agentnek és csak ha nem nulla. */
  comments?: { open: number }
  /** #1061 F1: kezelt kategóriák — az agent csak ezek kulcsútját írhatja az oldal `category` mezőjébe. */
  categories?: Array<{
    key: string
    name: string
    description?: string
    approval?: 'always'
    /** #1061 F3/F4: kötelező mezők és fejezetek. */
    requiredFields?: string[]
    requiredSections?: string[]
  }>
  /** #1061 F3: metaadat-mezős wiki — lejárt átnézés, tervezetek, egyedi mezők kulcsai. */
  metadata?: { reviewOverdue: number; drafts: number; fields: string[] }
  /** #1061 F2: „csak a kijelöltek” wiki — a tartalma nem kerülhet szélesebb körbe. */
  membersOnly?: boolean
}

export function renderAgentWikiBriefing(wikis: AgentWikiBriefing[], language: TenantLanguage): string {
  if (!wikis.length) return ''
  const en = language === 'en'
  const rows = wikis.map(wiki => {
    const access = wiki.access === 'write'
      ? `${en ? 'write mode' : 'írási mód'}: ${wiki.writeMode}; ${en ? 'Collect' : 'Mit gyűjtsön'}: ${wiki.collect || (en ? 'follow WIKI.md' : 'a WIKI.md szerint')}`
      : wiki.access === 'submit' ? (en ? 'may only submit' : 'csak beküldhet') : (en ? 'may only read' : 'csak olvashat')
    const inbox = wiki.access === 'read' ? '' : `; ${en ? 'inbox pending / in progress' : 'tálca várakozó / folyamatban'}: ${wiki.inbox.pending} / ${wiki.inbox.inProgress}${wiki.inbox.reprocess ? `; ${en ? 'sent back for reprocessing' : 'újrafeldolgozásra visszatéve'}: ${wiki.inbox.reprocess}` : ''}`
    const batches = (wiki.access === 'read' ? [] : wiki.batches ?? []).map(batch => `${batch.batchId}: ${batch.processed}/${batch.pending + (batch.reprocess ?? 0) + batch.inProgress + batch.processed + batch.skipped} ${en ? 'done' : 'kész'} (${batch.skipped} ${en ? 'skipped' : 'kihagyva'})`).join('; ')
    const changes = wiki.changes?.unseen
      ? `; ${en
          ? `${wiki.changes.unseen} new change${wiki.changes.unseen === 1 ? '' : 's'} since you last looked — call kb_wiki_changes once before working on this wiki`
          : `${wiki.changes.unseen} új módosítás a legutóbbi átnézés óta — a munka elején egyszer hívd a kb_wiki_changes-t`}`
      : ''
    const comments = wiki.comments?.open && wiki.access === 'write'
      ? `; ${en
          ? `${wiki.comments.open} open comment${wiki.comments.open === 1 ? '' : 's'}; call kb_wiki_comments`
          : `${wiki.comments.open} nyitott komment; hívd a kb_wiki_comments-t`}`
      : ''
    const categories = wiki.categories?.length && wiki.access !== 'read'
      ? `\n  ${en ? 'Categories (use the key as page category; others are rejected)' : 'Kategóriák (az oldal category mezőjébe a kulcs kerül; más érték hibát ad)'}: ${wiki.categories
          .map(category => `${category.key} = ${category.name}${category.description ? ` (${category.description})` : ''}${category.approval === 'always' ? (en ? ' [always needs approval]' : ' [mindig jóváhagyással]') : ''}${category.requiredFields?.length ? ` [${en ? 'required fields' : 'kötelező mezők'}: ${category.requiredFields.join(', ')}]` : ''}${category.requiredSections?.length ? ` [${en ? 'required sections' : 'kötelező fejezetek'}: ${category.requiredSections.join(', ')}]` : ''}`)
          .join('; ')}`
      : ''
    const membersOnly = wiki.membersOnly
      ? `; ${en
          ? 'members only — do not copy its content into a wider wiki or share it with people outside its list'
          : 'csak a kijelölteknek — a tartalmát ne vidd át szélesebb körű wikibe, és ne oszd meg a névsoron kívüliekkel'}`
      : ''
    // #1061 F3: az agent frissítést javasolhat a gazdának — átnézettnek viszont nem jelölheti.
    const metadata = wiki.metadata
      ? `\n  ${en
          ? `Metadata: ${wiki.metadata.reviewOverdue} page${wiki.metadata.reviewOverdue === 1 ? '' : 's'} overdue for review, ${wiki.metadata.drafts} draft${wiki.metadata.drafts === 1 ? '' : 's'} waiting${wiki.metadata.fields.length ? `; fields: ${wiki.metadata.fields.join(', ')}` : ''}. You may suggest updates to the page owner; never mark a page reviewed or approved yourself.`
          : `Metaadat: ${wiki.metadata.reviewOverdue} oldal átnézése lejárt, ${wiki.metadata.drafts} tervezet vár${wiki.metadata.fields.length ? `; mezők: ${wiki.metadata.fields.join(', ')}` : ''}. Frissítést javasolhatsz a gazdának; átnézettnek vagy jóváhagyottnak magad nem jelölheted.`}`
      : ''
    return `- ${wiki.name} (wikiId: ${wiki.wikiId}): ${access}${membersOnly}${inbox}${batches ? `; ${batches}` : ''}${changes}${comments}${categories}${metadata}`
  })
  if (wikis.some(wiki => wiki.access === 'write')) rows.push(en
    ? 'Read skill://llm-wiki-maintainer/SKILL.md. Process received sources NOW: kb_ingest processingMode:"wiki" → read source → kb_wiki_write, one source at a time; defer only on explicit request. Inbox: kb_list_index inbox:true → kb_get_document claimForWiki:true → write → finalize; report progress before stopping. Cite raw sources and wiki pages; retain and mark contradictions. Read WIKI.md (including ingest_review) and index.md first.'
    : 'Olvasd a skill://llm-wiki-maintainer/SKILL.md útmutatót. A kapott forrást AZONNAL dolgozd fel: kb_ingest processingMode:"wiki" → forrás olvasása → kb_wiki_write, egy forrás egyszerre; halasztás csak kifejezett kérésre. Tálca: kb_list_index inbox:true → kb_get_document claimForWiki:true → írás → lezárás; megálláskor állásjelentés. Hivatkozz a nyers forrásra és a wiki-oldalra; őrizd meg és jelöld az ellentmondásokat. Először WIKI.md (ingest_review is) és index.md.')
  return ['AGENT WIKI', ...rows].join('\n')
}
