export type WebResearchSourceType = 'official' | 'vendor_doc' | 'news' | 'blog' | 'unknown'
export type WebResearchConfidence = 'high' | 'medium' | 'low'
export type WebResearchContentType = 'html' | 'pdf'

export const WEB_RESEARCH_SOURCE_TYPES: WebResearchSourceType[] = [
  'official',
  'vendor_doc',
  'news',
  'blog',
  'unknown',
]

export const WEB_RESEARCH_FACT_MAX_CHARS = 4000

export const WEB_RESEARCH_EMPTY_DOCUMENT_NOTICE =
  'A dokumentumból nem sikerült szöveget kinyerni (kép-alapú, jelszavas vagy sérült fájl lehet). Az agent nem találta ki a tartalmat.'

export type WebResearchSource = {
  urlHash: string
  host: string
  sourceType: WebResearchSourceType
  contentHash: string
  fetchedAt: string
  title?: string
  contentType?: WebResearchContentType
  pageCount?: number
  truncated?: boolean
  hop?: boolean
  notice?: string
}

export type WebResearchFact = {
  statement: string
  sourceIndices: number[]
  confidence: WebResearchConfidence
}

export type WebResearchResult = {
  objectiveEcho: string
  facts: WebResearchFact[]
  sources: WebResearchSource[]
  overallConfidence: WebResearchConfidence
  unverified: boolean
  provenance: {
    egressRoleAgentId: string
    egressRoleAgentVersion?: number
    requesterAgentId: string
    queryHash: string
    contractVersion: 'web_research/v1'
  }
}

export type WebResearchRequestArgs = {
  objective: string
  allowedSourceTypes?: WebResearchSourceType[]
  knownDomain?: string
  maxSources?: number
}

export type WebResearchRequestResult =
  | { ok: true; result: WebResearchResult }
  | { ok: false; error: WebResearchBlockedReason }

export type WebResearchBlockedReason =
  | 'RESEARCH_VALIDATION_FAILED'
  | 'NO_TRUSTED_SOURCE'
  | 'delegation_disabled'
  | 'web_fetch_disabled'
  | 'requester_daily_limit'
  | 'web_egress_agent_missing'
  // #142 — a tenant Web-Egress példánya `inboundRestricted`: hiányzik az explicit
  // agent→Web-Egress `address` grant, ezért a kérő agent nem használhat webet.
  | 'web_egress_access_denied'
  | 'domain_not_allowed'
  | 'domain_denied'
