import { z } from 'zod'
import { FORBIDDEN_HOST_PATTERNS, SECRET_LIKE_PATTERNS } from '@/domain/net/untrusted-patterns'
import type { CheckStatus } from '@/domain/provisioning/draft-validator'
import type { WebResearchResult } from './web-research-types'

export type WebResearchValidationResult =
  | { status: 'passed' | 'warned'; result: WebResearchResult; warnings: string[]; errors: [] }
  | { status: 'failed'; warnings: string[]; errors: string[] }

const CONFIDENCE = z.enum(['high', 'medium', 'low'])
const SOURCE_TYPE = z.enum(['official', 'vendor_doc', 'news', 'blog'])

const schema = z.object({
  objectiveEcho: z.string().min(1).max(500),
  facts: z.array(z.object({
    statement: z.string().min(1).max(1000),
    sourceIndices: z.array(z.number().int().nonnegative()).min(1),
    confidence: CONFIDENCE,
  })).min(1),
  sources: z.array(z.object({
    urlHash: z.string().min(8).max(128),
    host: z.string().min(1).max(255),
    sourceType: SOURCE_TYPE,
    contentHash: z.string().min(8).max(128),
    fetchedAt: z.string().datetime(),
  })).min(1),
  overallConfidence: CONFIDENCE,
  unverified: z.boolean(),
  provenance: z.object({
    egressRoleAgentId: z.string().min(1),
    egressRoleAgentVersion: z.number().int().positive().optional(),
    requesterAgentId: z.string().min(1),
    queryHash: z.string().min(8).max(128),
    contractVersion: z.literal('web_research/v1'),
  }),
})

export type WebResearchValidatorOptions = {
  knownHosts: Iterable<string>
  maxFacts?: number
  maxSources?: number
}

function worst(...statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('warned')) return 'warned'
  return 'passed'
}

export function validateWebResearchResult(
  input: unknown,
  opts: WebResearchValidatorOptions,
): WebResearchValidationResult {
  const warnings: string[] = []
  const errors: string[] = []
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { status: 'failed', warnings, errors: ['schema_invalid'] }
  }

  const maxFacts = opts.maxFacts ?? 20
  const maxSources = opts.maxSources ?? 8
  const knownHosts = new Set([...opts.knownHosts].map((host) => host.toLowerCase()))
  const result = parsed.data

  if (result.facts.length > maxFacts) errors.push('too_many_facts')
  if (result.sources.length > maxSources) errors.push('too_many_sources')

  for (const fact of result.facts) {
    for (const idx of fact.sourceIndices) {
      if (idx >= result.sources.length) errors.push('source_index_out_of_range')
    }
    for (const rule of SECRET_LIKE_PATTERNS) {
      if (rule.pattern.test(fact.statement)) errors.push(`inline_secret:${rule.name}`)
    }
  }

  const hasUnverifiedSource = result.sources.some((source) => source.sourceType === 'news' || source.sourceType === 'blog')
  for (const source of result.sources) {
    const host = source.host.toLowerCase()
    if (!knownHosts.has(host)) errors.push(`unknown_source_host:${host}`)
    for (const rule of FORBIDDEN_HOST_PATTERNS) {
      if (rule.pattern.test(host)) errors.push(`forbidden_host:${rule.name}`)
    }
  }

  if (hasUnverifiedSource) {
    if (!result.unverified) {
      result.unverified = true
      warnings.push('unverified_forced')
    }
    if (result.overallConfidence === 'high') {
      result.overallConfidence = 'medium'
      warnings.push('confidence_capped')
    }
  }
  if (result.overallConfidence === 'high' && result.unverified) {
    errors.push('confidence_integrity')
  }

  const status = worst(errors.length > 0 ? 'failed' : 'passed', warnings.length > 0 ? 'warned' : 'passed')
  if (status === 'failed') return { status: 'failed', warnings, errors: [...new Set(errors)] }
  return { status, result, warnings, errors: [] }
}
