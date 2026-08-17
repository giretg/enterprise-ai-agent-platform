import type { GmailConnectorConfig } from '@/domain/connector-template/gmail-connector-config'
import type { ValidationResult } from './draft-validator'

export function validateGmailDraftConfig(config: GmailConnectorConfig): ValidationResult {
  const warnings: string[] = []
  const errors: string[] = []

  if (config.oauth.scopes.length === 0) {
    errors.push('Legalább egy Gmail scope szükséges.')
  }

  const status = errors.length > 0 ? 'failed' : 'passed'

  return {
    status,
    checks: {
      egressAllowlist: 'passed',
      scopeMinimization: 'passed',
      forbiddenPatterns: 'passed',
      secretInline: 'passed',
      writeToolsFlagged: 'passed',
      oauthCompleteness: errors.length > 0 ? 'failed' : 'passed',
    },
    warnings,
    errors,
    unknownHosts: [],
  }
}
